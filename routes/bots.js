const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');
const db = require('../database');
const { requireAuth } = require('../middleware/auth');
const engine = require('../engine/botRunner');
const router = express.Router();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '.data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const d = path.join(UPLOAD_DIR, String(req.session.userId));
    fs.mkdirSync(d, { recursive: true });
    cb(null, d);
  },
  filename: (req, file, cb) => cb(null, uuidv4() + '_' + file.originalname)
});

const upload = multer({
  storage,
  limits: { fileSize: 65 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.originalname.endsWith('.py') || file.originalname.endsWith('.zip');
    ok ? cb(null, true) : cb(new Error('Only .py and .zip files allowed'));
  }
});

// GET /api/bots
router.get('/', requireAuth, (req, res) => {
  const bots = db.prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  const enriched = bots.map(b => ({ ...b, live: engine.isRunning(b.id) }));
  res.json({ success: true, bots: enriched });
});

// POST /api/bots/create
router.post('/create', requireAuth, upload.single('bot_file'), (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.json({ success: false, message: 'Bot name required' });

    const botId = uuidv4().replace(/-/g, '').slice(0, 16);
    const botDir = engine.getBotDir(botId);
    let mainFile = 'main.py';
    let zipPath = null;

    if (req.file) {
      if (req.file.originalname.endsWith('.zip')) {
        zipPath = req.file.path;
        mainFile = 'main.py';
      } else {
        const dest = path.join(botDir, req.file.originalname);
        fs.copyFileSync(req.file.path, dest);
        fs.unlinkSync(req.file.path);
        mainFile = req.file.originalname;
      }
    } else {
      fs.writeFileSync(path.join(botDir, 'main.py'),
        '# Karl Hosting - Default Bot\nimport time\nprint("Bot started!")\nwhile True:\n    time.sleep(10)\n');
    }

    db.prepare('INSERT INTO bots (id, user_id, name, main_file, file_path, zip_path) VALUES (?, ?, ?, ?, ?, ?)')
      .run(botId, req.user.id, name, mainFile, req.file?.path || null, zipPath);

    res.json({ success: true, botId, hasZip: !!zipPath });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// POST /api/bots/:id/extract
router.post('/:id/extract', requireAuth, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  if (!bot.zip_path || !fs.existsSync(bot.zip_path))
    return res.json({ success: false, message: 'No zip file found' });

  try {
    const botDir = engine.getBotDir(bot.id);
    const zip = new AdmZip(bot.zip_path);
    const entries = zip.getEntries();

    const roots = new Set(entries.map(e => e.entryName.split('/')[0]));
    const stripRoot = roots.size === 1 && entries.some(e => e.isDirectory && e.entryName === [...roots][0] + '/');

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      let name = entry.entryName;
      if (stripRoot) name = name.split('/').slice(1).join('/');
      if (!name) continue;
      const dest = path.join(botDir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }

    const files = fs.readdirSync(botDir);
    const mainFile = files.find(f => f === 'main.py') || files.find(f => f.endsWith('.py')) || 'main.py';
    db.prepare('UPDATE bots SET main_file=?, zip_path=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(mainFile, bot.id);
    try { fs.unlinkSync(bot.zip_path); } catch {}

    res.json({ success: true, message: `Extracted ${entries.length} files. Main: ${mainFile}` });
  } catch (e) {
    res.json({ success: false, message: 'Extract failed: ' + e.message });
  }
});

// POST /api/bots/:id/start
router.post('/:id/start', requireAuth, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  if (bot.zip_path) return res.json({ success: false, message: 'Extract the zip file first' });
  const result = engine.startBot(bot.id);
  res.json(result);
});

// POST /api/bots/:id/stop
router.post('/:id/stop', requireAuth, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const result = engine.stopBot(bot.id);
  res.json(result);
});

// GET /api/bots/:id/logs
router.get('/:id/logs', requireAuth, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  res.json({ success: true, logs: engine.getLogs(bot.id) });
});

