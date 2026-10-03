const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { requireAuth, isAdminUser } = require('../middleware/auth');
const engine = require('../engine/botRunner');

const router = express.Router();

// Read-only lookup used by views the admin needs to inspect (bot detail, file
// browsing) — owners always see their own bot; admins may additionally view
// (never modify) any other user's bot through these specific read paths.
// Every other route below still uses the strict owner-only WHERE clause.
function loadBotForView(req) {
  const own = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (own) return own;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!isAdminUser(user)) return null;
  return db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id);
}

const PLAN_LIMITS = {
  free: { bots: 3, storage: 2.5 * 1024 * 1024 * 1024 },
  premium: { bots: 10, storage: 15 * 1024 * 1024 * 1024 }
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.DATA_DIR || '/data', 'uploads', String(req.session.userId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`)
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.py') || file.originalname.endsWith('.zip') ||
        file.mimetype === 'text/x-python' || file.mimetype === 'application/zip') {
      cb(null, true);
    } else {
      cb(new Error('Only .py and .zip files allowed'));
    }
  }
});

// GET /api/bots
router.get('/', requireAuth, (req, res) => {
  const bots = db.prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  // Sync runtime status into DB status field for accuracy
  const enriched = bots.map(b => ({
    ...b,
    live: engine.isRunning(b.id)
  }));
  res.json({ success: true, bots: enriched, plan: user.plan });
});

// POST /api/bots/create
router.post('/create', requireAuth, upload.single('bot_file'), (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    const botCount = db.prepare('SELECT COUNT(*) as count FROM bots WHERE user_id = ?').get(req.session.userId);
    const limit = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;

    if (botCount.count >= limit.bots) {
      return res.json({ success: false, message: `Your ${user.plan} plan allows max ${limit.bots} bots. Upgrade to add more.` });
    }

    const { name, token, library } = req.body;
    if (!name || !token) return res.json({ success: false, message: 'Bot name and token are required' });

    const existing = db.prepare('SELECT id FROM bots WHERE token = ?').get(token);
    if (existing) return res.json({ success: false, message: 'A bot with this token already exists' });

    const botId = uuidv4();
    let filePath = null;
    let storageUsed = 0;

    if (req.file) {
      filePath = req.file.path;
      storageUsed = req.file.size;
    }

    db.prepare(`
      INSERT INTO bots (id, user_id, name, token, library, file_path, storage_used)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(botId, req.session.userId, name, token, library || 'telebot_sync', filePath, storageUsed);

    db.prepare('INSERT INTO logs (bot_id, message, level) VALUES (?, ?, ?)').run(botId, `Bot "${name}" created successfully`, 'info');

    res.json({ success: true, botId, message: 'Bot created! Start it from your dashboard.' });
  } catch (err) {
    res.json({ success: false, message: err.message || 'Failed to create bot' });
  }
});

// POST /api/bots/:id/start — REAL EXECUTION
router.post('/:id/start', requireAuth, async (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  if (!bot.file_path) return res.json({ success: false, message: 'No file uploaded for this bot. Upload a .py or .zip file first.' });

  try {
    await engine.startBot(bot.id);
    res.json({ success: true, message: '🚀 Bot started successfully' });
  } catch (err) {
    res.json({ success: false, message: `Failed to start: ${err.message}` });
  }
});

// POST /api/bots/:id/stop
router.post('/:id/stop', requireAuth, async (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });

  await engine.killBot(bot.id, true);
  db.prepare('INSERT INTO logs (bot_id, message, level) VALUES (?, ?, ?)').run(bot.id, 'Bot stopped by user', 'warn');
  res.json({ success: true, message: '⏹️ Bot stopped' });
});

// POST /api/bots/:id/restart
router.post('/:id/restart', requireAuth, async (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  if (!bot.file_path) return res.json({ success: false, message: 'No file uploaded for this bot.' });

  try {
    await engine.killBot(bot.id, false);
    await engine.startBot(bot.id);
    res.json({ success: true, message: '🔄 Bot restarted' });
  // reset crash_notified on manual restart
  db.prepare('UPDATE bots SET crash_notified = 0 WHERE id = ?').run(req.params.id);
  } catch (err) {
    res.json({ success: false, message: `Restart failed: ${err.message}` });
  }
});

