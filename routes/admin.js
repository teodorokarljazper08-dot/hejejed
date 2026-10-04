  db.prepare('DELETE FROM activation_tokens WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.post('/magic-link', (req, res) => {
  const { userId } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user) return res.json({ success: false, message: 'User not found' });
  const token = uuidv4();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO login_links (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);
  const baseUrl = process.env.BASE_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'karl-hosting-production.up.railway.app'}`;
  res.json({ success: true, link: `${baseUrl}/api/auth/magic?t=${token}` });
});

router.get('/stats', (req, res) => {
  res.json({
    success: true,
    stats: {
      totalUsers: db.prepare('SELECT COUNT(*) c FROM users WHERE role != ?').get('admin').c,
      totalBots: db.prepare('SELECT COUNT(*) c FROM bots').get().c,
      runningBots: db.prepare("SELECT COUNT(*) c FROM bots WHERE status='running'").get().c,
      bannedUsers: db.prepare('SELECT COUNT(*) c FROM users WHERE banned=1').get().c,
      unusedTokens: db.prepare('SELECT COUNT(*) c FROM activation_tokens WHERE used_by IS NULL').get().c,
    }
  });
});

module.exports = router;
