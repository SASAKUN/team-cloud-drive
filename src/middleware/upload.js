const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

if (!fs.existsSync(config.uploadDir)) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const fileUuid = uuidv4();
    const uploadPath = path.join(config.uploadDir, fileUuid);
    fs.mkdirSync(uploadPath, { recursive: true });
    if (!req.fileUuids) req.fileUuids = [];
    req.fileUuids.push(fileUuid);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, originalName);
  }
});

const ALLOWED_EXTENSIONS = [
  '.doc', '.docx', '.pages',
  '.xls', '.xlsx', '.numbers',
  '.ppt', '.pptx', '.key',
  '.pdf', '.txt', '.csv', '.md',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg',
  '.zip', '.mp4', '.mov', '.avi', '.mkv'
];

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${ext}`));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxFileSizeBytes }
});

// Error handler middleware for multer file size errors
function handleUploadError(err, req, res, next) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    const maxMB = config.maxFileSizeMB;
    if (req.accepts('html')) {
      const File = require('../models/File');
      const { getFileIcon, formatFileSize } = require('../utils/mime');
      const files = File.findAll().map(f => ({ ...f, icon: getFileIcon(f.category, f.original_name), sizeFormatted: formatFileSize(f.size_bytes) }));
      return res.status(413).render('admin', {
        title: '管理后台',
        files,
        error: `文件大小超过限制（最大 ${maxMB}MB）。请压缩文件后重新上传。`,
        success: null
      });
    }
    return res.status(413).json({ error: `文件大小超过限制（最大 ${maxMB}MB）` });
  }
  if (err.message && err.message.startsWith('Unsupported file type')) {
    if (req.accepts('html')) {
      const File = require('../models/File');
      const { getFileIcon, formatFileSize } = require('../utils/mime');
      const files = File.findAll().map(f => ({ ...f, icon: getFileIcon(f.category, f.original_name), sizeFormatted: formatFileSize(f.size_bytes) }));
      return res.render('admin', {
        title: '管理后台',
        files,
        error: err.message,
        success: null
      });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
}

module.exports = upload;
module.exports.handleUploadError = handleUploadError;
