// services/mailer.js
// Email service — uses SMTP via nodemailer if configured,
// otherwise logs to console (safe no-op for Railway without SMTP).
//
// Required env vars (all optional — if missing, emails are skipped):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM

let _transport = null;

function _getTransport() {
  if (_transport) return _transport;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  try {
    const nodemailer = require('nodemailer');
    _transport = nodemailer.createTransport({
      host,
      port:   Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth:   { user, pass },
    });
    return _transport;
  } catch {
    return null;
  }
}

async function sendMail({ to, subject, html, text }) {
  const transport = _getTransport();
  if (!transport) {
    console.log(`[KARL/mailer] (no SMTP) Would send to ${to}: ${subject}`);
    return;
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await transport.sendMail({ from, to, subject, html, text });
  } catch (e) {
    console.error('[KARL/mailer] Send failed:', e.message);
  }
}

function planExpiryEmail({ username, plan, expiresAt }) {
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:auto">
      <h2>⏰ Your KARL plan is expiring soon</h2>
      <p>Hi <b>${username}</b>,</p>
      <p>Your <b>${plan}</b> plan expires on <b>${expiresAt}</b>.</p>
      <p>Contact the admin to renew before your bots are stopped.</p>
      <hr/>
      <small>KARL Bot Hosting</small>
    </div>
  `;
}

module.exports = { sendMail, planExpiryEmail };
                  
