const express = require('express');
const db = require('../database');
const { requireAdmin } = require('../middleware/auth');
const engine = require('../engine/botRunner');
const telegramBot = require('../bot/telegram');

const router = express.Router();
router.use(requireAdmin);

function withRuntime(bot) {
  const live = engine.isRunning(bot.id);
  const startedAt = live ? engine.getStartedAt(bot.id) : null;
  return {
    ...bot,
    live,
    uptime_seconds: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null
  };
}

// GET /api/admin/users — every user with their bot count, plan, ban status,
// and the Telegram identity behind the activation token they signed up with
router.get('/users', (req, res) => {
  db.syncExpiredPlans();
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.plan, u.created_at,
           u.banned, u.ban_reason, u.banned_at, u.premium_expires_at, u.referral_count,
           t.telegram_id, t.telegram_username,
           COUNT(b.id) as bot_count
    FROM users u
    LEFT JOIN bots b ON b.user_id = u.id
    LEFT JOIN activation_tokens t ON t.used_by = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
  res.json({ success: true, users });
});

// GET /api/admin/users/:id — one user plus all of their bots (with runtime info)
router.get('/users/:id', (req, res) => {
  db.syncExpiredPlans();
  const user = db.prepare(`
    SELECT u.id, u.username, u.email, u.plan, u.created_at,
           u.banned, u.ban_reason, u.banned_at, u.premium_expires_at, u.referral_count,
           t.telegram_id, t.telegram_username
    FROM users u
    LEFT JOIN activation_tokens t ON t.used_by = u.id
    WHERE u.id = ?
  `).get(req.params.id);
  if (!user) return res.json({ success: false, message: 'User not found' });
  const bots = db.prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY created_at DESC').all(user.id).map(withRuntime);
  res.json({ success: true, user, bots });
});

// POST /api/admin/users/:id/ban — ban a user (and stop any bots they have running)
router.post('/users/:id/ban', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.json({ success: false, message: 'User not found' });
  if (user.id === req.adminUser.id) return res.json({ success: false, message: "You can't ban your own admin account" });

  const reason = (req.body && req.body.reason) ? String(req.body.reason).slice(0, 300) : null;
  db.prepare('UPDATE users SET banned = 1, ban_reason = ?, banned_at = CURRENT_TIMESTAMP WHERE id = ?').run(reason, user.id);
  db.prepare('INSERT INTO ban_history (user_id, action, reason, admin_username) VALUES (?, ?, ?, ?)')
    .run(user.id, 'ban', reason, req.adminUser.username);

  // Stop their bots so a banned user can't keep running anything in the background
  try {
    const bots = db.prepare('SELECT id FROM bots WHERE user_id = ?').all(user.id);
    bots.forEach(b => { try { engine.killBot(b.id); } catch {} });
  } catch {}

  try { telegramBot.notifyBanned(user, reason); } catch {}

  res.json({ success: true, message: `${user.username} has been banned` });
});

// POST /api/admin/users/:id/unban
router.post('/users/:id/unban', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.json({ success: false, message: 'User not found' });
  db.prepare('UPDATE users SET banned = 0, ban_reason = NULL, banned_at = NULL WHERE id = ?').run(user.id);
  db.prepare('INSERT INTO ban_history (user_id, action, reason, admin_username) VALUES (?, ?, ?, ?)')
    .run(user.id, 'unban', null, req.adminUser.username);
  try { telegramBot.notifyUnbanned(user); } catch {}
  res.json({ success: true, message: `${user.username} has been unbanned` });
});

// POST /api/admin/users/:id/reset-telegram-link — deletes the activation_token
// row tied to this user so their /start flow behaves like a brand-new user
// again (useful for testing the channel-join gate / referral flow, or for
// letting a user relink a different Telegram account).
router.post('/users/:id/reset-telegram-link', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.json({ success: false, message: 'User not found' });
  const r = db.prepare('DELETE FROM activation_tokens WHERE used_by = ?').run(user.id);
  res.json({ success: true, message: r.changes ? `Telegram link reset for ${user.username}. They can /start fresh.` : 'No linked Telegram token found for this user.' });
});

