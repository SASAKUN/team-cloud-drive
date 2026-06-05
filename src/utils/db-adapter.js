/**
 * Database adapter that provides a better-sqlite3-like API
 * over both SQLite (local dev) and PostgreSQL (production).
 *
 * Usage:
 *   const db = require('./db-adapter');
 *   const stmt = db.prepare('SELECT * FROM files WHERE id = ?');
 *   const row = await stmt.get(id);        // async
 *   const rows = await stmt.all();         // async
 *   const result = await stmt.run(...);    // async, result.lastInsertRowid
 */

const config = require('../config');

// PostgreSQL schema (duplicated here to avoid circular require with database.js)
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

// Detect which backend to use
const usePostgres = !!config.databaseUrl;

let _db = null;

function getDb() {
  if (_db) return _db;

  if (usePostgres) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseUrl.includes('supabase')
        ? { rejectUnauthorized: false }
        : undefined,
    });

    // Track if we've initialized schema
    let schemaInitialized = false;

    _db = {
      _pool: pool,
      _isPg: true,

      async _ensureSchema() {
        if (schemaInitialized) return;
        schemaInitialized = true;
        await this.exec(pgSchema);
      },

      prepare(sql) {
        return new PgStatement(pool, sql);
      },

      async exec(sql) {
        const statements = sql.split(';').filter(s => s.trim());
        for (const stmt of statements) {
          try {
            await pool.query(stmt);
          } catch (e) {
            // Ignore "already exists" errors during schema creation
            if (!e.message.includes('already exists') &&
                !e.message.includes('Duplicate')) {
              throw e;
            }
          }
        }
      },

      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({
            prepare: (sql) => new PgStatement(client, sql),
          });
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },

      async close() {
        await pool.end();
      },
    };
  } else {
    // SQLite mode — wrap sync API to return Promises
    const Database = require('better-sqlite3');
    const path = require('path');
    const fs = require('fs');
    const dbPath = config.databasePath;
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const sqliteDb = new Database(dbPath);
    sqliteDb.pragma('journal_mode = WAL');

    _db = {
      _sqlite: sqliteDb,
      _isPg: false,

      prepare(sql) {
        const stmt = sqliteDb.prepare(sql);
        return {
          async run(...params) {
            return stmt.run(...params);
          },
          async get(...params) {
            return stmt.get(...params);
          },
          async all(...params) {
            return stmt.all(...params);
          },
        };
      },

      async exec(sql) {
        sqliteDb.exec(sql);
      },

      async transaction(fn) {
        const tx = sqliteDb.transaction((tFn) => {
          return tFn({
            prepare: (sql) => sqliteDb.prepare(sql),
          });
        });
        return tx(fn);
      },

      async close() {
        sqliteDb.close();
      },
    };
  }

  return _db;
}

// ===== PostgreSQL Statement Wrapper =====
class PgStatement {
  constructor(clientOrPool, sql) {
    this.client = clientOrPool;
    this.originalSql = sql;
    this.sql = this._convertPlaceholders(sql);
  }

  _convertPlaceholders(sql) {
    let idx = 0;
    return sql.replace(/\?/g, () => `$${++idx}`);
  }

  async _query(values) {
    const isPool = typeof this.client.query === 'function' && this.client.totalCount !== undefined;
    if (isPool) {
      return this.client.query(this.sql, values);
    }
    // It's a client (in transaction)
    return this.client.query(this.sql, values);
  }

  async run(...params) {
    const values = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const result = await this._query(values);
    return {
      lastInsertRowid: result.rows[0]?.id || null,
      changes: result.rowCount,
    };
  }

  async get(...params) {
    const values = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const result = await this._query(values);
    return result.rows[0] || undefined;
  }

  async all(...params) {
    const values = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const result = await this._query(values);
    return result.rows;
  }
}

module.exports = getDb();
