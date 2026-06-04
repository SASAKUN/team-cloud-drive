const config = require('../config');

// Simple admin check via session
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  // Redirect to admin login
  req.session.returnTo = req.originalUrl;
  res.redirect('/admin/login');
}

// Check if already logged in as admin
function isAdmin(req) {
  return req.session && req.session.isAdmin;
}

module.exports = { requireAdmin, isAdmin };
