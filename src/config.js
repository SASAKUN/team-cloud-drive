require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  sessionSecret: process.env.SESSION_SECRET || 'change-me',
  uploadDir: process.env.UPLOAD_DIR || './data/uploads',
  databasePath: process.env.DATABASE_PATH || './data/database.sqlite',
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  get maxFileSizeBytes() {
    return this.maxFileSizeMB * 1024 * 1024;
  }
};
