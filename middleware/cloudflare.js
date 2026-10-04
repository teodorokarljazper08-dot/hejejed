// Cloudflare middleware — reads CF-Connecting-IP and CF headers,
// attaches them to req, and logs suspicious traffic bursts.

const ATTACK_LOG = [];
const MAX_LOG    = 500;

function cloudflareMiddleware(req, res, next) {
  // Real IP: prefer CF header, fall back to X-Forwarded-For, then socket
  req.realIP =
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    '0.0.0.0';

  req.cfMeta = {
    country:  req.headers['cf-ipcountry']  || 'XX',
    ray:      req.headers['cf-ray']        || '',
    visitor:  req.headers['cf-visitor']    || '',
  };

  // Log high-frequency paths that look like scanners / bots
  const path = req.path || '';
  const suspicious =
    path.includes('..') ||
    path.includes('wp-') ||
    path.includes('.env') ||
    path.includes('phpmy') ||
    path.includes('admin.php');

  if (suspicious) {
    const entry = {
      ip:         req.realIP,
      country:    req.cfMeta.country,
      cf_ray:     req.cfMeta.ray,
      path,
      user_agent: req.headers['user-agent'] || '',
      ts:         Date.now(),
    };
    ATTACK_LOG.unshift(entry);
    if (ATTACK_LOG.length > MAX_LOG) ATTACK_LOG.length = MAX_LOG;
  }

  next();
}

function getRecentAttacks(limit = 100) {
  return ATTACK_LOG.slice(0, limit);
}

function getTopAttackers(limit = 20) {
  const counts = {};
  for (const e of ATTACK_LOG) {
    counts[e.ip] = (counts[e.ip] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ip, hits]) => ({ ip, hits }));
}

module.exports = { cloudflareMiddleware, getRecentAttacks, getTopAttackers };
