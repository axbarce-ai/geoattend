const pool = require('../config/db');
const ocrService = require('../services/ocrService');
const { logAction } = require('../services/auditService');
const { removeUpload } = require('../services/uploadStore');
const { recordVerificationAttendance } = require('./attendanceController');

// POST /api/ocr/verify  (multipart: image)
// Body also accepts an optional `event_id` — when provided and identity is
// matched, this verification doubles as a one-time attendance roll-call for
// that event (see recordVerificationAttendance), the alternative to the
// mobile app's GPS check-in for an employee who came without their phone.
// Scans an ID card, extracts ONLY the employee ID number (no name/position
// guessing from the card), and looks that number up directly against the
// `employees` table. Name/position shown to the admin always come from that
// database record — never from what OCR "read" off the card — so the result
// is a simple two-outcome check: the ID number is registered ("Match") or
// it isn't ("No Match").
async function verifyId(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'An ID card image is required.' });
    }

    const imagePath = `/uploads/ocr/${req.file.filename}`;
    const absolutePath = req.file.path;
    const eventId = req.body.event_id ? Number(req.body.event_id) : null;

    const { text } = await ocrService.extractText(absolutePath);
    const { employeeCode } = ocrService.parseIdCard(text);

    // Minimal server-console debug — just what was actually extracted.
    console.log('[OCR] Extracted employee number:', employeeCode || '(none found)');

    let result = 'no_match';
    let matchedEmployee = null;

    if (employeeCode) {
      const [rows] = await pool.query(
        `SELECT e.*, d.name AS department_name FROM employees e
         JOIN departments d ON e.department_id = d.id WHERE e.employee_code = ? AND e.is_approved = 1`,
        [employeeCode]
      );
      if (rows[0]) {
        matchedEmployee = rows[0];
        result = 'matched';
      }
    }

    const [insertResult] = await pool.query(
      `INSERT INTO ocr_records (employee_id, image_path, extracted_text, extracted_employee_code, result)
       VALUES (?, ?, ?, ?, ?)`,
      [matchedEmployee ? matchedEmployee.id : null, imagePath, text, employeeCode, result]
    );

    await logAction({
      adminId: req.admin ? req.admin.id : null,
      action: 'ocr_verify',
      module: 'ocr',
      details: { result, employeeCode },
      ip: req.ip
    });

    // Attendance is only attempted on an actual identity match — no match
    // means there's no employee to record attendance FOR.
    let attendance = null;
    if (result === 'matched' && eventId) {
      try {
        attendance = await recordVerificationAttendance({
          employeeId: matchedEmployee.id,
          eventId,
          method: 'ocr',
          ocrRecordId: insertResult.insertId,
          adminId: req.admin ? req.admin.id : null
        });
      } catch (attErr) {
        console.error('OCR-triggered attendance recording failed:', attErr.message);
        attendance = { success: false, status: 500, message: 'Identity verified, but recording attendance failed. Please try again or record it manually.' };
      }
    }

    res.json({
      success: result === 'matched',
      result,
      match: result === 'matched' ? 'Match' : 'No Match',
      ocrRecordId: insertResult.insertId,
      extractedEmployeeCode: employeeCode,
      employee: matchedEmployee
        ? {
            id: matchedEmployee.id,
            employee_code: matchedEmployee.employee_code,
            full_name: matchedEmployee.full_name,
            position: matchedEmployee.position,
            department: matchedEmployee.department_name
          }
        : null,
      attendance,
      message:
        result === 'matched'
          ? 'Identity verified successfully.'
          : employeeCode
          ? 'No employee record matches this ID number.'
          : 'Could not read an employee ID number from this card. Please retake the photo.'
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/ocr/records
async function getOcrRecords(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT o.*, e.full_name, e.employee_code, e.position FROM ocr_records o
       LEFT JOIN employees e ON o.employee_id = e.id
       ORDER BY o.created_at DESC LIMIT 100`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/ocr/records/:id
// Removes one scan from the Recent ID Scans log together with its photo.
// An attendance row recorded from this scan keeps its attendance; only its
// ocr_record_id link is cleared (ON DELETE SET NULL).
async function deleteOcrRecord(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT id, image_path, result FROM ocr_records WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'ID scan not found.' });

    await pool.query('DELETE FROM ocr_records WHERE id = ?', [rows[0].id]);
    await removeUpload(rows[0].image_path).catch((err) =>
      console.error(`[OCR] Could not delete photo ${rows[0].image_path}:`, err.message));

    await logAction({
      adminId: req.admin ? req.admin.id : null,
      action: 'delete',
      module: 'ocr',
      details: { ocr_record_id: rows[0].id, result: rows[0].result },
      ip: req.ip
    });
    res.json({ success: true, message: 'ID scan deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { verifyId, getOcrRecords, deleteOcrRecord };
