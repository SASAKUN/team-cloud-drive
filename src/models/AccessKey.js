const crypto = require('crypto');
const db = require('../database');

class AccessKey {
  static generate() {
    return crypto.randomBytes(4).toString('hex');
  }

  static create({ label, permission }) {
    const key = this.generate();
    const stmt = db.prepare(
      `INSERT INTO access_keys (key, label, permission) VALUES (?, ?, ?)`
    );
    const result = stmt.run(key, label || null, permission || 'preview');
    return this.findById(result.lastInsertRowid);
  }

  static findById(id) {
    return db.prepare('SELECT * FROM access_keys WHERE id = ?').get(id);
  }

  static findByKey(key) {
    return db.prepare('SELECT * FROM access_keys WHERE key = ? AND status = ?').get(key, 'active');
  }

  static findAll() {
    return db.prepare('SELECT * FROM access_keys ORDER BY created_at DESC').all();
  }

  static updatePermission(id, permission) {
    return db.prepare('UPDATE access_keys SET permission = ? WHERE id = ?').run(permission, id);
  }

  static revoke(id) {
    return db.prepare('UPDATE access_keys SET status = ? WHERE id = ?').run('revoked', id);
  }

  static reactivate(id) {
    return db.prepare('UPDATE access_keys SET status = ? WHERE id = ?').run('active', id);
  }

  static deleteById(id) {
    return db.prepare('DELETE FROM access_keys WHERE id = ?').run(id);
  }

  /* ---- Per-file permission overrides ---- */

  // Get all per-file permissions for a key
  static getFilePermissions(keyId) {
    return db.prepare(`
      SELECT kfp.*, f.original_name, f.visibility as file_visibility
      FROM key_file_permissions kfp
      JOIN files f ON f.uuid = kfp.file_uuid
      WHERE kfp.key_id = ?
      ORDER BY f.created_at DESC
    `).all(keyId);
  }

  // Get permission for a specific key + file combination
  static getFilePermission(keyId, fileUuid) {
    return db.prepare(
      'SELECT * FROM key_file_permissions WHERE key_id = ? AND file_uuid = ?'
    ).get(keyId, fileUuid);
  }

  // Set or update per-file permission for a key
  static setFilePermission(keyId, fileUuid, permission) {
    const existing = db.prepare(
      'SELECT id FROM key_file_permissions WHERE key_id = ? AND file_uuid = ?'
    ).get(keyId, fileUuid);

    if (existing) {
      db.prepare('UPDATE key_file_permissions SET permission = ? WHERE id = ?').run(permission, existing.id);
    } else {
      db.prepare('INSERT INTO key_file_permissions (key_id, file_uuid, permission) VALUES (?, ?, ?)').run(keyId, fileUuid, permission);
    }
  }

  // Remove per-file permission for a key
  static deleteFilePermission(keyId, fileUuid) {
    return db.prepare('DELETE FROM key_file_permissions WHERE key_id = ? AND file_uuid = ?').run(keyId, fileUuid);
  }

  // Get all file permissions for a key as a Map<file_uuid, permission>
  static getFilePermissionMap(keyId) {
    const rows = db.prepare('SELECT file_uuid, permission FROM key_file_permissions WHERE key_id = ?').all(keyId);
    const map = {};
    rows.forEach(r => { map[r.file_uuid] = r.permission; });
    return map;
  }

  // Check if a key can download a specific file
  // Takes key object and file, returns boolean
  static canDownloadFile(key, fileUuid) {
    if (!key) return false;
    // Check per-file permission first
    const fp = db.prepare('SELECT permission FROM key_file_permissions WHERE key_id = ? AND file_uuid = ?').get(key.id, fileUuid);
    if (fp) return fp.permission === 'download' || fp.permission === 'both';
    // Fall back to global permission
    return key.permission === 'download' || key.permission === 'both';
  }
}

module.exports = AccessKey;
