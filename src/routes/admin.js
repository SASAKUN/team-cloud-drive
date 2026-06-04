const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const File = require('../models/File');
const Bundle = require('../models/Bundle');
const AccessKey = require('../models/AccessKey');
const upload = require('../middleware/upload');
const { requireAdmin, isAdmin } = require('../middleware/auth');
const { getMimeType, getCategory, getFileIcon, formatFileSize } = require('../utils/mime');
const config = require('../config');

// ============ ADMIN LOGIN ============

router.get('/login', (req, res) => {
  if (isAdmin(req)) return res.redirect('/admin');
  res.render('admin-login', { title: '管理登录', error: null });
});

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === config.adminPassword) {
    req.session.isAdmin = true;
    const returnTo = req.session.returnTo || '/admin';
    delete req.session.returnTo;
    return res.redirect(returnTo);
  }
  res.render('admin-login', { title: '管理登录', error: '密码错误' });
});

router.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// ============ ADMIN PANEL (protected) - Separate pages ============

// GET /admin - Overview
router.get('/', requireAdmin, (req, res) => {
  const fileCount = File.findAll().length;
  const bundleCount = Bundle.findAll().length;
  const keyCount = AccessKey.findAll().length;
  res.render('admin', { title: '管理后台', currentPage: 'overview', fileCount, bundleCount, keyCount });
});

// GET /admin/files - File management page
router.get('/files', requireAdmin, (req, res) => {
  const files = File.findAll();
  const filesWithMeta = files.map(file => {
    const filePath = path.join(config.uploadDir, file.uuid, file.original_name);
    const fileDir = path.join(config.uploadDir, file.uuid);
    const missing = !fs.existsSync(filePath) && !(fs.existsSync(fileDir) && fs.readdirSync(fileDir).length > 0);
    return {
      ...file,
      icon: getFileIcon(file.category, file.original_name),
      sizeFormatted: formatFileSize(file.size_bytes),
      missing
    };
  });
  const invalidCount = filesWithMeta.filter(f => f.missing).length;
  res.render('admin-files', {
    title: '文件管理',
    currentPage: 'files',
    files: filesWithMeta,
    invalidCount,
    success: req.query.success || null,
    error: null
  });
});

// GET /admin/bundles - Bundle management page
router.get('/bundles', requireAdmin, (req, res) => {
  const bundles = Bundle.findAll().map(b => ({
    ...b,
    files: (b.files || []).map(f => ({
      ...f,
      icon: getFileIcon(f.category || getCategory(f.original_name), f.original_name),
      sizeFormatted: formatFileSize(f.size_bytes)
    })),
    children: (b.children || []).map(c => ({
      ...c,
      files: (c.files || []).map(f => ({
        ...f,
        icon: getFileIcon(f.category || getCategory(f.original_name), f.original_name),
        sizeFormatted: formatFileSize(f.size_bytes)
      }))
    }))
  }));
  const allFiles = File.findAll().map(f => ({
    ...f,
    icon: getFileIcon(f.category || getCategory(f.original_name), f.original_name),
    sizeFormatted: formatFileSize(f.size_bytes)
  }));
  res.render('admin-bundles', { title: '文件包管理', currentPage: 'bundles', bundles, files: allFiles });
});

// GET /admin/keys - Key management page
router.get('/keys', requireAdmin, (req, res) => {
  const keys = AccessKey.findAll();
  const files = File.findAll();
  res.render('admin-keys', { title: '密钥管理', currentPage: 'keys', keys, files });
});

// POST /admin/upload - Multi-file upload (supports AJAX and form POST)
router.post('/upload', requireAdmin, (req, res, next) => {
  upload.array('files', 20)(req, res, (err) => {
    if (err) {
      if (req.xhr || req.get('X-Requested-With') === 'XMLHttpRequest') {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: `文件大小超过限制（最大 ${config.maxFileSizeMB}MB）` });
        }
        if (err.message && err.message.startsWith('Unsupported file type')) {
          return res.status(400).json({ error: err.message });
        }
        return res.status(500).json({ error: '上传失败: ' + err.message });
      }
      return upload.handleUploadError(err, req, res, next);
    }

    if (!req.files || req.files.length === 0) {
      if (req.xhr || req.get('X-Requested-With') === 'XMLHttpRequest') {
        return res.json({ success: false, error: '请选择文件' });
      }
      const files = File.findAll().map(f => ({ ...f, icon: getFileIcon(f.category, f.original_name), sizeFormatted: formatFileSize(f.size_bytes) }));
      return res.render('admin-files', { title: '文件管理', currentPage: 'files', files, error: '请选择文件', success: null });
    }

    const visibility = req.body.visibility || 'public';
    let uploaded = [];

    req.files.forEach((file, idx) => {
      const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const mimeType = getMimeType(originalName);
      const category = getCategory(originalName);
      const fileUuid = req.fileUuids[idx];

      File.create({
        uuid: fileUuid,
        originalName,
        storedName: file.filename,
        mimeType,
        sizeBytes: file.size,
        category,
        description: req.body.description || '',
        visibility
      });
      uploaded.push({ uuid: fileUuid, name: originalName, size: file.size });
    });

    // AJAX: return JSON
    if (req.xhr || req.get('X-Requested-With') === 'XMLHttpRequest') {
      return res.json({ success: true, count: uploaded.length, files: uploaded });
    }

    // Form POST: redirect
    res.redirect('/admin/files?success=' + encodeURIComponent(`${uploaded.length} 个文件上传成功`));
  });
});

