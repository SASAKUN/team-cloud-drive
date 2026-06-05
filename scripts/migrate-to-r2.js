#!/usr/bin/env node
/**
 * Migrate local files to Cloudflare R2.
 * Run: node scripts/migrate-to-r2.js
 *
 * Reads SQLite DB, uploads all files from data/uploads/ to R2,
 * and updates the database with storage_key values.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || './data/database.sqlite';
const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';

// R2 config
const r2Enabled = process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY;
if (!r2Enabled) {
  console.error('❌ R2 credentials not set. Please configure .env');
  process.exit(1);
}

const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const BUCKET = process.env.R2_BUCKET_NAME;

async function main() {
  // Open SQLite
  const dbPath = path.resolve(DB_PATH);
  if (!fs.existsSync(dbPath)) {
    console.error('❌ Database not found:', dbPath);
    process.exit(1);
  }
  const db = new Database(dbPath);

  // Get all files
  const files = db.prepare('SELECT * FROM files').all();
  console.log(`Found ${files.length} files in database.`);

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const filePath = path.resolve(UPLOAD_DIR, file.uuid, file.original_name);
    const storageKey = `files/${file.uuid}/${file.original_name}`;

    // Check if already migrated
    if (file.storage_key) {
      console.log(`  ⏭️  Skipping (already migrated): ${file.original_name}`);
      skipped++;
      continue;
    }

    // Check local file exists
    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠️  Missing on disk: ${file.original_name}`);
      db.prepare('UPDATE files SET storage_key = ? WHERE uuid = ?').run(`MISSING:${storageKey}`, file.uuid);
      failed++;
      continue;
    }

    // Upload to R2
    try {
      const body = fs.readFileSync(filePath);
      await r2Client.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: storageKey,
        Body: body,
        ContentType: file.mime_type || 'application/octet-stream',
      }));
      db.prepare('UPDATE files SET storage_key = ? WHERE uuid = ?').run(storageKey, file.uuid);
      uploaded++;
      console.log(`  ✅ Uploaded: ${file.original_name} (${(file.size_bytes / 1024).toFixed(1)}KB)`);
    } catch (e) {
      console.error(`  ❌ Failed: ${file.original_name} — ${e.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Summary: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`);
  db.close();

  if (failed > 0) {
    console.log('\n⚠️  Some files failed. You can re-run this script to retry.');
  }
}

main().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
