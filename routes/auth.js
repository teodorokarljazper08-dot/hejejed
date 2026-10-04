const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { requireAuth, requireGuest } = require('../middleware/auth');
const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.json({ success: false, message: 'Invalid username or password' });
  if (user.banned) return res.json({ success: false, message: 'Account banned: ' + (user.ban_reason || 'contact admin') });
  req.session.userId = user.id;
  req.session.save(() => res.json({ success: true, redirect: '/dashboard' }));
});

router.post('/register', (req, res) => {
  const { username, password, token } = req.body;
  if (!username || !password || !token)
    return res.json({ success: false, message: 'All fields required' });
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username))
    return res.json({ success: false, message: 'Username: 3-32 chars, letters/numbers/._- only' });
  if (password.length < 6)
    return res.json({ success: false, message: 'Password must be at least 6 characters' });

  const tk = db.prepare('SELECT * FROM activation_tokens WHERE token = ? AND used_by IS NULL').get(token.trim().toUpperCase());
  if (!tk) return res.json({ success: false, message: 'Invalid or already used activation token' });
  
