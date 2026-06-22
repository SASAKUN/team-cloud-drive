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
const storage = require('../utils/storage');
const config = require('../config');
const db = require('../database');

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

// ============ ADMIN PANEL ============

router.get('/', requireAdmin, async (req, res) => {
  const fileCount = (await File.findAll()).length;
  const bundleCount = (await Bundle.findAll()).length;
  const keyCount = (await AccessKey.findAll()).length;
  res.render('admin', { title: '管理后台', currentPage: 'overview', fileCount, bundleCount, keyCount });
});

// GET /admin/files
router.get('/files', requireAdmin, async (req, res) => {
  const files = await File.findAll();
  const filesWithMeta = [];
  let r2Checks = 0, r2Found = 0, r2Errors = 0;
  for (const file of files) {
    const key = storage.makeKey(file.uuid, file.original_name);
    const exists = await storage.fileExists(key);
    r2Checks++;
    if (exists) r2Found++;
    if (exists === false && storage.r2Enabled) r2Errors++;
    filesWithMeta.push({
      ...file,
      icon: getFileIcon(file.category, file.original_name),
      sizeFormatted: formatFileSize(file.size_bytes),
      missing: !exists
    });
    if (r2Checks <= 3) {
      console.log('🔍 R2 check:', key, '=>', exists ? 'FOUND' : 'MISSING');
    }
  }
  console.log('📊 R2 results:', r2Found + '/' + r2Checks + ' files found,', r2Errors, 'R2 check failures');
  const invalidCount = filesWithMeta.filter(f => f.missing).length;
  res.render('admin-files', {
    title: '文件管理', currentPage: 'files', files: filesWithMeta,
    invalidCount, success: req.query.success || null, error: null
  });
});