// GET /api/bots/:id
router.get('/:id', requireAuth, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const startedAt = engine.getStartedAt(bot.id);
  res.json({ success: true, bot: { ...bot, live: engine.isRunning(bot.id),
    uptime: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0 }});
});

// DELETE /api/bots/:id
router.delete('/:id', requireAuth, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  engine.stopBot(bot.id);
  // Clean up bot files from disk
  try {
    const botDir = engine.getBotDir(bot.id);
    fs.rmSync(botDir, { recursive: true, force: true });
  } catch {}
  db.prepare('DELETE FROM bots WHERE id = ?').run(bot.id);
  res.json({ success: true });
});

// GET /api/bots/:id/files
router.get('/:id/files', requireAuth, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const botDir = engine.getBotDir(bot.id);
  try {
    const files = fs.readdirSync(botDir)
      .filter(f => !f.startsWith('.'))
      .map(f => {
        const stat = fs.statSync(path.join(botDir, f));
        return { name: f, size: stat.size, isDir: stat.isDirectory() };
      });
    res.json({ success: true, files });
  } catch { res.json({ success: true, files: [] }); }
});

// ── File manager helpers ──────────────────────────────────────────────────────
function safeInBot(botDir, relPath) {
  // Prevent path traversal — ensure resolved path stays inside botDir
  const resolved = path.resolve(botDir, relPath);
  if (!resolved.startsWith(path.resolve(botDir))) return null;
  return resolved;
}

// GET /api/bots/:id/files          — list all files (recursive)
router.get('/:id/files', requireAuth, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const botDir = engine.getBotDir(bot.id);

  function walk(dir, base = '') {
    let results = [];
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return results; }
    for (const f of entries) {
      if (f.startsWith('.') || f === 'output.log') continue;
      const full = path.join(dir, f);
      const rel  = base ? `${base}/${f}` : f;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        results.push({ name: f, path: rel, isDir: true, size: 0 });
        results = results.concat(walk(full, rel));
      } else {
        results.push({ name: f, path: rel, isDir: false, size: stat.size });
      }
    }
    return results;
  }

  res.json({ success: true, files: walk(botDir) });
});

// GET /api/bots/:id/file?path=...  — read file content
router.get('/:id/file', requireAuth, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const botDir = engine.getBotDir(bot.id);
  const target = safeInBot(botDir, req.query.path || '');
  if (!target) return res.json({ success: false, message: 'Invalid path' });
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory())
    return res.json({ success: false, message: 'File not found' });
  try {
    const content = fs.readFileSync(target, 'utf8');
    res.json({ success: true, content });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// POST /api/bots/:id/file          — write / create file  { path, content }
router.post('/:id/file', requireAuth, express.json(), (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const botDir = engine.getBotDir(bot.id);
  const target = safeInBot(botDir, req.body.path || '');
  if (!target) return res.json({ success: false, message: 'Invalid path' });
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, req.body.content ?? '', 'utf8');
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// DELETE /api/bots/:id/file?path=... — delete a file
router.delete('/:id/file', requireAuth, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const botDir = engine.getBotDir(bot.id);
  const target = safeInBot(botDir, req.query.path || '');
  if (!target) return res.json({ success: false, message: 'Invalid path' });
  try {
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// POST /api/bots/:id/rename        — rename / move  { from, to }
router.post('/:id/rename', requireAuth, express.json(), (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  const botDir = engine.getBotDir(bot.id);
  const from = safeInBot(botDir, req.body.from || '');
  const to   = safeInBot(botDir, req.body.to   || '');
  if (!from || !to) return res.json({ success: false, message: 'Invalid path' });
  if (!fs.existsSync(from)) return res.json({ success: false, message: 'Source not found' });
  if (fs.existsSync(to))    return res.json({ success: false, message: 'Destination already exists' });
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

module.exports = router;
            
