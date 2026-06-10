const express = require('express');
const router = express.Router();
const path = require('path');
const archiver = require('archiver');
const File = require('../models/File');
const Bundle = require('../models/Bundle');
const { getMimeType, getCategory, getFileIcon, formatFileSize, isPreviewable } = require('../utils/mime');
const { resolveAccessKey, canDownload, canDownloadFile, canPreview, canAccessBundle, canDownloadFromBundle, getEffectiveFilePerm, canDownloadFileWithBundleContext } = require('../middleware/accessKey');
const AccessKey = require('../models/AccessKey');
const storage = require('../utils/storage');

// Apply access key middleware to all public routes
router.use(resolveAccessKey);

// ============ KEY ENTRY PAGE ============

router.get('/key-entry', (req, res) => {
  const redirect = req.query.redirect || '/';
  const key = req.query.key || '';
  const error = req.query.error || '';
  res.render('key-entry', { title: '输入访问密钥', key, redirect, error });
});

router.post('/key-entry', async (req, res) => {
  const { key, redirect } = req.body;
  if (!key || !key.trim()) {
    const backUrl = redirect ? `/key-entry?redirect=${encodeURIComponent(redirect)}&error=${encodeURIComponent('请输入访问密钥')}` : '/key-entry?error=' + encodeURIComponent('请输入访问密钥');
    return res.redirect(backUrl);
  }

  const found = await AccessKey.findByKey(key.trim());
  if (!found) {
    const backUrl = redirect ? `/key-entry?redirect=${encodeURIComponent(redirect)}&error=${encodeURIComponent('密钥无效，请检查后重试')}` : '/key-entry?error=' + encodeURIComponent('密钥无效，请检查后重试');
    return res.redirect(backUrl);
  }

  req.session.accessKey = found.key;
  req.session.accessPermission = found.permission;
  req.session.accessKeyId = found.id;

  res.redirect(redirect || '/');
});

// GET/POST /key-clear
router.all('/key-clear', (req, res) => {
  delete req.session.accessKey;
  delete req.session.accessPermission;
  delete req.session.accessKeyId;
  res.redirect('/');
});

// ============ PUBLIC ROUTES ============