// GET /api/admin/users/:id/ban-history — full ban/unban timeline for one user
router.get('/users/:id/ban-history', (req, res) => {
  const history = db.prepare('SELECT * FROM ban_history WHERE user_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ success: true, history });
});

// GET /api/admin/users/banned/list — banned users only, for the Banned Users view
router.get('/users/banned/list', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.plan, u.banned_at, u.ban_reason,
           t.telegram_id, t.telegram_username
    FROM users u
    LEFT JOIN activation_tokens t ON t.used_by = u.id
    WHERE u.banned = 1
    ORDER BY u.banned_at DESC
  `).all();
  res.json({ success: true, users });
});

const UNIT_MS = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000
};

// POST /api/admin/users/:id/time — add or subtract premium time
// body: { amount: number, unit: 'second'|'minute'|'hour'|'day'|'month'|'year', direction: 'add'|'reduce' }
router.post('/users/:id/time', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.json({ success: false, message: 'User not found' });

  const amount = Number(req.body && req.body.amount);
  const unit = req.body && req.body.unit;
  const direction = req.body && req.body.direction;

  if (!amount || amount <= 0 || !Number.isFinite(amount)) {
    return res.json({ success: false, message: 'Enter a valid positive amount' });
  }
  if (!UNIT_MS[unit]) {
    return res.json({ success: false, message: 'Invalid time unit' });
  }
  if (direction !== 'add' && direction !== 'reduce') {
    return res.json({ success: false, message: 'Invalid direction' });
  }

  const deltaMs = amount * UNIT_MS[unit] * (direction === 'add' ? 1 : -1);

  // Base off existing expiry if it's still in the future, otherwise base off now
  const currentExpiry = user.premium_expires_at ? new Date(user.premium_expires_at).getTime() : 0;
  const base = currentExpiry > Date.now() ? currentExpiry : Date.now();
  let newExpiry = base + deltaMs;
  if (newExpiry <= Date.now()) {
    // Time ran out (or went negative) — drop them to free with no expiry set
    db.prepare("UPDATE users SET plan = 'free', premium_expires_at = NULL WHERE id = ?").run(user.id);
    try { telegramBot.notifyPlanExpired(user); } catch {}
    return res.json({ success: true, message: `${user.username} is now on the Free plan (time expired)`, premium_expires_at: null, plan: 'free' });
  }

  const newExpiryIso = new Date(newExpiry).toISOString();
  db.prepare("UPDATE users SET plan = 'premium', premium_expires_at = ? WHERE id = ?").run(newExpiryIso, user.id);
  if (direction === 'add') { try { telegramBot.notifyPlanGranted(user, 'Premium (time added)', newExpiryIso); } catch {} }
  res.json({ success: true, message: `${direction === 'add' ? 'Added' : 'Removed'} ${amount} ${unit}(s) for ${user.username}`, premium_expires_at: newExpiryIso, plan: 'premium' });
});

// ── Billing / plans ──────────────────────────────────────────────────────
// A small fixed catalog admins pick from instead of typing raw amount/unit
// every time. "amount" here is the display price tag, not something charged
// automatically — Nix still handles payment manually over Telegram; this just
// records what was agreed and starts the clock.
const PLAN_PRESETS = {
  trial_7d:      { label: 'Free 7-Day Trial', amount: 'Free',  days: 7 },
  starter_1w:    { label: 'Starter — 1 Week', amount: '₱100',  days: 7 },
  standard_3w:   { label: 'Standard — 3 Weeks', amount: '₱250', days: 21 },
  pro_1m:        { label: 'Pro — 1 Month', amount: '₱400',   days: 30 },
  pro_3m:        { label: 'Pro — 3 Months', amount: '₱1000', days: 90 },
  lifetime:      { label: 'Lifetime', amount: '₱2500', days: 36500 }
};

// GET /api/admin/plans — the preset catalog, for the dropdown
router.get('/plans', (req, res) => {
  res.json({ success: true, plans: Object.entries(PLAN_PRESETS).map(([key, p]) => ({ key, ...p })) });
});

// POST /api/admin/users/:id/plan — apply a preset plan to a user
// body: { planKey }
router.post('/users/:id/plan', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.json({ success: false, message: 'User not found' });

  const planKey = req.body && req.body.planKey;
  const preset = PLAN_PRESETS[planKey];
  if (!preset) return res.json({ success: false, message: 'Unknown plan' });

  const currentExpiry = user.premium_expires_at ? new Date(user.premium_expires_at).getTime() : 0;
  const base = currentExpiry > Date.now() ? currentExpiry : Date.now();
  const newExpiry = base + preset.days * 24 * 60 * 60 * 1000;
  const newExpiryIso = new Date(newExpiry).toISOString();

  db.prepare("UPDATE users SET plan = 'premium', premium_expires_at = ? WHERE id = ?").run(newExpiryIso, user.id);
  db.prepare(`
    INSERT INTO billing_history (user_id, plan_key, plan_label, amount_label, action, granted_by, expires_at)
    VALUES (?, ?, ?, ?, 'grant', ?, ?)
  `).run(user.id, planKey, preset.label, preset.amount, req.adminUser.username, newExpiryIso);

  try { telegramBot.notifyPlanGranted(user, preset.label, newExpiryIso); } catch {}

  res.json({ success: true, message: `${preset.label} applied to ${user.username}`, premium_expires_at: newExpiryIso, plan: 'premium' });
});

// POST /api/admin/users/:id/remove-plan — revoke premium immediately
router.post('/users/:id/remove-plan', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.json({ success: false, message: 'User not found' });

  db.prepare("UPDATE users SET plan = 'free', premium_expires_at = NULL WHERE id = ?").run(user.id);
  db.prepare(`
    INSERT INTO billing_history (user_id, plan_key, plan_label, amount_label, action, granted_by, expires_at)
    VALUES (?, NULL, 'Plan removed', NULL, 'remove', ?, NULL)
  `).run(user.id, req.adminUser.username);

  try { telegramBot.notifyPlanRemoved(user); } catch {}

  res.json({ success: true, message: `${user.username} moved back to Free plan`, plan: 'free', premium_expires_at: null });
});

// GET /api/admin/users/:id/billing — full billing/grant history for a user
router.get('/users/:id/billing', (req, res) => {
  const rows = db.prepare('SELECT * FROM billing_history WHERE user_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ success: true, history: rows });
});

// GET /api/admin/bots — every bot across every user (with runtime info), for the Active Bots view
router.get('/bots', (req, res) => {
  const bots = db.prepare(`
    SELECT b.*, u.username, u.email
    FROM bots b
    JOIN users u ON u.id = b.user_id
    ORDER BY b.updated_at DESC
  `).all().map(withRuntime);
  res.json({ success: true, bots });
});

// GET /api/admin/tokens — list all activation tokens with usage info
router.get('/tokens', (req, res) => {
  const tokens = db.prepare(`
    SELECT t.*, u.username as used_by_username
    FROM activation_tokens t
    LEFT JOIN users u ON u.id = t.used_by
    ORDER BY t.created_at DESC
  `).all();
  res.json({ success: true, tokens });
});

// DELETE /api/admin/tokens/:id — revoke a token (marks it as unused so it can't be reused, or deletes it)
router.delete('/tokens/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM activation_tokens WHERE id = ?').get(req.params.id);
  if (!t) return res.json({ success: false, message: 'Token not found' });
  db.prepare('DELETE FROM activation_tokens WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Token revoked and deleted' });
});

// GET /api/admin/bots/:id/download — silently download any bot's files (no user notification)
router.get('/bots/:id/download', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id);
  if (!bot) return res.json({ success: false, message: 'Bot not found' });
  if (!bot.file_path) return res.json({ success: false, message: 'No files uploaded' });
  try {
    const AdmZip = require('adm-zip');
    const engine = require('../engine/botRunner');
    const botDir = engine.ensureExtracted(bot, bot.id);
    const zip = new AdmZip();
    zip.addLocalFolder(botDir);
    const buf = zip.toBuffer();
    const safe = bot.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}_admin.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    res.send(buf);
  } catch (e) {
    res.json({ success: false, message: e.message || 'Download failed' });
  }
});

const { parseProxyLines } = require('../utils/proxyPool');

// ── Proxy pool (admin side) ─────────────────────────────────────────────
// Users only ever see what getUsableProxies() hands them (routes/proxies.js);
// everything here is the admin's stockroom.

// GET /api/admin/proxies/stats
router.get('/proxies/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM proxies').get().c;
  const alive = db.prepare("SELECT COUNT(*) c FROM proxies WHERE status = 'alive'").get().c;
  const unassigned = db.prepare('SELECT COUNT(*) c FROM proxies WHERE assigned_user_id IS NULL').get().c;
  const pendingRequests = db.prepare("SELECT COUNT(*) c FROM proxy_requests WHERE status = 'pending'").get().c;
  res.json({ success: true, total, alive, dead: total - alive, unassigned, assigned: total - unassigned, pendingRequests });
});

// GET /api/admin/proxies?filter=all|unassigned|assigned|dead&q=&limit=&offset=
router.get('/proxies', (req, res) => {
  const filter = req.query.filter || 'all';
  const q = req.query.q || '';
  const limit = Math.min(500, Number(req.query.limit) || 200);
  const offset = Number(req.query.offset) || 0;

  const where = [];
  const params = [];
  if (filter === 'unassigned') where.push('p.assigned_user_id IS NULL');
  if (filter === 'assigned') where.push('p.assigned_user_id IS NOT NULL');
  if (filter === 'dead') where.push("p.status = 'dead'");
  if (q) { where.push('p.host LIKE ?'); params.push(`%${q}%`); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT p.*, u.username as assigned_username
    FROM proxies p LEFT JOIN users u ON u.id = p.assigned_user_id
    ${whereSql}
    ORDER BY p.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM proxies p ${whereSql}`).get(...params).c;
  res.json({ success: true, proxies: rows, total });
});

