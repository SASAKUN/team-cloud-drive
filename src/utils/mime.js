const mime = require('mime-types');
const path = require('path');

// Map file extensions to categories
const CATEGORY_MAP = {
  document: ['.doc', '.docx', '.pages', '.pdf', '.txt', '.md', '.rtf', '.odt'],
  spreadsheet: ['.xls', '.xlsx', '.numbers', '.csv'],
  presentation: ['.ppt', '.pptx', '.key', '.odp']
};

// Extended MIME types for iWork formats (not in standard mime-types)
const IWORK_MIMES = {
  '.pages': 'application/x-iwork-pages-sffpages',
  '.numbers': 'application/x-iwork-numbers-sffnumbers',
  '.key': 'application/x-iwork-keynote-sffkey'
};

function getCategory(filename) {
  const ext = path.extname(filename).toLowerCase();
  for (const [category, extensions] of Object.entries(CATEGORY_MAP)) {
    if (extensions.includes(ext)) return category;
  }
  return 'other';
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (IWORK_MIMES[ext]) return IWORK_MIMES[ext];
  return mime.lookup(filename) || 'application/octet-stream';
}

function getFileIcon(category, filename) {
  const ext = path.extname(filename).toLowerCase();
  const icons = {
    document: '📄',
    spreadsheet: '📊',
    presentation: '📽️',
    other: '📎'
  };

  // Specific icons for common types
  if (ext === '.pdf') return '📕';
  if (ext === '.pages') return '📝';
  if (ext === '.numbers') return '🧮';
  if (ext === '.key') return '🎬';

  return icons[category] || '📎';
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function isPreviewable(mimeType, category) {
  const previewable = [
    'application/pdf',
    'text/plain',
    'text/csv',
    'text/markdown'
  ];
  if (previewable.includes(mimeType)) return true;
  if (mimeType.startsWith('image/')) return true;
  if (mimeType.startsWith('text/')) return true;
  return false;
}

module.exports = {
  getCategory,
  getMimeType,
  getFileIcon,
  formatFileSize,
  isPreviewable
};
