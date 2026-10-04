const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../database');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '.data');
const BOTS_DIR = path.join(DATA_DIR, 'bots');
fs.mkdirSync(BOTS_DIR, { recursive: true });

const _running = new Map(); // botId -> { proc, startedAt }

function getBotDir(botId) {
  const d = path.join(BOTS_DIR, botId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function getLogPath(botId) { return path.join(getBotDir(botId), 'output.log'); }

function log(botId, msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: true });
  const line = `[${ts}] ${msg}\n`;
  try { fs.appendFileSync(getLogPath(botId), line); } catch {}
}

function isRunning(botId) {
  const r = _running.get(botId);
  if (!r) return false;
  if (r.proc.exitCode !== null) { _running.delete(botId); return false; }
  return true;
}

function getStartedAt(botId) {
  return _running.get(botId)?.startedAt || null;
}

function startBot(botId) {
  if (isRunning(botId)) return { ok: false, error: 'Already running' };
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
  if (!bot) return { ok: false, error: 'Bot not found' };

  const botDir = getBotDir(botId);
  const mainFile = bot.main_file || 'main.py';
  const mainPath = path.join(botDir, mainFile);

  if (!fs.existsSync(mainPath)) return { ok: false, error: `${mainFile} not found` };

  // Clear log
  try { fs.writeFileSync(getLogPath(botId), ''); } catch {}
  log(botId, `Starting bot: ${bot.name}`);
  log(botId, `Main file: ${mainFile}`);

  // Install requirements if exists
  const reqPath = path.join(botDir, 'requirements.txt');
  if (fs.existsSync(reqPath)) {
    log(botId, 'Installing requirements...');
    const pip = spawn('python3', ['-m', 'pip', 'install', '-r', reqPath, '--break-system-packages', '-q'], {
      cwd: botDir, env: { ...process.env, HOME: botDir, PYTHONUNBUFFERED: '1' }
    });
    pip.stdout?.on('data', d => log(botId, d.toString().trim()));
    pip.stderr?.on('data', d => log(botId, d.toString().trim()));
    pip.on('close', code => {
      log(botId, code === 0 ? 'Requirements installed.' : 'Some packages failed.');
      _spawnBot(botId, bot, botDir, mainPath);
    });
  } else {
    _spawnBot(botId, bot, botDir, mainPath);
  }
  db.prepare('UPDATE bots SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('starting', botId);
  return { ok: true };
}

function _spawnBot(botId, bot, botDir, mainPath) {
  const proc = spawn('python3', [mainPath], {
    cwd: botDir,
    env: { ...process.env, HOME: botDir, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
  });
  const startedAt = Date.now();
  _running.set(botId, { proc, startedAt });
  db.prepare('UPDATE bots SET status=?, pid=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('running', proc.pid, botId);
  log(botId, `PID: ${proc.pid}`);
  log(botId, '--- Output ---');

  proc.stdout?.on('data', d => log(botId, d.toString().trimEnd()));
  proc.stderr?.on('data', d => log(botId, d.toString().trimEnd()));
  proc.on('close', code => {
    _running.delete(botId);
    db.prepare('UPDATE bots SET status=?, pid=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('stopped', botId);
    log(botId, `--- Process exited (code ${code}) ---`);
  });
}

function stopBot(botId) {
  const r = _running.get(botId);
  if (!r) return { ok: false, error: 'Not running' };
  r.proc.kill('SIGTERM');
  setTimeout(() => { try { r.proc.kill('SIGKILL'); } catch {} }, 3000);
  _running.delete(botId);
  db.prepare('UPDATE bots SET status=?, pid=NULL WHERE id=?').run('stopped', botId);
  return { ok: true };
}

function getLogs(botId, lines = 200) {
  const lp = getLogPath(botId);
  if (!fs.existsSync(lp)) return '';
  const content = fs.readFileSync(lp, 'utf8');
  const all = content.split('\n');
  return all.slice(-lines).join('\n');
}

function getBotDir2(botId) { return getBotDir(botId); }

module.exports = { startBot, stopBot, isRunning, getStartedAt, getLogs, getBotDir: getBotDir2 };
