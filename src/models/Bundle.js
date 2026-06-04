const db = require('../database');

class Bundle {
  static create({ name, description, visibility, parentId }) {
    const stmt = db.prepare(
      `INSERT INTO bundles (name, description, visibility, parent_id) VALUES (?, ?, ?, ?)`
    );
    const result = stmt.run(name, description || null, visibility || 'public', parentId || null);
    return this.findById(result.lastInsertRowid);
  }

  static findById(id) {
    const bundle = db.prepare('SELECT * FROM bundles WHERE id = ?').get(id);
    if (!bundle) return null;
    bundle.files = this.getBundleFiles(bundle.id);
    bundle.children = this.findChildren(bundle.id);
    return bundle;
  }

  static findChildren(parentId) {
    const children = db.prepare('SELECT * FROM bundles WHERE parent_id = ? ORDER BY created_at DESC').all(parentId);
    return children.map(c => {
      c.files = this.getBundleFiles(c.id);
      c.children = []; // only one level
      return c;
    });
  }

  static findAll() {
    const bundles = db.prepare(
      'SELECT * FROM bundles WHERE parent_id IS NULL ORDER BY created_at DESC'
    ).all();
    return bundles.map(b => {
      b.files = this.getBundleFiles(b.id);
      b.children = this.findChildren(b.id);
      return b;
    });
  }

  // Flat list of ALL bundles (for permission management UI)
  static findAllFlat() {
    const bundles = db.prepare(
      'SELECT * FROM bundles ORDER BY created_at DESC'
    ).all();
    return bundles.map(b => {
      b.files = this.getBundleFiles(b.id);
      return b;
    });
  }

  static findAllPublic() {
    const bundles = db.prepare(
      "SELECT * FROM bundles WHERE parent_id IS NULL AND visibility IN ('public', 'download_only') ORDER BY created_at DESC"
    ).all();
    return bundles.map(b => {
      b.files = this.getBundleFiles(b.id);
      b.children = this.findChildren(b.id);
      return b;
    });
  }

  static getBundleFiles(bundleId) {
    return db.prepare(`
      SELECT f.*, bf.sort_order
      FROM bundle_files bf
      JOIN files f ON f.uuid = bf.file_uuid
      WHERE bf.bundle_id = ?
      ORDER BY bf.sort_order, f.created_at DESC
    `).all(bundleId);
  }

  static addFile(bundleId, fileUuid, sortOrder) {
    try {
      const stmt = db.prepare(
        `INSERT INTO bundle_files (bundle_id, file_uuid, sort_order) VALUES (?, ?, ?)`
      );
      stmt.run(bundleId, fileUuid, sortOrder || 0);
      return true;
    } catch (e) {
      // UNIQUE constraint — file already in bundle
      return false;
    }
  }

  static removeFile(bundleId, fileUuid) {
    return db.prepare('DELETE FROM bundle_files WHERE bundle_id = ? AND file_uuid = ?').run(bundleId, fileUuid);
  }

  static update(id, { name, description, visibility, parentId }) {
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

  static deleteById(id) {
    // Move children to top-level before deleting
    db.prepare('UPDATE bundles SET parent_id = NULL WHERE parent_id = ?').run(id);
    return db.prepare('DELETE FROM bundles WHERE id = ?').run(id);
  }

  // Get all descendant bundle IDs (for recursive download)
  static getAllDescendantIds(bundleId) {
    const ids = [Number(bundleId)];
    const children = this.findChildren(bundleId);
    children.forEach(c => ids.push(c.id));
    return ids;
  }
}

module.exports = Bundle;
