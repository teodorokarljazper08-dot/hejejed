require('dotenv').config();
const express = require('express');
const fs = require('fs');
// Ensure persistent data directories exist
const DATA_DIR = process.env.DATA_DIR || '/data';
['uploads', 'extracted'].forEach(sub => {
  fs.mkdirSync(require('path').join(DATA_DIR, sub), { recursive: true });
});
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const db = require('./database');
const authRoutes = require('./routes/auth');
const botRoutes = require('./routes/bots');
const fileRoutes = require('./routes/files');
const adminRoutes = require('./routes/admin');
const proxyRoutes = require('./routes/proxies');
const announcementRoutes = require('./routes/announcements');
const envVarRoutes = require('./routes/envvars');
const { requireAuth, requireGuest, isAdminUser } = require('./middleware/auth');
const { cloudflareMiddleware, getRecentAttacks, getTopAttackers } = require('./middleware/cloudflare');
const telegramBot = require('./bot/telegram');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Cloudflare proxy
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '70mb' }));
app.use(express.urlencoded({ extended: true, limit: '70mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Cloudflare DDoS protection (apply to all routes)
app.use(cloudflareMiddleware);

app.use(session({
  secret: process.env.SESSION_SECRET || 'karl-super-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, keyGenerator: (req) => req.realIP || req.ip });
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/bots', botRoutes);
app.use('/api/bots/:id/files', fileRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/proxies', proxyRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/bots/:id/env', envVarRoutes);

// ── Admin account bootstrap ──────────────────────────────────────
// Reads ADMIN_USERNAME / ADMIN_PASSWORD from environment variables (set
// these in Railway → Variables — NEVER commit real credentials into code
// that goes to a public GitHub repo) and makes sure that account exists
// with admin rights. Runs on every boot; re-syncs the password if you
// change the env var, so the account always matches what's configured.
(function ensureAdminAccount() {
  const username = process.env.ADMIN_USERNAME || 'Karluser32';
  const plainPassword = process.env.ADMIN_PASSWORD || 'Karlpass32';
  if (!username || !plainPassword) {
    console.log('[KARL] ADMIN_USERNAME / ADMIN_PASSWORD not set in env — skipping admin bootstrap.');
    return;
  }
  const bcrypt = require('bcryptjs');
  const hashed = bcrypt.hashSync(plainPassword, 12);
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE users SET password = ?, email_verified = 1 WHERE id = ?').run(hashed, existing.id);
    console.log(`[KARL] Admin account "${username}" verified (password synced from env).`);
  } else {
    db.prepare('INSERT INTO users (username, email, password, plan, email_verified) VALUES (?, ?, ?, ?, 1)')
      .run(username, `${username.toLowerCase()}@karl.local`, hashed, 'premium');
    console.log(`[KARL] Admin account "${username}" created.`);
  }
})();

// ── Security dashboard (admin only) ───────────────────────────
app.get('/api/security/attacks', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!isAdminUser(user)) {
    return res.json({ success: false, message: 'Admin access only. Contact support if you think this is an error.' });
  }
  const attacks = getRecentAttacks(100);
  const topAttackers = getTopAttackers(20);
  res.json({ success: true, attacks, topAttackers });
});

app.get('/api/security/ip', (req, res) => {
  // Returns caller's detected IP (useful for debugging Cloudflare setup)
  res.json({
    realIP: req.realIP,
    cfMeta: req.cfMeta,
    raw: req.socket.remoteAddress
  });
});

// ── Pages ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/login', requireGuest, (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/register', requireGuest, (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!isAdminUser(user)) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/bot/create', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'create-bot.html')));
app.get('/bot/view/:id', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'bot.html')));
app.get('/bot/edit/:id', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'bot.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));
app.get('/verify-email', requireGuest, (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/forgot-password', requireGuest, (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/reset-password', requireGuest, (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/status', (req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));

// Public status API — shows bot names + status only (no tokens/IDs)
app.get('/api/status', (req, res) => {
  const bots = db.prepare("SELECT name, status, uptime_start FROM bots ORDER BY name").all();
  res.json({ success: true, bots });
});
app.get('/security', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'security.html')));

// Public token check — used by the signup form to validate before submitting
app.get('/api/auth/check-token', (req, res) => {
  const token = String(req.query.token || '').trim().toUpperCase();
  if (!token) return res.json({ valid: false, message: 'No token provided' });
  const row = db.prepare('SELECT used_by FROM activation_tokens WHERE token = ?').get(token);
  if (!row) return res.json({ valid: false, message: 'Token not found' });
  if (row.used_by) return res.json({ valid: false, message: 'Token already used' });
  return res.json({ valid: true, message: 'Token is valid ✓' });
});

app.get('/api/admin/stats', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const { isAdminUser } = require('./middleware/auth');
  if (!isAdminUser(user)) return res.json({ success: false, message: 'Admin only' });
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  const premiumUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE plan = 'premium'").get().c;
  const bannedUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE banned = 1").get().c;
  const totalBots = db.prepare("SELECT COUNT(*) as c FROM bots").get().c;
  const runningBots = db.prepare("SELECT COUNT(*) as c FROM bots WHERE status = 'running'").get().c;
  const newUsersToday = db.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= date('now')").get().c;
  const newUsersWeek = db.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= date('now', '-7 days')").get().c;
  res.json({ success: true, stats: { totalUsers, premiumUsers, bannedUsers, totalBots, runningBots, newUsersToday, newUsersWeek } });
});

app.get('/api/me', requireAuth, (req, res) => {
  db.syncExpiredPlans();
  const user = db.prepare('SELECT id, username, email, plan, created_at, trial_started_at, premium_expires_at FROM users WHERE id = ?').get(req.session.userId);
  let trialDaysLeft = null;
  if (user && user.plan === 'free') {
    const start = user.trial_started_at ? new Date(user.trial_started_at).getTime() : new Date(user.created_at).getTime();
    const msLeft = (start + 7 * 24 * 60 * 60 * 1000) - Date.now();
    trialDaysLeft = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
  }
  res.json({ success: true, user: { ...user, is_admin: isAdminUser(user), trial_days_left: trialDaysLeft } });
});

app.get('/api/me/billing', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM billing_history WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  res.json({ success: true, history: rows });
});

app.listen(PORT, () => {
  console.log(`[KARL] Server running on port ${PORT}`);
  telegramBot.init();
  setInterval(() => {
    // Grab anyone about to be flipped to Free BEFORE syncing, so we can notify them
    try {
      const justExpired = db.prepare(`
        SELECT * FROM users
        WHERE plan = 'premium' AND premium_expires_at IS NOT NULL AND premium_expires_at <= CURRENT_TIMESTAMP
      `).all();
      db.syncExpiredPlans();
      justExpired.forEach(u => { try { telegramBot.notifyPlanExpired(u); } catch {} });
    } catch {
      db.syncExpiredPlans();
    }
    // Send expiry warning emails 3 days before plan ends
    try {
      const { sendMail, planExpiryEmail } = require('./services/mailer');
      const expiringSoon = db.prepare(`
        SELECT u.username, u.email, u.plan, u.premium_expires_at, u.email_verified
        FROM users u
        WHERE u.plan = 'premium'
          AND u.email IS NOT NULL AND u.email_verified = 1
          AND u.premium_expires_at IS NOT NULL
          AND datetime(u.premium_expires_at) <= datetime('now', '+3 days')
          AND datetime(u.premium_expires_at) > datetime('now')
      `).all();
      expiringSoon.forEach(u => {
        const expiresAt = new Date(u.premium_expires_at).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
        sendMail({ to: u.email, subject: 'Your KARL plan is expiring soon', html: planExpiryEmail({ username: u.username, plan: u.plan, expiresAt }) });
      });
    } catch {}
  }, 5 * 60 * 1000);
});
