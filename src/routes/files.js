const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const File = require('../models/File');
const Bundle = require('../models/Bundle');
const { getMimeType, getCategory, getFileIcon, formatFileSize, isPreviewable } = require('../utils/mime');
const { resolveAccessKey, canDownload, canDownloadFile, canPreview, canAccessBundle, canDownloadFromBundle, getEffectiveFilePerm } = require('../middleware/accessKey');
const AccessKey = require('../models/AccessKey');
const config = require('../config');

// Apply access key middleware to all public routes
router.use(resolveAccessKey);

// ============ KEY ENTRY PAGE ============

// GET /key-entry — Key entry form
router.get('/key-entry', (req, res) => {
  const redirect = req.query.redirect || '/';
  const key = req.query.key || '';
  const error = req.query.error || '';
  res.render('key-entry', {
    title: '输入访问密钥',
    key,
    redirect,
    error
  });
});

// POST /key-entry — Submit key, store in session, redirect
router.post('/key-entry', (req, res) => {
  const { key, redirect } = req.body;
  if (!key || !key.trim()) {
    const backUrl = redirect ? `/key-entry?redirect=${encodeURIComponent(redirect)}&error=${encodeURIComponent('请输入访问密钥')}` : '/key-entry?error=' + encodeURIComponent('请输入访问密钥');
    return res.redirect(backUrl);
  }

  const found = AccessKey.findByKey(key.trim());
  if (!found) {
    const backUrl = redirect ? `/key-entry?redirect=${encodeURIComponent(redirect)}&error=${encodeURIComponent('密钥无效，请检查后重试')}` : '/key-entry?error=' + encodeURIComponent('密钥无效，请检查后重试');
    return res.redirect(backUrl);
  }

  // Store in session
  req.session.accessKey = found.key;
  req.session.accessPermission = found.permission;
  req.session.accessKeyId = found.id;

  // Redirect to the original page
  res.redirect(redirect || '/');
});

// GET/POST /key-clear — Clear key from session
router.all('/key-clear', (req, res) => {
  delete req.session.accessKey;
  delete req.session.accessPermission;
  delete req.session.accessKeyId;
  res.redirect('/');
});

// ============ PUBLIC ROUTES (no login) ============

