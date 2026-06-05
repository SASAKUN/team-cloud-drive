const crypto = require('crypto');
const db = require('../database');

class AccessKey {
  static generate() {
    return crypto.randomBytes(4).toString('hex');
  }

  static async create({ label, permission }) {
    const key = this.generate();
    const stmt = db.prepare(
      `INSERT INTO access_keys (key, label, permission) VALUES (?, ?, ?)`
    );
    const result = await stmt.run(key, label || null, permission || 'preview');
    return this.findById(result.lastInsertRowid);
  }

  static async findById(id) {
    return db.prepare('SELECT * FROM access_keys WHERE id = ?').get(id);
  }

  static async findByKey(key) {
    return db.prepare('SELECT * FROM access_keys WHERE key = ? AND status = ?').get(key, 'active');
  }

  static async findAll() {
    return db.prepare('SELECT * FROM access_keys ORDER BY created_at DESC').all();
  }

  static async updatePermission(id, permission) {
    return db.prepare('UPDATE access_keys SET permission = ? WHERE id = ?').run(permission, id);
  }

  static async revoke(id) {
    return db.prepare('UPDATE access_keys SET status = ? WHERE id = ?').run('revoked', id);
  }

  static async reactivate(id) {
    return db.prepare('UPDATE access_keys SET status = ? WHERE id = ?').run('active', id);
  }

  static async deleteById(id) {
    return db.prepare('DELETE FROM access_keys WHERE id = ?').run(id);
  }

  /* ---- Per-file permission overrides ---- */

  // Get all per-file permissions for a key
  static async getFilePermissions(keyId) {
    return db.prepare(`
      SELECT kfp.*, f.original_name, f.visibility as file_visibility
      FROM key_file_permissions kfp
      JOIN files f ON f.uuid = kfp.file_uuid
      WHERE kfp.key_id = ?
      ORDER BY f.created_at DESC
    `).all(keyId);
  }

  // Get permission for a specific key + file combination
  static async getFilePermission(keyId, fileUuid) {
    return db.prepare(
      'SELECT * FROM key_file_permissions WHERE key_id = ? AND file_uuid = ?'
    ).get(keyId, fileUuid);
  }

  // Set or update per-file permission for a key
  static async setFilePermission(keyId, fileUuid, permission) {
    const existing = await db.prepare(
      'SELECT id FROM key_file_permissions WHERE key_id = ? AND file_uuid = ?'
    ).get(keyId, fileUuid);

    if (existing) {
      await db.prepare('UPDATE key_file_permissions SET permission = ? WHERE id = ?').run(permission, existing.id);
    } else {
      await db.prepare('INSERT INTO key_file_permissions (key_id, file_uuid, permission) VALUES (?, ?, ?)').run(keyId, fileUuid, permission);
    }
  }

  // Remove per-file permission for a key
  static async deleteFilePermission(keyId, fileUuid) {
    return db.prepare('DELETE FROM key_file_permissions WHERE key_id = ? AND file_uuid = ?').run(keyId, fileUuid);
  }

  // Get all file permissions for a key as a Map<file_uuid, permission>
  static async getFilePermissionMap(keyId) {
    const rows = await db.prepare('SELECT file_uuid, permission FROM key_file_permissions WHERE key_id = ?').all(keyId);
    const map = {};
    rows.forEach(r => { map[r.file_uuid] = r.permission; });
    return map;
  }

  // Check if a key can download a specific file
  static async canDownloadFile(key, fileUuid) {
    if (!key) return false;
    // Check per-file permission first
    const fp = await db.prepare('SELECT permission FROM key_file_permissions WHERE key_id = ? AND file_uuid = ?').get(key.id, fileUuid);
    if (fp) return fp.permission === 'download' || fp.permission === 'both';
    // Fall back to global permission
    return key.permission === 'download' || key.permission === 'both';
  }

  /* ---- Per-bundle permission overrides ---- */

  // Get all per-bundle permissions for a key
  static async getBundlePermissions(keyId) {
    return db.prepare(`
      SELECT bkp.*, b.name as bundle_name, b.visibility as bundle_visibility
      FROM bundle_key_permissions bkp
      JOIN bundles b ON b.id = bkp.bundle_id
      WHERE bkp.key_id = ?
      ORDER BY b.name
    `).all(keyId);
  }

  // Get permission for a specific key + bundle combo
  static async getBundlePermission(keyId, bundleId) {
    return db.prepare(
      'SELECT * FROM bundle_key_permissions WHERE key_id = ? AND bundle_id = ?'
    ).get(keyId, bundleId);
  }

  // Set or update per-bundle permission for a key
  static async setBundlePermission(keyId, bundleId, permission) {
    const existing = await db.prepare(
      'SELECT id FROM bundle_key_permissions WHERE key_id = ? AND bundle_id = ?'
    ).get(keyId, bundleId);

    if (existing) {
      await db.prepare('UPDATE bundle_key_permissions SET permission = ? WHERE id = ?').run(permission, existing.id);
    } else {
      await db.prepare('INSERT INTO bundle_key_permissions (key_id, bundle_id, permission) VALUES (?, ?, ?)').run(keyId, bundleId, permission);
    }
  }

  // Remove per-bundle permission for a key
  static async deleteBundlePermission(keyId, bundleId) {
    return db.prepare('DELETE FROM bundle_key_permissions WHERE key_id = ? AND bundle_id = ?').run(keyId, bundleId);
  }

  // Get all bundle permissions for a key as a Map<bundle_id, permission>
  static async getBundlePermissionMap(keyId) {
    const rows = await db.prepare('SELECT bundle_id, permission FROM bundle_key_permissions WHERE key_id = ?').all(keyId);
    const map = {};
    rows.forEach(r => { map[r.bundle_id] = r.permission; });
    return map;
  }

  // Get the effective permission for a key on a specific bundle
  static async getEffectiveBundlePermission(key, bundleId) {
    if (!key) return 'none';
    const bp = await db.prepare('SELECT permission FROM bundle_key_permissions WHERE key_id = ? AND bundle_id = ?').get(key.id, bundleId);
    if (bp) return bp.permission;
    return key.permission;
  }

  // Get the effective permission for a key on a file within a bundle
  static async getEffectivePermission(key, bundleId, fileUuid) {
    if (!key) return 'none';
    // 1. Check per-file override (highest priority)
    const fp = await db.prepare('SELECT permission FROM key_file_permissions WHERE key_id = ? AND file_uuid = ?').get(key.id, fileUuid);
    if (fp) return fp.permission;
    // 2. Check per-bundle override
    if (bundleId) {
      const bp = await db.prepare('SELECT permission FROM bundle_key_permissions WHERE key_id = ? AND bundle_id = ?').get(key.id, bundleId);
      if (bp) return bp.permission;
    }
    // 3. Fall back to global
    return key.permission;
  }
}

module.exports = AccessKey;
