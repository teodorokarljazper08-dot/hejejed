// routes/files.js — per-bot File Manager API.
// Mounted in server.js at /api/bots/:id/files (mergeParams so req.params.id works here).
//
// Every route below operates inside that ONE bot's working directory
// (resolved via engine.resolveBotDir / ensureExtracted), so a user editing
// their bot can never read or write another user's files, and never escape
// outside their own bot's folder (checked in safeResolve()).

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { requireAuth, isAdminUser } = require('../middleware/auth');
const engine = require('../engine/botRunner');

const router = express.Router({ mergeParams: true });

const PLAN_LIMITS = {
  free: 2.5 * 1024 * 1024 * 1024,
  premium: 15 * 1024 * 1024 * 1024
};
const MAX_EDIT_BYTES = 2 * 1024 * 1024;   // 2MB — cap for the inline text editor
const MAX_UPLOAD_BYTES = 65 * 1024 * 1024; // 65MB — cap for a single uploaded file

// ── Shared helpers ───────────────────────────────────────────────
// Returns { bot, isAdminView } — isAdminView is true only when the bot
// belongs to someone else and the requester is an admin. Mutating routes
// (save/upload/delete/rename/create) reject when isAdminView is true, so an
// admin can look at another user's files here but never change them.
function loadBotOr404(req, res) {
  const own = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (own) { return { bot: own, isAdminView: false }; }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (isAdminUser(user)) {
    const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id);
    if (bot) return { bot, isAdminView: true };
  }
  res.json({ success: false, message: 'Bot not found' });
  return null;
}

function getBotDir(bot) {
  // Lazily extracts ZIPs the first time the File Manager is opened, so users
  // can browse/edit files even before ever starting the bot.
  return engine.ensureExtracted(bot, bot.id);
}

// Resolves a user-supplied relative path against botDir, rejecting any
// attempt to climb outside of it (../, absolute paths, symlink escapes, etc).
function safeResolve(botDir, relPath) {
  const clean = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(botDir, clean);
  const rootResolved = path.resolve(botDir);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error('Invalid path');
  }
  return abs;
}

function isLikelyBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function refreshStorage(botId, botDir) {
  try {
    const size = engine.getDirSize(botDir);
    db.prepare('UPDATE bots SET storage_used = ? WHERE id = ?').run(size, botId);
    return size;
  } catch { return null; }
}

function planLimitFor(userId) {
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
  return PLAN_LIMITS[user && user.plan] || PLAN_LIMITS.free;
}

// Mutating routes call this first — blocks admins from writing to a bot
// folder they're only allowed to view.
function blockIfAdminView(req, res) {
  if (req.isAdminView) { res.json({ success: false, message: 'Read-only: admin view of another user\'s bot' }); return true; }
  return false;
}

// All routes need auth + a real bot + an existing working directory.
router.use(requireAuth, (req, res, next) => {
  const result = loadBotOr404(req, res);
  if (!result) return;
  const { bot, isAdminView } = result;
  if (!bot.file_path) return res.json({ success: false, message: 'Upload a bot file first — then you can manage its files here.' });
  let botDir;
  try {
    botDir = getBotDir(bot);
  } catch (e) {
    return res.json({ success: false, message: `Could not open bot files: ${e.message}` });
  }
  req.bot = bot;
  req.botDir = botDir;
  req.isAdminView = isAdminView;
  next();
});

// GET /api/bots/:id/files?dir=relative/path — list a directory
router.get('/', (req, res) => {
  try {
    const dirAbs = safeResolve(req.botDir, req.query.dir || '');
    if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
      return res.json({ success: false, message: 'Folder not found' });
    }
    const entries = fs.readdirSync(dirAbs, { withFileTypes: true })
      .filter(e => e.name !== '.git' && e.name !== '.karl_proxies.txt')
      .map(e => {
        const full = path.join(dirAbs, e.name);
        let size = null, modified = null;
        try {
          const st = fs.statSync(full);
          modified = st.mtime.toISOString();
          size = e.isDirectory() ? null : st.size;
        } catch {}
        return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size, modified };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ success: true, dir: req.query.dir || '', entries });
  } catch (e) {
    res.json({ success: false, message: e.message || 'Failed to list folder' });
  }
});

// GET /api/bots/:id/files/content?path=relative/file — read a text file
router.get('/content', (req, res) => {
  try {
    const fileAbs = safeResolve(req.botDir, req.query.path || '');
    if (!fs.existsSync(fileAbs) || !fs.statSync(fileAbs).isFile()) {
      return res.json({ success: false, message: 'File not found' });
    }
    const stat = fs.statSync(fileAbs);
    if (stat.size > MAX_EDIT_BYTES) {
      return res.json({ success: false, message: `File is too large to edit here (${(stat.size / 1024 / 1024).toFixed(1)}MB, limit 2MB). Re-upload it instead.` });
    }
    const buf = fs.readFileSync(fileAbs);
    if (isLikelyBinary(buf)) {
      return res.json({ success: false, message: 'This looks like a binary file — it can\'t be edited as text. Delete and re-upload to replace it.' });
    }
    res.json({ success: true, path: req.query.path, content: buf.toString('utf8'), size: stat.size });
  } catch (e) {
    res.json({ success: false, message: e.message || 'Failed to read file' });
  }
});

