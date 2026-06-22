const db = require('../database');

class File {
  static async create({ uuid, originalName, storedName, mimeType, sizeBytes, category, description, visibility, storageKey, storageBackend }) {
    const stmt = db.prepare(
      `INSERT INTO files (uuid, original_name, stored_name, mime_type, size_bytes, category, description, visibility, storage_key, storage_backend)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const result = await stmt.run(uuid, originalName, storedName, mimeType, sizeBytes, category, description || null, visibility || 'public', storageKey || null, storageBackend || 'local');
    return this.findById(result.lastInsertRowid);
  }

  static async findById(id) {
    return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  }

  static async findByUuid(uuid) {
    return db.prepare('SELECT * FROM files WHERE uuid = ?').get(uuid);
  }

  // Public-facing: only show public and download_only files
  static async findAllPublic() {
    return db.prepare(
      "SELECT * FROM files WHERE visibility IN ('public', 'download_only') ORDER BY created_at DESC"
    ).all();
  }

  static async findAllPublicByCategory(category) {
    return db.prepare(
      "SELECT * FROM files WHERE visibility IN ('public', 'download_only') AND category = ? ORDER BY created_at DESC"
    ).all(category);
  }

  static async searchPublic(query) {
    return db.prepare(
      "SELECT * FROM files WHERE visibility IN ('public', 'download_only') AND original_name LIKE ? ORDER BY created_at DESC"
    ).all(`%${query}%`);
  }

  // Admin: all files
  static async findAll() {
    return db.prepare('SELECT * FROM files ORDER BY created_at DESC').all();
  }

  static async setVisibility(uuid, visibility) {
    return db.prepare('UPDATE files SET visibility = ? WHERE uuid = ?').run(visibility, uuid);
  }

  static async updateDescription(uuid, description) {
    return db.prepare('UPDATE files SET description = ? WHERE uuid = ?').run(description, uuid);
  }

  static async deleteByUuid(uuid) {
    return db.prepare('DELETE FROM files WHERE uuid = ?').run(uuid);
  }
}

module.exports = File;
