const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '.data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'karl.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    plan TEXT DEFAULT 'free',
    token TEXT UNIQUE,
    banned INTEGER DEFAULT 0,
    ban_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'stopped',
    pid INTEGER,
    file_path TEXT,
    main_file TEXT DEFAULT 'main.py',
    token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS activation_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    telegram_id TEXT,
    telegram_username TEXT,
    used_by INTEGER DEFAULT NULL,
    used_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS login_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Migrations
try { db.exec('ALTER TABLE bots ADD COLUMN zip_path TEXT'); } catch {}
try { db.exec('ALTER TABLE bots ADD COLUMN restart_count INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN premium_expires_at DATETIME'); } catch {}
try { db.exec('ALTER TABLE activation_tokens ADD COLUMN used_at DATETIME DEFAULT NULL'); } catch {}

// Bootstrap admin
(function() {
  const bcrypt = require('bcryptjs');
  const adminUser = process.env.ADMIN_USERNAME || 'Karluser32';
  const adminPass = process.env.ADMIN_PASSWORD || 'Karlpass32';
  const hashed = bcrypt.hashSync(adminPass, 12);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUser);
  if (existing) {
    db.prepare('UPDATE users SET password = ?, role = ? WHERE username = ?').run(hashed, 'admin', adminUser);
  } else {
    db.prepare('INSERT INTO users (username, password, role, plan) VALUES (?, ?, ?, ?)').run(adminUser, hashed, 'admin', 'premium');
  }
  console.log(`[KARL] Admin account "${adminUser}" ready.`);
})();

module.exports = db;