// GET / - Public file listing (with bundles)
router.get('/', (req, res) => {
  const { category, search } = req.query;
  let files;

  if (search) {
    files = File.searchPublic(search);
  } else if (category && category !== 'all') {
    files = File.findAllPublicByCategory(category);
  } else {
    files = File.findAllPublic();
  }

  // If user has access key, also fetch hidden files
  let hiddenFiles = [];
  if (canPreview(req)) {
    const allFiles = File.findAll();
    const publicUuids = new Set(files.map(f => f.uuid));
    hiddenFiles = allFiles.filter(f => !publicUuids.has(f.uuid));
  }

  const filesWithMeta = files.map(file => ({
    ...file,
    icon: getFileIcon(file.category, file.original_name),
    sizeFormatted: formatFileSize(file.size_bytes),
    canDownload: file.visibility === 'public' || (file.visibility === 'download_only' && canDownload(req)) || canDownloadFile(req, file.uuid)
  }));

  const hiddenWithMeta = hiddenFiles.map(file => ({
    ...file,
    icon: getFileIcon(file.category, file.original_name),
    sizeFormatted: formatFileSize(file.size_bytes),
    canDownload: file.visibility === 'public' || canDownloadFile(req, file.uuid),
    isHidden: true
  }));

  // Helper: add metadata to a bundle and its children files
  function addBundleMeta(b) {
    // Check if this key has bundle-level permission (file > bundle > global)
    const bundleFileDownloadCheck = (f) => {
      const effPerm = getEffectiveFilePerm(req, b.id, f.uuid);
      if (effPerm === 'none') return false;
      return f.visibility === 'public' || (f.visibility === 'download_only' && effPerm !== 'preview') || effPerm === 'download' || effPerm === 'both' || (f.visibility === 'download_only' && canDownload(req)) || canDownloadFile(req, f.uuid);
    };
    return {
      ...b,
      files: b.files.map(f => ({
        ...f,
        icon: getFileIcon(f.category, f.original_name),
        sizeFormatted: formatFileSize(f.size_bytes),
        canDownload: bundleFileDownloadCheck(f)
      })),
      children: (b.children || []).map(c => ({
        ...c,
        files: c.files.map(f => ({
          ...f,
          icon: getFileIcon(f.category, f.original_name),
          sizeFormatted: formatFileSize(f.size_bytes),
          canDownload: (() => {
            const effPerm = getEffectiveFilePerm(req, c.id, f.uuid);
            if (effPerm === 'none') return false;
            return f.visibility === 'public' || (f.visibility === 'download_only' && effPerm !== 'preview') || effPerm === 'download' || effPerm === 'both' || (f.visibility === 'download_only' && canDownload(req)) || canDownloadFile(req, f.uuid);
          })()
        }))
      }))
    };
  }

  // Fetch public bundles
  let bundles = [];
  if (!search) {
    bundles = Bundle.findAllPublic()
      .filter(b => canAccessBundle(req, b.id))
      .map(b => addBundleMeta(b));
  }

  // If user has access key, also include hidden bundles
  if (canPreview(req)) {
    const allBundles = Bundle.findAll();
    const publicBundleIds = new Set(bundles.map(b => b.id));
    const hiddenBundles = allBundles
      .filter(b => !publicBundleIds.has(b.id) && canAccessBundle(req, b.id))
      .map(b => ({ ...addBundleMeta(b), isHidden: true }));
    bundles = bundles.concat(hiddenBundles);
  }

  // Recent files for announcement bar (last 5)
  const recentFiles = File.findAllPublic()
    .slice(0, 5)
    .map(f => ({
      uuid: f.uuid,
      original_name: f.original_name,
      created_at: f.created_at
    }));

  res.render('dashboard', {
    title: '文件列表',
    files: filesWithMeta,
    hiddenFiles: hiddenWithMeta,
    bundles,
    recentFiles,
    currentCategory: category || 'all',
    currentSearch: search || '',
    accessKey: req.accessKey || null
  });
});

// GET /files/:uuid - Public file detail
router.get('/files/:uuid', (req, res) => {
  const file = File.findByUuid(req.params.uuid);
  if (!file) {
    return res.status(404).render('error', { title: '文件未找到', message: '该文件不存在' });
  }
  if (file.visibility === 'hidden' && !canPreview(req)) {
    return res.status(404).render('error', { title: '文件未找到', message: '该文件不存在或已被隐藏' });
  }

  const canDownloadFileItem = file.visibility === 'public' || canDownload(req) || canDownloadFile(req, file.uuid);
  const previewable = isPreviewable(file.mime_type, file.category);

  res.render('file-detail', {
    title: file.original_name,
    file: {
      ...file,
      icon: getFileIcon(file.category, file.original_name),
      sizeFormatted: formatFileSize(file.size_bytes),
      previewable
    },
    canDownload: canDownloadFileItem
  });
});

// GET /files/:uuid/download - Single file download
router.get('/files/:uuid/download', (req, res) => {
  const file = File.findByUuid(req.params.uuid);
  if (!file || (file.visibility === 'hidden' && !canPreview(req))) {
    return res.status(404).render('error', { title: '文件未找到', message: '该文件不存在' });
  }

  // Check download permission: public files always downloadable, download_only needs key
  const canDl = file.visibility === 'public' || canDownload(req) || canDownloadFile(req, file.uuid);
  if (!canDl) {
    return res.status(403).render('error', { title: '权限不足', message: '此文件仅支持在线预览，不支持下载。使用下载密钥可解锁下载权限。' });
  }

  const filePath = path.join(config.uploadDir, file.uuid, file.original_name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).render('error', { title: '文件未找到', message: '文件在磁盘上不存在' });
  }

  res.download(filePath, file.original_name);
});