// POST /api/bots/:id/files/content  { path, content } — save (overwrite) a text file
router.post('/content', express.json({ limit: '3mb' }), (req, res) => {
  if (blockIfAdminView(req, res)) return;
  try {
    const { path: relPath, content } = req.body || {};
    if (!relPath) return res.json({ success: false, message: 'No file path given' });
    const fileAbs = safeResolve(req.botDir, relPath);
    if (Buffer.byteLength(content || '', 'utf8') > MAX_EDIT_BYTES) {
      return res.json({ success: false, message: 'Content exceeds the 2MB editor limit' });
    }
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, content || '', 'utf8');
    const size = refreshStorage(req.bot.id, req.botDir);
    if (size !== null && size > planLimitFor(req.session.userId)) {
      return res.json({ success: false, message: 'Saved, but you are now over your plan\'s storage limit — free up space or upgrade.' });
    }
    res.json({ success: true, message: 'Saved' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'Failed to save file' });
  }
});

// POST /api/bots/:id/files/folder  { path } — create a new folder
router.post('/folder', express.json(), (req, res) => {
  if (blockIfAdminView(req, res)) return;
  try {
    const { path: relPath } = req.body || {};
    if (!relPath) return res.json({ success: false, message: 'Folder name is required' });
    const abs = safeResolve(req.botDir, relPath);
    if (fs.existsSync(abs)) return res.json({ success: false, message: 'That name already exists' });
    fs.mkdirSync(abs, { recursive: true });
    res.json({ success: true, message: 'Folder created' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'Failed to create folder' });
  }
});

// POST /api/bots/:id/files/file  { path } — create a new empty file
router.post('/file', express.json(), (req, res) => {
  if (blockIfAdminView(req, res)) return;
  try {
    const { path: relPath } = req.body || {};
    if (!relPath) return res.json({ success: false, message: 'File name is required' });
    const abs = safeResolve(req.botDir, relPath);
    if (fs.existsSync(abs)) return res.json({ success: false, message: 'That name already exists' });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
    refreshStorage(req.bot.id, req.botDir);
    res.json({ success: true, message: 'File created' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'Failed to create file' });
  }
});

// POST /api/bots/:id/files/rename  { path, newName } — rename a file or folder in place
router.post('/rename', express.json(), (req, res) => {
  if (blockIfAdminView(req, res)) return;
  try {
    const { path: relPath, newName } = req.body || {};
    if (!relPath || !newName) return res.json({ success: false, message: 'Path and new name are required' });
    if (/[\\/]/.test(newName)) return res.json({ success: false, message: 'New name cannot contain slashes' });
    const fromAbs = safeResolve(req.botDir, relPath);
    const toAbs = safeResolve(req.botDir, path.join(path.dirname(relPath), newName));
    if (!fs.existsSync(fromAbs)) return res.json({ success: false, message: 'Not found' });
    if (fs.existsSync(toAbs)) return res.json({ success: false, message: 'That name already exists' });
    fs.renameSync(fromAbs, toAbs);
    res.json({ success: true, message: 'Renamed' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'Failed to rename' });
  }
});

// DELETE /api/bots/:id/files  { path } — delete a file or folder (recursive)
router.delete('/', express.json(), (req, res) => {
  if (blockIfAdminView(req, res)) return;
  try {
    const { path: relPath } = req.body || {};
    if (!relPath) return res.json({ success: false, message: 'No path given' });
    const abs = safeResolve(req.botDir, relPath);
    if (abs === path.resolve(req.botDir)) return res.json({ success: false, message: 'Cannot delete the bot\'s root folder' });
    if (!fs.existsSync(abs)) return res.json({ success: false, message: 'Not found' });
    fs.rmSync(abs, { recursive: true, force: true });
    refreshStorage(req.bot.id, req.botDir);
    res.json({ success: true, message: 'Deleted' });
  } catch (e) {
    res.json({ success: false, message: e.message || 'Failed to delete' });
  }
});

// POST /api/bots/:id/files/upload  (multipart: file, dir) — upload a file into a folder
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

router.post('/upload', (req, res, next) => { if (blockIfAdminView(req, res)) return; next(); }, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, message: 'No file received' });
    const targetDirRel = req.body.dir || '';
    const dirAbs = safeResolve(req.botDir, targetDirRel);
    fs.mkdirSync(dirAbs, { recursive: true });
    const destAbs = safeResolve(req.botDir, path.join(targetDirRel, req.file.originalname));

    const limit = planLimitFor(req.session.userId);
    const projectedSize = engine.getDirSize(req.botDir) + req.file.size;
    if (projectedSize > limit) {
      return res.json({ success: false, message: 'This upload would exceed your plan\'s storage limit. Free up space or upgrade.' });
    }

    fs.writeFileSync(destAbs, req.file.buffer);
    refreshStorage(req.bot.id, req.botDir);
    res.json({ success: true, message: `Uploaded ${req.file.originalname}` });
  } catch (e) {
    res.json({ success: false, message: e.message || 'Upload failed' });
  }
});

module.exports = router;