// GET /admin/bundles
router.get('/bundles', requireAdmin, async (req, res) => {
  const bundles = (await Bundle.findAll()).map(b => ({
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
  const allFiles = (await File.findAll()).map(f => ({
    ...f,
    icon: getFileIcon(f.category || getCategory(f.original_name), f.original_name),
    sizeFormatted: formatFileSize(f.size_bytes)
  }));
  res.render('admin-bundles', { title: '文件包管理', currentPage: 'bundles', bundles, files: allFiles });
});

// GET /admin/keys
router.get('/keys', requireAdmin, async (req, res) => {
  const keys = await AccessKey.findAll();
  const files = await File.findAll();
  res.render('admin-keys', { title: '密钥管理', currentPage: 'keys', keys, files });
});

// POST /admin/upload - Multi-file upload
router.post('/upload', requireAdmin, (req, res, next) => {
  upload.array('files', 20)(req, res, async (err) => {
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
      const files = (await File.findAll()).map(f => ({ ...f, icon: getFileIcon(f.category, f.original_name), sizeFormatted: formatFileSize(f.size_bytes) }));
      return res.render('admin-files', { title: '文件管理', currentPage: 'files', files, error: '请选择文件', success: null });
    }

    const visibility = req.body.visibility || 'public';
    let uploaded = [];

    for (let idx = 0; idx < req.files.length; idx++) {
      const file = req.files[idx];
      const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const mimeType = getMimeType(originalName);
      const category = getCategory(originalName);
      const fileUuid = req.fileUuids[idx];

      // Build storage key and upload to R2
      const storageKey = storage.makeKey(fileUuid, originalName);
      await storage.uploadFile(storageKey, file.path, mimeType);

      await File.create({
        uuid: fileUuid,
        originalName,
        storedName: file.filename,
        mimeType,
        sizeBytes: file.size,
        category,
        description: req.body.description || '',
        visibility,
        storageKey
      });

      uploaded.push({ uuid: fileUuid, name: originalName, size: file.size });
    }

    // Clean up temp files created by multer
    if (storage.r2Enabled && req.files) {
      req.files.forEach(f => {
        try { fs.rmSync(f.path, { recursive: true }); } catch (e) { /* ignore */ }
        try {
          const parentDir = path.dirname(f.path);
          if (fs.readdirSync(parentDir).length === 0) fs.rmdirSync(parentDir);
        } catch (e) { /* ignore */ }
      });
    }

    if (req.xhr || req.get('X-Requested-With') === 'XMLHttpRequest') {
      return res.json({ success: true, count: uploaded.length, files: uploaded });
    }
    res.redirect('/admin/files?success=' + encodeURIComponent(`${uploaded.length} 个文件上传成功`));
  });
});

// POST /admin/files/:uuid/visibility
router.post('/files/:uuid/visibility', requireAdmin, async (req, res) => {
  const { visibility } = req.body;
  if (!['public', 'download_only', 'hidden'].includes(visibility)) {
    return res.status(400).json({ error: '无效的可见性设置' });
  }
  await File.setVisibility(req.params.uuid, visibility);
  res.json({ success: true, visibility });
});

// POST /admin/files/batch/visibility
router.post('/files/batch/visibility', requireAdmin, async (req, res) => {
  const { uuids, visibility } = req.body;
  if (!Array.isArray(uuids) || !['public', 'download_only', 'hidden'].includes(visibility)) {
    return res.status(400).json({ error: '无效参数' });
  }
  for (const uuid of uuids) await File.setVisibility(uuid, visibility);
  res.json({ success: true });
});

// POST /admin/files/:uuid/delete
router.post('/files/:uuid/delete', requireAdmin, async (req, res) => {
  const file = await File.findByUuid(req.params.uuid);
  if (!file) return res.status(404).json({ error: '文件不存在' });

  try {
    const key = storage.makeKey(file.uuid, file.original_name);
    await storage.deleteFile(key);
  } catch (e) {
    console.log('⚠️  Storage delete skipped (file may not exist in bucket):', e.message);
  }
  await File.deleteByUuid(file.uuid);
  res.json({ success: true });
});

// POST /admin/files/batch/delete
router.post('/files/batch/delete', requireAdmin, async (req, res) => {
  const { uuids } = req.body;
  if (!Array.isArray(uuids)) return res.status(400).json({ error: '无效参数' });

  for (const uuid of uuids) {
    const file = await File.findByUuid(uuid);
    if (file) {
      try {
        const key = storage.makeKey(file.uuid, file.original_name);
        await storage.deleteFile(key);
      } catch (e) {
        console.log('⚠️  Storage delete skipped:', e.message);
      }
      await File.deleteByUuid(file.uuid);
    }
  }
  res.json({ success: true });
});

// GET /admin/files/invalid
router.get('/files/invalid', requireAdmin, async (req, res) => {
  const files = await File.findAll();
  const invalid = [];
  for (const f of files) {
    const key = storage.makeKey(f.uuid, f.original_name);
    if (!(await storage.fileExists(key))) {
      invalid.push({ uuid: f.uuid, name: f.original_name, size: f.size_bytes });
    }
  }
  res.json({ invalid, count: invalid.length });
});

// POST /admin/files/cleanup-invalid
router.post('/files/cleanup-invalid', requireAdmin, async (req, res) => {
  const files = await File.findAll();
  let deleted = 0;

  for (const f of files) {
    const key = storage.makeKey(f.uuid, f.original_name);
    if (!(await storage.fileExists(key))) {
      await File.deleteByUuid(f.uuid);
      deleted++;
    }
  }

  res.json({ success: true, deleted });
});

// ============ BUNDLE MANAGEMENT ============

router.post('/bundles', requireAdmin, async (req, res) => {
  const { name, description, visibility, parentId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '文件包名称不能为空' });
  const bundle = await Bundle.create({ name: name.trim(), description: description || null, visibility: visibility || 'public', parentId: parentId || null });
  res.json({ success: true, bundle });
});

router.post('/bundles/:id', requireAdmin, async (req, res) => {
  const { name, description, visibility, parentId } = req.body;
  await Bundle.update(req.params.id, { name, description, visibility, parentId });
  res.json({ success: true });
});

router.post('/bundles/:id/delete', requireAdmin, async (req, res) => {
  const bundle = await Bundle.findById(req.params.id);
  if (!bundle) return res.status(404).json({ error: '文件包不存在' });
  await Bundle.deleteById(req.params.id);
  res.json({ success: true });
});

router.post('/bundles/:id/files', requireAdmin, async (req, res) => {
  const { fileUuid } = req.body;
  if (!fileUuid) return res.status(400).json({ error: '请选择文件' });
  const file = await File.findByUuid(fileUuid);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  const added = await Bundle.addFile(req.params.id, fileUuid, 0);
  if (!added) return res.status(409).json({ error: '该文件已在文件包中' });
  res.json({ success: true });
});

router.post('/bundles/:id/files/remove', requireAdmin, async (req, res) => {
  const { fileUuid } = req.body;
  await Bundle.removeFile(req.params.id, fileUuid);
  res.json({ success: true });
});

router.get('/bundles/:id', requireAdmin, async (req, res) => {
  const bundle = await Bundle.findById(req.params.id);
  if (!bundle) return res.status(404).json({ error: '文件包不存在' });
  res.json({ bundle });
});

// ============ ACCESS KEY MANAGEMENT ============

router.post('/keys', requireAdmin, async (req, res) => {
  const { label, permission } = req.body;
  if (!['preview', 'download', 'both'].includes(permission)) {
    return res.status(400).json({ error: '无效的权限设置' });
  }
  const accessKey = await AccessKey.create({ label: label || null, permission });
  res.json({ success: true, key: accessKey });
});

router.post('/keys/:id', requireAdmin, async (req, res) => {
  const key = await AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  const { permission } = req.body;
  if (permission && ['preview', 'download', 'both'].includes(permission)) {
    await AccessKey.updatePermission(req.params.id, permission);
  }
  res.json({ success: true, key: await AccessKey.findById(req.params.id) });
});

router.post('/keys/:id/revoke', requireAdmin, async (req, res) => {
  const key = await AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  await AccessKey.revoke(req.params.id);
  res.json({ success: true });
});

router.post('/keys/:id/reactivate', requireAdmin, async (req, res) => {
  const key = await AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  await AccessKey.reactivate(req.params.id);
  res.json({ success: true });
});

router.post('/keys/:id/delete', requireAdmin, async (req, res) => {
  const key = await AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  await AccessKey.deleteById(req.params.id);
  res.json({ success: true });
});

router.get('/keys/list', requireAdmin, async (req, res) => {
  const keys = await AccessKey.findAll();
  res.json({ keys });
});

/* ---- Per-key per-file permission management ---- */

router.get('/keys/:id/files', requireAdmin, async (req, res) => {
  const key = await AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });

  const files = await File.findAll();
  const perms = await AccessKey.getFilePermissionMap(req.params.id);

  const filesWithPerms = files.map(f => ({
    uuid: f.uuid, original_name: f.original_name, size_bytes: f.size_bytes,
    visibility: f.visibility, category: f.category, created_at: f.created_at,
    keyPermission: perms[f.uuid] || null,
    globalPermission: key.permission
  }));

  res.json({ key, files: filesWithPerms });
});

