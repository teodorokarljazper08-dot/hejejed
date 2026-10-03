const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireGuest, requireAuth } = require('../middleware/auth');
const router = express.Router();

function getLoginAttempts(identifier, ip) {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM login_attempts WHERE (identifier = ? OR ip = ?) AND created_at > ?').get(identifier, ip, since);
  return row.cnt;
}
function recordAttempt(identifier, ip) {
  db.prepare('INSERT INTO login_attempts (identifier, ip) VALUES (?, ?)').run(identifier, ip);
}
function clearAttempts(identifier) {
  db.prepare('DELETE FROM login_attempts WHERE identifier = ?').run(identifier);
}

// ── Register ──────────────────────────────────────────────────
router.post('/register', requireGuest, async (req, res) => {
  try {
    const { username, email, password, confirm_password, activation_token } = req.body;
    if (!username || !email || !password || !confirm_password || !activation_token)
      return res.json({ success: false, message: 'All fields are required, including your Activation Token' });

    const tokenRow = db.prepare('SELECT * FROM activation_tokens WHERE token = ?').get(activation_token.trim().toUpperCase());
    if (!tokenRow) return res.json({ success: false, message: 'Invalid activation token. Get yours from the KARL Telegram bot.' });
    if (tokenRow.used_by) return res.json({ success: false, message: 'This activation token has already been used.' });

    if (username.length < 3 || username.length > 20) return res.json({ success: false, message: 'Username must be 3-20 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.json({ success: false, message: 'Username can only contain letters, numbers, underscores' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ success: false, message: 'Invalid email address' });
    if (password.length < 8) return res.json({ success: false, message: 'Password must be at least 8 characters' });
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password))
      return res.json({ success: false, message: 'Password needs an uppercase letter, a lowercase letter, and a number — e.g. Karl2025' });
    if (password !== confirm_password) return res.json({ success: false, message: 'Passwords do not match' });

    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username))
      return res.json({ success: false, message: 'Username already taken' });
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase()))
      return res.json({ success: false, message: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO users (username, email, password, trial_started_at, activation_token, email_verified) VALUES (?, ?, ?, ?, ?, 1)')
      .run(username, email.toLowerCase(), hashed, now, activation_token.trim().toUpperCase());

    const newUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!newUser) return res.json({ success: false, message: 'Account creation failed. Please try again.' });

    db.prepare('UPDATE activation_tokens SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE token = ?')
      .run(newUser.id, activation_token.trim().toUpperCase());

    // ── Referral credit: +1 day of premium for whoever referred this user ──
    if (tokenRow.referred_by) {
      try {
        const referrer = db.prepare('SELECT * FROM users WHERE username = ?').get(tokenRow.referred_by);
        if (referrer && referrer.id !== newUser.id) {
          const currentExpiry = referrer.premium_expires_at ? new Date(referrer.premium_expires_at).getTime() : 0;
          const base = currentExpiry > Date.now() ? currentExpiry : Date.now();
          const newExpiryIso = new Date(base + 24 * 60 * 60 * 1000).toISOString();
          db.prepare("UPDATE users SET plan = 'premium', premium_expires_at = ?, referral_count = referral_count + 1 WHERE id = ?")
            .run(newExpiryIso, referrer.id);
          db.prepare('INSERT INTO referrals (referrer_id, referred_id, days_credited) VALUES (?, ?, 1)')
            .run(referrer.id, newUser.id);
          try {
            require('../bot/telegram').notifyReferralCredit(referrer, {
              userId: newUser.id,
              username,
              telegram_id: tokenRow.telegram_id,
              telegram_username: tokenRow.telegram_username,
              joinedAt: now
            }, 1, newExpiryIso);
          } catch {}
        }
      } catch (e) {
        console.error('[AUTH] referral credit error:', e.message);
      }
    }

    res.json({ success: true, redirect: '/login', message: 'Account created successfully. You can now sign in.' });
  } catch (err) {
    console.error('[AUTH] register error:', err);
    res.json({ success: false, message: 'Server error. Try again.' });
  }
});

// ── Login ──────────────────────────────────────────────────────
router.post('/login', requireGuest, async (req, res) => {
  try {
    const { username, password } = req.body;
    const ip = req.ip;

    if (!username || !password) return res.json({ success: false, message: 'All fields are required' });

    if (getLoginAttempts(username, ip) >= 5)
      return res.json({ success: false, message: 'Too many failed attempts. Wait 15 minutes and try again.' });

    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
    if (!user) {
      recordAttempt(username, ip);
      return res.json({ success: false, message: 'Invalid username or password' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      recordAttempt(username, ip);
      return res.json({ success: false, message: 'Invalid username or password' });
    }

    if (user.banned) {
      return res.json({ success: false, message: user.ban_reason ? `Account banned: ${user.ban_reason}` : 'Your account has been banned.' });
    }

    clearAttempts(username);
    db.syncExpiredPlans();

    // Make sure email_verified is set — no email system means no block
    if (!user.email_verified) {
      db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.plan = user.plan;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    console.error('[AUTH] login error:', err);
    res.json({ success: false, message: 'Server error. Try again.' });
  }
});

// ── Forgot password ────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { username, email, token } = req.body;
    if (!username || !email || !token) return res.json({ success: false, message: 'All fields are required' });

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
    if (!user) return res.json({ success: false, message: 'No account found with that username' });

    if (!user.email || user.email.toLowerCase() !== email.trim().toLowerCase())
      return res.json({ success: false, message: 'Email does not match this account' });

    const tokenRow = db.prepare('SELECT * FROM activation_tokens WHERE token = ? AND used_by = ?')
      .get(token.trim().toUpperCase(), user.id);
    if (!tokenRow) return res.json({ success: false, message: 'Activation token does not match this account' });

    req.session.resetUserId = user.id;
    res.json({ success: true, message: 'Identity verified. Choose your new password.' });
  } catch (err) {
    console.error('[AUTH] forgot-password error:', err);
    res.json({ success: false, message: 'Server error. Try again.' });
  }
});

// ── Reset password ─────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const userId = req.session.resetUserId;
    if (!userId) return res.json({ success: false, message: 'Session expired. Please start over.' });

    const { password, confirm_password } = req.body;
    if (!password || !confirm_password) return res.json({ success: false, message: 'All fields are required' });
    if (password !== confirm_password) return res.json({ success: false, message: 'Passwords do not match' });
    if (password.length < 8) return res.json({ success: false, message: 'Password must be at least 8 characters' });
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password))
      return res.json({ success: false, message: 'Password needs an uppercase letter, lowercase letter, and a number' });

    const hashed = await bcrypt.hash(password, 12);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, userId);
    delete req.session.resetUserId;
    res.json({ success: true, message: 'Password reset successfully. You can now sign in.' });
  } catch (err) {
    console.error('[AUTH] reset-password error:', err);
    res.json({ success: false, message: 'Server error. Try again.' });
  }
});

// ── Logout ─────────────────────────────────────────────────────
router.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
