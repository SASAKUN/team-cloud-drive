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

  // R2 / S3-compatible object storage
  r2AccountId: process.env.R2_ACCOUNT_ID || null,
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || null,
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || null,
  r2BucketName: process.env.R2_BUCKET_NAME || null,
  r2Endpoint: process.env.R2_ENDPOINT || null,
  // Public domain for browser-accessible presigned URLs
  // (e.g., https://pub-<hash>.r2.dev or custom domain)
  // Set this to avoid browsers hitting the S3 API endpoint directly
  r2PublicUrl: process.env.R2_PUBLIC_URL || null,

  get maxFileSizeBytes() {
    return this.maxFileSizeMB * 1024 * 1024;
  },
};
