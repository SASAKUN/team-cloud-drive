const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// ===== R2 Configuration =====
const r2Enabled = !!(config.r2AccessKeyId && config.r2SecretAccessKey);
const r2PublicUrl = config.r2PublicUrl || null;

let r2Client = null;
if (r2Enabled) {
  r2Client = new S3Client({
    region: 'auto',
    endpoint: config.r2Endpoint,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
    forcePathStyle: true,
  });

  if (r2PublicUrl) {
    console.log('☁️  R2 enabled — downloads via public URL:', r2PublicUrl);
  } else {
    console.log('☁️  R2 enabled (WARNING: no R2_PUBLIC_URL set — downloads will fail for browsers on Render)');
  }
}

const BUCKET = config.r2BucketName;

// ===== Storage API =====

/**
 * Upload a file to storage (R2 or local)
 */
async function uploadFile(key, source, contentType) {
  if (r2Enabled) {
    const body = typeof source === 'string' ? fs.readFileSync(source) : source;
    const size = typeof source === 'string' ? fs.statSync(source).size : Buffer.byteLength(body);

    // Try R2 public domain upload first (avoids S3 API endpoint TLS issue on Render)
    if (r2PublicUrl) {
      try {
        const presignedUrl = await getUploadUrl(key, contentType, 300);
        if (presignedUrl) {
          const https = require('https');
          const { URL } = require('url');
          const parsedUrl = new URL(presignedUrl);
          await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: parsedUrl.hostname,
              path: parsedUrl.pathname + parsedUrl.search,
              method: 'PUT',
              headers: {
                'Content-Type': contentType || 'application/octet-stream',
                'Content-Length': size,
              },
              rejectUnauthorized: true, // r2.dev uses valid Cloudflare certs
            }, (res) => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve();
              } else {
                let body = '';
                res.on('data', d => body += d);
                res.on('end', () => reject(new Error(`R2 upload failed: ${res.statusCode} ${body}`)));
              }
            });
            req.on('error', reject);
            req.write(body);
            req.end();
          });
          console.log('✅ R2 upload via public URL:', key);
          return { key, size };
        }
      } catch (e) {
        console.log('⚠️  R2 public URL upload failed:', e.message, '— falling back to S3 API');
      }
    }

    // Fallback: S3 API endpoint (may fail on Render due to TLS)
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    });
    await r2Client.send(command);
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
 * Get a presigned upload URL that browsers can PUT to directly.
 * Uses r2PublicUrl as endpoint so the URL is browser-accessible.
 * getSignedUrl() is pure local crypto — no network call.
 */
async function getUploadUrl(key, contentType, expiresIn = 300) {
  if (!r2Enabled || !r2PublicUrl) return null;

  // Use the public domain as endpoint so browsers can PUT directly
  const uploadClient = new S3Client({
    region: 'auto',
    endpoint: r2PublicUrl,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
    forcePathStyle: true,
  });

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });

  return getSignedUrl(uploadClient, command, { expiresIn });
}

// ====== R2 Download Strategy ======
//
// Problem: Render's Node.js TLS cannot connect to R2's S3 API endpoint
// (SSL alert 40 — handshake failure). So we can't proxy file content
// through the server.
//
// Solution A (RECOMMENDED): Enable Public Access on the R2 bucket in
// Cloudflare Dashboard, set R2_PUBLIC_URL to the r2.dev domain
// (e.g. https://pub-xxxxxxxxxxxx.r2.dev), and redirect browsers
// directly to the public URL. The server still enforces access control
// before issuing the 302 redirect. UUID-based paths make files
// practically unguessable.
//
// Solution B (fallback): Generate a presigned URL and 302 redirect.
// This ONLY works when the presigned URL domain is browser-accessible,
// which the S3 API endpoint is NOT.

/**
 * Get a readable stream for a file (for piping to archiver etc.)
 * Returns { stream, size, contentType } or null
 *
 * NOTE: In R2 mode on Render, getReadStream CANNOT fetch file content
 *       due to TLS handshake incompatibility. Batch ZIP downloads
 *       require server-side streaming and will not work in R2 mode.
 */
async function getReadStream(key) {
  // Check local disk first (file may have been uploaded locally when R2 failed)
  const localPath = path.join(config.uploadDir, key);
  if (fs.existsSync(localPath)) {
    const stat = fs.statSync(localPath);
    return {
      stream: fs.createReadStream(localPath),
      size: stat.size,
      contentType: 'application/octet-stream',
    };
  }

  if (r2Enabled) {
    return null; // Cannot stream from R2 server-side (TLS issue)
  }

  return null;
}

