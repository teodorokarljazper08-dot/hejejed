const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { getUsableProxies, toLine } = require('../utils/proxyPool');

// Dropped into a bot's folder (as karl_proxy.py) the first time its proxy
// rotator is enabled, so the bot's own code can use the assigned proxies
// with zero setup: `import karl_proxy; session = karl_proxy.get_session()`.
// Only written once — re-editing it yourself is safe, it won't be overwritten.
const KARL_PROXY_HELPER_SOURCE = `"""
karl_proxy.py — generated once by KARL when you enabled the proxy rotator
for this bot. Feel free to edit; it won't be overwritten.

Usage:
    import karl_proxy

    proxy = karl_proxy.get_proxy()        # "http://user:pass@host:port" or None
    session = karl_proxy.get_session()    # requests.Session() with it applied
    karl_proxy.rotate()                   # advance to the next proxy
"""
import os
import threading

_PROXY_FILE = os.environ.get("KARL_PROXY_FILE")
_lock = threading.Lock()
_proxies = []
_index = 0


def _load():
    global _proxies
    if not _PROXY_FILE or not os.path.exists(_PROXY_FILE):
        return
    lines = []
    with open(_PROXY_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(":")
            if len(parts) == 4:
                host, port, user, pwd = parts
                lines.append(f"http://{user}:{pwd}@{host}:{port}")
            elif len(parts) == 2:
                host, port = parts
                lines.append(f"http://{host}:{port}")
    _proxies = lines


_load()


def count():
    """How many proxies are loaded."""
    return len(_proxies)


def get_proxy():
    """Returns the current proxy URL, or None if proxies are off / empty."""
    with _lock:
        if not _proxies:
            return None
        return _proxies[_index % len(_proxies)]


def rotate():
    """Advance to the next proxy in the pool and return it."""
    global _index
    with _lock:
        if _proxies:
            _index = (_index + 1) % len(_proxies)
    return get_proxy()


def get_session():
    """A requests.Session pre-configured with the current proxy."""
    import requests
    s = requests.Session()
    p = get_proxy()
    if p:
        s.proxies.update({"http": p, "https": p})
    return s
`;

const runningBots = new Map();
const MAX_RESTART_ATTEMPTS = 10;
const BASE_RESTART_DELAY_MS = 3000;
const MAX_LOG_BUFFER = 500;

let _pythonCmd = null;
let _pipCmd = null;

