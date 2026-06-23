const fs = require('fs');
const path = require('path');
const config = require('../config');

// ===== Supabase Storage Configuration =====
const supabaseUrl = config.supabaseUrl || null;
const supabaseKey = config.supabaseServiceRoleKey || null;
const supabaseEnabled = !!(supabaseUrl && supabaseKey);
const BUCKET = config.supabaseStorageBucket || 'files';

if (supabaseEnabled) {
  console.log(`☁️  Supabase Storage enabled: ${supabaseUrl}/storage/v1 (bucket: ${BUCKET})`);
}

// ===== Helpers =====

function makeKey(uuid, filename) {
  return `files/${uuid}/${filename}`;
}

function encodeKeyForUrl(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * Supabase Storage REST API helper
 * Docs: https://supabase.com/docs/reference/javascript/storage-createbucket
 */
async function supabaseFetch(path, options = {}) {
  const url = `${supabaseUrl}/storage/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${supabaseKey}`,
      'apikey': supabaseKey,
      ...options.headers,
    },
  });
  return res;
}

// ===== Storage API =====

/**
 * Upload a file to Supabase Storage
 */
async function uploadFile(key, source, contentType) {
  if (supabaseEnabled) {
    const body = typeof source === 'string' ? fs.readFileSync(source) : source;
    const size = typeof source === 'string' ? fs.statSync(source).size : Buffer.byteLength(body);

    try {
      const res = await supabaseFetch(`object/${BUCKET}/${encodeKeyForUrl(key)}`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType || 'application/octet-stream',
          'x-upsert': 'false',
        },
        body,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Supabase upload failed (${res.status}): ${errText}`);
      }

      console.log('✅ Supabase Storage upload:', key);
      return { key, size, storageBackend: 'supabase' };
    } catch (e) {
      console.error('❌ Supabase Storage upload error:', e.message);
      throw e;
    }
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
 */
async function getReadStream(key) {
  if (supabaseEnabled) {
    try {
      const url = `${supabaseUrl}/storage/v1/object/${BUCKET}/${encodeKeyForUrl(key)}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${supabaseKey}`, 'apikey': supabaseKey },
      });
      if (!res.ok) return null;
      const buffer = await res.arrayBuffer();
      const stream = require('stream');
      const readable = new stream.Readable();
      readable._read = () => {};
      readable.push(Buffer.from(buffer));
      readable.push(null);
      return {
        stream: readable,
        size: parseInt(res.headers.get('content-length') || '0', 10),
        contentType: res.headers.get('content-type') || 'application/octet-stream',
      };
    } catch (e) {
      console.error('Supabase getReadStream error:', e.message);
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
 * Get a download URL for a file
 * With Supabase: returns a signed URL (valid for 1 hour)
 */
async function getDownloadUrl(key, expiresIn = 3600) {
  if (supabaseEnabled) {
    try {
      const res = await supabaseFetch(`object/sign/${BUCKET}/${encodeKeyForUrl(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn }),
      });
      if (res.ok) {
        const data = await res.json();
        return `${supabaseUrl}/storage/v1${data.signedURL}`;
      }
    } catch (e) {
      console.error('Supabase getDownloadUrl error:', e.message);
    }
  }
  return null;
}

/**
 * Stream a file to a response (for preview/download)
 * With Supabase: issues a 302 redirect to the signed URL
 */
async function streamFile(key, res, options = {}) {
  const { filename, contentType = 'application/octet-stream', inline = false } = options;

  if (supabaseEnabled) {
    try {
      // Create a signed URL for download
      const signRes = await supabaseFetch(`object/sign/${BUCKET}/${encodeKeyForUrl(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 300 }),
      });

      if (signRes.ok) {
        const data = await signRes.json();
        let signedUrl = `${supabaseUrl}/storage/v1${data.signedURL}`;

        // Supabase signed URLs already include content-disposition handling
        // but we can add response headers via query params
        const url = new URL(signedUrl);
        if (inline) {
          url.searchParams.set('download', '');
        }

        console.log(`  ↪ Redirecting to Supabase Storage (${filename || key})`);
        return res.redirect(302, url.toString());
      } else {
        const errText = await signRes.text();
        console.error('Supabase sign error:', signRes.status, errText);
      }
    } catch (e) {
      console.error('Supabase streamFile error:', e.message);
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
  if (supabaseEnabled) {
    try {
      const res = await supabaseFetch(`object/${BUCKET}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: [encodeKeyForUrl(key)] }),
      });
      if (res.ok) {
        console.log('✅ Supabase Storage delete:', key);
      } else {
        const errText = await res.text();
        console.error('Supabase delete error:', res.status, errText);
      }
    } catch (e) {
      console.error('Supabase deleteFile error:', e.message);
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
  if (supabaseEnabled) {
    try {
      const res = await supabaseFetch(`object/${BUCKET}/${encodeKeyForUrl(key)}`, {
        method: 'HEAD',
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  // Local fallback
  return fs.existsSync(path.join(config.uploadDir, key));
}

/**
 * Get public URL for a file
 */
function getPublicUrl(key) {
  if (supabaseEnabled) {
    return `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${encodeKeyForUrl(key)}`;
  }
  return null;
}

module.exports = {
  supabaseEnabled,
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
