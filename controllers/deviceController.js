const pool = require('../config/db');
const { logAction } = require('../services/auditService');
const { isBlockedStatus, blockedMessage } = require('../services/deviceAccess');

// GET /api/devices
// Each device row is paired with the employee_faces row whose created_at is
// closest to that device's registered_at, rather than just the employee's
// most recent face on file -- an employee can register more than once (each
// registration attempt/device inserts its own employee_faces row; see
// FACE_VERIFICATION_README.md's "Known gaps" note), so for someone with
// multiple devices, "closest in time" is what correctly ties each device
// back to the specific photo captured during THAT device's registration
// (linkDevice() inserts both rows in the same request, so they're always
// seconds apart) instead of always showing their newest photo regardless of
// which device is being reviewed.
async function getDevices(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT md.*, e.full_name, e.employee_code, e.position, e.classification,
              e.status AS employee_status, e.remark AS employee_remark,
              e.email, e.phone, e.is_approved AS employee_approved, d.name AS department_name,
              matched_face.image_path AS face_image_path,
              matched_face.created_at AS face_captured_at
       FROM mobile_devices md
       JOIN employees e ON md.employee_id = e.id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN (
         SELECT md2.id AS device_id, ef.image_path, ef.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY md2.id
                  ORDER BY ABS(TIMESTAMPDIFF(SECOND, ef.created_at, md2.registered_at)) ASC
                ) AS rn
         FROM mobile_devices md2
         JOIN employee_faces ef ON ef.employee_id = md2.employee_id
       ) matched_face ON matched_face.device_id = md.id AND matched_face.rn = 1
       ORDER BY md.registered_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// POST /api/devices/register  (called by the mobile app on first login)
async function registerDevice(req, res, next) {
  try {
    const { employee_id, device_uid, model, brand, os } = req.body;
    if (!employee_id || !device_uid) {
      return res.status(400).json({ success: false, message: 'employee_id and device_uid are required.' });
    }
    if (Number(employee_id) !== Number(req.employee.id)) {
      return res.status(403).json({ success: false, message: 'You can only register your own device.' });
    }

    // The employee_id on a phone is cached locally after login and can go
    // stale (e.g. the employee record was deleted/recreated by an admin
    // since). Check it explicitly and fail with a clear, specific error
    // instead of letting the INSERT below hit a foreign-key constraint and
    // leak a raw MySQL message to the app.
    const [employeeRows] = await pool.query('SELECT id FROM employees WHERE id = ?', [employee_id]);
    if (!employeeRows[0]) {
      return res.status(404).json({
        success: false,
        code: 'EMPLOYEE_NOT_FOUND',
        message: 'Your account could not be found. Please sign out and sign in again.'
      });
    }

    const [existing] = await pool.query('SELECT * FROM mobile_devices WHERE device_uid = ?', [device_uid]);
    if (existing[0]) {
      // A device can only ever belong to one employee. If this device_uid is
      // already on file under a different employee, block it instead of silently
      // treating it as "already registered" for the requester.
      if (String(existing[0].employee_id) !== String(employee_id)) {
        return res.status(409).json({
          success: false,
          message: 'This device is already registered to another employee.'
        });
      }
      return res.json({ success: true, message: 'Device already registered.', data: existing[0] });
    }

    // One employee may register and use multiple devices, so no check against
    // the employee already having an approved device here.

    const [result] = await pool.query(
      `INSERT INTO mobile_devices (employee_id, device_uid, model, brand, os, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [employee_id, device_uid, model || null, brand || null, os || null]
    );

    res.status(201).json({ success: true, message: 'Device registered and pending admin approval.', data: { id: result.insertId } });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/devices/:id/status  { status: 'approved'|'rejected'|'blacklisted' }
async function updateDeviceStatus(req, res, next) {
  try {
    const { status } = req.body;
    if (!['pending', 'approved', 'rejected', 'blacklisted'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status value.' });
    }
    const [deviceRows] = await pool.query('SELECT employee_id, status, model FROM mobile_devices WHERE id = ?', [req.params.id]);
    const device = deviceRows[0];
    if (!device) return res.status(404).json({ success: false, message: 'Device not found.' });

    await pool.query('UPDATE mobile_devices SET status = ? WHERE id = ?', [status, req.params.id]);
    // Approving a self-registered employee's device is what accepts them:
    // from now on they appear in the Employees list (see schemaUpgrades.js).
    if (status === 'approved') {
      await pool.query('UPDATE employees SET is_approved = 1 WHERE id = ?', [device.employee_id]);
      // Confirmation alert for the employee: their phone is now registered.
      if (device.status !== 'approved') {
        await pool.query(
          `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Device Registered', ?, 'device_approved')`,
          [device.employee_id, `Your phone${device.model ? ` (${device.model})` : ''} has been approved. You can now record attendance with it.`]
        );
      }
    }
    await logAction({ adminId: req.admin.id, action: 'update_status', module: 'devices', details: { id: req.params.id, status }, ip: req.ip });

    // Tell the employee. A blocked phone is also signed out on its next
    // request (see middleware/authMiddleware.js requireEmployeeAuth), where
    // the app shows its own notification with the same explanation.
    if (isBlockedStatus(status) && device.status !== status) {
      await pool.query(
        `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, ?, ?, 'device_blocked')`,
        [device.employee_id, status === 'blacklisted' ? 'Device Blacklisted' : 'Device Rejected', blockedMessage(status)]
      );
    }
    res.json({ success: true, message: `Device marked as ${status}.` });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/devices/:id
// Removes a device registration. If it belonged to someone who registered
// themselves and was never accepted (employees.is_approved = 0), and it was
// their only device, their pending employee record goes too (faces etc.
// cascade), so they can register again from scratch. Attendance history keeps
// its rows (attendance.device_id is set to NULL). A phone still signed in on
// this device is signed out on its next request (services/deviceAccess.js).
async function deleteDevice(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT md.id, md.employee_id, md.device_uid, e.is_approved, e.employee_code
       FROM mobile_devices md JOIN employees e ON e.id = md.employee_id WHERE md.id = ?`,
      [req.params.id]
    );
    const device = rows[0];
    if (!device) return res.status(404).json({ success: false, message: 'Device not found.' });

    await pool.query('DELETE FROM mobile_devices WHERE id = ?', [device.id]);

    let employeeRemoved = false;
    if (!device.is_approved) {
      const [[{ remaining }]] = await pool.query('SELECT COUNT(*) AS remaining FROM mobile_devices WHERE employee_id = ?', [device.employee_id]);
      if (remaining === 0) {
        await pool.query('DELETE FROM employees WHERE id = ? AND is_approved = 0', [device.employee_id]);
        employeeRemoved = true;
      }
    }

    await logAction({
      adminId: req.admin.id, action: 'delete', module: 'devices',
      details: { id: device.id, deviceUid: device.device_uid, employeeCode: device.employee_code, pendingRegistrationRemoved: employeeRemoved },
      ip: req.ip
    });
    res.json({
      success: true,
      message: employeeRemoved ? 'Device and pending registration deleted.' : 'Device deleted.',
      data: { employeeRemoved }
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getDevices, registerDevice, updateDeviceStatus, deleteDevice };
