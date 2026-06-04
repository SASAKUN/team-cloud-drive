#!/usr/bin/env node
/**
 * Export all local data (keys, files metadata, bundles) to JSON.
 * Usage: node scripts/export-data.js > data-export.json
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../src/database');

const data = {
  access_keys: db.prepare('SELECT * FROM access_keys').all(),
  files: db.prepare('SELECT * FROM files').all(),
  bundles: db.prepare('SELECT * FROM bundles').all(),
  bundle_files: db.prepare('SELECT * FROM bundle_files').all(),
  key_file_permissions: db.prepare('SELECT * FROM key_file_permissions').all()
};

process.stdout.write(JSON.stringify(data, null, 2));