// POST /api/admin/proxies/bulk-add  { text, assignToUserId? }
// `text` is a paste of "host:port:user:pass" lines (one per proxy).
router.post('/proxies/bulk-add', (req, res) => {
  const { ok, skipped } = parseProxyLines(req.body && req.body.text);
  if (!ok.length) {
    return res.json({ success: false, message: 'No valid proxy lines found. Expected host:port:user:pass, one per line.' });
  }

  let assignTo = null;
  if (req.body && req.body.assignToUserId) {
    assignTo = Number(req.body.assignToUserId);
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(assignTo);
    if (!u) return res.json({ success: false, message: 'That user does not exist' });
  }

  const existing = new Set(db.prepare('SELECT raw FROM proxies').all().map(r => r.raw));
  const insert = db.prepare(`
    INSERT INTO proxies (host, port, username, password, raw, assigned_user_id, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let added = 0, duplicates = 0;
  const insertMany = db.transaction((rows) => {
    for (const p of rows) {
      if (existing.has(p.raw)) { duplicates++; continue; }
      insert.run(p.host, p.port, p.username, p.password, p.raw, assignTo, req.adminUser.username);
      existing.add(p.raw);
      added++;
    }
  });
  insertMany(ok);

  const bits = [`Added ${added} prox${added === 1 ? 'y' : 'ies'}`];
  if (duplicates) bits.push(`${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped`);
  if (skipped) bits.push(`${skipped} line${skipped === 1 ? '' : 's'} had a bad format`);
  if (assignTo) bits.push('assigned directly to that user');
  res.json({ success: true, message: bits.join(', ') + '.', added, duplicates, skipped });
});

// POST /api/admin/proxies/assign  { userId, count } — hand out N unassigned
// proxies from the shared pool to a specific user, dedicated to them.
router.post('/proxies/assign', (req, res) => {
  const userId = Number(req.body && req.body.userId);
  const count = Math.max(1, Math.min(5000, Number(req.body && req.body.count) || 0));
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!user) return res.json({ success: false, message: 'User not found' });

  const rows = db.prepare("SELECT id FROM proxies WHERE assigned_user_id IS NULL AND status = 'alive' LIMIT ?").all(count);
  if (!rows.length) return res.json({ success: false, message: 'No unassigned proxies left in the pool' });

  const update = db.prepare('UPDATE proxies SET assigned_user_id = ? WHERE id = ?');
  const tx = db.transaction(() => { for (const r of rows) update.run(userId, r.id); });
  tx();
  res.json({ success: true, message: `Assigned ${rows.length} prox${rows.length === 1 ? 'y' : 'ies'} to ${user.username}` });
});

// POST /api/admin/proxies/:id/unassign — release a dedicated proxy back to the shared pool
router.post('/proxies/:id/unassign', (req, res) => {
  const p = db.prepare('SELECT * FROM proxies WHERE id = ?').get(req.params.id);
  if (!p) return res.json({ success: false, message: 'Proxy not found' });
  db.prepare('UPDATE proxies SET assigned_user_id = NULL WHERE id = ?').run(p.id);
  res.json({ success: true, message: 'Released back to the shared pool' });
});

// DELETE /api/admin/proxies/:id
router.delete('/proxies/:id', (req, res) => {
  db.prepare('DELETE FROM proxies WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Proxy deleted' });
});

// POST /api/admin/proxies/clear-dead
router.post('/proxies/clear-dead', (req, res) => {
  const r = db.prepare("DELETE FROM proxies WHERE status = 'dead'").run();
  res.json({ success: true, message: `Removed ${r.changes} dead prox${r.changes === 1 ? 'y' : 'ies'}` });
});

// POST /api/admin/proxies/check-all — test proxies via HTTP CONNECT tunnel (more accurate than TCP-only)
router.post('/proxies/check-all', async (req, res) => {
  try {
    const net = require('net');
    const proxies = db.prepare("SELECT id, host, port, username, password FROM proxies").all();

    // HTTP CONNECT through proxy → verifies TCP reachability AND that it can actually tunnel traffic.
    // Pure TCP-connect only checks the port is open; a dead/banned proxy can pass TCP but fail CONNECT.
    function checkProxy(host, port, username, password) {
      return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(6000);
        let done = false;
        const finish = (ok) => { if (!done) { done = true; socket.destroy(); resolve(ok); } };

        socket.on('error', () => finish(false));
        socket.on('timeout', () => finish(false));

        socket.connect(port, host, () => {
          const auth = username && password
            ? `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}\r\n`
            : '';
          socket.write(`CONNECT api.telegram.org:443 HTTP/1.1\r\nHost: api.telegram.org:443\r\n${auth}\r\n`);

          let buf = '';
          socket.on('data', (chunk) => {
            buf += chunk.toString();
            if (buf.includes('\r\n\r\n')) {
              // 200 Connection established = proxy is alive and can tunnel
              finish(/^HTTP\/1\.[01] 200/i.test(buf));
            }
          });
        });
      });
    }

    let alive = 0, dead = 0;
    // Check in batches of 20 to avoid overwhelming the network
    for (let i = 0; i < proxies.length; i += 20) {
      const batch = proxies.slice(i, i + 20);
      await Promise.all(batch.map(async (p) => {
        const ok = await checkProxy(p.host, p.port, p.username, p.password);
        db.prepare("UPDATE proxies SET status = ?, last_checked_at = CURRENT_TIMESTAMP WHERE id = ?").run(ok ? 'alive' : 'dead', p.id);
        ok ? alive++ : dead++;
      }));
    }

    res.json({ success: true, message: `Check complete: ${alive} alive, ${dead} dead`, alive, dead });
  } catch (err) {
    res.json({ success: false, message: 'Check failed: ' + err.message });
  }
});

// GET /api/admin/proxy-requests — pending requests from users wanting more
router.get('/proxy-requests', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, u.username, u.plan
    FROM proxy_requests r JOIN users u ON u.id = r.user_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at ASC
  `).all();
  res.json({ success: true, requests: rows });
});

