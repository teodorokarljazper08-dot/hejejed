const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || '/data/database.sqlite';
const db = new Database(path.resolve(DB_PATH));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    password TEXT NOT NULL,
    plan TEXT DEFAULT 'free',
    telegram_id TEXT,
    email_verified INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    library TEXT DEFAULT 'telebot_sync',
    status TEXT DEFAULT 'stopped',
    file_path TEXT,
    storage_used INTEGER DEFAULT 0,
    pid INTEGER DEFAULT NULL,
    restart_count INTEGER DEFAULT 0,
    uptime_start INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    message TEXT NOT NULL,
    level TEXT DEFAULT 'info',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS activation_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    telegram_id TEXT UNIQUE NOT NULL,
    telegram_username TEXT,
    used_by INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME DEFAULT NULL,
    FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS ddos_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    country TEXT DEFAULT 'XX',
    cf_ray TEXT,
    hits INTEGER DEFAULT 0,
    path TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ban_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    admin_username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT,
    password TEXT,
    raw TEXT NOT NULL,
    assigned_user_id INTEGER DEFAULT NULL,
    status TEXT DEFAULT 'alive',
    added_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS proxy_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    message TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS email_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    type TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT NOT NULL,
    ip TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    photo_url TEXT DEFAULT NULL,
    active INTEGER DEFAULT 1,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bot_env_vars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
    UNIQUE(bot_id, key)
  );
`);

// Migrations
try { db.exec('ALTER TABLE bots ADD COLUMN pid INTEGER DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE bots ADD COLUMN notes TEXT DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE bots ADD COLUMN scheduled_restart TEXT DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE bots ADD COLUMN crash_notified INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN trial_started_at DATETIME DEFAULT CURRENT_TIMESTAMP'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN activation_token TEXT DEFAULT NULL'); } catch {}
try { db.exec("UPDATE users SET trial_started_at = created_at WHERE trial_started_at IS NULL"); } catch {}
try { db.exec('ALTER TABLE bots ADD COLUMN restart_count INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN ban_reason TEXT DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN banned_at DATETIME DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN premium_expires_at DATETIME DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE bots ADD COLUMN proxy_enabled INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE bots ADD COLUMN uptime_start INTEGER DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN reset_telegram_code TEXT DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN reset_code_expires DATETIME DEFAULT NULL'); } catch {}

// ── Referrals ──────────────────────────────────────────────────────────
try { db.exec('ALTER TABLE users ADD COLUMN referral_count INTEGER DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE activation_tokens ADD COLUMN referred_by TEXT DEFAULT NULL"); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL,
    referred_id INTEGER NOT NULL,
    days_credited INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (referred_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ── Editable "main file" override for ZIP-based bots ────────────────────
try { db.exec('ALTER TABLE bots ADD COLUMN entry_file TEXT DEFAULT NULL'); } catch {}

function syncExpiredPlans() {
  try {
    db.prepare(`
      UPDATE users SET plan = 'free'
      WHERE plan = 'premium'
        AND premium_expires_at IS NOT NULL
        AND premium_expires_at <= CURRENT_TIMESTAMP
    `).run();
  } catch {}
}

try { db.exec('DROP TABLE IF EXISTS payments'); } catch {}

// Billing history — one row per plan grant/removal so admins (and the user
// themselves) can see what plan was applied, when, for how long, and by whom.
db.exec(`
  CREATE TABLE IF NOT EXISTS billing_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan_key TEXT,
    plan_label TEXT NOT NULL,
    amount_label TEXT,
    action TEXT NOT NULL DEFAULT 'grant',
    granted_by TEXT,
    starts_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

db.syncExpiredPlans = syncExpiredPlans;
module.exports = db;