router.post('/keys/:id/file-permission', requireAdmin, async (req, res) => {
  const key = await AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });

  const { file_uuid, permission } = req.body;
  if (!file_uuid) return res.status(400).json({ error: '缺少 file_uuid' });

  if (permission === 'none') {
    await AccessKey.deleteFilePermission(req.params.id, file_uuid);
  } else if (['preview', 'download', 'both'].includes(permission)) {
    await AccessKey.setFilePermission(req.params.id, file_uuid, permission);
  } else {
    return res.status(400).json({ error: '无效的权限设置' });
  }
  res.json({ success: true });
});

router.post('/keys/:id/file-permissions/batch', requireAdmin, async (req, res) => {
  const key = await AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });

  const { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.status(400).json({ error: '无效参数' });

  for (const p of permissions) {
    if (p.permission === 'none') {
      await AccessKey.deleteFilePermission(req.params.id, p.file_uuid);
    } else if (['preview', 'download', 'both'].includes(p.permission)) {
      await AccessKey.setFilePermission(req.params.id, p.file_uuid, p.permission);
    }
  }
  res.json({ success: true });
});

/* ---- Per-key per-bundle permission management ---- */

router.get('/keys/:id/bundles', requireAdmin, async (req, res) => {
  const key = await AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });

  const bundlesRaw = Bundle.findAllFlat ? await Bundle.findAllFlat() : await Bundle.findAll();
  const perms = await AccessKey.getBundlePermissionMap(req.params.id);

  const bundlesWithPerms = bundlesRaw.map(b => ({
    id: b.id, name: b.name, visibility: b.visibility,
    parent_id: b.parent_id || null,
    fileCount: (b.files || []).length,
    keyPermission: perms[b.id] || null,
    globalPermission: key.permission
  }));

  res.json({ key, bundles: bundlesWithPerms });
});

