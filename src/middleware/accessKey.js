const AccessKey = require('../models/AccessKey');

function resolveAccessKey(req, res, next) {
  const keyParam = req.query.key;

  async function resolve() {
    if (keyParam) {
      try {
        const key = await AccessKey.findByKey(keyParam);
        if (key) {
          req.accessKey = key;
          if (req.session) {
            req.session.accessKey = keyParam;
            req.session.accessPermission = key.permission;
            req.session.accessKeyId = key.id;
          }
          const [filePerms, bundlePerms] = await Promise.all([
            AccessKey.getFilePermissionMap(key.id),
            AccessKey.getBundlePermissionMap(key.id)
          ]);
          req._keyFilePerms = filePerms;
          req._keyBundlePerms = bundlePerms;
        }
      } catch (e) { /* key resolution failed, continue without */ }
    } else if (req.session && req.session.accessKey && req.session.accessKeyId) {
      try {
        const key = await AccessKey.findByKey(req.session.accessKey);
        if (key && key.permission === req.session.accessPermission) {
          req.accessKey = key;
          const [filePerms, bundlePerms] = await Promise.all([
            AccessKey.getFilePermissionMap(key.id),
            AccessKey.getBundlePermissionMap(key.id)
          ]);
          req._keyFilePerms = filePerms;
          req._keyBundlePerms = bundlePerms;
        } else {
          delete req.session.accessKey;
          delete req.session.accessPermission;
          delete req.session.accessKeyId;
        }
      } catch (e) { /* session key resolution failed */ }
    }
  }

  resolve().then(() => next()).catch(() => next());
}

// Check if user has download permission via access key (global)
function canDownload(req) {
  return req.accessKey && (req.accessKey.permission === 'download' || req.accessKey.permission === 'both');
}

// Check if user can download a specific file — reads from preloaded map
function canDownloadFile(req, fileUuid) {
  if (!req.accessKey) return false;
  // Check per-file override first (from preloaded map)
  if (req._keyFilePerms && req._keyFilePerms[fileUuid]) {
    const perm = req._keyFilePerms[fileUuid];
    return perm === 'download' || perm === 'both';
  }
  // Fall back to global
  return req.accessKey.permission === 'download' || req.accessKey.permission === 'both';
}

// Check if user has at least preview permission via access key
function canPreview(req) {
  return !!req.accessKey;
}

// Check if a key can access content in a specific bundle — reads from preloaded map
function canAccessBundle(req, bundleId) {
  if (!req.accessKey) return false;
  // Check bundle override first
  if (req._keyBundlePerms && req._keyBundlePerms[bundleId] !== undefined) {
    return req._keyBundlePerms[bundleId] !== 'none';
  }
  // If no override, any active key can access
  return true;
}

// Check if a key can download from a specific bundle — reads from preloaded map
function canDownloadFromBundle(req, bundleId) {
  if (!req.accessKey) return false;
  // Check bundle override first
  if (req._keyBundlePerms && req._keyBundlePerms[bundleId] !== undefined) {
    const perm = req._keyBundlePerms[bundleId];
    return perm === 'download' || perm === 'both';
  }
  // Fall back to global
  return req.accessKey.permission === 'download' || req.accessKey.permission === 'both';
}

// Check effective permission on a file within a bundle context
// Priority: file override > bundle override > global
function getEffectiveFilePerm(req, bundleId, fileUuid) {
  if (!req.accessKey) return 'none';
  // 1. File override
  if (req._keyFilePerms && req._keyFilePerms[fileUuid]) {
    return req._keyFilePerms[fileUuid];
  }
  // 2. Bundle override
  if (req._keyBundlePerms && req._keyBundlePerms[bundleId] !== undefined) {
    return req._keyBundlePerms[bundleId];
  }
  // 3. Global
  return req.accessKey.permission;
}

module.exports = { resolveAccessKey, canDownload, canDownloadFile, canPreview, canAccessBundle, canDownloadFromBundle, getEffectiveFilePerm };
