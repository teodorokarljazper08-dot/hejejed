function init() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log('[KARL] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled.'); return; }
  const https = require('https');
  let offset = 0;
  function poll() {
    const body = JSON.stringify({ offset, timeout: 30, limit: 50 });
    const req = https.request({ hostname:'api.telegram.org', path:`/bot${token}/getUpdates`, method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} }, res => {
      let raw=''; res.on('data',c=>raw+=c); res.on('end',()=>{
        try {
          const j = JSON.parse(raw);
          if (j.ok) for (const u of j.result) {
            offset = Math.max(offset, u.update_id+1);
            handleUpdate(u);
          }
        } catch {}
        setTimeout(poll, 1000);
      });
    });
    req.on('error', ()=>setTimeout(poll,5000));
    req.setTimeout(35000,()=>{req.destroy();setTimeout(poll,2000);});
    req.write(body); req.end();
  }
  poll();
  console.log('[KARL] Telegram bot polling started.');
}

function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const fromId = String(msg.from?.id||'');
  const username = msg.from?.username||'';
  if (msg.text.startsWith('/start')) {
    const db = require('../database');
    const { v4: uuidv4 } = require('uuid');
    const existing = db.prepare('SELECT * FROM activation_tokens WHERE telegram_id=?').get(fromId);
    if (existing && existing.used_by) { send(chatId,'✅ Already registered! Log in at your Karl Hosting panel.'); return; }
    const token = 'KARL-' + uuidv4().replace(/-/g,'').slice(0,16).toUpperCase();
    if (existing) db.prepare('UPDATE activation_tokens SET token=?,created_at=CURRENT_TIMESTAMP WHERE telegram_id=?').run(token,fromId);
    else db.prepare('INSERT INTO activation_tokens (token,telegram_id,telegram_username) VALUES (?,?,?)').run(token,fromId,username);
    send(chatId, `👋 Welcome to Karl Hosting!\n\nYour activation token:\n\`${token}\`\n\nUse this on the registration page:\nhttps://karl-hosting-production.up.railway.app/register`);
    const adminId = process.env.TELEGRAM_ADMIN_ID;
    if (adminId) send(adminId, `🆕 /start from @${username||fromId}\nToken: \`${token}\``);
  }
}

function send(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token) return;
  const body = JSON.stringify({ chat_id: String(chatId), text, parse_mode:'Markdown' });
  const req = require('https').request({ hostname:'api.telegram.org', path:`/bot${token}/sendMessage`, method:'POST',
    headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} }, r=>r.resume());
  req.on('error',()=>{}); req.write(body); req.end();
}

module.exports = { init };