router.post('/keys/:id/bundle-permission', requireAdmin, async (req, res) => {
  const key = await AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });

  const { bundle_id, permission } = req.body;
  if (!bundle_id) return res.status(400).json({ error: '缺少 bundle_id' });

  if (permission === 'inherit') {
    await AccessKey.deleteBundlePermission(req.params.id, bundle_id);
  } else if (['preview', 'download', 'both', 'none'].includes(permission)) {
    await AccessKey.setBundlePermission(req.params.id, bundle_id, permission);
  } else {
    return res.status(400).json({ error: '无效的权限设置' });
  }
  res.json({ success: true });
});

router.post('/keys/:id/bundle-permissions/batch', requireAdmin, async (req, res) => {
  const key = await AccessKey.findById(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });

  const { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.status(400).json({ error: '无效参数' });

  for (const p of permissions) {
    if (p.permission === 'inherit') {
      await AccessKey.deleteBundlePermission(req.params.id, p.bundle_id);
    } else if (['preview', 'download', 'both', 'none'].includes(p.permission)) {
      await AccessKey.setBundlePermission(req.params.id, p.bundle_id, p.permission);
    }
  }
  res.json({ success: true });
});

router.get('/bundles/:id/permissions', requireAdmin, async (req, res) => {
  const bundle = await Bundle.findById(req.params.id);
  if (!bundle) return res.status(404).json({ error: '文件包不存在' });

  const allKeys = await AccessKey.findAll();
  const keysWithPerms = [];
  for (const k of allKeys) {
    const bp = await AccessKey.getBundlePermission(k.id, req.params.id);
    keysWithPerms.push({
      id: k.id, key: k.key, label: k.label,
      globalPermission: k.permission, status: k.status,
      bundlePermission: bp ? bp.permission : null
    });
  }

  res.json({ bundle: { id: bundle.id, name: bundle.name, visibility: bundle.visibility }, keys: keysWithPerms });
});

router.post('/bundles/:id/permission', requireAdmin, async (req, res) => {
  const bundle = await Bundle.findById(req.params.id);
  if (!bundle) return res.status(404).json({ error: '文件包不存在' });

  const { key_id, permission } = req.body;
  if (!key_id) return res.status(400).json({ error: '缺少 key_id' });

  if (permission === 'inherit') {
    await AccessKey.deleteBundlePermission(key_id, req.params.id);
  } else if (['preview', 'download', 'both', 'none'].includes(permission)) {
    await AccessKey.setBundlePermission(key_id, req.params.id, permission);
  } else {
    return res.status(400).json({ error: '无效的权限设置' });
  }
  res.json({ success: true });
});

// ============ DATA EXPORT / IMPORT ============

router.get('/export', requireAdmin, async (req, res) => {
  const data = {
    access_keys: await AccessKey.findAll(),
    files: await File.findAll(),
    bundles: (await Bundle.findAll()).map(b => ({
      ...b,
      files: (b.files || []).map(f => f.uuid),
      children: (b.children || []).map(c => ({
        ...c,
        files: (c.files || []).map(f => f.uuid)
      }))
    })),
    key_file_permissions: await db.prepare('SELECT * FROM key_file_permissions').all(),
    bundle_key_permissions: await db.prepare('SELECT * FROM bundle_key_permissions').all()
  };
  res.attachment('data-export.json');
  res.json(data);
});