// POST /admin/files/:uuid/visibility
router.post('/files/:uuid/visibility', requireAdmin, (req, res) => {
  const { visibility } = req.body;
  if (!['public', 'download_only', 'hidden'].includes(visibility)) {
    return res.status(400).json({ error: '无效的可见性设置' });
  }
  File.setVisibility(req.params.uuid, visibility);
  res.json({ success: true, visibility });
});

// POST /admin/files/batch/visibility - Batch change visibility
router.post('/files/batch/visibility', requireAdmin, (req, res) => {
  const { uuids, visibility } = req.body;
  if (!Array.isArray(uuids) || !['public', 'download_only', 'hidden'].includes(visibility)) {
    return res.status(400).json({ error: '无效参数' });
  }
  uuids.forEach(uuid => File.setVisibility(uuid, visibility));
  res.json({ success: true });
});

// POST /admin/files/:uuid/delete
router.post('/files/:uuid/delete', requireAdmin, (req, res) => {
  const file = File.findByUuid(req.params.uuid);
  if (!file) return res.status(404).json({ error: '文件不存在' });

  const fileDir = path.join(config.uploadDir, file.uuid);
  if (fs.existsSync(fileDir)) {
    fs.rmSync(fileDir, { recursive: true });
  }
  File.deleteByUuid(file.uuid);
  res.json({ success: true });
});

// POST /admin/files/batch/delete - Batch delete
router.post('/files/batch/delete', requireAdmin, (req, res) => {
  const { uuids } = req.body;
  if (!Array.isArray(uuids)) return res.status(400).json({ error: '无效参数' });

  uuids.forEach(uuid => {
    const file = File.findByUuid(uuid);
    if (file) {
      const fileDir = path.join(config.uploadDir, file.uuid);
      if (fs.existsSync(fileDir)) fs.rmSync(fileDir, { recursive: true });
      File.deleteByUuid(file.uuid);
    }
  });
  res.json({ success: true });
});

// GET /admin/files/invalid — List files whose physical data is missing from disk
router.get('/files/invalid', requireAdmin, (req, res) => {
  const files = File.findAll();
  const invalid = files.filter(f => {
    const dir = path.join(config.uploadDir, f.uuid, f.original_name);
    return !fs.existsSync(dir);
  });
  res.json({ invalid: invalid.map(f => ({ uuid: f.uuid, name: f.original_name, size: f.size_bytes })), count: invalid.length });
});

// POST /admin/files/cleanup-invalid — Delete all DB records whose physical files are missing
router.post('/files/cleanup-invalid', requireAdmin, (req, res) => {
  const files = File.findAll();
  let deleted = 0;

  files.forEach(f => {
    const dir = path.join(config.uploadDir, f.uuid, f.original_name);
    if (!fs.existsSync(dir)) {
      // Also try checking the directory itself (multer stores as uploadDir/uuid/filename)
      const fileDir = path.join(config.uploadDir, f.uuid);
      if (!fs.existsSync(fileDir) || fs.readdirSync(fileDir).length === 0) {
        File.deleteByUuid(f.uuid);
        deleted++;
      }
    }
  });

  res.json({ success: true, deleted });
});

// ============ BUNDLE MANAGEMENT ============

// POST /admin/bundles - Create a new bundle
router.post('/bundles', requireAdmin, (req, res) => {
  const { name, description, visibility, parentId } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '文件包名称不能为空' });
  }
  const bundle = Bundle.create({ name: name.trim(), description: description || null, visibility: visibility || 'public', parentId: parentId || null });
  res.json({ success: true, bundle });
});