/**
 * Get a download URL for a file
 * With R2_PUBLIC_URL: returns direct public URL (no expiration)
 * Without: generates a presigned URL (may not work in browsers on Render)
 */
async function getDownloadUrl(key, expiresIn = 3600) {
  if (r2Enabled) {
    // Check if file exists locally (R2 upload may have failed)
    const localPath = path.join(config.uploadDir, key);
    if (fs.existsSync(localPath)) {
      return localPath; // Will be served from local storage
    }

    if (r2PublicUrl) {
      // Direct public URL — bucket must have Public Access enabled
      return `${r2PublicUrl.replace(/\/$/, '')}/${encodeKeyForUrl(key)}`;
    }
    // Fallback: presigned URL (uses S3 API endpoint, browsers may reject)
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return getSignedUrl(r2Client, command, { expiresIn });
  }
  return path.join(config.uploadDir, key);
}

/**
 * Stream a file to a response (for preview/download)
 *
 * With R2_PUBLIC_URL: 302 redirect to the public URL. Server verifies
 *   permissions first, then browser fetches directly from R2's public
 *   domain — no TLS issues.
 *
 * Without R2_PUBLIC_URL: generates a presigned URL and 302 redirects.
 *   This uses the S3 API endpoint which browsers on Render cannot
 *   connect to (SSL alert 40).
 */
async function streamFile(key, res, options = {}) {
  const { filename, contentType = 'application/octet-stream', inline = false } = options;

  if (r2Enabled) {
    // Try R2 redirect (public URL or presigned)
    try {
      if (r2PublicUrl) {
        // === Solution A: Direct public URL ===
        const url = new URL(`${r2PublicUrl.replace(/\/$/, '')}/${encodeKeyForUrl(key)}`);
        if (inline) {
          url.searchParams.set('response-content-disposition', 'inline');
        } else if (filename) {
          url.searchParams.set(
            'response-content-disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
          );
        }
        if (contentType && contentType !== 'application/octet-stream') {
          url.searchParams.set('response-content-type', contentType);
        }

        console.log(`  ↪ Redirecting to R2 public URL (${filename || key})`);
        return res.redirect(302, url.toString());
      }

      // === Solution B fallback: Presigned URL ===
      const cmdInput = { Bucket: BUCKET, Key: key };

      if (inline) {
        cmdInput.ResponseContentDisposition = 'inline';
      } else if (filename) {
        cmdInput.ResponseContentDisposition =
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
      }

      if (contentType && contentType !== 'application/octet-stream') {
        cmdInput.ResponseContentType = contentType;
      }

      const command = new GetObjectCommand(cmdInput);
      const signedUrl = await getSignedUrl(r2Client, command, { expiresIn: 300 });

      console.log(`  ↪ Redirecting to R2 presigned URL (${filename || key})`);
      return res.redirect(302, signedUrl);
    } catch (err) {
      console.error('R2 download failed, trying local fallback:', err.message);
      // Fall through to local check below
    }
  }

  // Local storage fallback (also used when R2 is enabled but file stored locally)
  const localPath = path.join(config.uploadDir, key);
  if (fs.existsSync(localPath)) {
    const disposition = inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(filename || path.basename(key))}`;
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', fs.statSync(localPath).size);
    const stream = fs.createReadStream(localPath);
    stream.pipe(res);
    return;
  }

  if (!res.headersSent) {
    return res.status(404).send('File not found');
  }
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
 */
async function fileExists(key) {
  // Always check local disk first
  if (fs.existsSync(path.join(config.uploadDir, key))) {
    return true;
  }
  if (r2Enabled) {
    if (key && key.startsWith('files/')) return true;
    return false;
  }
  return false;
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
  if (r2Enabled && r2PublicUrl) {
    return `${r2PublicUrl.replace(/\/$/, '')}/${encodeKeyForUrl(key)}`;
  }
  if (r2Enabled) {
    return `${config.r2Endpoint}/${BUCKET}/${encodeKeyForUrl(key)}`;
  }
  return null;
}

/**
 * Encode a storage key for use in a URL.
 * Splits by '/' and encodes each segment with encodeURIComponent,
 * so path separators stay as '/' but filenames are properly encoded.
 */
function encodeKeyForUrl(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

module.exports = {
  r2Enabled,
  uploadFile,
  getDownloadUrl,
  getUploadUrl,
  getReadStream,
  streamFile,
  deleteFile,
  fileExists,
  makeKey,
  getPublicUrl,
  encodeKeyForUrl,
};
