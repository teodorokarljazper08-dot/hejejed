const { spawn, spawnSync } = require('child_process');
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
  const ts = new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

// ── Find a working Python 3 binary ────────────────────────────────────────────
function findPython() {
  const candidates = ['python3', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python'];
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && (r.stdout + r.stderr).includes('Python 3')) return bin;
    } catch {}
  }
  return 'python3'; // fallback — let it fail loudly in the log
}

// ── Install requirements synchronously (blocks until done) ───────────────────
function installRequirements(botId, botDir, pythonBin) {
  const reqPath = path.join(botDir, 'requirements.txt');
  if (!fs.existsSync(reqPath)) return true;

  log(botId, `[PIP] Found requirements.txt — installing with ${pythonBin}...`);

  // Try: python3 -m pip install ... --break-system-packages
  // Then retry without --break-system-packages (older pip / venv envs)
  const pipArgs = [
    ['-m', 'pip', 'install', '-r', reqPath, '--break-system-packages', '--quiet', '--no-warn-script-location'],
    ['-m', 'pip', 'install', '-r', reqPath, '--quiet', '--no-warn-script-location'],
    ['-m', 'pip', 'install', '-r', reqPath, '--user', '--quiet', '--no-warn-script-location'],
  ];

  for (const args of pipArgs) {
    try {
      const r = spawnSync(pythonBin, args, {
        cwd: botDir,
        encoding: 'utf8',
        timeout: 300_000,  // 5 min — large deps like torch can take time
        env: {
          ...process.env,
          HOME: botDir,
          PYTHONUNBUFFERED: '1',
          PIP_DISABLE_PIP_VERSION_CHECK: '1',
          PIP_NO_COLOR: '1',
        }
      });

      const out = ((r.stdout || '') + (r.stderr || '')).trim();
      if (out) out.split('\n').forEach(l => { if (l.trim()) log(botId, `[PIP] ${l}`); });

      if (r.status === 0) {
        log(botId, '[PIP] ✅ Requirements installed successfully.');
        return true;
      }

      log(botId, `[PIP] Attempt failed (exit ${r.status}), trying fallback...`);
    } catch (e) {
      log(botId, `[PIP] Error: ${e.message}`);
    }
  }

  log(botId, '[PIP] ⚠️ Could not install all requirements — starting bot anyway.');
  return false;
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

  db.prepare('UPDATE bots SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('starting', botId);

  const pythonBin = findPython();
  log(botId, `[SYS] Python binary: ${pythonBin}`);

  // Install requirements SYNCHRONOUSLY in a worker thread so we don't block Node's event loop
  // but the install fully completes before the bot spawns
  const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

  // Inline worker via data URI trick — simpler: just use setImmediate + sync call in background
  // Since spawnSync is blocking by design we run it via a detached async wrapper
  setImmediate(() => {
    installRequirements(botId, botDir, pythonBin);
    _spawnBot(botId, bot, botDir, mainPath, pythonBin);
  });

  return { ok: true };
}

function _spawnBot(botId, bot, botDir, mainPath, pythonBin = 'python3') {
  const proc = spawn(pythonBin, [mainPath], {
    cwd: botDir,
    env: {
      ...process.env,
      HOME: botDir,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONDONTWRITEBYTECODE: '1',
    }
  });
  const startedAt = Date.now();
  _running.set(botId, { proc, startedAt });
  db.prepare('UPDATE bots SET status=?, pid=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('running', proc.pid, botId);
  log(botId, `[SYS] PID: ${proc.pid}`);
  log(botId, '─'.repeat(40));

  proc.stdout?.on('data', d => log(botId, d.toString().trimEnd()));
  proc.stderr?.on('data', d => log(botId, d.toString().trimEnd()));
  proc.on('close', code => {
    _running.delete(botId);
    db.prepare('UPDATE bots SET status=?, pid=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('stopped', botId);
    log(botId, `─`.repeat(40));
    log(botId, `[SYS] Process exited (code ${code ?? '?'})`);
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

function getLogs(botId, lines = 300) {
  const lp = getLogPath(botId);
  if (!fs.existsSync(lp)) return '';
  const content = fs.readFileSync(lp, 'utf8');
  const all = content.split('\n');
  return all.slice(-lines).join('\n');
}

function getBotDir2(botId) { return getBotDir(botId); }

module.exports = { startBot, stopBot, isRunning, getStartedAt, getLogs, getBotDir: getBotDir2 };