// GET /batch/download - Batch download as ZIP
router.get('/batch/download', (req, res) => {
  const uuids = req.query.uuids;
  if (!uuids) return res.status(400).send('No files selected');

  const uuidList = uuids.split(',');
  const files = uuidList
    .map(uuid => File.findByUuid(uuid))
    .filter(f => {
      if (!f) return false;
      if (f.visibility === 'public') return true;
      if (f.visibility === 'download_only') return canDownload(req) || canDownloadFile(req, f.uuid);
      if (f.visibility === 'hidden') return canDownload(req) || canDownloadFile(req, f.uuid);
      return false;
    });

  if (files.length === 0) {
    return res.status(404).render('error', { title: '下载失败', message: '没有可下载的文件' });
  }

  const archive = archiver('zip', { zlib: { level: 5 } });
  res.attachment('documents.zip');

  archive.on('error', (err) => { res.status(500).send({ error: err.message }); });
  archive.pipe(res);

  files.forEach(file => {
    const filePath = path.join(config.uploadDir, file.uuid, file.original_name);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: file.original_name });
    }
  });

  archive.finalize();
});

// GET /bundles/:id/download - Download entire bundle as ZIP (including child bundles)
router.get('/bundles/:id/download', (req, res) => {
  const bundle = Bundle.findById(req.params.id);
  if (!bundle) {
    return res.status(404).render('error', { title: '文件包不存在', message: '该文件包不存在或已被删除' });
  }
  if (bundle.visibility === 'hidden' && !canPreview(req)) {
    return res.status(404).render('error', { title: '文件包不存在', message: '该文件包不存在或已被隐藏' });
  }
  // Enforce bundle-level permissions (file > bundle > global)
  if (req.accessKey && !canAccessBundle(req, bundle.id)) {
    return res.status(403).render('error', { title: '权限不足', message: '您的密钥无权访问此文件包。' });
  }
  // Check download permission: bundle override or global
  if (bundle.visibility === 'download_only' && !canDownloadFromBundle(req, bundle.id) && !canDownload(req)) {
    return res.status(403).render('error', { title: '权限不足', message: '此文件包仅支持预览。使用下载密钥可解锁下载权限。' });
  }

  // Collect all files from this bundle and its children
  const allBundleIds = Bundle.getAllDescendantIds(req.params.id);
  let allFiles = [];
  allBundleIds.forEach(bid => {
    const b = Bundle.findById(bid);
    if (b && b.files) allFiles = allFiles.concat(b.files);
  });

  const downloadable = allFiles.filter(f => {
    // Check effective permission for this file in this bundle context
    const effPerm = getEffectiveFilePerm(req, bundle.id, f.uuid);
    if (effPerm === 'none') return false;
    if (f.visibility === 'public') return true;
    if (effPerm === 'download' || effPerm === 'both') return true;
    if (f.visibility === 'download_only') return canDownload(req) || canDownloadFile(req, f.uuid);
    if (f.visibility === 'hidden') return canDownload(req) || canDownloadFile(req, f.uuid);
    return false;
  });

  if (downloadable.length === 0) {
    return res.status(404).render('error', { title: '下载失败', message: '文件包中没有可下载的文件' });
  }

  const safeName = bundle.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
  const archive = archiver('zip', { zlib: { level: 5 } });
  res.attachment(safeName + '.zip');

  archive.on('error', (err) => { res.status(500).send({ error: err.message }); });
  archive.pipe(res);

  downloadable.forEach(file => {
    const filePath = path.join(config.uploadDir, file.uuid, file.original_name);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: file.original_name });
    }
  });

  archive.finalize();
});

// GET /files/:uuid/raw - Raw file for preview
router.get('/files/:uuid/raw', (req, res) => {
  const file = File.findByUuid(req.params.uuid);
  if (!file || (file.visibility === 'hidden' && !canPreview(req))) return res.status(404).send('Not found');

  const filePath = path.join(config.uploadDir, file.uuid, file.original_name);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  res.sendFile(filePath);
});

module.exports = router;
