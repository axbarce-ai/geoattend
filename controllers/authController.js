const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const config = require('../config/config');
const { logAction } = require('../services/auditService');

// Issues the admin's JWT (also as a cookie) and records the sign-in.
async function startSession(req, res, admin, { remember = false, method }) {
  const token = jwt.sign(
    { id: admin.id, email: admin.email, role: admin.role, name: admin.full_name },
    config.jwt.secret,
    { expiresIn: remember ? '30d' : config.jwt.expiresIn }
  );

  await pool.query('UPDATE admin_accounts SET last_login = NOW() WHERE id = ?', [admin.id]);
  await logAction({ adminId: admin.id, action: 'login', module: 'auth', details: { method }, ip: req.ip });

  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: (remember ? 30 : 1) * 24 * 60 * 60 * 1000
  });

  res.json({
    success: true,
    message: 'Login successful.',
    token,
    admin: { id: admin.id, name: admin.full_name, email: admin.email, role: admin.role }
  });
}

let googleClient = null;

// POST /api/auth/google  { credential }
// The only way into the admin dashboard: the admin's Google account (Google
// Identity Services on the login screen). Google proves the email; it must belong to an
// active admin account -- SSO never creates accounts, a Super Admin does
// (Settings > Admin Accounts).
async function googleLogin(req, res, next) {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(501).json({ success: false, message: 'Google Sign-In is not configured on this server (GOOGLE_CLIENT_ID).' });
    }
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ success: false, message: 'Missing Google credential.' });

    if (!googleClient) {
      const { OAuth2Client } = require('google-auth-library');
      googleClient = new OAuth2Client();
    }
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Google sign-in could not be verified. Please try again.' });
    }
    if (!payload.email_verified) {
      return res.status(403).json({ success: false, message: 'Your Google email is not verified.' });
    }

    const email = String(payload.email).toLowerCase();
    const [rows] = await pool.query('SELECT * FROM admin_accounts WHERE email = ? AND is_active = 1', [email]);
    if (!rows[0]) {
      return res.status(403).json({ success: false, message: `${email} is not an admin account. Ask a Super Admin to add it in Settings.` });
    }

    await startSession(req, res, rows[0], { method: 'google' });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/logout
async function logout(req, res) {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully.' });
}

// GET /api/auth/me
async function me(req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT id, full_name, email, role, last_login FROM admin_accounts WHERE id = ?',
      [req.admin.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Admin account not found.' });
    res.json({ success: true, admin: rows[0] });
  } catch (err) {
    next(err);
  }
}

module.exports = { googleLogin, logout, me };