// DELETE /api/bots/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });

  await engine.killBot(bot.id, false);

  // Remove the extracted/working folder (covers anything added via File Manager)
  // as well as the original uploaded .py/.zip itself.
  try {
    const botDir = engine.resolveBotDir(bot);
    if (botDir && fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true, force: true });
  } catch {}
  if (bot.file_path && fs.existsSync(bot.file_path)) fs.unlinkSync(bot.file_path);

  db.prepare('DELETE FROM bots WHERE id = ?').run(bot.id);
  res.json({ success: true, message: 'Bot deleted' });
});

// PATCH /api/bots/:id/notes  { notes }
router.patch('/:id/notes', requireAuth, express.json(), (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const notes = String(req.body.notes || '').slice(0, 500);
  db.prepare('UPDATE bots SET notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(notes, req.params.id);
  res.json({ success: true, message: 'Notes saved' });
});

// PATCH /api/bots/:id/schedule  { time } — "HH:MM" UTC or "" to clear
router.patch('/:id/schedule', requireAuth, express.json(), (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const time = String(req.body.time || '').trim();
  const valid = !time || /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  if (!valid) return res.json({ success: false, message: 'Time must be HH:MM (24h UTC) or empty to clear' });
  db.prepare('UPDATE bots SET scheduled_restart = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(time || null, req.params.id);
  res.json({ success: true, message: time ? `Scheduled daily restart at ${time} UTC` : 'Scheduled restart cleared' });
});

// PATCH /api/bots/:id/name  { name }
router.patch('/:id/name', requireAuth, express.json(), (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const name = String((req.body && req.body.name) || '').trim();
  if (!name || name.length > 40) return res.json({ success: false, message: 'Name must be 1-40 characters' });
  db.prepare('UPDATE bots SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, bot.id);
  db.prepare('INSERT INTO logs (bot_id, message, level) VALUES (?, ?, ?)').run(bot.id, `Bot renamed to "${name}"`, 'info');
  res.json({ success: true, message: 'Bot renamed', name });
});

// PATCH /api/bots/:id/token  { token }
router.patch('/:id/token', requireAuth, express.json(), (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const token = String((req.body && req.body.token) || '').trim();
  if (!token) return res.json({ success: false, message: 'Token cannot be empty' });
  const dup = db.prepare('SELECT id FROM bots WHERE token = ? AND id != ?').get(token, bot.id);
  if (dup) return res.json({ success: false, message: 'Another bot already uses this token' });
  db.prepare('UPDATE bots SET token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(token, bot.id);
  db.prepare('INSERT INTO logs (bot_id, message, level) VALUES (?, ?, ?)').run(bot.id, 'Bot token was changed', 'info');
  res.json({ success: true, message: 'Token updated. Restart the bot to apply the new token.' });
});

// PATCH /api/bots/:id/mainfile  { file } — sets which .py file inside the
// bot's folder should be executed (used for ZIP uploads with multiple files)
router.patch('/:id/mainfile', requireAuth, express.json(), (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const file = String((req.body && req.body.file) || '').trim();
  if (!file.endsWith('.py')) return res.json({ success: false, message: 'Main file must end in .py' });
  if (/[\/\\]/.test(file) || file.includes('..')) return res.json({ success: false, message: 'Enter a filename only (no folders)' });
  db.prepare('UPDATE bots SET entry_file = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(file, bot.id);
  db.prepare('INSERT INTO logs (bot_id, message, level) VALUES (?, ?, ?)').run(bot.id, `Main file set to ${file}`, 'info');
  res.json({ success: true, message: 'Main file updated. Restart the bot to apply.' });
});

// PATCH /api/bots/:id/proxy  { enabled: true|false }
router.patch('/:id/proxy', requireAuth, express.json(), (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const enabled = !!(req.body && req.body.enabled);
  db.prepare('UPDATE bots SET proxy_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(enabled ? 1 : 0, bot.id);
  db.prepare('INSERT INTO logs (bot_id, message, level) VALUES (?, ?, ?)').run(bot.id, `Proxy rotator ${enabled ? 'enabled' : 'disabled'} — restart the bot to apply`, 'info');
  res.json({ success: true, message: `Proxy rotator ${enabled ? 'enabled' : 'disabled'}. Restart the bot to apply.` });
});

// GET /api/bots/:id/download — download the bot's entire working directory as a ZIP
router.get('/:id/download', requireAuth, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  if (!bot.file_path) return res.json({ success: false, message: 'No files uploaded yet' });
  try {
    const AdmZip = require('adm-zip');
    const botDir = engine.ensureExtracted(bot, bot.id);
    const zip = new AdmZip();
    zip.addLocalFolder(botDir);
    const buf = zip.toBuffer();
    const safe = bot.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}_files.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    res.send(buf);
  } catch (e) {
    res.json({ success: false, message: e.message || 'Download failed' });
  }
});

// GET /api/bots/:id/detail — single bot detail
router.get('/:id/detail', requireAuth, (req, res) => {
  const bot = loadBotForView(req);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  let hasReq = false;
  try {
    const botDir = engine.ensureExtracted(bot, bot.id);
    hasReq = botDir ? fs.existsSync(path.join(botDir, 'requirements.txt')) : false;
  } catch {}
  res.json({ success: true, bot: { ...bot, has_requirements: hasReq } });
});

// POST /api/bots/:id/requirements — upload requirements.txt
const reqUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
      if (!bot || !bot.file_path) return cb(new Error('Bot has no file yet'));
      try {
        cb(null, engine.ensureExtracted(bot, bot.id));
      } catch (e) {
        cb(e);
      }
    },
    filename: (req, file, cb) => cb(null, 'requirements.txt')
  }),
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.originalname === 'requirements.txt' || file.originalname.endsWith('.txt')) cb(null, true);
    else cb(new Error('File must be named requirements.txt'));
  }
});

