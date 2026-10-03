const express = require('express');
const db = require('../database');
const { requireAuth } = require('../middleware/auth');
const router = express.Router({ mergeParams: true });

function ownsBot(userId, botId) {
  return db.prepare('SELECT id FROM bots WHERE id = ? AND user_id = ?').get(botId, userId);
}

// GET all env vars for a bot
router.get('/', requireAuth, (req, res) => {
  if (!ownsBot(req.session.userId, req.params.id))
    return res.json({ success: false, message: 'Not found' });
  const vars = db.prepare('SELECT id, key, value FROM bot_env_vars WHERE bot_id = ? ORDER BY key').all(req.params.id);
  res.json({ success: true, vars });
});

// PUT set/update a var
router.put('/', requireAuth, (req, res) => {
  if (!ownsBot(req.session.userId, req.params.id))
    return res.json({ success: false, message: 'Not found' });
  const { key, value } = req.body;
  if (!key) return res.json({ success: false, message: 'Key is required' });
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) return res.json({ success: false, message: 'Key must be alphanumeric/underscore' });
  db.prepare('INSERT INTO bot_env_vars (bot_id, key, value) VALUES (?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET value = excluded.value')
    .run(req.params.id, key.trim().toUpperCase(), value != null ? String(value) : '');
  res.json({ success: true, message: 'Variable saved' });
});

// DELETE a var
router.delete('/', requireAuth, (req, res) => {
  if (!ownsBot(req.session.userId, req.params.id))
    return res.json({ success: false, message: 'Not found' });
  const { key } = req.body;
  if (!key) return res.json({ success: false, message: 'Key is required' });
  db.prepare('DELETE FROM bot_env_vars WHERE bot_id = ? AND key = ?').run(req.params.id, key.trim().toUpperCase());
  res.json({ success: true, message: 'Variable deleted' });
});

module.exports = router;
