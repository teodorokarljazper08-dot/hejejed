const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { requireAdmin } = require('../middleware/auth');
const engine = require('../engine/botRunner');
const router = express.Router();
router.use(requireAdmin);

// GET /api/admin/users
router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id,username,role,plan,banned,ban_reason,created_at FROM users ORDER BY created_at DESC').all();
  const enriched = users.map(u => ({
    ...u,
    bot_count: db.prepare('SELECT COUNT(*) as c FROM bots WHERE user_id = ?').get(u.id).c
  }));
  res.json({ success: true, users: enriched });
});

// POST /api/admin/users/:id/ban
router.post('/users/:id/ban', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.json({ success: false, message: 'User not found' });
  if (user.role === 'admin') return res.json({ success: false, message: "Can't ban admin" });
  const reason = req.body?.reason || '';
  db.prepare('UPDATE users SET banned=1, ban_reason=? WHERE id=?').run(reason, user.id);
  // Stop their bots
  db.prepare('SELECT id FROM bots WHERE user_id=?').all(user.id).forEach(b => engine.stopBot(b.id));
  res.json({ success: true });
});

// POST /api/admin/users/:id/unban
router.post('/users/:id/unban', (req, res) => {
  db.prepare('UPDATE users SET banned=0, ban_reason=NULL WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user || user.role === 'admin') return res.json({ success: false, message: 'Cannot delete' });
  db.prepare('SELECT id FROM bots WHERE user_id=?').all(user.id).forEach(b => engine.stopBot(b.id));
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// GET /api/admin/bots
router.get('/bots', (req, res) => {
  const bots = db.prepare('SELECT b.*, u.username FROM bots b JOIN users u ON u.id=b.user_id ORDER BY b.created_at DESC').all();
  res.json({ success: true, bots: bots.map(b => ({ ...b, live: engine.isRunning(b.id) })) });
});

// POST /api/admin/tokens/generate
router.post('/tokens/generate', (req, res) => {
  const count = Math.min(50, parseInt(req.body?.count) || 1);
  const tokens = [];
  for (let i = 0; i < count; i++) {
    const token = 'KARL-' + uuidv4().replace(/-/g,'').slice(0,16).toUpperCase();
    try {
      db.prepare('INSERT INTO activation_tokens (token) VALUES (?)').run(token);
      tokens.push(token);
    } catch {}
  }
  res.json({ success: true, tokens });
});

// GET /api/admin/tokens
router.get('/tokens', (req, res) => {
  const tokens = db.prepare('SELECT t.*, u.username as used_by_username FROM activation_tokens t LEFT JOIN users u ON u.id=t.used_by ORDER BY t.created_at DESC').all();
  res.json({ success: true, tokens });
});

// DELETE /api/admin/tokens/:id
router.delete('/tokens/:id', (req, res) => {
  db.prepare('DELETE FROM activation_tokens WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/admin/magic-link - generate login link for a user
router.post('/magic-link', (req, res) => {
  const { userId } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user) return res.json({ success: false, message: 'User not found' });
  const token = uuidv4();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO login_links (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);
  const baseUrl = process.env.BASE_URL || 'https://karl-hosting-production.up.railway.app';
  res.json({ success: true, link: `${baseUrl}/api/auth/magic?t=${token}` });
});

// GET /api/admin/stats
router.get('/stats', (req, res) => {
  res.json({
    success: true,
    stats: {
      totalUsers: db.prepare('SELECT COUNT(*) c FROM users WHERE role != ?').get('admin').c,
      totalBots: db.prepare('SELECT COUNT(*) c FROM bots').get().c,
      runningBots: db.prepare("SELECT COUNT(*) c FROM bots WHERE status='running'").get().c,
      bannedUsers: db.prepare('SELECT COUNT(*) c FROM users WHERE banned=1').get().c,
      unusedTokens: db.prepare('SELECT COUNT(*) c FROM activation_tokens WHERE used_by IS NULL').get().c,
    }
  });
});

module.exports = router;