// POST /admin/bundles/:id - Update bundle
router.post('/bundles/:id', requireAdmin, (req, res) => {
  const { name, description, visibility, parentId } = req.body;
  Bundle.update(req.params.id, { name, description, visibility, parentId });
  res.json({ success: true });
});

// POST /admin/bundles/:id/delete - Delete a bundle
router.post('/bundles/:id/delete', requireAdmin, (req, res) => {
  const bundle = Bundle.findById(req.params.id);
  if (!bundle) return res.status(404).json({ error: '文件包不存在' });
  Bundle.deleteById(req.params.id);
  res.json({ success: true });
});

// POST /admin/bundles/:id/files - Add file to bundle
router.post('/bundles/:id/files', requireAdmin, (req, res) => {
  const { fileUuid } = req.body;
  if (!fileUuid) return res.status(400).json({ error: '请选择文件' });
  const file = File.findByUuid(fileUuid);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  const added = Bundle.addFile(req.params.id, fileUuid, 0);
  if (!added) return res.status(409).json({ error: '该文件已在文件包中' });
  res.json({ success: true });
});

// POST /admin/bundles/:id/files/remove - Remove file from bundle
router.post('/bundles/:id/files/remove', requireAdmin, (req, res) => {
  const { fileUuid } = req.body;
  Bundle.removeFile(req.params.id, fileUuid);
  res.json({ success: true });
});

// GET /admin/bundles/:id - Get bundle details
router.get('/bundles/:id', requireAdmin, (req, res) => {
  const bundle = Bundle.findById(req.params.id);
  if (!bundle) return res.status(404).json({ error: '文件包不存在' });
  res.json({ bundle });
});

// ============ ACCESS KEY MANAGEMENT ============

// POST /admin/keys - Create a new access key
router.post('/keys', requireAdmin, (req, res) => {
  const { label, permission } = req.body;
  if (!['preview', 'download', 'both'].includes(permission)) {
    return res.status(400).json({ error: '无效的权限设置' });
  }
  const accessKey = AccessKey.create({ label: label || null, permission });
  res.json({ success: true, key: accessKey });
});

// POST /admin/keys/:id - Update key permission
router.post('/keys/:id', requireAdmin, (req, res) => {
  const key = AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  const { permission } = req.body;
  if (permission && ['preview', 'download', 'both'].includes(permission)) {
    AccessKey.updatePermission(req.params.id, permission);
  }
  res.json({ success: true, key: AccessKey.findById(req.params.id) });
});

// POST /admin/keys/:id/revoke - Revoke a key
router.post('/keys/:id/revoke', requireAdmin, (req, res) => {
  const key = AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  AccessKey.revoke(req.params.id);
  res.json({ success: true });
});

// POST /admin/keys/:id/reactivate - Reactivate a revoked key
router.post('/keys/:id/reactivate', requireAdmin, (req, res) => {
  const key = AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  AccessKey.reactivate(req.params.id);
  res.json({ success: true });
});

// POST /admin/keys/:id/delete - Delete an access key
router.post('/keys/:id/delete', requireAdmin, (req, res) => {
  const key = AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  AccessKey.deleteById(req.params.id);
  res.json({ success: true });
});

// GET /admin/keys/list - List all access keys (JSON for AJAX)
router.get('/keys/list', requireAdmin, (req, res) => {
  const keys = AccessKey.findAll();
  res.json({ keys });
});

/* ---- Per-key per-file permission management ---- */

// GET /admin/keys/:id/files - Get all files with per-key permission info
router.get('/keys/:id/files', requireAdmin, (req, res) => {
  const key = AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });

  const files = File.findAll();
  const perms = AccessKey.getFilePermissionMap(req.params.id);

  const filesWithPerms = files.map(f => ({
    uuid: f.uuid,
    original_name: f.original_name,
    size_bytes: f.size_bytes,
    visibility: f.visibility,
    category: f.category,
    created_at: f.created_at,
    // The effective permission for this key on this file
    keyPermission: perms[f.uuid] || null, // null means no override set
    // The fallback: what the key's global permission would grant
    globalPermission: key.permission
  }));

  res.json({ key, files: filesWithPerms });
});

// POST /admin/keys/:id/file-permission - Set per-file permission for a key
router.post('/keys/:id/file-permission', requireAdmin, (req, res) => {
  const key = AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });

  const { file_uuid, permission } = req.body;
  if (!file_uuid) return res.status(400).json({ error: '缺少 file_uuid' });

  if (permission === 'none') {
    // Remove override
    AccessKey.deleteFilePermission(req.params.id, file_uuid);
  } else if (['preview', 'download', 'both'].includes(permission)) {
    AccessKey.setFilePermission(req.params.id, file_uuid, permission);
  } else {
    return res.status(400).json({ error: '无效的权限设置' });
  }

  res.json({ success: true });
});

