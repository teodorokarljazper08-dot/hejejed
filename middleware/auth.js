const db = require('../database');

const ADMIN_USERNAMES = (process.env.ADMIN_USERNAME ? [process.env.ADMIN_USERNAME] : ['Karluser32']);

function isAdminUser(user) {
  if (!user) return false;
  return ADMIN_USERNAMES.includes(user.username) || user.plan === 'admin';
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    return res.redirect('/login');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ success: false, message: 'Session invalid' });
    }
    return res.redirect('/login');
  }
  if (user.banned) {
    req.session.destroy(() => {});
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ success: false, message: 'Your account has been banned.' });
    }
    return res.redirect('/login?banned=1');
  }
  req.currentUser = user;
  next();
}

function requireGuest(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect('/dashboard');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !isAdminUser(user)) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  req.adminUser = user;
  req.currentUser = user;
  next();
}

module.exports = { requireAuth, requireGuest, requireAdmin, isAdminUser };
      