router.post('/:id/requirements', requireAuth, (req, res, next) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  if (!bot.file_path) return res.json({ success: false, message: 'Upload a bot file first before adding requirements' });
  next();
}, reqUpload.single('requirements'), (req, res) => {
  if (!req.file) return res.json({ success: false, message: 'No file received' });
  db.prepare('INSERT INTO logs (bot_id, message, level) VALUES (?, ?, ?)').run(req.params.id, 'requirements.txt uploaded — restart bot to install', 'info');
  res.json({ success: true, message: 'requirements.txt uploaded. Restart the bot to install packages.' });
});

// POST /api/bots/:id/upload — re-upload bot file
router.post('/:id/upload', requireAuth, upload.single('bot_file'), (req, res) => {
  try {
    const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
    if (!bot) return res.json({ success: false, message: 'Bot not found' });
    if (!req.file) return res.json({ success: false, message: 'No file received' });
    if (bot.file_path && fs.existsSync(bot.file_path)) fs.unlinkSync(bot.file_path);
    db.prepare('UPDATE bots SET file_path = ?, storage_used = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.file.path, req.file.size, bot.id);
    db.prepare('INSERT INTO logs (bot_id, message, level) VALUES (?, ?, ?)').run(bot.id, `File updated: ${req.file.originalname}`, 'info');
    res.json({ success: true, message: 'Bot file updated. Start or restart to apply.' });
  } catch (err) {
    res.json({ success: false, message: err.message || 'Upload failed' });
  }
});

// GET /api/bots/:id/logs — DB logs
router.get('/:id/logs', requireAuth, (req, res) => {
  const bot = loadBotForView(req);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });

  const logs = db.prepare('SELECT * FROM logs WHERE bot_id = ? ORDER BY created_at DESC LIMIT 200').all(bot.id);
  res.json({ success: true, logs: logs.reverse(), bot });
});

// GET /api/bots/:id/live — in-memory live buffer (fast polling)
router.get('/:id/live', requireAuth, (req, res) => {
  const bot = loadBotForView(req);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });

  const since = parseInt(req.query.since || 0);
  const buffer = engine.getLiveBuffer(bot.id);
  const fresh = since ? buffer.filter(l => l.ts > since) : buffer;
  const live = engine.isRunning(bot.id);
  const startedAt = live ? engine.getStartedAt(bot.id) : null;
  // Refresh restart_count from DB
  const freshBot = db.prepare('SELECT restart_count FROM bots WHERE id = ?').get(bot.id);
  res.json({ success: true, logs: fresh, running: live, status: bot.status, started_at: startedAt, restart_count: freshBot ? freshBot.restart_count : 0 });
});

// GET /api/bots/activity — recent log entries across all of this user's bots
// Used by the dashboard's Activity Feed section.
router.get('/activity', requireAuth, (req, res) => {
  try {
    const entries = db.prepare(`
      SELECT l.message, l.level, l.created_at, b.name AS bot_name
      FROM logs l
      JOIN bots b ON l.bot_id = b.id
      WHERE b.user_id = ?
      ORDER BY l.id DESC
      LIMIT 30
    `).all(req.session.userId);
    res.json({ success: true, entries });
  } catch (e) {
    res.json({ success: false, entries: [] });
  }
});

module.exports = router;
