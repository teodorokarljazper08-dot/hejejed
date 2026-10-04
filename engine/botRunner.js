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

// ── Find a working Python 3 binary ────────────────────────────────────────────
function findPython() {
  // On Railway nixpacks, python3 is in /nix/store but pip lives separately.
  // We need a python3 that has pip bundled — check pip first.
  const { execSync } = require('child_process');

  // 1. Try to find python3 that has pip working
  const candidates = ['python3', 'python3.12', 'python3.11', 'python3.10', 'python'];
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['-m', 'pip', '--version'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) return bin; // this python has pip — use it
    } catch {}
  }

  // 2. Try to find pip3/pip directly and get the python it belongs to
  try {
    const pipPath = execSync('which pip3 || which pip || find /usr -name pip3 -type f 2>/dev/null | head -1', { encoding: 'utf8', timeout: 5000 }).trim();
    if (pipPath) {
      // Get the python associated with this pip
      const pyPath = pipPath.replace('/pip3','').replace('/pip','') + '/python3';
      const r = spawnSync(pyPath, ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0) return pyPath;
    }
  } catch {}

  // 3. Search nix store for a python3 with pip
  try {
    const found = execSync(
      'find /nix/store -maxdepth 4 -name "python3*" -type f 2>/dev/null | head -5',
      { encoding: 'utf8', timeout: 5000 }
    ).trim().split('\n');
    for (const bin of found) {
      if (!bin) continue;
      const r = spawnSync(bin, ['-m', 'pip', '--version'], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0) return bin;
    }
  } catch {}

  // 4. Last resort — use python3 even without pip (bot may still run if no requirements)
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0 && (r.stdout + r.stderr).includes('Python 3')) return bin;
    } catch {}
  }
  return 'python3';
}

// ── Find pip binary directly (fallback when -m pip fails) ─────────────────────
function findPip() {
  const { execSync } = require('child_process');
  const candidates = ['pip3', 'pip', 'pip3.12', 'pip3.11', 'pip3.10'];
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0) return bin;
    } catch {}
  }
  try {
    const found = execSync(
      'find /nix/store -maxdepth 5 -name "pip3" -type f 2>/dev/null | head -3',
      { encoding: 'utf8', timeout: 5000 }
    ).trim().split('\n');
    for (const bin of found) {
      if (!bin) continue;
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0) return bin;
    }
  } catch {}
  return null;
}

// ── Install requirements synchronously (blocks until done) ───────────────────
function installRequirements(botId, botDir, pythonBin) {
  const reqPath = path.join(botDir, 'requirements.txt');
  if (!fs.existsSync(reqPath)) return true;

  log(botId, `[PIP] Found requirements.txt — installing with ${pythonBin}...`);

  // Try: python3 -m pip install ... --break-system-packages
  // Then retry without --break-system-packages (older pip / venv envs)
  const ENV = {
    ...process.env,
    HOME: botDir,
    PYTHONUNBUFFERED: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_COLOR: '1',
  };
  const OPTS = { cwd: botDir, encoding: 'utf8', timeout: 300_000, env: ENV };

  // Build list of install attempts:
  // [binary, args[]]
  const attempts = [
    [pythonBin, ['-m', 'pip', 'install', '-r', reqPath, '--break-system-packages', '-q', '--no-warn-script-location']],
    [pythonBin, ['-m', 'pip', 'install', '-r', reqPath, '-q', '--no-warn-script-location']],
    [pythonBin, ['-m', 'pip', 'install', '-r', reqPath, '--user', '-q', '--no-warn-script-location']],
  ];

  // Also try direct pip binary if found
  const pipBin = findPip();
  if (pipBin) {
    attempts.push([pipBin, ['install', '-r', reqPath, '--break-system-packages', '-q']]);
    attempts.push([pipBin, ['install', '-r', reqPath, '-q']]);
  }

  for (const [bin, args] of attempts) {
    try {
      log(botId, `[PIP] Trying: ${bin} ${args.slice(0,2).join(' ')} ...`);
      const r = spawnSync(bin, args, OPTS);
      const out = ((r.stdout || '') + (r.stderr || '')).trim();
      if (out) out.split('\n').forEach(l => { if (l.trim()) log(botId, `[PIP] ${l}`); });
      if (r.status === 0) {
        log(botId, '[PIP] ✅ Requirements installed successfully.');
        return true;
      }
      log(botId, `[PIP] Attempt failed (exit ${r.status}), trying next...`);
    } catch (e) {
      log(botId, `[PIP] Error: ${e.message}`);
    }
  }

  log(botId, '[PIP] ⚠️ Could not install requirements — starting bot anyway.');
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
  