router.post('/import', requireAdmin, async (req, res) => {
  const data = req.body;
  if (!data) return res.status(400).json({ error: '无效数据' });

  try {

    await db.transaction(async (tx) => {
      if (Array.isArray(data.access_keys)) {
        const insertKey = tx.prepare(
          'INSERT INTO access_keys (id, key, label, permission, status, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING'
        );
        for (const k of data.access_keys) {
          await insertKey.run(k.id, k.key, k.label, k.permission, k.status, k.created_at);
        }
      }

      if (Array.isArray(data.files)) {
        const insertFile = tx.prepare(
          'INSERT INTO files (id, uuid, original_name, stored_name, mime_type, size_bytes, category, visibility, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING'
        );
        for (const f of data.files) {
          await insertFile.run(f.id, f.uuid, f.original_name, f.stored_name, f.mime_type, f.size_bytes, f.category, f.visibility, f.description, f.created_at);
        }
      }

      if (Array.isArray(data.bundles)) {
        const insertBundle = tx.prepare(
          'INSERT INTO bundles (id, name, description, visibility, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING'
        );
        const insertBundleFile = tx.prepare(
          'INSERT INTO bundle_files (bundle_id, file_uuid, sort_order) VALUES (?, ?, ?) ON CONFLICT (bundle_id, file_uuid) DO NOTHING'
        );
        for (const b of data.bundles) {
          await insertBundle.run(b.id, b.name, b.description, b.visibility, b.parent_id || null, b.created_at);
          if (Array.isArray(b.files)) {
            for (let idx = 0; idx < b.files.length; idx++) {
              const fu = b.files[idx];
              const uuid = typeof fu === 'string' ? fu : fu.uuid || fu.file_uuid;
              if (uuid) await insertBundleFile.run(b.id, uuid, idx);
            }
          }
          if (Array.isArray(b.children)) {
            for (const c of b.children) {
              await insertBundle.run(c.id, c.name, c.description, c.visibility, c.parent_id, c.created_at);
              if (Array.isArray(c.files)) {
                for (let idx = 0; idx < c.files.length; idx++) {
                  const fu = c.files[idx];
                  const uuid = typeof fu === 'string' ? fu : fu.uuid || fu.file_uuid;
                  if (uuid) await insertBundleFile.run(c.id, uuid, idx);
                }
              }
            }
          }
        }
      }

      if (!Array.isArray(data.bundles) && Array.isArray(data.bundle_files)) {
        const insertBundleFile = tx.prepare(
          'INSERT INTO bundle_files (bundle_id, file_uuid, sort_order) VALUES (?, ?, ?) ON CONFLICT (bundle_id, file_uuid) DO NOTHING'
        );
        for (const bf of data.bundle_files) {
          await insertBundleFile.run(bf.bundle_id, bf.file_uuid, bf.sort_order || 0);
        }
      }

      if (Array.isArray(data.key_file_permissions)) {
        const insertPerm = tx.prepare(
          'INSERT INTO key_file_permissions (key_id, file_uuid, permission) VALUES (?, ?, ?) ON CONFLICT (key_id, file_uuid) DO NOTHING'
        );
        for (const p of data.key_file_permissions) {
          await insertPerm.run(p.key_id, p.file_uuid, p.permission);
        }
      }

      if (Array.isArray(data.bundle_key_permissions)) {
        const insertBkp = tx.prepare(
          'INSERT INTO bundle_key_permissions (key_id, bundle_id, permission) VALUES (?, ?, ?) ON CONFLICT (key_id, bundle_id) DO NOTHING'
        );
        for (const p of data.bundle_key_permissions) {
          await insertBkp.run(p.key_id, p.bundle_id, p.permission);
        }
      }
    });

    res.json({ success: true, message: '数据导入成功' });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: '导入失败: ' + err.message });
  }
});

module.exports = router;
