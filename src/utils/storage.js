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
  console.log('☁️  R2 enabled (browser-direct download via presigned URL redirect)');
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

// EXTERNAL preset (preferred for Render → R2 due to TLS incompatibility):
// 1) Generate presigned URL (pure local crypto) with Response headers baked in
// 2) 302 redirect the browser to that URL — browser fetches directly from R2
// This avoids ALL Render ↔ R2 network calls and the TLS handshake failure.

/**
 * Get a readable stream for a file (for piping to archiver etc.)
 * Returns { stream, size, contentType } or null
 *
 * NOTE: In R2 mode on Render, getReadStream CANNOT fetch file content
 *       due to TLS handshake failure (alert 40). Batch downloads that
 *       require server-side streaming (ZIP archiving) will not work in
 *       R2 mode on Render.
 */
async function getReadStream(key) {
  if (r2Enabled) {
    // Cannot fetch R2 content from Render due to TLS incompatibility.
    // For batch downloads that use getReadStream, files will be skipped
    // silently. Single-file downloads use streamFile() → 302 redirect.
    return null;
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
 *
 * R2 mode: generates a presigned URL (local crypto only, no R2 network call)
 * then 302-redirects the browser to fetch directly from Cloudflare R2.
 * This completely avoids Render's TLS handshake failure with R2.
 */
async function streamFile(key, res, options = {}) {
  const { filename, contentType = 'application/octet-stream', inline = false } = options;

  if (r2Enabled) {
    try {
      // Build GetObjectCommand with response headers baked into presigned URL
      const cmdInput = {
        Bucket: BUCKET,
        Key: key,
      };

      if (inline) {
        cmdInput.ResponseContentDisposition = 'inline';
      } else if (filename) {
        // RFC 5987 filename encoding for presigned URL
        cmdInput.ResponseContentDisposition =
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
      }

      if (contentType && contentType !== 'application/octet-stream') {
        cmdInput.ResponseContentType = contentType;
      }

      const command = new GetObjectCommand(cmdInput);
      const signedUrl = await getSignedUrl(r2Client, command, { expiresIn: 300 });

      // Step 2: Redirect browser to download directly from R2
      console.log(`  ↪ Redirecting browser to R2 presigned URL (${filename || key})`);
      return res.redirect(302, signedUrl);
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
