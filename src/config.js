require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  sessionSecret: process.env.SESSION_SECRET || 'change-me',
  uploadDir: process.env.UPLOAD_DIR || './data/uploads',
  databasePath: process.env.DATABASE_PATH || './data/database.sqlite',
  databaseUrl: process.env.DATABASE_URL || null,
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  // ===== Tencent Cloud COS (S3-compatible, permanent storage) =====
  cosSecretId: process.env.COS_SECRET_ID || null,
  cosSecretKey: process.env.COS_SECRET_KEY || null,
  cosBucket: process.env.COS_BUCKET || null,
  cosRegion: process.env.COS_REGION || 'ap-guangzhou',
  // Endpoint auto-derived from region: https://cos.<region>.myqcloud.com

  get maxFileSizeBytes() {
    return this.maxFileSizeMB * 1024 * 1024;
  },
};
