const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../config/db');
const { logAction } = require('../services/auditService');
const { sendMail, checkDeliverable } = require('../services/mailService');

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 60;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// GET /api/admin-accounts
async function getAdminAccounts(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT id, full_name, email, role, is_active, last_login, created_at FROM admin_accounts ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin-accounts/send-otp — { email, full_name }
// Emails a 6-digit code to the new admin's address. Creating the account
// (below) requires that code, so only a real inbox the person controls can
// become an admin account.
async function sendAdminOtp(req, res, next) {
  try {
    const email = normalizeEmail(req.body.email);
    const fullName = String(req.body.full_name || '').trim();

    const deliverable = await checkDeliverable(email);
    if (!deliverable.ok) return res.status(400).json({ success: false, message: deliverable.reason });

    const [dup] = await pool.query('SELECT id FROM admin_accounts WHERE email = ?', [email]);
    if (dup[0]) return res.status(409).json({ success: false, message: 'An admin account with that email already exists.' });

    const [recent] = await pool.query(
      'SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age FROM admin_email_otps WHERE email = ? ORDER BY id DESC LIMIT 1',
      [email]
    );
    if (recent[0] && recent[0].age < OTP_RESEND_SECONDS) {
      const wait = OTP_RESEND_SECONDS - recent[0].age;
      return res.status(429).json({ success: false, message: `Please wait ${wait}s before requesting another code.`, retryAfterSeconds: wait });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const codeHash = await bcrypt.hash(code, 10);
    await pool.query('DELETE FROM admin_email_otps WHERE email = ?', [email]);
    await pool.query(
      'INSERT INTO admin_email_otps (email, code_hash, expires_at, created_by) VALUES (?, ?, NOW() + INTERVAL ? MINUTE, ?)',
      [email, codeHash, OTP_TTL_MINUTES, req.admin.id]
    );

    const greeting = fullName ? `Hi ${fullName},` : 'Hi,';
    const inviter = req.admin.name || 'A Super Admin';
    const result = await sendMail({
      to: email,
      subject: `${code} is your GeoAttend admin verification code`,
      text: `${greeting}\n\n${inviter} is creating a GeoAttend admin account for this email address.\n\nYour verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.\n\nIf you weren't expecting this, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1B2559">
        <h2 style="color:#0D00A5;margin-bottom:4px">GeoAttend</h2>
        <p>${escapeHtml(greeting)}</p>
        <p>${escapeHtml(inviter)} is creating a GeoAttend admin account for this email address. Enter this code to verify it:</p>
        <p style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#F0F2FF;padding:16px;text-align:center;border-radius:12px">${code}</p>
        <p style="color:#6B7280;font-size:13px">The code expires in ${OTP_TTL_MINUTES} minutes. If you weren't expecting this, you can ignore this email.</p>
      </div>`
    });

    await logAction({ adminId: req.admin.id, action: 'send_otp', module: 'admin_accounts', details: { email }, ip: req.ip });
    res.json({
      success: true,
      message: result.sent
        ? `Verification code sent to ${email}.`
        : 'Email sending is not configured, so the code was printed in the server terminal instead.',
      expiresInMinutes: OTP_TTL_MINUTES,
      resendAfterSeconds: OTP_RESEND_SECONDS
    });
  } catch (err) {
    next(err);
  }
}

// Checks (and on success consumes) the emailed code for `email`. Returns an
// error message, or null when the code is right.
async function verifyAdminOtp(email, otp) {
  const [rows] = await pool.query(
    'SELECT id, code_hash, attempts, expires_at < NOW() AS expired FROM admin_email_otps WHERE email = ? ORDER BY id DESC LIMIT 1',
    [email]
  );
  const row = rows[0];
  if (!row) return 'Send a verification code to this email first.';
  if (row.expired) return 'The verification code has expired. Send a new one.';
  if (row.attempts >= OTP_MAX_ATTEMPTS) return 'Too many wrong codes. Send a new one.';
  if (!/^\d{6}$/.test(String(otp || '')) || !(await bcrypt.compare(String(otp), row.code_hash))) {
    await pool.query('UPDATE admin_email_otps SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    const left = OTP_MAX_ATTEMPTS - row.attempts - 1;
    return left > 0 ? `Incorrect verification code (${left} attempt${left === 1 ? '' : 's'} left).` : 'Too many wrong codes. Send a new one.';
  }
  await pool.query('DELETE FROM admin_email_otps WHERE email = ?', [email]);
  return null;
}

// POST /api/admin-accounts — { full_name, email, password, role, otp }
// role: 'super_admin' (full access) or 'admin' (Verification module only — OCR & Face)
// otp: the code emailed by sendAdminOtp.
async function createAdminAccount(req, res, next) {
  try {
    const { full_name, password, role, otp } = req.body;
    const email = normalizeEmail(req.body.email);
    if (!full_name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Full name, email, and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    if (!['super_admin', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Role must be super_admin or admin.' });
    }

    const [dup] = await pool.query('SELECT id FROM admin_accounts WHERE email = ?', [email]);
    if (dup[0]) return res.status(409).json({ success: false, message: 'An admin account with that email already exists.' });

    const otpError = await verifyAdminOtp(email, otp);
    if (otpError) return res.status(400).json({ success: false, code: 'OTP_INVALID', message: otpError });

    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      `INSERT INTO admin_accounts (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
      [full_name, email, hash, role]
    );

    await logAction({ adminId: req.admin.id, action: 'create', module: 'admin_accounts', details: { email, role }, ip: req.ip });
    res.status(201).json({ success: true, message: 'Admin account created.', data: { id: result.insertId } });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin-accounts/:id — { full_name, role, is_active, password }
async function updateAdminAccount(req, res, next) {
  try {
    const { id } = req.params;
    const { full_name, role, is_active, password } = req.body;

    const [existing] = await pool.query('SELECT * FROM admin_accounts WHERE id = ?', [id]);
    if (!existing[0]) return res.status(404).json({ success: false, message: 'Admin account not found.' });

    if (Number(id) === req.admin.id && role && role !== existing[0].role) {
      return res.status(400).json({ success: false, message: 'You cannot change your own role.' });
    }
    if (Number(id) === req.admin.id && is_active === false) {
      return res.status(400).json({ success: false, message: 'You cannot deactivate your own account.' });
    }
    if (role && !['super_admin', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Role must be super_admin or admin.' });
    }

    const passwordHash = password ? await bcrypt.hash(password, 12) : existing[0].password_hash;

    await pool.query(
      `UPDATE admin_accounts SET full_name = ?, role = ?, is_active = ?, password_hash = ? WHERE id = ?`,
      [
        full_name || existing[0].full_name,
        role || existing[0].role,
        is_active === undefined ? existing[0].is_active : (is_active ? 1 : 0),
        passwordHash,
        id
      ]
    );

    await logAction({ adminId: req.admin.id, action: 'update', module: 'admin_accounts', details: { id }, ip: req.ip });
    res.json({ success: true, message: 'Admin account updated.' });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/admin-accounts/:id
async function deleteAdminAccount(req, res, next) {
  try {
    const { id } = req.params;
    if (Number(id) === req.admin.id) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
    }
    const [result] = await pool.query('DELETE FROM admin_accounts WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Admin account not found.' });

    await logAction({ adminId: req.admin.id, action: 'delete', module: 'admin_accounts', details: { id }, ip: req.ip });
    res.json({ success: true, message: 'Admin account deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAdminAccounts, sendAdminOtp, createAdminAccount, updateAdminAccount, deleteAdminAccount };
