const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// ===== R2 Configuration =====
const r2Enabled = !!(config.r2AccessKeyId && config.r2SecretAccessKey);

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
 * Get a readable stream for a file (for piping to archiver etc.)
 * Returns { stream, size, contentType } or null
 */
async function getReadStream(key) {
  if (r2Enabled) {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const response = await r2Client.send(command);
    return {
      stream: response.Body,
      size: response.ContentLength,
      contentType: response.ContentType || 'application/octet-stream',
    };
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
 */
async function streamFile(key, res, options = {}) {
  const { filename, contentType = 'application/octet-stream', inline = false } = options;

  if (r2Enabled) {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const url = await getSignedUrl(r2Client, command, { expiresIn: 300 });
    return res.redirect(url);
  }

  const localPath = path.join(config.uploadDir, key);
  if (!fs.existsSync(localPath)) {
    return res.status(404).send('File not found');
  }

  const disposition = inline ? 'inline' : `attachment; filename="${encodeURIComponent(filename || path.basename(key))}"`;
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
