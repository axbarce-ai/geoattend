const pool = require('../config/db');

// Small, idempotent schema changes applied at server start, so an existing
// database (e.g. the live Aiven one) picks them up without a manual
// migration. Each step checks before changing anything.

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
}

// employees.is_approved: 0 for someone who registered themselves in the app
// and hasn't been accepted by an admin yet (their device is still pending).
// They stay out of the Employees list, dashboard counts, ratings and reports
// until an admin approves their device (deviceController.updateDeviceStatus).
// Everyone already in the database counts as approved, except earlier
// self-registrations whose device was never approved.
async function addEmployeeApproval() {
  if (await columnExists('employees', 'is_approved')) return;
  await pool.query('ALTER TABLE employees ADD COLUMN is_approved TINYINT(1) NOT NULL DEFAULT 1');
  const [result] = await pool.query(
    `UPDATE employees e SET e.is_approved = 0
     WHERE e.employee_code IN (
       SELECT JSON_UNQUOTE(JSON_EXTRACT(a.details, '$.employeeCode')) FROM audit_logs a
       WHERE a.action = 'self_register' AND JSON_VALID(a.details)
     )
     AND NOT EXISTS (SELECT 1 FROM mobile_devices md WHERE md.employee_id = e.id AND md.status = 'approved')`
  );
  console.log(`[schema] Added employees.is_approved (${result.affectedRows} pending self-registration(s)).`);
}

// face_records.source: where a face-verification photo came from -- the
// admin's Verification kiosk ('kiosk', every existing row) or an employee's
// own anomaly re-verification in the mobile app ('mobile_anomaly').
async function addFaceRecordSource() {
  if (await columnExists('face_records', 'source')) return;
  await pool.query("ALTER TABLE face_records ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'kiosk'");
  console.log('[schema] Added face_records.source.');
}

// One-time codes emailed to a new admin's address before the account is
// created (adminAccountController.sendAdminOtp / createAdminAccount), which
// proves the address is real and belongs to them.
async function addAdminEmailOtps() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS admin_email_otps (
       id INT AUTO_INCREMENT PRIMARY KEY,
       email VARCHAR(150) NOT NULL,
       code_hash VARCHAR(255) NOT NULL,
       attempts INT NOT NULL DEFAULT 0,
       expires_at DATETIME NOT NULL,
       created_by INT NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_admin_email_otps_email (email)
     ) ENGINE=InnoDB`
  );
}

// Admins sign in with Google only, so new admin accounts have no password.
async function makeAdminPasswordOptional() {
  const [rows] = await pool.query(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_accounts' AND COLUMN_NAME = 'password_hash'`
  );
  if (!rows[0] || rows[0].IS_NULLABLE === 'YES') return;
  await pool.query('ALTER TABLE admin_accounts MODIFY password_hash VARCHAR(255) NULL');
  console.log('[schema] Made admin_accounts.password_hash optional.');
}

// Alerts shown in the admin dashboard's notification bell (see
// services/adminNotificationService.js).
async function addAdminNotifications() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS admin_notifications (
       id INT AUTO_INCREMENT PRIMARY KEY,
       type VARCHAR(60) NOT NULL,
       severity ENUM('info','success','warning','danger') NOT NULL DEFAULT 'info',
       title VARCHAR(200) NOT NULL,
       message TEXT NOT NULL,
       target_view VARCHAR(40) NULL,
       employee_id INT NULL,
       is_read TINYINT(1) NOT NULL DEFAULT 0,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_admin_notifications_read (is_read, created_at),
       FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
     ) ENGINE=InnoDB`
  );
}

async function indexExists(table, index) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index]
  );
  return rows.length > 0;
}

// Removes schema the app never reads or writes: the old monthly `ratings`
// table (replaced by employee_ratings), columns nothing fills in, and two
// single-column indexes already covered by a composite index on the same
// leading column. Every one of these was empty when this was written.
async function dropUnusedSchema() {
  await pool.query('DROP TABLE IF EXISTS ratings');
  const columns = [
    ['ocr_records', 'extracted_name'],
    ['ocr_records', 'extracted_position'],
    ['ocr_records', 'confidence'],
    ['attendance', 'rejection_reason'],
    ['certificates', 'qr_code_path'],
    ['mobile_devices', 'mac_address']
  ];
  for (const [table, column] of columns) {
    if (!(await columnExists(table, column))) continue;
    await pool.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
    console.log(`[schema] Dropped unused column ${table}.${column}.`);
  }
  const indexes = [
    ['attendance', 'idx_attendance_emp'], // covered by uniq_emp_date_event
    ['attendance_sessions', 'idx_attendance_sessions_attendance'] // covered by idx_attendance_sessions_open
  ];
  for (const [table, index] of indexes) {
    if (!(await indexExists(table, index))) continue;
    await pool.query(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
    console.log(`[schema] Dropped redundant index ${table}.${index}.`);
  }
}

async function run() {
  await addEmployeeApproval();
  await addFaceRecordSource();
  await addAdminEmailOtps();
  await makeAdminPasswordOptional();
  await addAdminNotifications();
  await dropUnusedSchema();
}

module.exports = { run };