router.get('/', async (req, res) => {
  const { category, search } = req.query;
  let files;

  if (search) {
    files = await File.searchPublic(search);
  } else if (category && category !== 'all') {
    files = await File.findAllPublicByCategory(category);
  } else {
    files = await File.findAllPublic();
  }

  // If user has access key, also fetch hidden files
  let hiddenFiles = [];
  if (canPreview(req)) {
    const allFiles = await File.findAll();
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

  function addBundleMeta(b) {
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

  let bundles = [];
  if (!search) {
    bundles = (await Bundle.findAllPublic())
      .filter(b => canAccessBundle(req, b.id))
      .map(b => addBundleMeta(b));
  }

  if (canPreview(req)) {
    const allBundles = await Bundle.findAll();
    const publicBundleIds = new Set(bundles.map(b => b.id));
    const hiddenBundles = allBundles
      .filter(b => !publicBundleIds.has(b.id) && canAccessBundle(req, b.id))
      .map(b => ({ ...addBundleMeta(b), isHidden: true }));
    bundles = bundles.concat(hiddenBundles);
  }

  const recentFiles = (await File.findAllPublic()).slice(0, 5).map(f => ({
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

// GET /files/:uuid
router.get('/files/:uuid', async (req, res) => {
  const file = await File.findByUuid(req.params.uuid);
  if (!file) {
    return res.status(404).render('error', { title: '文件未找到', message: '该文件不存在' });
  }
  if (file.visibility === 'hidden' && !canPreview(req)) {
    return res.status(404).render('error', { title: '文件未找到', message: '该文件不存在或已被隐藏' });
  }

  const canDownloadFileItem = await canDownloadFileWithBundleContext(req, file.uuid, file.visibility);
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

// GET /files/:uuid/download
router.get('/files/:uuid/download', async (req, res) => {
  const file = await File.findByUuid(req.params.uuid);
  if (!file || (file.visibility === 'hidden' && !canPreview(req))) {
    return res.status(404).render('error', { title: '文件未找到', message: '该文件不存在' });
  }

  const canDl = await canDownloadFileWithBundleContext(req, file.uuid, file.visibility);
  if (!canDl) {
    return res.status(403).render('error', { title: '权限不足', message: '此文件仅支持在线预览，不支持下载。使用下载密钥可解锁下载权限。' });
  }

  const key = storage.makeKey(file.uuid, file.original_name);
  const exists = await storage.fileExists(key);
  if (!exists) {
    return res.status(404).render('error', { title: '文件未找到', message: '文件在存储中不存在' });
  }

  return storage.streamFile(key, res, {
    filename: file.original_name,
    contentType: file.mime_type,
    inline: false
  });
});

// GET /batch/download - Batch download as ZIP
router.get('/batch/download', async (req, res) => {
  const uuids = req.query.uuids;
  if (!uuids) return res.status(400).send('No files selected');

  const uuidList = uuids.split(',');
  const files = [];
  for (const uuid of uuidList) {
    const f = await File.findByUuid(uuid);
    if (!f) continue;
    if (f.visibility === 'public' ||
        (f.visibility === 'download_only' && canDownload(req)) ||
        canDownloadFile(req, f.uuid)) {
      files.push(f);
    }
  }

  if (files.length === 0) {
    return res.status(404).render('error', { title: '下载失败', message: '没有可下载的文件' });
  }

  // For R2: add files to archive by downloading first
  const archive = archiver('zip', { zlib: { level: 5 } });
  res.attachment('documents.zip');

  archive.on('error', (err) => { res.status(500).send({ error: err.message }); });
  archive.pipe(res);

  for (const file of files) {
    const key = storage.makeKey(file.uuid, file.original_name);
    try {
      const streamData = await storage.getReadStream(key);
      if (streamData) {
        archive.append(streamData.stream, { name: file.original_name });
      }
    } catch (e) {
      // skip missing files
    }
  }

  archive.finalize();
});

// GET /bundles/:id/download
router.get('/bundles/:id/download', async (req, res) => {
  const bundle = await Bundle.findById(req.params.id);
  if (!bundle) {
    return res.status(404).render('error', { title: '文件包不存在', message: '该文件包不存在或已被删除' });
  }
  if (bundle.visibility === 'hidden' && !canPreview(req)) {
    return res.status(404).render('error', { title: '文件包不存在', message: '该文件包不存在或已被隐藏' });
  }
  if (req.accessKey && !canAccessBundle(req, bundle.id)) {
    return res.status(403).render('error', { title: '权限不足', message: '您的密钥无权访问此文件包。' });
  }
  if (bundle.visibility === 'download_only' && !canDownloadFromBundle(req, bundle.id) && !canDownload(req)) {
    return res.status(403).render('error', { title: '权限不足', message: '此文件包仅支持预览。使用下载密钥可解锁下载权限。' });
  }

  const allBundleIds = await Bundle.getAllDescendantIds(req.params.id);
  let allFiles = [];
  for (const bid of allBundleIds) {
    const b = await Bundle.findById(bid);
    if (b && b.files) allFiles = allFiles.concat(b.files);
  }

  const downloadable = allFiles.filter(f => {
    const effPerm = getEffectiveFilePerm(req, bundle.id, f.uuid);
    if (effPerm === 'none') return false;
    if (f.visibility === 'public') return true;
    if (effPerm === 'download' || effPerm === 'both') return true;
    if (f.visibility === 'download_only') return canDownload(req) || canDownloadFile(req, f.uuid);
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

  for (const file of downloadable) {
    const key = storage.makeKey(file.uuid, file.original_name);
    try {
      const streamData = await storage.getReadStream(key);
      if (streamData) {
        archive.append(streamData.stream, { name: file.original_name });
      }
    } catch (e) {
      // skip missing files
    }
  }

  archive.finalize();
});

// GET /files/:uuid/raw - Raw file for preview
router.get('/files/:uuid/raw', async (req, res) => {
  const file = await File.findByUuid(req.params.uuid);
  if (!file || (file.visibility === 'hidden' && !canPreview(req))) return res.status(404).send('Not found');

  const key = storage.makeKey(file.uuid, file.original_name);
  const exists = await storage.fileExists(key);
  if (!exists) return res.status(404).send('Not found');

  return storage.streamFile(key, res, {
    filename: file.original_name,
    contentType: file.mime_type,
    inline: true
  });
});

module.exports = router;
