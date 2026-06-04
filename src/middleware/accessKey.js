const AccessKey = require('../models/AccessKey');

// Middleware: resolve access key from query param or session
// Attaches req.accessKey with the full key object or null
function resolveAccessKey(req, res, next) {
  // Check query parameter first, then session
  const keyParam = req.query.key;
  if (keyParam) {
    const key = AccessKey.findByKey(keyParam);
    if (key) {
      req.accessKey = key;
      // Persist in session for subsequent page loads
      if (req.session) {
        req.session.accessKey = keyParam;
        req.session.accessPermission = key.permission;
        req.session.accessKeyId = key.id;
      }
    }
  } else if (req.session && req.session.accessKey) {
    const key = AccessKey.findByKey(req.session.accessKey);
    if (key && key.permission === req.session.accessPermission) {
      req.accessKey = key;
    } else {
      // Key was deleted or changed — clear session
      delete req.session.accessKey;
      delete req.session.accessPermission;
      delete req.session.accessKeyId;
    }
  }
  next();
}

// Check if user has download permission via access key (global)
function canDownload(req) {
  return req.accessKey && (req.accessKey.permission === 'download' || req.accessKey.permission === 'both');
}

// Check if user can download a specific file (per-file permission override)
function canDownloadFile(req, fileUuid) {
  if (!req.accessKey) return false;
  return AccessKey.canDownloadFile(req.accessKey, fileUuid);
}

// Check if user has at least preview permission via access key
function canPreview(req) {
  return !!req.accessKey;
}

// Check if a key can access (preview) content in a specific bundle
// Respects: file > bundle > global priority
function canAccessBundle(req, bundleId) {
  if (!req.accessKey) return false;
  const perm = AccessKey.getEffectiveBundlePermission(req.accessKey, bundleId);
  if (perm === 'none') return false;
  return true;
}

// Check if a key can download from a specific bundle
function canDownloadFromBundle(req, bundleId) {
  if (!req.accessKey) return false;
  const perm = AccessKey.getEffectiveBundlePermission(req.accessKey, bundleId);
  return perm === 'download' || perm === 'both';
}

// Check effective permission on a file within a bundle context
function getEffectiveFilePerm(req, bundleId, fileUuid) {
  return AccessKey.getEffectivePermission(req.accessKey, bundleId, fileUuid);
}

module.exports = { resolveAccessKey, canDownload, canDownloadFile, canPreview, canAccessBundle, canDownloadFromBundle, getEffectiveFilePerm };