function findPython() {
  if (_pythonCmd) return _pythonCmd;
  const candidates = ['python3', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python'];
  for (const cmd of candidates) {
    try {
      const out = execSync(`${cmd} --version 2>&1`, { timeout: 5000 }).toString().trim();
      if (out.startsWith('Python 3')) {
        _pythonCmd = cmd;
        return cmd;
      }
    } catch {}
  }
  const nixPaths = [
    '/nix/var/nix/profiles/default/bin/python3',
    '/run/current-system/sw/bin/python3',
    '/usr/bin/python3',
    '/usr/local/bin/python3',
  ];
  for (const p of nixPaths) {
    if (fs.existsSync(p)) {
      try {
        const out = execSync(`${p} --version 2>&1`, { timeout: 5000 }).toString().trim();
        if (out.startsWith('Python 3')) { _pythonCmd = p; return p; }
      } catch {}
    }
  }
  try {
    const found = execSync('find /nix -name "python3" -type f 2>/dev/null | head -1', { timeout: 8000 }).toString().trim();
    if (found) { _pythonCmd = found; return found; }
  } catch {}
  return null;
}

function findPip(pythonCmd) {
  if (_pipCmd) return _pipCmd;
  if (!pythonCmd) return null;
  const pipCandidates = ['pip3', 'pip3.12', 'pip3.11', 'pip3.10', 'pip'];
  for (const cmd of pipCandidates) {
    try {
      execSync(`${cmd} --version 2>&1`, { timeout: 5000 });
      _pipCmd = cmd;
      return cmd;
    } catch {}
  }
  try {
    execSync(`${pythonCmd} -m pip --version 2>&1`, { timeout: 5000 });
    _pipCmd = `${pythonCmd} -m pip`;
    return _pipCmd;
  } catch {}
  try {
    const pipPath = execSync(`find /nix -name "pip3" -type f 2>/dev/null | head -1`, { timeout: 8000 }).toString().trim();
    if (pipPath) { _pipCmd = pipPath; return pipPath; }
  } catch {}
  return null;
}

function resetCmdCache() {
  _pythonCmd = null;
  _pipCmd = null;
}

async function ensurePythonReady(botId) {
  return new Promise((resolve) => {
    const py = findPython();
    if (py) {
      appendLog(botId, `Python found: ${py}`, 'info');
      resolve(true);
      return;
    }
    appendLog(botId, 'Python not found in PATH — attempting install via pip/nix...', 'warn');
    const nixInstall = spawn('nix-env', ['-iA', 'nixpkgs.python312', 'nixpkgs.python312Packages.pip'], {
      env: { ...process.env }
    });
    nixInstall.stdout.on('data', d => appendLog(botId, d.toString().trim(), 'info'));
    nixInstall.stderr.on('data', d => {
      const l = d.toString().trim();
      if (l) appendLog(botId, l, 'warn');
    });
    nixInstall.on('close', code => {
      resetCmdCache();
      if (findPython()) {
        appendLog(botId, 'Python installed successfully', 'info');
        resolve(true);
      } else {
        appendLog(botId, 'Could not install Python. Check Railway build config — add python3 to nixpacks.toml', 'error');
        resolve(false);
      }
    });
    nixInstall.on('error', () => {
      appendLog(botId, 'Python not available and nix-env not found. Rebuild the Railway deployment.', 'error');
      resolve(false);
    });
  });
}

// Maps an imported module name to the PyPI package that actually provides it,
// for the common cases where they differ (e.g. "import telegram" comes from
// the PyPI package "python-telegram-bot", not a package literally called
// "telegram"). Anything not listed here is assumed to match its import name.
const IMPORT_TO_PACKAGE = {
  // Telegram bot frameworks
  telegram: 'python-telegram-bot',
  telebot: 'pyTelegramBotAPI',
  aiogram: 'aiogram',
  pyrogram: 'pyrogram',
  telethon: 'telethon',

  // Discord
  discord: 'discord.py',

  // Web / HTTP
  bs4: 'beautifulsoup4',
  aiohttp: 'aiohttp',
  httpx: 'httpx',
  requests: 'requests',
  flask: 'flask',
  fastapi: 'fastapi',
  uvicorn: 'uvicorn',
  starlette: 'starlette',
  flask_cors: 'Flask-Cors',
  socketio: 'python-socketio',

  // Data / ML
  cv2: 'opencv-python-headless',
  PIL: 'Pillow',
  sklearn: 'scikit-learn',
  numpy: 'numpy',
  pandas: 'pandas',
  matplotlib: 'matplotlib',
  scipy: 'scipy',

  // Config / Env
  yaml: 'PyYAML',
  dotenv: 'python-dotenv',
  toml: 'toml',

  // Crypto / Auth
  Crypto: 'pycryptodome',
  Cryptodome: 'pycryptodome',
  jwt: 'PyJWT',
  nacl: 'PyNaCl',

  // Database
  redis: 'redis',
  pymongo: 'pymongo',
  motor: 'motor',
  sqlalchemy: 'SQLAlchemy',
  psycopg2: 'psycopg2-binary',
  pymysql: 'PyMySQL',
  aiosqlite: 'aiosqlite',

  // Utilities
  dateutil: 'python-dateutil',
  pytz: 'pytz',
  serial: 'pyserial',
  aiofiles: 'aiofiles',
  apscheduler: 'APScheduler',
  cachetools: 'cachetools',
  pydantic: 'pydantic',
  tqdm: 'tqdm',
  loguru: 'loguru',

  // AI / Cloud
  google: 'google-api-python-client',
  openai: 'openai',
  anthropic: 'anthropic',
  g4f: 'g4f',
};

// Modules that are part of the Python standard library (or otherwise never
// need installing) — these must NEVER be sent to pip, or installs will fail
// on bogus package names.
const STDLIB_MODULES = new Set([
  'os','sys','re','time','json','math','random','datetime','collections','itertools',
  'functools','typing','asyncio','threading','subprocess','pathlib','logging','io',
  'string','copy','enum','abc','traceback','uuid','hashlib','base64','socket','struct',
  'sqlite3','csv','xml','http','urllib','email','unittest','argparse','shutil','tempfile',
  'glob','pickle','queue','multiprocessing','signal','platform','getpass','configparser',
  'zipfile','tarfile','gzip','contextlib','dataclasses','warnings','inspect','importlib',
  'textwrap','decimal','fractions','statistics','secrets','heapq','bisect','array',
  'weakref','gc','ctypes','select','ssl','ftplib','smtplib','imaplib','poplib','telnetlib',
  'webbrowser','cmd','shlex','operator','types','numbers','keyword','token','tokenize',
  'ast','dis','symtable','codeop','code','pprint','reprlib','this',
  // additional stdlib entries bots commonly use
  'html','ntpath','posixpath','atexit','builtins','concurrent','cProfile',
  'profile','pdb','timeit','mimetypes','xmlrpc','wsgiref','doctest',
  'readline','sysconfig','errno','faulthandler','abc',
]);

// Scans every .py file in the bot's folder for top-level "import x" / "from x
// import y" statements and returns the set of third-party module names that
// are actually used — so we can auto-install them even when the user never
// uploaded a requirements.txt. This is what lets a bare "from telegram import
// Update" just work with zero setup from the user.
function detectImports(botDir) {
  const found = new Set();
  const importRe = /^\s*(?:import\s+([a-zA-Z0-9_.]+)(?:\s+as\s+\w+)?|from\s+([a-zA-Z0-9_.]+)\s+import)/;

  function scanDir(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '__pycache__' || e.name === 'venv') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { scanDir(full, depth + 1); continue; }
      if (!e.name.endsWith('.py')) continue;
      let content;
      try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
      for (const line of content.split('\n')) {
        const m = importRe.exec(line);
        if (m) {
          const mod = (m[1] || m[2]).split('.')[0];
          if (mod && !STDLIB_MODULES.has(mod)) found.add(mod);
        }
      }
    }
  }
  scanDir(botDir, 0);
  return [...found];
}