// POST /admin/keys/:id/file-permissions/batch - Batch set per-file permissions
router.post('/keys/:id/file-permissions/batch', requireAdmin, (req, res) => {
  const key = AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });

  const { permissions } = req.body; // [{file_uuid, permission}, ...]
  if (!Array.isArray(permissions)) return res.status(400).json({ error: '无效参数' });

  permissions.forEach(p => {
    if (p.permission === 'none') {
      AccessKey.deleteFilePermission(req.params.id, p.file_uuid);
    } else if (['preview', 'download', 'both'].includes(p.permission)) {
      AccessKey.setFilePermission(req.params.id, p.file_uuid, p.permission);
    }
  });

  res.json({ success: true });
});

/* ---- Per-key per-bundle permission management ---- */

// GET /admin/keys/:id/bundles - Get all bundles with per-key permission info
router.get('/keys/:id/bundles', requireAdmin, (req, res) => {
  const key = AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });

  const bundles = Bundle.findAllFlat ? Bundle.findAllFlat() : Bundle.findAll();
  const perms = AccessKey.getBundlePermissionMap(req.params.id);

  const bundlesWithPerms = bundles.map(b => ({
    id: b.id,
    name: b.name,
    visibility: b.visibility,
    parent_id: b.parent_id || null,
    fileCount: (b.files || []).length,
    keyPermission: perms[b.id] || null,
    globalPermission: key.permission
  }));

  res.json({ key, bundles: bundlesWithPerms });
});

// POST /admin/keys/:id/bundle-permission - Set per-bundle permission for a key
router.post('/keys/:id/bundle-permission', requireAdmin, (req, res) => {
  const key = AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });

  const { bundle_id, permission } = req.body;
  if (!bundle_id) return res.status(400).json({ error: '缺少 bundle_id' });

  if (permission === 'inherit') {
    // Remove override → fall back to global
    AccessKey.deleteBundlePermission(req.params.id, bundle_id);
  } else if (['preview', 'download', 'both', 'none'].includes(permission)) {
    AccessKey.setBundlePermission(req.params.id, bundle_id, permission);
  } else {
    return res.status(400).json({ error: '无效的权限设置' });
  }

  res.json({ success: true });
});

// POST /admin/keys/:id/bundle-permissions/batch - Batch set per-bundle permissions
router.post('/keys/:id/bundle-permissions/batch', requireAdmin, (req, res) => {
  const key = AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });

  const { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.status(400).json({ error: '无效参数' });

  permissions.forEach(p => {
    if (p.permission === 'inherit') {
      AccessKey.deleteBundlePermission(req.params.id, p.bundle_id);
    } else if (['preview', 'download', 'both', 'none'].includes(p.permission)) {
      AccessKey.setBundlePermission(req.params.id, p.bundle_id, p.permission);
    }
  });

  res.json({ success: true });
});

// GET /admin/bundles/:id/permissions - Get all keys with their permissions for a specific bundle
router.get('/bundles/:id/permissions', requireAdmin, (req, res) => {
  const bundle = Bundle.findById(req.params.id);
  if (!bundle) return res.status(404).json({ error: '文件包不存在' });

  const allKeys = AccessKey.findAll();
  const keysWithPerms = allKeys.map(k => ({
    id: k.id,
    key: k.key,
    label: k.label,
    globalPermission: k.permission,
    status: k.status,
    bundlePermission: AccessKey.getBundlePermission(k.id, req.params.id)?.permission || null
  }));

  res.json({ bundle: { id: bundle.id, name: bundle.name, visibility: bundle.visibility }, keys: keysWithPerms });
});

// POST /admin/bundles/:id/permission - Set a key's permission on a specific bundle
router.post('/bundles/:id/permission', requireAdmin, (req, res) => {
  const bundle = Bundle.findById(req.params.id);
  if (!bundle) return res.status(404).json({ error: '文件包不存在' });

  const { key_id, permission } = req.body;
  if (!key_id) return res.status(400).json({ error: '缺少 key_id' });

  if (permission === 'inherit') {
    AccessKey.deleteBundlePermission(key_id, req.params.id);
  } else if (['preview', 'download', 'both', 'none'].includes(permission)) {
    AccessKey.setBundlePermission(key_id, req.params.id, permission);
  } else {
    return res.status(400).json({ error: '无效的权限设置' });
  }

  res.json({ success: true });
});

// ============ DATA EXPORT / IMPORT ============

