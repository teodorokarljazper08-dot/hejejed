// routes/proxies.js — what a regular user can see/do with proxies.
// Admin-side stock management lives in routes/admin.js instead.

const express = require('express');
const db = require('../database');
const { requireAuth } = require('../middleware/auth');
const { getUsableProxies, toLine, toMaskedLine } = require('../utils/proxyPool');

const router = express.Router();

// GET /api/proxies — summary + a masked preview of what this account can use
router.get('/', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, plan FROM users WHERE id = ?').get(req.session.userId);
  const { assigned, shared, limit } = getUsableProxies(user.id, user.plan);
  const allProxies = [...assigned, ...shared];
  const aliveCount = allProxies.filter(p => p.status === 'alive').length;
  const deadCount  = allProxies.filter(p => p.status === 'dead').length;
  res.json({
    success: true,
    plan: user.plan,
    shared_limit: limit,
    shared_count: shared.length,
    assigned_count: assigned.length,
    total: allProxies.length,
    alive: aliveCount,
    dead: deadCount,
    preview: allProxies.slice(0, 50).map(toMaskedLine)
  });
});

// GET /api/proxies/download — the real list, as a .txt file (host:port:user:pass per line)
router.get('/download', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, plan FROM users WHERE id = ?').get(req.session.userId);
  const { assigned, shared } = getUsableProxies(user.id, user.plan);
  const lines = [...assigned, ...shared].map(toLine).join('\n');
  res.setHeader('Content-Disposition', 'attachment; filename="proxies.txt"');
  res.setHeader('Content-Type', 'text/plain');
  res.send((lines || '# No proxies available yet') + '\n');
});

// POST /api/proxies/request  { message }
router.post('/request', requireAuth, express.json(), (req, res) => {
  const pending = db.prepare("SELECT id FROM proxy_requests WHERE user_id = ? AND status = 'pending'").get(req.session.userId);
  if (pending) {
    return res.json({ success: false, message: 'You already have a pending request — sit tight, Nix will get to it.' });
  }
  const message = String((req.body && req.body.message) || '').slice(0, 300);
  db.prepare('INSERT INTO proxy_requests (user_id, message) VALUES (?, ?)').run(req.session.userId, message);
  res.json({ success: true, message: 'Request sent! Nix will assign you more proxies soon.' });
});

module.exports = router;