function pipArgsFor(pythonCmd, pip, packages, extraArgs) {
  const base = ['--quiet', '--disable-pip-version-check', '--no-warn-script-location', '--break-system-packages', ...extraArgs];
  if (pip && pip.includes(' -m pip')) {
    return { bin: pythonCmd, args: ['-m', 'pip', 'install', ...packages, ...base] };
  } else if (pip) {
    return { bin: pip, args: ['install', ...packages, ...base] };
  }
  return null;
}

function runPipInstall(bin, args, botDir, botId, label) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd: botDir, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    proc.stdout.on('data', d => { const l = d.toString().trim(); if (l) appendLog(botId, l, 'info'); });
    proc.stderr.on('data', d => { const l = d.toString().trim(); if (l && !l.startsWith('WARNING')) appendLog(botId, l, 'warn'); });
    proc.on('close', code => {
      if (code === 0) {
        appendLog(botId, `${label} installed`, 'info');
      } else {
        appendLog(botId, `${label} install exited with code ${code} — continuing anyway`, 'warn');
      }
      resolve(true);
    });
    proc.on('error', err => {
      appendLog(botId, `pip spawn error: ${err.message} — continuing anyway`, 'warn');
      resolve(true);
    });
  });
}

async function installDeps(botDir, botId, pythonCmd) {
  const pipInitial = findPip(pythonCmd);
  if (!pipInitial) {
    appendLog(botId, 'pip not found — trying: python -m ensurepip', 'warn');
    try { execSync(`${pythonCmd} -m ensurepip --upgrade 2>&1`, { timeout: 30000 }); resetCmdCache(); } catch {}
  }
  const pipResolved = findPip(pythonCmd);

  // 1. Install from requirements.txt if present (explicit, user-controlled).
  const reqFile = path.join(botDir, 'requirements.txt');
  let declaredPackages = new Set();
  if (fs.existsSync(reqFile)) {
    const lines = fs.readFileSync(reqFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (lines.length) {
      appendLog(botId, `Installing ${lines.length} package(s) from requirements.txt...`, 'info');
      const call = pipResolved && pipResolved.includes(' -m pip')
        ? { bin: pythonCmd, args: ['-m', 'pip', 'install', '-r', reqFile, '--quiet', '--disable-pip-version-check', '--no-warn-script-location', '--break-system-packages'] }
        : pipResolved
          ? { bin: pipResolved, args: ['install', '-r', reqFile, '--quiet', '--disable-pip-version-check', '--no-warn-script-location', '--break-system-packages'] }
          : null;
      if (call) {
        await runPipInstall(call.bin, call.args, botDir, botId, 'requirements.txt packages');
        for (const l of lines) {
          const name = l.split(/[=<>!~\[]/)[0].trim().toLowerCase();
          if (name) declaredPackages.add(name);
        }
      } else {
        appendLog(botId, 'pip unavailable — skipping requirements.txt install', 'warn');
      }
    } else {
      appendLog(botId, 'requirements.txt is empty', 'info');
    }
  } else {
    appendLog(botId, 'No requirements.txt found', 'info');
  }

  // 2. Auto-detect imports from the bot's own source code and install
  // anything missing — this is what makes "from telegram import Update"
  // work even when the user never wrote a requirements.txt at all.
  const imported = detectImports(botDir);
  const toAutoInstall = [];
  for (const mod of imported) {
    const pkgSpec = IMPORT_TO_PACKAGE[mod] || mod;
    const pkgName = pkgSpec.split(/[=<>!~\[]/)[0].toLowerCase();
    if (declaredPackages.has(pkgName)) continue; // already handled by requirements.txt
    // Quick check: is the module already importable? Skip the network round-trip if so.
    try {
      execSync(`${pythonCmd} -c "import ${mod}"`, { timeout: 8000, stdio: 'ignore' });
      continue; // already available, nothing to do
    } catch {}
    toAutoInstall.push(pkgSpec);
  }

  if (toAutoInstall.length) {
    appendLog(botId, `Auto-detected missing import(s) — installing: ${toAutoInstall.join(', ')}`, 'info');
    const call = pipArgsFor(pythonCmd, pipResolved, toAutoInstall, []);
    if (call) {
      await runPipInstall(call.bin, call.args, botDir, botId, 'Auto-detected packages');
    } else {
      appendLog(botId, 'pip unavailable — could not auto-install detected imports', 'warn');
    }
  }

  return true;
}

// ── Bot directory resolution (shared with routes/bots.js and routes/files.js) ──
// A bot's "working directory" is where its code, requirements.txt, and any
// user-managed files live. For a single .py upload it's the folder the file
// sits in. For a .zip upload it's a persistent <zipname>_extracted folder
// (created once, reused afterwards) so the File Manager and the requirements
// uploader and the actual run all agree on the same directory.
function resolveBotDir(bot) {
  if (!bot || !bot.file_path) return null;
  if (bot.file_path.endsWith('.zip')) {
    const dataDir = process.env.DATA_DIR || '/data';
    return path.join(dataDir, 'extracted', String(bot.id));
  }
  return path.dirname(bot.file_path);
}

// Like resolveBotDir, but guarantees the directory exists — extracting the
// ZIP on first access if it hasn't been extracted yet. Safe to call many
// times; extraction only happens once (marked by the folder's existence).
function ensureExtracted(bot, botId) {
  if (!bot || !bot.file_path) return null;
  if (!bot.file_path.endsWith('.zip')) {
    const dir = path.dirname(bot.file_path);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dataDir = process.env.DATA_DIR || '/data';
  const extractDir = path.join(dataDir, 'extracted', String(bot.id));
  if (!fs.existsSync(extractDir)) {
    fs.mkdirSync(extractDir, { recursive: true });
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(bot.file_path);
    zip.extractAllTo(extractDir, true);
    if (botId) appendLog(botId, 'Extracted ZIP', 'info');
  }
  return extractDir;
}

// Recursively sums file sizes under a directory — used to keep storage_used
// accurate after the File Manager adds/edits/removes files.
function getDirSize(dir) {
  let total = 0;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const item of items) {
    const full = path.join(dir, item.name);
    try {
      if (item.isDirectory()) total += getDirSize(full);
      else total += fs.statSync(full).size;
    } catch {}
  }
  return total;
}

function findEntryPoint(botDir, hintFile) {
  if (hintFile && fs.existsSync(hintFile) && hintFile.endsWith('.py')) return hintFile;
  const candidates = ['main.py', 'bot.py', 'index.py', 'run.py', 'app.py', 'start.py', 'n.py'];
  for (const c of candidates) {
    const p = path.join(botDir, c);
    if (fs.existsSync(p)) return p;
  }
  try {
    const sub = fs.readdirSync(botDir);
    for (const item of sub) {
      const full = path.join(botDir, item);
      if (fs.statSync(full).isDirectory()) {
        for (const c of candidates) {
          const p = path.join(full, c);
          if (fs.existsSync(p)) return p;
        }
      }
    }
    const pyFiles = fs.readdirSync(botDir).filter(f => f.endsWith('.py')).sort();
    if (pyFiles.length) return path.join(botDir, pyFiles[0]);
  } catch {}
  return null;
}

function appendLog(botId, message, level = 'info') {
  if (!message || !String(message).trim()) return;
  const trimmed = String(message).slice(0, 2000);
  try { db.prepare('INSERT INTO logs (bot_id, message, level) VALUES (?, ?, ?)').run(botId, trimmed, level); } catch {}
  if (!runningBots.has(botId)) return;
  const state = runningBots.get(botId);
  state.logBuffer.push({ message: trimmed, level, ts: Date.now() });
  if (state.logBuffer.length > MAX_LOG_BUFFER) state.logBuffer.shift();
}

async function startBot(botId) {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
  if (!bot) throw new Error(`Bot ${botId} not found`);
  if (runningBots.has(botId)) await killBot(botId, false);

  const state = { process: null, restartCount: 0, restartTimer: null, logBuffer: [], startedAt: Date.now(), intentionallyStopped: false };
  runningBots.set(botId, state);
  appendLog(botId, `Starting bot "${bot.name}"...`, 'info');
  db.prepare('UPDATE bots SET uptime_start = ? WHERE id = ?').run(Date.now(), botId);
  resetCrashFlag(botId);
  db.prepare("UPDATE bots SET status = 'starting', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(botId);
  await _spawnBot(bot, state);
}

async function _spawnBot(bot, state) {
  const botId = bot.id;
  let botDir, entryPoint;

  if (bot.file_path) {
    if (bot.file_path.endsWith('.py')) {
      entryPoint = bot.file_path;
      botDir = path.dirname(bot.file_path);
    } else if (bot.file_path.endsWith('.zip')) {
      try {
        botDir = ensureExtracted(bot, botId);
      } catch (e) {
        appendLog(botId, `ZIP extract failed: ${e.message}`, 'error');
        db.prepare("UPDATE bots SET status = 'error', pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(botId);
        return;
      }
      entryPoint = findEntryPoint(botDir, bot.entry_file ? path.join(botDir, bot.entry_file) : null);
    } else {
      botDir = path.dirname(bot.file_path);
      entryPoint = bot.file_path;
    }
  }

  if (!entryPoint || !fs.existsSync(entryPoint)) {
    appendLog(botId, 'No Python entry point found. Upload a .py file or a ZIP containing main.py / bot.py.', 'error');
    db.prepare("UPDATE bots SET status = 'error', pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(botId);
    return;
  }


  // ── Trial / subscription check ─────────────────────────────────────────
  const userRow = db.prepare('SELECT plan, trial_started_at FROM users WHERE id = ?').get(bot.user_id);
  if (userRow && userRow.plan === 'free') {
    const trialStart = userRow.trial_started_at ? new Date(userRow.trial_started_at).getTime() : Date.now();
    const trialDays = 7;
    const trialExpired = Date.now() > trialStart + trialDays * 24 * 60 * 60 * 1000;
    if (trialExpired) {
      appendLog(botId, '⏰ Your 7-day free trial has expired. Upgrade to a paid plan to keep your bots running.', 'error');
      db.prepare("UPDATE bots SET status = 'stopped', pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(botId);
      return;
    }
  }

  appendLog(botId, `Entry: ${path.basename(entryPoint)}`, 'info');

  // Write bot env vars to .env file in the bot directory
  try {
    const envVars = db.prepare('SELECT key, value FROM bot_env_vars WHERE bot_id = ?').all(botId);
    if (envVars.length > 0) {
      const envContent = envVars.map(v => `${v.key}=${v.value}`).join('\n');
      const envPath = path.join(path.dirname(entryPoint), '.env');
      fs.writeFileSync(envPath, envContent + '\n');
      appendLog(botId, `Loaded ${envVars.length} environment variable(s)`, 'info');
    }
  } catch (envErr) {
    appendLog(botId, `Could not write .env: ${envErr.message}`, 'warn');
  }

  // Keep storage_used accurate now that ZIPs are fully extracted on disk.
  try {
    const size = getDirSize(botDir);
    if (size) db.prepare('UPDATE bots SET storage_used = ? WHERE id = ?').run(size, botId);
  } catch {}

  const pyReady = await ensurePythonReady(botId);
  if (!pyReady) {
    appendLog(botId, 'Cannot start bot: Python is not available in this environment.', 'error');
    db.prepare("UPDATE bots SET status = 'error', pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(botId);
    return;
  }

  const pythonCmd = findPython();
  await installDeps(botDir, botId, pythonCmd);
  if (state.intentionallyStopped) return;

  // ── Proxy rotator (only if the user enabled it for this bot) ───────────
  let proxyCount = 0;
  let proxyFile = '';
  if (bot.proxy_enabled) {
    try {
      const userRow2 = db.prepare('SELECT plan FROM users WHERE id = ?').get(bot.user_id);
      const { assigned, shared } = getUsableProxies(bot.user_id, userRow2 ? userRow2.plan : 'free');
      const lines = [...assigned, ...shared].map(toLine);
      proxyCount = lines.length;
      if (lines.length) {
        proxyFile = path.join(botDir, '.karl_proxies.txt');
        fs.writeFileSync(proxyFile, lines.join('\n') + '\n');
        appendLog(botId, `Proxy rotator enabled — ${lines.length} proxy(ies) available`, 'info');
      } else {
        appendLog(botId, 'Proxy rotator is enabled but no proxies are assigned to your account yet — request some from the Proxies page.', 'warn');
      }
      const helperPath = path.join(botDir, 'karl_proxy.py');
      if (!fs.existsSync(helperPath)) {
        fs.writeFileSync(helperPath, KARL_PROXY_HELPER_SOURCE);
        appendLog(botId, 'Added karl_proxy.py — import it in your bot to use the rotator', 'info');
      }
    } catch (e) {
      appendLog(botId, `Proxy setup failed: ${e.message}`, 'warn');
    }
  }

  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    BOT_TOKEN: bot.token,
    KARL_BOT_ID: bot.id,
    KARL_BOT_NAME: bot.name,
    KARL_PROXY_ENABLED: bot.proxy_enabled ? '1' : '0',
    KARL_PROXY_FILE: proxyFile,
    KARL_PROXY_COUNT: String(proxyCount)
  };

  appendLog(botId, `Launching with ${pythonCmd}...`, 'info');
  const proc = spawn(pythonCmd, [entryPoint], { cwd: botDir, env });
  state.process = proc;

  db.prepare("UPDATE bots SET status = 'running', pid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(proc.pid, botId);
  appendLog(botId, `Bot running (PID ${proc.pid})`, 'info');

  proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => appendLog(botId, l, 'info')));
  proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => appendLog(botId, l, 'warn')));

  proc.on('close', (code) => {
    if (state.intentionallyStopped) {
      appendLog(botId, 'Bot stopped', 'warn');
      db.prepare("UPDATE bots SET status = 'stopped', pid = NULL, uptime_start = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(botId);
      return;
    }
    // Capture last error lines for debug display
  const lastLogs = db.prepare("SELECT message FROM logs WHERE bot_id = ? AND level IN ('warn','error') ORDER BY id DESC LIMIT 5").all(botId);
  const errorSummary = lastLogs.map(l => l.message).reverse().join(' | ');
  appendLog(botId, `Crashed (exit ${code}) — scheduling restart...`, 'warn');
  if (errorSummary) appendLog(botId, `Last error: ${errorSummary.slice(0, 300)}`, 'error');
    state.restartCount++;
    // Persist restart count to DB so UI can show it
    try { db.prepare('UPDATE bots SET restart_count = restart_count + 1 WHERE id = ?').run(botId); } catch {}
    if (state.restartCount > MAX_RESTART_ATTEMPTS) {
      appendLog(botId, `Max restarts (${MAX_RESTART_ATTEMPTS}) exceeded. Check your bot code.`, 'error');
      db.prepare("UPDATE bots SET status = 'error', pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(botId);
      runningBots.delete(botId);
      // Notify user via Telegram if they haven't been notified yet
      notifyCrash(botId);
      return;
    }
    const delay = Math.min(BASE_RESTART_DELAY_MS * Math.pow(1.5, state.restartCount - 1), 60000);
    appendLog(botId, `Restart #${state.restartCount} in ${(delay / 1000).toFixed(1)}s`, 'warn');
    db.prepare("UPDATE bots SET status = 'restarting', pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(botId);
    state.restartTimer = setTimeout(async () => {
      if (!state.intentionallyStopped) {
        const freshBot = db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
        if (freshBot) await _spawnBot(freshBot, state);
      }
    }, delay);
  });

  proc.on('error', (err) => {
    appendLog(botId, `Spawn error: ${err.message}`, 'error');
    if (err.code === 'ENOENT') {
      appendLog(botId, `"${pythonCmd}" not found — resetting Python path cache`, 'error');
      resetCmdCache();
    }
  });
}

async function killBot(botId, updateDb = true) {
  const state = runningBots.get(botId);
  if (!state) return;
  state.intentionallyStopped = true;
  if (state.restartTimer) { clearTimeout(state.restartTimer); state.restartTimer = null; }
  if (state.process) {
    try { state.process.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { state.process.kill('SIGKILL'); } catch {} }, 3000);
  }
  runningBots.delete(botId);
  if (updateDb) db.prepare("UPDATE bots SET status = 'stopped', pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(botId);
}

function getLiveBuffer(botId) { return (runningBots.get(botId) || {}).logBuffer || []; }
function isRunning(botId) { return runningBots.has(botId); }
function getRunningCount() { return runningBots.size; }
function getStartedAt(botId) { const s = runningBots.get(botId); return s ? s.startedAt : null; }

// ── Crash notification ────────────────────────────────────────────────────
function notifyCrash(botId) {
  try {
    const already = db.prepare('SELECT crash_notified FROM bots WHERE id = ?').get(botId);
    if (already && already.crash_notified) return; // already sent once
    db.prepare('UPDATE bots SET crash_notified = 1 WHERE id = ?').run(botId);
    const { notifyUserCrash } = require('../bot/telegram');
    const bot = db.prepare('SELECT b.*, u.telegram_id FROM bots b JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(botId);
    if (bot && bot.telegram_id) notifyUserCrash(bot);
  } catch {}
}

// Reset crash_notified when a bot is explicitly started (fresh slate)
function resetCrashFlag(botId) {
  try { db.prepare('UPDATE bots SET crash_notified = 0 WHERE id = ?').run(botId); } catch {}
}

// ── Trial expiry enforcer — checks every hour ─────────────────────────────
// Stops any running bot whose owner is on free plan and trial has expired.
setInterval(async () => {
  try {
    const expiredBots = db.prepare(`
      SELECT b.id, b.name FROM bots b
      JOIN users u ON u.id = b.user_id
      WHERE u.plan = 'free'
        AND b.status = 'running'
        AND (CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', u.trial_started_at) AS INTEGER)) > ${7 * 24 * 3600}
    `).all();
    for (const b of expiredBots) {
      try {
        appendLog(b.id, '⏰ Free trial expired — bot stopped automatically. Upgrade to keep running.', 'error');
        await killBot(b.id, true);
      } catch {}
    }
  } catch {}
}, 60 * 60 * 1000); // every hour

// ── Scheduled restart ticker ───────────────────────────────────────────────
// Checks every minute if any running bot has a scheduled_restart time that
// matches the current HH:MM (UTC). If so, restarts it silently.
setInterval(async () => {
  const now = new Date();
  const hhmm = now.toISOString().slice(11, 16); // "HH:MM" UTC
  try {
    const bots = db.prepare("SELECT * FROM bots WHERE scheduled_restart = ? AND status = 'running'").all(hhmm);
    for (const bot of bots) {
      try {
        appendLog(bot.id, `Scheduled restart at ${hhmm} UTC triggered`, 'info');
        await killBot(bot.id, false);
        await startBot(bot.id);
      } catch {}
    }
  } catch {}
}, 60 * 1000);

process.on('SIGTERM', async () => {
  for (const [id] of runningBots) await killBot(id);
  process.exit(0);
});

module.exports = { startBot, killBot, getLiveBuffer, isRunning, getRunningCount, getStartedAt, appendLog, resolveBotDir, ensureExtracted, getDirSize };
