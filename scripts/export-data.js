#!/usr/bin/env node
/**
 * Export all local data (keys, files metadata, bundles) to JSON.
 * Usage: node scripts/export-data.js > data-export.json
 */

// Temporarily silence console output during module loading
const _log = console.log;
const _warn = console.warn;
const _info = console.info;
console.log = () => {};
console.warn = () => {};
console.info = () => {};

const db = require('../src/database');

// Restore console
console.log = _log;
console.warn = _warn;
console.info = _info;

const data = {
  access_keys: db.prepare('SELECT * FROM access_keys').all(),
  files: db.prepare('SELECT * FROM files').all(),
  bundles: db.prepare('SELECT * FROM bundles').all(),
  bundle_files: db.prepare('SELECT * FROM bundle_files').all(),
  key_file_permissions: db.prepare('SELECT * FROM key_file_permissions').all(),
  bundle_key_permissions: db.prepare('SELECT * FROM bundle_key_permissions').all()
};

process.stdout.write(JSON.stringify(data, null, 2));
