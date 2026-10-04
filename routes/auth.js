const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { requireAuth, requireGuest } = require('../middleware/auth');
const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.json({ success: false, message: 'Invalid username or password' });
  if (user.banned) return res.json({ success: false, message: 'Account banned: ' + (user.ban_reason || 'contact admin') });
  req.session.userId = user.id;
  req.session.save(() => res.json({ success: true, redirect: '/dashboard' }));
});

router.post('/register', (req, res) => {
  const { username, password, token } = req.body;
  if (!username || !password || !token)
    return res.json({ success: false, message: 'All fields required' });
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username))
    return res.json({ success: false, message: 'Username: 3-32 chars, letters/numbers/._- only' });
  if (password.length < 6)
    return res.json({ success: false, message: 'Password must be at least 6 characters' });

  const tk = db.prepare('SELECT * FROM activation_tokens WHERE token = ? AND used_by IS NULL').get(token.trim().toUpperCase());
  if (!tk) return res.json({ success: false, message: 'Invalid or already used activation token' });

  req.session.save(() => res.json({ success: true, redirect: '/dashboard' }));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true, redirect: '/login' }));
});

router.get('/magic', (req, res) => {
  const { t } = req.query;
  if (!t) return res.redirect('/login?error=invalid');
  const link = db.prepare('SELECT * FROM login_links WHERE token = ? AND used = 0 AND expires_at > CURRENT_TIMESTAMP').get(t);
  if (!link) return res.redirect('/login?error=expired');
  db.prepare('UPDATE login_links SET used = 1 WHERE id = ?').run(link.id);
  req.session.userId = link.user_id;
  req.session.save(() => res.redirect('/dashboard'));
});

router.get('/check-token', (req, res) => {
  const token = String(req.query.token || '').trim().toUpperCase();
  if (!token) return res.json({ valid: false, message: 'No token provided' });
  const row = db.prepare('SELECT used_by, expires_at, duration FROM activation_tokens WHERE token = ?').get(token);
  if (!row) return res.json({ valid: false, message: 'Token not found' });
  if (row.used_by) return res.json({ valid: false, message: 'Token already used' });
  if (row.expires_at && new Date(row.expires_at) < new Date())
    return res.json({ valid: false, message: 'Token has expired' });
  return res.json({ valid: true, message: 'Token is valid ✓', duration: row.duration });
});

module.exports = router;
