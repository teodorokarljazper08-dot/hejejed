// utils/proxyPool.js
// Proxy pool helpers used by botRunner and admin routes.

const db = require('../database');

/**
 * Parse a block of text into proxy objects.
 * Supports: host:port, host:port:user:pass
 * Returns { ok: [...], skipped: N }
 */
function parseProxyLines(text) {
  const lines = (text || '').split(/\r?\n/);
  const ok = [];
  let skipped = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length === 2) {
      const [host, port] = parts;
      if (host && port && !isNaN(Number(port))) {
        ok.push({ host, port: Number(port), username: null, password: null, raw: line });
      } else { skipped++; }
    } else if (parts.length === 4) {
      const [host, port, username, password] = parts;
      if (host && port && !isNaN(Number(port))) {
        ok.push({ host, port: Number(port), username, password, raw: line });
      } else { skipped++; }
    } else {
      skipped++;
    }
  }
  return { ok, skipped };
}

/**
 * Get proxies usable by a specific user.
 * Returns their assigned proxies first, then fills from unassigned pool.
 */
function getUsableProxies(userId) {
  try {
    const assigned = db.prepare(
      "SELECT * FROM proxies WHERE assigned_user_id = ? AND status = 'alive'"
    ).all(userId);
    if (assigned.length > 0) return assigned;
    // Fall back to unassigned pool
    return db.prepare(
      "SELECT * FROM proxies WHERE assigned_user_id IS NULL AND status = 'alive' LIMIT 50"
    ).all();
  } catch {
    return [];
  }
}

/**
 * Format a proxy row as a connection string: host:port:user:pass or host:port
 */
function toLine(proxy) {
  if (!proxy) return '';
  if (proxy.username && proxy.password) {
    return `${proxy.host}:${proxy.port}:${proxy.username}:${proxy.password}`;
  }
  return `${proxy.host}:${proxy.port}`;
}

/**
 * Like toLine but masks the password.
 */
function toMaskedLine(proxy) {
  if (!proxy) return '';
  if (proxy.username && proxy.password) {
    return `${proxy.host}:${proxy.port}:${proxy.username}:****`;
  }
  return `${proxy.host}:${proxy.port}`;
}

module.exports = { parseProxyLines, getUsableProxies, toLine, toMaskedLine };
  
