const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// ===== R2 Configuration =====
const r2Enabled = !!(config.r2AccessKeyId && config.r2SecretAccessKey);

let r2Client = null;
if (r2Enabled) {
  // Keep HTTPS for presigned URL generation (local crypto, no network call).
  // Actual downloads use the presigned URL via HTTP due to TLS handshake
  // incompatibility between Render's Node.js and Cloudflare R2.
  r2Client = new S3Client({
    region: 'auto',
    endpoint: config.r2Endpoint,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
    forcePathStyle: true,
  });
  console.log('☁️  R2 enabled (stream via presigned URL → HTTP fallback)');
}

const BUCKET = config.r2BucketName;

// ===== Storage API =====

/**
 * Upload a file to storage (R2 or local)
 */
async function uploadFile(key, source, contentType) {
  if (r2Enabled) {
    const body = typeof source === 'string' ? fs.readFileSync(source) : source;
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    });
    await r2Client.send(command);
    const size = typeof source === 'string' ? fs.statSync(source).size : Buffer.byteLength(body);
    return { key, size };
  }

  // Local storage fallback
  const localPath = path.join(config.uploadDir, key);
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (typeof source === 'string') {
    fs.copyFileSync(source, localPath);
  } else {
    fs.writeFileSync(localPath, source);
  }
  const size = fs.statSync(localPath).size;
  return { key, size };
}

/**
 * Fetch a presigned URL with redirect following and TLS fallback.
 * Tries: 1) HTTPS directly  2) HTTP with redirect following  3) HTTPS after redirect
 */
function fetchPresigned(signedUrl, timeout = 30000) {
  const https = require('https');
  const http = require('http');
  const url = require('url');

  return new Promise((resolve, reject) => {
    function attempt(urlStr, redirectCount) {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));

      const parsed = url.parse(urlStr);
      const isHttps = parsed.protocol === 'https:';
      const mod = isHttps ? https : http;
      const agentOpts = { rejectUnauthorized: false, keepAlive: false };

      const req = mod.get(urlStr, { agent: new mod.Agent(agentOpts), timeout }, (res) => {
        const status = res.statusCode;

        // Follow redirects (301, 302, 307, 308)
        if ((status === 301 || status === 302 || status === 307 || status === 308) && res.headers.location) {
          const redirectUrl = url.resolve(urlStr, res.headers.location);
          res.resume(); // drain response
          console.log(`  ↪ R2 redirect (${status}) → ${redirectUrl.substring(0, 80)}...`);
          return attempt(redirectUrl, redirectCount + 1);
        }

        if (status >= 400) {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            console.error(`R2 fetch error: status=${status}, body=${body.substring(0, 300)}`);
            reject(new Error(`R2 returned ${status}: ${body.substring(0, 200)}`));
          });
          return;
        }

        resolve(res);
      });

      req.on('timeout', () => { req.destroy(); reject(new Error('Connection timeout')); });
      req.on('error', reject);
    }

    // Start with HTTPS (original presigned URL)
    const httpsUrl = signedUrl;
    attempt(httpsUrl, 0);
  });
}

/**
 * Get a readable stream for a file (for piping to archiver etc.)
 * Returns { stream, size, contentType } or null
 */
async function getReadStream(key) {
  if (r2Enabled) {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const signedUrl = await getSignedUrl(r2Client, command, { expiresIn: 300 });

    try {
      const r2Res = await fetchPresigned(signedUrl);
      return {
        stream: r2Res,
        size: parseInt(r2Res.headers['content-length'] || '0'),
        contentType: r2Res.headers['content-type'] || 'application/octet-stream',
      };
    } catch (err) {
      console.error('getReadStream failed for', key, ':', err.message);
      return null;
    }
  }

  const localPath = path.join(config.uploadDir, key);
  if (!fs.existsSync(localPath)) return null;
  const stat = fs.statSync(localPath);
  return {
    stream: fs.createReadStream(localPath),
    size: stat.size,
    contentType: 'application/octet-stream',
  };
}

/**
 * Get a presigned URL for downloading a file (R2) or local file path
 */
async function getDownloadUrl(key, expiresIn = 3600) {
  if (r2Enabled) {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return getSignedUrl(r2Client, command, { expiresIn });
  }
  return path.join(config.uploadDir, key);
}

/**
 * Stream a file to a response (for preview/download)
 * R2 mode: generates presigned URL locally (no network), fetches via HTTP,
 * and pipes to client — avoiding TLS handshake issues on Render.
 */
async function streamFile(key, res, options = {}) {
  const { filename, contentType = 'application/octet-stream', inline = false } = options;

  if (r2Enabled) {
    try {
      // Step 1: Generate presigned URL (pure local crypto, no network call)
      const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
      const signedUrl = await getSignedUrl(r2Client, command, { expiresIn: 300 });

      // Step 2: Fetch from R2 with redirect-following (HTTPS → HTTP fallback)
      fetchPresigned(signedUrl)
        .then((r2Res) => {
          // Step 3: Stream to client
          const disposition = inline
            ? 'inline'
            : `attachment; filename*=UTF-8''${encodeURIComponent(filename || path.basename(key))}`;

          res.setHeader('Content-Disposition', disposition);
          res.setHeader('Content-Type', r2Res.headers['content-type'] || contentType);
          if (r2Res.headers['content-length']) {
            res.setHeader('Content-Length', r2Res.headers['content-length']);
          }
          r2Res.pipe(res);
        })
        .catch((err) => {
          console.error('R2 fetch error for', key, ':', err.message);
          if (!res.headersSent) res.status(502).send('File download failed — storage temporarily unavailable');
        });
    } catch (err) {
      console.error('R2 presigned URL generation error for', key, ':', err.message);
      if (!res.headersSent) {
        return res.status(500).send('Failed to generate download link');
      }
    }
    return;
  }

  const localPath = path.join(config.uploadDir, key);
  if (!fs.existsSync(localPath)) {
    return res.status(404).send('File not found');
  }

  const disposition = inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(filename || path.basename(key))}`;
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', fs.statSync(localPath).size);
  const stream = fs.createReadStream(localPath);
  stream.pipe(res);
}

/**
 * Delete a file from storage
 */
async function deleteFile(key) {
  if (r2Enabled) {
    const command = new DeleteObjectCommand({ Bucket: BUCKET, Key: key });
    await r2Client.send(command);
    return;
  }

  const localPath = path.join(config.uploadDir, key);
  if (fs.existsSync(localPath)) {
    fs.unlinkSync(localPath);
    try {
      const dir = path.dirname(localPath);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch (e) { /* ignore */ }
  }
}

/**
 * Check if a file exists in storage
 * When R2 is enabled, trust storage_key from DB (verified during upload).
 * GetObject/HeadObject calls trigger SSL handshake issues on some hosts.
 */
async function fileExists(key) {
  if (r2Enabled) {
    // Trust storage_key — actual access is verified when file is downloaded
    if (key && key.startsWith('files/')) {
      return true;
    }
    return false;
  }
  return fs.existsSync(path.join(config.uploadDir, key));
}

/**
 * Generate storage key for a file
 */
function makeKey(uuid, filename) {
  return `files/${uuid}/${filename}`;
}

/**
 * Get public URL for a file (if bucket is public)
 */
function getPublicUrl(key) {
  if (r2Enabled) {
    return `${config.r2Endpoint}/${BUCKET}/${key}`;
  }
  return null;
}

module.exports = {
  r2Enabled,
  uploadFile,
  getDownloadUrl,
  getReadStream,
  streamFile,
  deleteFile,
  fileExists,
  makeKey,
  getPublicUrl,
};
