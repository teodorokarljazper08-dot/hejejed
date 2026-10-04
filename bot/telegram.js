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
  const chatId   = msg.chat.id;
  const fromId   = String(msg.from?.id || '');
  const username  = msg.from?.username || '';
  const firstName = msg.from?.first_name || 'there';

  if (msg.text.startsWith('/start')) {
    const db = require('../database');
    const { v4: uuidv4 } = require('uuid');

    const existing = db.prepare('SELECT * FROM activation_tokens WHERE telegram_id=?').get(fromId);

    // ── Case 1: User already redeemed a token (has an active account) ─────────
    if (existing && existing.used_by) {
      sendMarkdown(chatId,
        `┌─────────────────────┐\n` +
        `│  ✅  ALREADY ACTIVE  │\n` +
        `└─────────────────────┘\n\n` +
        `Hey *${escMd(firstName)}*, you already have an active account\\!\n\n` +
        `👉 Log in at your panel and get hosting\\!`
      );
      return;
    }

    // ── Case 2: User already has an unused token — just resend it ─────────────
    if (existing && !existing.used_by) {
      const baseUrl = process.env.BASE_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-app.up.railway.app'}`;
      const expiry  = new Date(existing.expires_at);
      const now     = new Date();

      // If the existing token is expired, fall through to generate a fresh one
      if (expiry > now) {
        const hoursLeft = Math.max(1, Math.round((expiry - now) / (1000 * 60 * 60)));
        sendMarkdown(chatId,
          `┌──────────────────────────┐\n` +
          `│   🚀  KARL HOSTING BOT   │\n` +
          `└──────────────────────────┘\n\n` +
          `Hey *${escMd(firstName)}*\\! You already have a token\\:\n\n` +
          `\`${existing.token}\`\n\n` +
          `⏱ *Expires in:* ~${hoursLeft}h\n` +
          `📋 *Copy the token above*, then:\n\n` +
          `👉 [Register at Karl Hosting](${baseUrl}/register)\n\n` +
          `─────────────────────────────\n` +
          `_This token can only be used by one account\\._`
        );
        return;
      }
      // Expired token — delete it so we generate a fresh one below
      db.prepare('DELETE FROM activation_tokens WHERE telegram_id=?').run(fromId);
    }

    // ── Case 3: New user or expired token — generate exactly ONE 1-day token ──
    const tokenStr  = 'KARL-' + uuidv4().replace(/-/g, '').slice(0, 16).toUpperCase();
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 1 day
    const duration  = '1d';

    // Insert fresh token — no UPDATE, only INSERT so each user gets exactly one
    db.prepare('INSERT INTO activation_tokens (token, duration, expires_at, telegram_id, telegram_username) VALUES (?,?,?,?,?)')
      .run(tokenStr, duration, expires_at, fromId, username);

    const baseUrl = process.env.BASE_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-app.up.railway.app'}`;

    sendMarkdown(chatId,
      `┌──────────────────────────┐\n` +
      `│   🚀  KARL HOSTING BOT   │\n` +
      `└──────────────────────────┘\n\n` +
      `Welcome, *${escMd(firstName)}*\\! 👋\n\n` +
      `Here's your activation token:\n\n` +
      `\`${tokenStr}\`\n\n` +
      `⏱ *Valid for:* 1 day\n` +
      `📋 *Copy the token above*, then:\n\n` +
      `👉 [Register at Karl Hosting](${baseUrl}/register)\n\n` +
      `─────────────────────────────\n` +
      `_This token is single\\-use — only one account can redeem it\\._`
    );

    const adminId = process.env.TELEGRAM_ADMIN_ID;
    if (adminId) {
      sendMarkdown(adminId,
        `🆕 *New token issued*\n` +
        `👤 @${escMd(username || fromId)}\n` +
        `🎟 \`${tokenStr}\`\n` +
        `⏱ Duration: 1 day`
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
  
