const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const dataDir = path.dirname(config.databasePath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');

// Simple schema: just files with visibility control
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'download_only', 'hidden')),
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS access_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    label TEXT,
    permission TEXT NOT NULL DEFAULT 'preview' CHECK(permission IN ('preview', 'download')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bundles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'download_only', 'hidden')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bundle_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    file_uuid TEXT NOT NULL REFERENCES files(uuid) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(bundle_id, file_uuid)
  );

  CREATE TABLE IF NOT EXISTS key_file_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id INTEGER NOT NULL REFERENCES access_keys(id) ON DELETE CASCADE,
    file_uuid TEXT NOT NULL REFERENCES files(uuid) ON DELETE CASCADE,
    permission TEXT NOT NULL DEFAULT 'preview' CHECK(permission IN ('preview', 'download')),
    UNIQUE(key_id, file_uuid)
  );

  CREATE TABLE IF NOT EXISTS bundle_key_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id INTEGER NOT NULL REFERENCES access_keys(id) ON DELETE CASCADE,
    bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    permission TEXT NOT NULL DEFAULT 'preview' CHECK(permission IN ('preview', 'download', 'both')),
    UNIQUE(key_id, bundle_id)
  );
`);

// Migration: add status column if upgrading from old schema
try {
  db.exec(`ALTER TABLE access_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked'))`);
} catch (e) { /* column already exists */ }

// Migration: add parent_id to bundles for sub-bundle support
try {
  db.exec(`ALTER TABLE bundles ADD COLUMN parent_id INTEGER REFERENCES bundles(id) ON DELETE CASCADE`);
} catch (e) { /* column already exists */ }

// Migration: add 'both' permission level (preview | download | both)
// Check if migration needed by examining CHECK constraint
const akSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'access_keys' AND type = 'table'").get();
const needsMigration = akSql && !akSql.sql.includes("'both'");

if (needsMigration) {
  db.transaction(() => {
    // Disable foreign key enforcement during migration
    db.pragma('foreign_keys = OFF');

    // 1. Rebuild access_keys with 'both' permission + map existing 'download' → 'both'
    db.exec(`
      CREATE TABLE access_keys_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        label TEXT,
        permission TEXT NOT NULL DEFAULT 'preview' CHECK(permission IN ('preview', 'download', 'both')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO access_keys_new (id, key, label, permission, status, created_at)
        SELECT id, key, label,
          CASE WHEN permission = 'download' THEN 'both' ELSE permission END,
          status, created_at
        FROM access_keys;
      DROP TABLE access_keys;
      ALTER TABLE access_keys_new RENAME TO access_keys;
    `);

    // 2. Rebuild key_file_permissions with 'both' + map 'download' → 'both'
    db.exec(`
      CREATE TABLE key_file_permissions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id INTEGER NOT NULL REFERENCES access_keys(id) ON DELETE CASCADE,
        file_uuid TEXT NOT NULL REFERENCES files(uuid) ON DELETE CASCADE,
        permission TEXT NOT NULL DEFAULT 'preview' CHECK(permission IN ('preview', 'download', 'both')),
        UNIQUE(key_id, file_uuid)
      );
      INSERT INTO key_file_permissions_new (id, key_id, file_uuid, permission)
        SELECT id, key_id, file_uuid,
          CASE WHEN permission = 'download' THEN 'both' ELSE permission END
        FROM key_file_permissions;
      DROP TABLE key_file_permissions;
      ALTER TABLE key_file_permissions_new RENAME TO key_file_permissions;
    `);

    db.pragma('foreign_keys = ON');
  })();
}

// Migration: add 'none' to bundle_key_permissions CHECK constraint
const bkpSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'bundle_key_permissions' AND type = 'table'").get();
const needsBkpMigration = bkpSql && !bkpSql.sql.includes("'none'");

if (needsBkpMigration) {
  db.transaction(() => {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE bundle_key_permissions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id INTEGER NOT NULL REFERENCES access_keys(id) ON DELETE CASCADE,
        bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
        permission TEXT NOT NULL DEFAULT 'preview' CHECK(permission IN ('preview', 'download', 'both', 'none')),
        UNIQUE(key_id, bundle_id)
      );
      INSERT INTO bundle_key_permissions_new SELECT * FROM bundle_key_permissions;
      DROP TABLE bundle_key_permissions;
      ALTER TABLE bundle_key_permissions_new RENAME TO bundle_key_permissions;
    `);
    db.pragma('foreign_keys = ON');
  })();
}

module.exports = db;
