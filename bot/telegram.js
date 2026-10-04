// bot/telegram.js
// Telegram notification bot — sends DMs to users when their plan changes,
// they get banned, their bot crashes, etc.
//
// Set TELEGRAM_BOT_TOKEN + TELEGRAM_ADMIN_ID in Railway env vars.
// If not set the module still loads fine — notifications are silently skipped.

const https = require('https');

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN  || '';
const ADMIN_ID   = process.env.TELEGRAM_ADMIN_ID   || '';

function _send(chatId, text) {
  if (!BOT_TOKEN || !chatId) return Promise.resolve();
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'HTML' });
    const opts = {
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', () => resolve());
    req.setTimeout(8000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

function _adminNotify(text) {
  if (ADMIN_ID) _send(ADMIN_ID, text).catch(() => {});
}

// ── Bot commands handler (polling) ──────────────────────────────────────────
let _pollingActive = false;
let _offset = 0;

function _processUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const text     = msg.text.trim();
  const chatId   = msg.chat.id;
  const username = (msg.from && msg.from.username) ? msg.from.username : '';
  const fromId   = msg.from ? String(msg.from.id) : '';

  if (text === '/start' || text.startsWith('/start ')) {
    const db = require('../database');
    // Check if this Telegram account already has a token
    const existing = db.prepare('SELECT * FROM activation_tokens WHERE telegram_id = ?').get(fromId);
    if (existing && existing.used_by) {
      _send(chatId,
        `✅ <b>Already registered</b>\n\nYour Telegram account is already linked.\n` +
        `Log in at your hosting panel.`
      ).catch(() => {});
      return;
    }

    // Generate a new activation token
    const { v4: uuidv4 } = require('uuid');
    const token = ('KARL-' + uuidv4().replace(/-/g,'').slice(0,16).toUpperCase());

    if (existing) {
      db.prepare('UPDATE activation_tokens SET token = ?, created_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
        .run(token, fromId);
    } else {
      try {
        db.prepare('INSERT INTO activation_tokens (token, telegram_id, telegram_username) VALUES (?, ?, ?)')
          .run(token, fromId, username);
      } catch (e) {
        _send(chatId, '⚠️ Could not create your token. Please try again.').catch(() => {});
        return;
      }
    }

    _send(chatId,
      `👋 <b>Welcome to KARL Bot Hosting!</b>\n\n` +
      `Your activation token:\n<code>${token}</code>\n\n` +
      `Use this token when creating your account on the website.`
    ).catch(() => {});

    if (ADMIN_ID) {
      _send(ADMIN_ID,
        `🆕 New /start\n@${username || fromId} (${fromId})\nToken: <code>${token}</code>`
      ).catch(() => {});
    }
  }
}

function _poll() {
  if (!BOT_TOKEN) return;
  const body = JSON.stringify({ offset: _offset, timeout: 30, limit: 100 });
  const opts = {
    hostname: 'api.telegram.org',
    path:     `/bot${BOT_TOKEN}/getUpdates`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  const req = https.request(opts, (res) => {
    let raw = '';
    res.on('data', c => raw += c);
    res.on('end', () => {
      try {
        const j = JSON.parse(raw);
        if (j.ok && Array.isArray(j.result)) {
          for (const u of j.result) {
            _offset = Math.max(_offset, u.update_id + 1);
            try { _processUpdate(u); } catch {}
          }
        }
      } catch {}
      if (_pollingActive) setTimeout(_poll, 1000);
    });
  });
  req.on('error', () => { if (_pollingActive) setTimeout(_poll, 5000); });
  req.setTimeout(35000, () => { req.destroy(); if (_pollingActive) setTimeout(_poll, 2000); });
  req.write(body);
  req.end();
}

// ── Public API ───────────────────────────────────────────────────────────────

function init() {
  if (!BOT_TOKEN) {
    console.log('[KARL/telegram] TELEGRAM_BOT_TOKEN not set — notifications disabled.');
    return;
  }
  _pollingActive = true;
  console.log('[KARL/telegram] Telegram bot polling started.');
  _poll();
}

function notifyPlanGranted(user, planLabel, expiresAt) {
  const tid = user && user.telegram_id;
  if (!tid) return;
  const expStr = expiresAt ? new Date(expiresAt).toUTCString().replace(' GMT','') : '∞';
  _send(tid,
    `🎉 <b>Plan Activated: ${planLabel}</b>\n\nExpires: <code>${expStr}</code>\n\nLog in to start using your bots!`
  ).catch(() => {});
}

function notifyPlanExpired(user) {
  const tid = user && user.telegram_id;
  if (!tid) return;
  _send(tid,
    `⚠️ <b>Your plan has expired</b>\n\nYour bots have been stopped. Contact admin to renew.`
  ).catch(() => {});
}

function notifyPlanRemoved(user) {
  const tid = user && user.telegram_id;
  if (!tid) return;
  _send(tid,
    `🔻 <b>Plan Removed</b>\n\nYour premium plan was removed by an admin. Contact support if this is a mistake.`
  ).catch(() => {});
}

function notifyBanned(user, reason) {
  const tid = user && user.telegram_id;
  if (!tid) return;
  const why = reason ? `\n\nReason: ${reason}` : '';
  _send(tid,
    `🚫 <b>Account Banned</b>${why}\n\nContact support if you believe this is an error.`
  ).catch(() => {});
}

function notifyUnbanned(user) {
  const tid = user && user.telegram_id;
  if (!tid) return;
  _send(tid,
    `✅ <b>Account Unbanned</b>\n\nYour account has been restored. You can log in again.`
  ).catch(() => {});
}

function notifyUserCrash(bot) {
  const tid = bot && bot.telegram_id;
  if (!tid) return;
  _send(tid,
    `💥 <b>Bot Crashed: ${bot.name || bot.id}</b>\n\nYour bot stopped unexpectedly. Check the logs and restart it from your dashboard.`
  ).catch(() => {});
}

function notifyReferralCredit(referrer, info) {
  const tid = referrer && referrer.telegram_id;
  if (!tid) return;
  const days = (info && info.days) ? info.days : 1;
  _send(tid,
    `🎁 <b>Referral Bonus!</b>\n\nSomeone you referred just registered. You got <b>${days} day(s)</b> added to your plan!`
  ).catch(() => {});
}

module.exports = {
  init,
  notifyPlanGranted,
  notifyPlanExpired,
  notifyPlanRemoved,
  notifyBanned,
  notifyUnbanned,
  notifyUserCrash,
  notifyReferralCredit,
};
      
