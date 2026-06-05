const express = require('express');
const path = require('path');
const morgan = require('morgan');
const cookieSession = require('cookie-session');
const config = require('./src/config');
const { isAdmin } = require('./src/middleware/auth');

const app = express();

// Middleware
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieSession({
  name: 'session',
  keys: [config.sessionSecret],
  maxAge: 24 * 60 * 60 * 1000
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Make admin status available to views
app.use((req, res, next) => {
  res.locals.isAdmin = isAdmin(req);
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  res.locals.baseUrl = `${proto}://${host}`;
  next();
});

// Routes
app.use('/admin', require('./src/routes/admin'));
app.use('/', require('./src/routes/files'));

// 404
app.use((req, res) => {
  res.status(404).render('error', {
    title: '页面未找到',
    message: '您访问的页面不存在'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', {
    title: '服务器错误',
    message: err.message
  });
});

// Start server after DB initialization
async function start() {
  // Initialize database (async)
  require('./src/database');

  // Wait a tick for DB init to complete
  await new Promise(resolve => setTimeout(resolve, 100));

  app.listen(config.port, () => {
    console.log(`📁 Team Cloud Drive running at ${config.baseUrl}`);
    console.log(`🔗 分享链接: ${config.baseUrl}`);
    console.log(`⚙️  管理后台: ${config.baseUrl}/admin`);
    if (config.databaseUrl) {
      console.log(`🐘 Using PostgreSQL (Supabase)`);
    } else {
      console.log(`💾 Using SQLite (local)`);
    }
    if (config.r2AccessKeyId) {
      console.log(`☁️  Using Cloudflare R2 storage`);
    }
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
