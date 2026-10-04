function init() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log('[KARL] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled.'); return; }
  const https = require('https');
  let offset = 0;

  function poll() {
    const body = JSON.stringify({ offset, timeout: 30, limit: 50 });
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/getUpdates`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          if (j.ok) for (const u of j.result) { offset = Math.max(offset, u.update_id + 1); handleUpdate(u); }
        } catch {}
        setTimeout(poll, 1000);
      });
    });
    req.on('error', () => setTimeout(poll, 5000));
    req.setTimeout(35000, () => { req.destroy(); setTimeout(poll, 2000); });
    req.write(body); req.end();
  }
  poll();
  console.log('[KARL] Telegram bot polling started.');
}

function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const fromId = String(msg.from?.id || '');
  const username = msg.from?.username || '';
  const firstName = msg.from?.first_name || 'there';

  if (msg.text.startsWith('/start')) {
    const db = require('../database');
    const { v4: uuidv4 } = require('uuid');

    const existing = db.prepare('SELECT * FROM activation_tokens WHERE telegram_id=?').get(fromId);
    if (existing && existing.used_by) {
      sendMarkdown(chatId,
        `┌─────────────────────┐\n` +
        `│  ✅  ALREADY ACTIVE  │\n` +
        `└─────────────────────┘\n\n` +
        `Hey *${escMd(firstName)}*, you're already registered\\!\n\n` +
        `👉 Log in at your panel and get hosting\\!`
      );
      return;
    }

    // Always issue 1d (2 hour) token from bot
    const tokenStr = 'KARL-' + uuidv4().replace(/-/g, '').slice(0, 16).toUpperCase();
    const expires_at = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 1h = 2 hours
    const duration = '1h';

    if (existing) {
      db.prepare('UPDATE activation_tokens SET token=?, duration=?, expires_at=?, created_at=CURRENT_TIMESTAMP WHERE telegram_id=?')
        .run(tokenStr, duration, expires_at, fromId);
    } else {
      db.prepare('INSERT INTO activation_tokens (token, duration, expires_at, telegram_id, telegram_username) VALUES (?,?,?,?,?)')
        .run(tokenStr, duration, expires_at, fromId, username);
    }

    const baseUrl = process.env.BASE_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-app.up.railway.app'}`;

    sendMarkdown(chatId,
      `┌──────────────────────────┐\n` +
      `│   🚀  KARL HOSTING BOT   │\n` +
      `└──────────────────────────┘\n\n` +
      `Welcome, *${escMd(firstName)}*\\! 👋\n\n` +
      `Here's your activation token:\n\n` +
      `\`${tokenStr}\`\n\n` +
      `⏱ *Expires in:* 2 hours\n` +
      `📋 *Copy the token above*, then:\n\n` +
      `👉 [Register at Karl Hosting](${baseUrl}/register)\n\n` +
      `─────────────────────────────\n` +
      `_Need a longer token? Contact the admin\\._`
    );

    const adminId = process.env.TELEGRAM_ADMIN_ID;
    if (adminId) {
      sendMarkdown(adminId,
        `🆕 *New token request*\n` +
        `👤 @${escMd(username || fromId)}\n` +
        `🎟 \`${tokenStr}\`\n` +
        `⏱ Duration: 2h`
      );
    }
  }
}

function escMd(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function sendMarkdown(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token) return;
  const body = JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'MarkdownV2' });
  const req = require('https').request({
    hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, r => r.resume());
  req.on('error', () => {});
  req.write(body); req.end();
}

module.exports = { init };
                   
