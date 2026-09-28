const pool = require('../config/db');
const { localDate } = require('../services/dateService');
const path = require('path');
const certificateService = require('../services/certificateService');
const { logAction } = require('../services/auditService');

// POST /api/certificates/generate  { employee_id, event_title, event_id?, award_date?, venue? }
// award_date (YYYY-MM-DD) and venue fill the "Given this award on ___ at ___"
// line; award_date defaults to today, venue to the event's own venue.
async function generateCertificate(req, res, next) {
  try {
    const { employee_id, event_title, event_id } = req.body;
    const awardDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.award_date || '')) ? req.body.award_date : null;
    let venue = String(req.body.venue || '').trim().slice(0, 150);
    if (!employee_id || !event_title) {
      return res.status(400).json({ success: false, message: 'employee_id and event_title are required.' });
    }

    const [empRows] = await pool.query('SELECT full_name FROM employees WHERE id = ?', [employee_id]);
    if (!empRows[0]) return res.status(404).json({ success: false, message: 'Employee not found.' });

    if (!venue && event_id) {
      const [eventRows] = await pool.query('SELECT venue FROM events WHERE id = ?', [event_id]);
      venue = eventRows[0]?.venue || '';
    }

    const template = await loadTemplate();
    const certificateNumber = `CERT-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
    const issuedDate = localDate();

    const { pdfPath } = await certificateService.generateCertificatePdf({
      certificateNumber,
      employeeName: empRows[0].full_name,
      eventTitle: event_title,
      issuedDate,
      awardDate,
      venue,
      template
    });

    const relativePath = `/uploads/certificates/${path.basename(pdfPath)}`;

    const [result] = await pool.query(
      `INSERT INTO certificates (employee_id, event_id, certificate_number, event_title, issued_date, pdf_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [employee_id, event_id || null, certificateNumber, event_title, issuedDate, relativePath]
    );

    await logAction({ adminId: req.admin.id, action: 'generate', module: 'certificates', details: { certificateNumber }, ip: req.ip });

    res.status(201).json({
      success: true,
      message: 'Certificate generated successfully.',
      data: { id: result.insertId, certificateNumber, downloadUrl: relativePath }
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/certificates
async function getCertificates(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, e.full_name FROM certificates c JOIN employees e ON c.employee_id = e.id
       ORDER BY c.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// Admin-editable certificate wording, stored as JSON in settings. Only the
// keys in certificateService.DEFAULT_TEMPLATE are kept.
const TEMPLATE_SETTING_KEY = 'certificate_template';

async function loadTemplate() {
  const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [TEMPLATE_SETTING_KEY]);
  try {
    return certificateService.resolveTemplate(JSON.parse(rows[0]?.setting_value || '{}'));
  } catch (e) {
    return certificateService.resolveTemplate();
  }
}

// GET /api/certificates/template
async function getTemplate(req, res, next) {
  try {
    res.json({ success: true, data: await loadTemplate(), defaults: certificateService.DEFAULT_TEMPLATE });
  } catch (err) {
    next(err);
  }
}

// PUT /api/certificates/template  { schoolName, accreditation, ... }
// A blank field resets that part back to its default wording.
async function saveTemplate(req, res, next) {
  try {
    const clean = {};
    Object.keys(certificateService.DEFAULT_TEMPLATE).forEach((k) => {
      const v = req.body[k];
      if (typeof v === 'string' && v.trim()) clean[k] = v.trim().slice(0, 200);
    });
    await pool.query(
      `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [TEMPLATE_SETTING_KEY, JSON.stringify(clean)]
    );
    await logAction({ adminId: req.admin.id, action: 'update_template', module: 'certificates', details: clean, ip: req.ip });
    res.json({ success: true, message: 'Certificate template saved.', data: certificateService.resolveTemplate(clean) });
  } catch (err) {
    next(err);
  }
}

module.exports = { generateCertificate, getCertificates, getTemplate, saveTemplate };