// GET /admin/export — Download all data as JSON (for migration)
router.get('/export', requireAdmin, (req, res) => {
  const db = require('../database');
  const data = {
    access_keys: AccessKey.findAll(),
    files: File.findAll(),
    bundles: Bundle.findAll().map(b => ({
      ...b,
      files: (b.files || []).map(f => f.uuid),
      children: (b.children || []).map(c => ({
        ...c,
        files: (c.files || []).map(f => f.uuid)
      }))
    })),
    key_file_permissions: db.prepare('SELECT * FROM key_file_permissions').all(),
    bundle_key_permissions: db.prepare('SELECT * FROM bundle_key_permissions').all()
  };
  res.attachment('data-export.json');
  res.json(data);
});

// POST /admin/import — Import JSON data
router.post('/import', requireAdmin, (req, res) => {
  const data = req.body;
  if (!data) return res.status(400).json({ error: '无效数据' });

  const db = require('../database');

  try {
    db.transaction(() => {
      // Import access keys
      if (Array.isArray(data.access_keys)) {
        const insertKey = db.prepare(`
          INSERT OR IGNORE INTO access_keys (id, key, label, permission, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        data.access_keys.forEach(k => {
          insertKey.run(k.id, k.key, k.label, k.permission, k.status, k.created_at);
        });
      }

      // Import files (metadata only)
      if (Array.isArray(data.files)) {
        const insertFile = db.prepare(`
          INSERT OR IGNORE INTO files (id, uuid, original_name, stored_name, mime_type, size_bytes, category, visibility, description, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        data.files.forEach(f => {
          insertFile.run(f.id, f.uuid, f.original_name, f.stored_name, f.mime_type, f.size_bytes, f.category, f.visibility, f.description, f.created_at);
        });
      }

      // Import bundles
      if (Array.isArray(data.bundles)) {
        const insertBundle = db.prepare(`
          INSERT OR IGNORE INTO bundles (id, name, description, visibility, parent_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        const insertBundleFile = db.prepare(`
          INSERT OR IGNORE INTO bundle_files (bundle_id, file_uuid, sort_order)
          VALUES (?, ?, ?)
        `);
        data.bundles.forEach(b => {
          insertBundle.run(b.id, b.name, b.description, b.visibility, b.parent_id || null, b.created_at);
          if (Array.isArray(b.files)) {
            b.files.forEach((fileUuid, idx) => {
              // Support both string uuids and {uuid} objects
              const uuid = typeof fileUuid === 'string' ? fileUuid : fileUuid.uuid || fileUuid.file_uuid;
              if (uuid) insertBundleFile.run(b.id, uuid, idx);
            });
          }
          if (Array.isArray(b.children)) {
            b.children.forEach(c => {
              insertBundle.run(c.id, c.name, c.description, c.visibility, c.parent_id, c.created_at);
              if (Array.isArray(c.files)) {
                c.files.forEach((fileUuid, idx) => {
                  const uuid = typeof fileUuid === 'string' ? fileUuid : fileUuid.uuid || fileUuid.file_uuid;
                  if (uuid) insertBundleFile.run(c.id, uuid, idx);
                });
              }
            });
          }
        });
      }

      // Also support raw bundle_files table (from script export)
      if (!Array.isArray(data.bundles) && Array.isArray(data.bundle_files)) {
        const insertBundleFile = db.prepare(`
          INSERT OR IGNORE INTO bundle_files (bundle_id, file_uuid, sort_order)
          VALUES (?, ?, ?)
        `);
        data.bundle_files.forEach(bf => {
          insertBundleFile.run(bf.bundle_id, bf.file_uuid, bf.sort_order || 0);
        });
      }

      // Import key_file_permissions (raw table from script export)
      if (Array.isArray(data.key_file_permissions)) {
        const insertPerm = db.prepare(`
          INSERT OR IGNORE INTO key_file_permissions (key_id, file_uuid, permission)
          VALUES (?, ?, ?)
        `);
        data.key_file_permissions.forEach(p => {
          insertPerm.run(p.key_id, p.file_uuid, p.permission);
        });
      }

      // Import bundle_key_permissions (raw table from script export)
      if (Array.isArray(data.bundle_key_permissions)) {
        const insertBkp = db.prepare(`
          INSERT OR IGNORE INTO bundle_key_permissions (key_id, bundle_id, permission)
          VALUES (?, ?, ?)
        `);
        data.bundle_key_permissions.forEach(p => {
          insertBkp.run(p.key_id, p.bundle_id, p.permission);
        });
      }
    })();

    res.json({ success: true, message: '数据导入成功' });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: '导入失败: ' + err.message });
  }
});

module.exports = router;