// POST /api/admin/proxy-requests/:id/resolve  { count } to assign + fulfill, or { dismiss: true }
router.post('/proxy-requests/:id/resolve', (req, res) => {
  const reqRow = db.prepare('SELECT * FROM proxy_requests WHERE id = ?').get(req.params.id);
  if (!reqRow) return res.json({ success: false, message: 'Request not found' });

  if (req.body && req.body.dismiss) {
    db.prepare("UPDATE proxy_requests SET status = 'dismissed', resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(reqRow.id);
    return res.json({ success: true, message: 'Request dismissed' });
  }

  const count = Math.max(1, Math.min(5000, Number(req.body && req.body.count) || 0));
  const rows = db.prepare("SELECT id FROM proxies WHERE assigned_user_id IS NULL AND status = 'alive' LIMIT ?").all(count);
  if (!rows.length) return res.json({ success: false, message: 'No unassigned proxies left in the pool' });

  const update = db.prepare('UPDATE proxies SET assigned_user_id = ? WHERE id = ?');
  const tx = db.transaction(() => { for (const r of rows) update.run(reqRow.user_id, r.id); });
  tx();
  db.prepare("UPDATE proxy_requests SET status = 'fulfilled', resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(reqRow.id);
  res.json({ success: true, message: `Assigned ${rows.length} proxies and marked the request fulfilled` });
});

module.exports = router;
                
