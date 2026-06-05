const db = require('../database');

class Bundle {
  static async create({ name, description, visibility, parentId }) {
    const stmt = db.prepare(
      `INSERT INTO bundles (name, description, visibility, parent_id) VALUES (?, ?, ?, ?)`
    );
    const result = await stmt.run(name, description || null, visibility || 'public', parentId || null);
    return this.findById(result.lastInsertRowid);
  }

  static async findById(id) {
    const bundle = await db.prepare('SELECT * FROM bundles WHERE id = ?').get(id);
    if (!bundle) return null;
    bundle.files = await this.getBundleFiles(bundle.id);
    bundle.children = await this.findChildren(bundle.id);
    return bundle;
  }

  static async findChildren(parentId) {
    const children = await db.prepare('SELECT * FROM bundles WHERE parent_id = ? ORDER BY created_at DESC').all(parentId);
    const result = [];
    for (const c of children) {
      c.files = await this.getBundleFiles(c.id);
      c.children = []; // only one level deep for now
      result.push(c);
    }
    return result;
  }

  static async findAll() {
    const bundles = await db.prepare(
      'SELECT * FROM bundles WHERE parent_id IS NULL ORDER BY created_at DESC'
    ).all();
    const result = [];
    for (const b of bundles) {
      b.files = await this.getBundleFiles(b.id);
      b.children = await this.findChildren(b.id);
      result.push(b);
    }
    return result;
  }

  // Flat list of ALL bundles (for permission management UI)
  static async findAllFlat() {
    const bundles = await db.prepare(
      'SELECT * FROM bundles ORDER BY created_at DESC'
    ).all();
    const result = [];
    for (const b of bundles) {
      b.files = await this.getBundleFiles(b.id);
      result.push(b);
    }
    return result;
  }

  static async findAllPublic() {
    const bundles = await db.prepare(
      "SELECT * FROM bundles WHERE parent_id IS NULL AND visibility IN ('public', 'download_only') ORDER BY created_at DESC"
    ).all();
    const result = [];
    for (const b of bundles) {
      b.files = await this.getBundleFiles(b.id);
      b.children = await this.findChildren(b.id);
      result.push(b);
    }
    return result;
  }

  static async getBundleFiles(bundleId) {
    return db.prepare(`
      SELECT f.*, bf.sort_order
      FROM bundle_files bf
      JOIN files f ON f.uuid = bf.file_uuid
      WHERE bf.bundle_id = ?
      ORDER BY bf.sort_order, f.created_at DESC
    `).all(bundleId);
  }

  static async addFile(bundleId, fileUuid, sortOrder) {
    try {
      const stmt = db.prepare(
        `INSERT INTO bundle_files (bundle_id, file_uuid, sort_order) VALUES (?, ?, ?)`
      );
      await stmt.run(bundleId, fileUuid, sortOrder || 0);
      return true;
    } catch (e) {
      // UNIQUE constraint — file already in bundle
      return false;
    }
  }

  static async removeFile(bundleId, fileUuid) {
    return db.prepare('DELETE FROM bundle_files WHERE bundle_id = ? AND file_uuid = ?').run(bundleId, fileUuid);
  }

  static async update(id, { name, description, visibility, parentId }) {
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (visibility !== undefined) { updates.push('visibility = ?'); params.push(visibility); }
    if (parentId !== undefined) { updates.push('parent_id = ?'); params.push(parentId || null); }
    if (updates.length === 0) return null;
    params.push(id);
    return db.prepare(`UPDATE bundles SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  static async deleteById(id) {
    // Move children to top-level before deleting
    await db.prepare('UPDATE bundles SET parent_id = NULL WHERE parent_id = ?').run(id);
    return db.prepare('DELETE FROM bundles WHERE id = ?').run(id);
  }

  // Get all descendant bundle IDs (for recursive download)
  static async getAllDescendantIds(bundleId) {
    const ids = [Number(bundleId)];
    const children = await this.findChildren(bundleId);
    children.forEach(c => ids.push(c.id));
    return ids;
  }
}

module.exports = Bundle;
