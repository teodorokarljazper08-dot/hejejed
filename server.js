require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const db = require('./database');
const { requireAuth, requireGuest, isAdmin } = require('./middleware/auth');
const authRoutes  = require('./routes/auth');
const botRoutes   = require('./routes/bots');
const adminRoutes = require('./routes/admin');
const telegramBot = require('./bot/telegram');

const app  = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET) {
  console.warn('[KARL] WARNING: SESSION_SECRET not set. Sessions will not persist across restarts. Set this env var in Railway.');
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '70mb' }));
app.use(express.urlencoded({ extended: true, limit: '70mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'karl-secret-fallback-set-env-var',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth',  authRoutes);
app.use('/api/bots',  botRoutes);
app.use('/api/admin', adminRoutes);

// Pages
app.get('/',          (req, res) => req.session.userId ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login',     requireGuest, (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/register',  requireGuest, (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/dashboard', requireAuth,  (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/bot/:id',   requireAuth,  (req, res) => res.sendFile(path.join(__dirname, 'public', 'bot.html')));
app.get('/admin',     requireAuth,  (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!isAdmin(user)) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Current user API
app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id,username,role,plan,created_at FROM users WHERE id=?').get(req.session.userId);
  res.json({ success: true, user: { ...user, is_admin: isAdmin(user) } });
});

// Start Telegram bot if token is set
telegramBot.init();

app.listen(PORT, () => console.log(`[KARL] Server running on port ${PORT}`));
