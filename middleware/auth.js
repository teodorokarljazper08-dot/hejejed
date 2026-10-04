const db = require('../database');
function isAdmin(user) { return user && user.role === 'admin'; }
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, message: 'Not authenticated' });
    return res.redirect('/login');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) { req.session.destroy(()=>{}); return res.redirect('/login'); }
  if (user.banned) { req.session.destroy(()=>{}); return res.redirect('/login?banned=1'); }
  req.user = user;
  next();
}
function requireGuest(req, res, next) {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ success: false, message: 'Not authenticated' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !isAdmin(user)) return res.status(403).json({ success: false, message: 'Admin only' });
  req.user = user;
  next();
}
module.exports = { requireAuth, requireGuest, requireAdmin, isAdmin };
