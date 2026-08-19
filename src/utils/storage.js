const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// ===== Tencent Cloud COS Configuration =====
// COS is fully S3-compatible. Unlike R2, it uses standard TLS
// and works perfectly with Render — upload, download, streaming, all work.
const cosEnabled = !!(config.cosSecretId && config.cosSecretKey && config.cosBucket);
const BUCKET = config.cosBucket;
const REGION = config.cosRegion || 'ap-guangzhou';
const ENDPOINT = `https://cos.${REGION}.myqcloud.com`;

let cosClient = null;
if (cosEnabled) {
  cosClient = new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    credentials: {
      accessKeyId: config.cosSecretId,
      secretAccessKey: config.cosSecretKey,
    },
    forcePathStyle: true,
  });
  console.log(`☁️  Tencent COS enabled: ${ENDPOINT} (bucket: ${BUCKET})`);
}

// ===== Helpers =====

function makeKey(uuid, filename) {
  return `files/${uuid}/${filename}`;
}

function encodeKeyForUrl(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

// ===== Storage API =====

/**
 * Upload a file to COS (or local fallback)
 */
async function uploadFile(key, source, contentType) {
  if (cosEnabled) {
    const body = typeof source === 'string' ? fs.readFileSync(source) : source;
    const size = typeof source === 'string' ? fs.statSync(source).size : Buffer.byteLength(body);

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    });
    await cosClient.send(command);
    console.log('✅ COS upload:', key);
    return { key, size, storageBackend: 'cos' };
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
  return { key, size, storageBackend: 'local' };
}

/**
 * Get a readable stream for a file (for batch ZIP downloads)
 * Returns { stream, size, contentType } or null
 *
 * With COS, server-side streaming works perfectly (standard TLS).
 */
async function getReadStream(key) {
  if (cosEnabled) {
    try {
      const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
      const response = await cosClient.send(command);
      return {
        stream: response.Body,
        size: response.ContentLength || 0,
        contentType: response.ContentType || 'application/octet-stream',
      };
    } catch (e) {
      console.error('COS getReadStream error:', e.message);
    }
  }

  // Local fallback
  const localPath = path.join(config.uploadDir, key);
  if (fs.existsSync(localPath)) {
    const stat = fs.statSync(localPath);
    return {
      stream: fs.createReadStream(localPath),
      size: stat.size,
      contentType: 'application/octet-stream',
    };
  }
  return null;
}

/**
 * Get a presigned download URL (valid for `expiresIn` seconds)
 */
async function getDownloadUrl(key, expiresIn = 3600) {
  if (cosEnabled) {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return getSignedUrl(cosClient, command, { expiresIn });
  }
  return path.join(config.uploadDir, key);
}

/**
 * Stream a file to a response (for preview/download)
 *
 * With COS: generates a presigned URL and 302 redirects browser.
 * COS presigned URLs are browser-accessible (standard TLS).
 */
async function streamFile(key, res, options = {}) {
  const { filename, contentType = 'application/octet-stream', inline = false } = options;

  if (cosEnabled) {
    try {
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
      const signedUrl = await getSignedUrl(cosClient, command, { expiresIn: 300 });

      console.log(`  ↪ Redirecting to COS presigned URL (${filename || key})`);
      return res.redirect(302, signedUrl);
    } catch (err) {
      console.error('COS download error:', err.message);
      // Fall through to local check below
    }
  }

  // Local storage fallback
  const localPath = path.join(config.uploadDir, key);
  if (fs.existsSync(localPath)) {
    const disposition = inline
      ? 'inline'
      : `attachment; filename*=UTF-8''${encodeURIComponent(filename || path.basename(key))}`;
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
  if (cosEnabled) {
    try {
      const command = new DeleteObjectCommand({ Bucket: BUCKET, Key: key });
      await cosClient.send(command);
      console.log('✅ COS delete:', key);
    } catch (e) {
      console.error('COS delete error:', e.message);
    }
    return;
  }

  // Local fallback
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
  if (cosEnabled) {
    try {
      const command = new HeadObjectCommand({ Bucket: BUCKET, Key: key });
      await cosClient.send(command);
      return true;
    } catch (e) {
      return false;
    }
  }

  return fs.existsSync(path.join(config.uploadDir, key));
}

/**
 * Get public URL for a file
 */
function getPublicUrl(key) {
  if (cosEnabled) {
    return `${ENDPOINT}/${BUCKET}/${encodeKeyForUrl(key)}`;
  }
  return null;
}

module.exports = {
  cosEnabled,
  uploadFile,
  getDownloadUrl,
  getReadStream,
  streamFile,
  deleteFile,
  fileExists,
  makeKey,
  getPublicUrl,
  encodeKeyForUrl,
};
