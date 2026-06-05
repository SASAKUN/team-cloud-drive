const path = require('path');
const fs = require('fs');
const config = require('./config');

// Use adapter: PostgreSQL when DATABASE_URL is set, otherwise SQLite
const db = require('./utils/db-adapter');

// Ensure data directory exists for SQLite mode
if (!config.databaseUrl) {
  const dataDir = path.dirname(config.databasePath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

// ===== SQLite Schema (default) =====
const sqliteSchema = `
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
    storage_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS access_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    label TEXT,
    permission TEXT NOT NULL DEFAULT 'preview' CHECK(permission IN ('preview', 'download', 'both')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bundles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'download_only', 'hidden')),
    parent_id INTEGER REFERENCES bundles(id) ON DELETE CASCADE,
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
    permission TEXT NOT NULL DEFAULT 'preview' CHECK(permission IN ('preview', 'download', 'both')),
    UNIQUE(key_id, file_uuid)
  );

  CREATE TABLE IF NOT EXISTS bundle_key_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id INTEGER NOT NULL REFERENCES access_keys(id) ON DELETE CASCADE,
    bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    permission TEXT NOT NULL DEFAULT 'preview' CHECK(permission IN ('preview', 'download', 'both', 'none')),
    UNIQUE(key_id, bundle_id)
  );
`;

// ===== PostgreSQL Schema =====
const pgSchema = `
  CREATE TABLE IF NOT EXISTS files (
    id SERIAL PRIMARY KEY,
    uuid TEXT UNIQUE NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'download_only', 'hidden')),
    description TEXT,
    storage_key TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS access_keys (
    id SERIAL PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    label TEXT,
    permission TEXT NOT NULL DEFAULT 'preview' CHECK(permission IN ('preview', 'download', 'both')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS bundles (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'download_only', 'hidden')),
    parent_id INTEGER REFERENCES bundles(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS bundle_files (
    id SERIAL PRIMARY KEY,
    bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    file_uuid TEXT NOT NULL REFERENCES files(uuid) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(bundle_id, file_uuid)
  );

  CREATE TABLE IF NOT EXISTS key_file_permissions (
    id SERIAL PRIMARY KEY,
    key_id INTEGER NOT NULL REFERENCES access_keys(id) ON DELETE CASCADE,
    file_uuid TEXT NOT NULL REFERENCES files(uuid) ON DELETE CASCADE,
    permission TEXT NOT NULL DEFAULT 'preview' CHECK(permission IN ('preview', 'download', 'both')),
    UNIQUE(key_id, file_uuid)
  );

  CREATE TABLE IF NOT EXISTS bundle_key_permissions (
    id SERIAL PRIMARY KEY,
    key_id INTEGER NOT NULL REFERENCES access_keys(id) ON DELETE CASCADE,
    bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    permission TEXT NOT NULL DEFAULT 'preview' CHECK(permission IN ('preview', 'download', 'both', 'none')),
    UNIQUE(key_id, bundle_id)
  );
`;

// Initialize schema
async function initSchema() {
  const schema = config.databaseUrl ? pgSchema : sqliteSchema;
  await db.exec(schema);
}

// Run migrations
async function runMigrations() {
  if (!config.databaseUrl) {
    // SQLite migrations
    try {
      await db.exec(`ALTER TABLE access_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked'))`);
    } catch (e) { /* exists */ }

    try {
      await db.exec(`ALTER TABLE bundles ADD COLUMN parent_id INTEGER REFERENCES bundles(id) ON DELETE CASCADE`);
    } catch (e) { /* exists */ }

    try {
      await db.exec(`ALTER TABLE files ADD COLUMN storage_key TEXT`);
    } catch (e) { /* exists */ }

    // Migration for 'both' permission in access_keys
    const akSql = await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'access_keys' AND type = 'table'").get();
    if (akSql && !akSql.sql.includes("'both'")) {
      await db.transaction(async (tx) => {
        await tx.prepare("PRAGMA foreign_keys = OFF").run();
        await tx.exec(`
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
        await tx.prepare("PRAGMA foreign_keys = ON").run();
      });
    }

    // Migration for 'both' in key_file_permissions
    const kfpSql = await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'key_file_permissions' AND type = 'table'").get();
    if (kfpSql && !kfpSql.sql.includes("'both'")) {
      await db.transaction(async (tx) => {
        await tx.prepare("PRAGMA foreign_keys = OFF").run();
        await tx.exec(`
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
        await tx.prepare("PRAGMA foreign_keys = ON").run();
      });
    }

    // Migration for 'none' in bundle_key_permissions
    const bkpSql = await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'bundle_key_permissions' AND type = 'table'").get();
    if (bkpSql && !bkpSql.sql.includes("'none'")) {
      await db.transaction(async (tx) => {
        await tx.prepare("PRAGMA foreign_keys = OFF").run();
        await tx.exec(`
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
        await tx.prepare("PRAGMA foreign_keys = ON").run();
      });
    }
  } else {
    // PostgreSQL migrations: storage_key column
    try {
      await db.exec(`ALTER TABLE files ADD COLUMN IF NOT EXISTS storage_key TEXT`);
    } catch (e) { /* exists or other error */ }
  }
}

// Initialize db and export a promise that resolves when ready
let initPromise = (async () => {
  try {
    await initSchema();
    console.log('✅ Schema initialized');
    await runMigrations();
    console.log('✅ Migrations complete');
  } catch (err) {
    console.error('❌ Database initialization failed:', err.message);
    // Don't throw — let the server start anyway so we can see logs
  }
})();

// Export schema builders for the adapter
module.exports = db;
module.exports.getPgSchema = () => pgSchema;
module.exports.getSqliteSchema = () => sqliteSchema;
module.exports.initPromise = initPromise;

