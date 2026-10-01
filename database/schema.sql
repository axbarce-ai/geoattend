-- ============================================================
-- GeoAttend Pro — Database Schema (MySQL 8+)
-- ============================================================

CREATE DATABASE IF NOT EXISTS geoattend_pro
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE geoattend_pro;

-- ------------------------------------------------------------
-- ADMIN ACCOUNTS
-- ------------------------------------------------------------
CREATE TABLE admin_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NULL,  -- unused: admins sign in with Google only
  role ENUM('super_admin','admin','staff') DEFAULT 'admin',
  is_active TINYINT(1) DEFAULT 1,
  last_login DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- TOKENS (refresh / password-reset)
-- ------------------------------------------------------------
CREATE TABLE tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id INT NOT NULL,
  token VARCHAR(255) NOT NULL,
  type ENUM('refresh','reset_password') NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES admin_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- DEPARTMENTS
-- ------------------------------------------------------------
CREATE TABLE departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,
  office VARCHAR(150) NULL,
  description TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- EMPLOYEES
-- ------------------------------------------------------------
CREATE TABLE employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_code VARCHAR(20) NOT NULL UNIQUE,
  full_name VARCHAR(150) NOT NULL,
  surname VARCHAR(80) NULL,
  given_name VARCHAR(80) NULL,
  middle_name VARCHAR(80) NULL,
  suffix VARCHAR(10) NULL,
  department_id INT NOT NULL,
  office VARCHAR(150) NULL,
  position VARCHAR(120) NULL,
  gender VARCHAR(40) NULL,
  photo_path VARCHAR(255) NULL,
  email VARCHAR(150) UNIQUE NULL,
  phone VARCHAR(30) NULL,
  password_hash VARCHAR(255) NULL,
  status ENUM('Full-time','Part-time','COS','Inactive') DEFAULT 'Full-time',
  remark ENUM('Active','On Leave') DEFAULT 'Active',
  -- Was ENUM('Regular','COS','Casual') until the mobile registration form's
  -- Classification field got its own fixed option list (Permanent
  -- Administrative, Permanent Academic, Casual Administrative, COS
  -- Administrative, COS Academic, Job Order) plus a free-text "Others"
  -- override -- an ENUM can't hold a value that isn't one of its declared
  -- options, so it was widened to VARCHAR. Existing 'Regular'/'COS'/'Casual'
  -- values are untouched and keep working everywhere they're already used
  -- (the Dashboard breakdown chart, the admin Employees classification
  -- badge/filter) -- they just now sit alongside the new values rather than
  -- being the only three ever possible.
  classification VARCHAR(50) DEFAULT 'Permanent Administrative',
  attendance_score DECIMAL(5,2) DEFAULT 100.00,
  rating_points DECIMAL(6,2) DEFAULT 0,
  -- DoubleSafe-style device re-verification (employeeAuthController.linkDevice):
  -- tracks failed live-selfie-vs-enrolled-face match attempts when registering a
  -- NEW device for an employee who already has a face on file, and locks further
  -- attempts out after too many failures.
  face_failed_attempts INT NOT NULL DEFAULT 0,
  face_locked_until DATETIME NULL,
  face_lock_reason VARCHAR(255) NULL,
  -- 0 = registered themselves in the app, not yet accepted by an admin;
  -- hidden from the Employees list until their device is approved.
  is_approved TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- MOBILE DEVICES
-- ------------------------------------------------------------
CREATE TABLE mobile_devices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  device_uid VARCHAR(150) NOT NULL UNIQUE, -- Android ID / IMEI-derived unique id
  model VARCHAR(120) NULL,
  brand VARCHAR(120) NULL,
  os VARCHAR(60) NULL,
  status ENUM('pending','approved','rejected','blacklisted') DEFAULT 'pending',
  registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- EVENTS (used for scheduled attendance windows)
-- ------------------------------------------------------------
CREATE TABLE events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  venue VARCHAR(200) NULL,
  start_datetime DATETIME NOT NULL,
  end_datetime DATETIME NOT NULL,
  department_id INT NULL,
  is_active TINYINT(1) DEFAULT 1,
  recurrence_type ENUM('none','weekly','dates') NOT NULL DEFAULT 'none',
  recurrence_days VARCHAR(20) NULL,
  recurrence_end_date DATE NULL,
  is_recurring_parent TINYINT(1) NOT NULL DEFAULT 0,
  parent_event_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (parent_event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- GEOFENCE (circle geofences tied to an event)
-- ------------------------------------------------------------
CREATE TABLE geofences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  venue VARCHAR(200) NULL,
  shape_type ENUM('circle','polygon','rectangle') DEFAULT 'circle',
  center_lat DECIMAL(10,7) NULL,
  center_lng DECIMAL(10,7) NULL,
  radius_meters INT NULL,
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- GEOFENCE POINTS (for polygon/rectangle shapes)
-- ------------------------------------------------------------
CREATE TABLE geofence_points (
  id INT AUTO_INCREMENT PRIMARY KEY,
  geofence_id INT NOT NULL,
  point_order INT NOT NULL,
  lat DECIMAL(10,7) NOT NULL,
  lng DECIMAL(10,7) NOT NULL,
  FOREIGN KEY (geofence_id) REFERENCES geofences(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- OCR RECORDS
-- ------------------------------------------------------------
CREATE TABLE ocr_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NULL,
  image_path VARCHAR(255) NOT NULL,
  extracted_text TEXT NULL,
  extracted_employee_code VARCHAR(20) NULL,
  result ENUM('matched','no_match','wrong_employee','wrong_id','unreadable','duplicate','expired','low_confidence') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- FACE VERIFICATION (added in migration_v7) — second identity
-- verification method alongside OCR, backed by an ONNX face
-- recognition model (see services/faceService.js).
-- ------------------------------------------------------------
CREATE TABLE employee_faces (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  image_path VARCHAR(255) NOT NULL,
  video_path VARCHAR(255) NULL, -- optional guided liveness clip (blink/nod/turn-head) recorded during mobile registration
  embedding LONGTEXT NOT NULL, -- JSON array of floats produced by the ONNX face-recognition model
  model_name VARCHAR(100) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE face_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NULL,
  image_path VARCHAR(255) NOT NULL,
  similarity DECIMAL(5,2) NULL,
  result ENUM('matched','no_match','no_face_detected','expired','duplicate') NOT NULL,
  liveness_verified TINYINT(1) NOT NULL DEFAULT 0,
  liveness_actions VARCHAR(120) NULL,
  -- 'kiosk' (admin Verification page) or 'mobile_anomaly' (employee's own
  -- re-verification after an anomaly flag, in the mobile app)
  source VARCHAR(20) NOT NULL DEFAULT 'kiosk',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- DOUBLESAFE-STYLE DEVICE RE-VERIFICATION ATTEMPTS
-- One row per DoubleSafe checkpoint run during employeeAuthController.linkDevice:
-- registering a NEW device for an employee who already has a face enrolled must
-- have their live selfie matched against that face on file first (mirrors
-- GCash's DoubleSafe device-change re-verification). Separate from face_records
-- (which logs the ADMIN dashboard's kiosk verification tool) since this is a
-- self-service, employee-initiated checkpoint with its own lockout policy.
-- ------------------------------------------------------------
CREATE TABLE device_verification_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  device_uid VARCHAR(255) NULL,
  image_path VARCHAR(255) NULL,
  similarity DECIMAL(5,2) NULL,
  result ENUM('matched','no_match','locked') NOT NULL,
  liveness_verified TINYINT(1) NOT NULL DEFAULT 0,
  liveness_actions VARCHAR(120) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- ATTENDANCE (one row per completed day/session)
-- ------------------------------------------------------------
CREATE TABLE attendance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  event_id INT NULL,
  geofence_id INT NULL,
  device_id INT NULL,
  ocr_record_id INT NULL,
  -- How this row's time-in was captured: the normal mobile app + GPS flow,
  -- or an admin-run alternative at the dashboard's Verification kiosk (ID
  -- card scan, or live selfie) for an employee without their phone/ID.
  -- See faceRecordId/verifiedByAdminId below for which record/admin did it.
  verification_method ENUM('mobile_gps','ocr','face') NOT NULL DEFAULT 'mobile_gps',
  face_record_id INT NULL,
  verified_by_admin_id INT NULL,
  attendance_date DATE NOT NULL,
  time_in DATETIME NULL,
  time_out DATETIME NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  accuracy_meters DECIMAL(6,2) NULL,
  attendance_status ENUM('Present','Late','Absent','Excused') DEFAULT 'Present',
  verification_status ENUM('Verified','Pending','Rejected') DEFAULT 'Pending',
  late_minutes INT DEFAULT 0,
  work_hours DECIMAL(5,2) DEFAULT 0,
  total_duration_seconds INT NOT NULL DEFAULT 0, -- accumulated across every time-in/time-out session for the day
  last_lat DECIMAL(10,7) NULL,
  last_lng DECIMAL(10,7) NULL,
  last_ping_at DATETIME NULL,
  outside_streak INT DEFAULT 0,
  auto_ended TINYINT(1) DEFAULT 0,
  selfie_path VARCHAR(255) NULL,
  selfie_lat DECIMAL(10,7) NULL,
  selfie_lng DECIMAL(10,7) NULL,
  requires_face_verification TINYINT(1) DEFAULT 0,
  face_verified_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL,
  FOREIGN KEY (geofence_id) REFERENCES geofences(id) ON DELETE SET NULL,
  FOREIGN KEY (device_id) REFERENCES mobile_devices(id) ON DELETE SET NULL,
  FOREIGN KEY (ocr_record_id) REFERENCES ocr_records(id) ON DELETE SET NULL,
  FOREIGN KEY (face_record_id) REFERENCES face_records(id) ON DELETE SET NULL,
  FOREIGN KEY (verified_by_admin_id) REFERENCES admin_accounts(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_emp_date_event (employee_id, attendance_date, event_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- ATTENDANCE SESSIONS (one row per time-in/time-out cycle —
-- an employee can leave and re-enter an event's geofence any
-- number of times while it's still running; each dip is one row
-- here, and the parent `attendance` row above accumulates the
-- total duration across all of them via total_duration_seconds)
-- ------------------------------------------------------------
CREATE TABLE attendance_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attendance_id INT NOT NULL,
  employee_id INT NOT NULL,
  time_in DATETIME NOT NULL,
  time_out DATETIME NULL,
  duration_seconds INT NULL,
  in_latitude DECIMAL(10,7) NULL,
  in_longitude DECIMAL(10,7) NULL,
  out_latitude DECIMAL(10,7) NULL,
  out_longitude DECIMAL(10,7) NULL,
  auto_ended TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- ATTENDANCE LOGS (raw event trail: entered geofence, exited, denied, etc.)
-- ------------------------------------------------------------
CREATE TABLE attendance_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attendance_id INT NULL,
  employee_id INT NOT NULL,
  action VARCHAR(60) NOT NULL, -- e.g. geofence_entered, geofence_exited, attendance_submitted, attendance_rejected
  details TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- NOTIFICATIONS
-- ------------------------------------------------------------
CREATE TABLE notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(60) DEFAULT 'general',
  is_read TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- ADMIN NOTIFICATIONS (dashboard bell -- device registrations, unregistered
-- device attempts, geo anomalies; see services/adminNotificationService.js)
-- ------------------------------------------------------------
CREATE TABLE admin_notifications (
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
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- ADMIN EMAIL OTPS (verifies a new admin's email before the account exists)
-- ------------------------------------------------------------
CREATE TABLE admin_email_otps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(150) NOT NULL,
  code_hash VARCHAR(255) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_email_otps_email (email)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- CERTIFICATES
-- ------------------------------------------------------------
CREATE TABLE certificates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  event_id INT NULL,
  certificate_number VARCHAR(60) NOT NULL UNIQUE,
  event_title VARCHAR(200) NOT NULL,
  issued_date DATE NOT NULL,
  pdf_path VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- EMPLOYEE RATINGS (one row per employee per EVENT, auto-generated once the
-- event ends from the employee's attendance status for that event —
-- 1 = absent, 5 = present — and admin-editable afterward. rating_date is
-- kept as a denormalized copy of the event's date for easy month/year
-- filtering without a join.)
-- ------------------------------------------------------------
CREATE TABLE employee_ratings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  event_id INT NULL,
  rating_date DATE NOT NULL,
  rating TINYINT NOT NULL DEFAULT 1,
  is_manual TINYINT(1) DEFAULT 0,
  notes VARCHAR(255) NULL,
  updated_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES admin_accounts(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_emp_rating_event (employee_id, event_id),
  CONSTRAINT chk_rating_range CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- GEO ANOMALIES (suspected spoofing/hacking alerts)
-- ------------------------------------------------------------
CREATE TABLE geo_anomalies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attendance_id INT NULL,
  employee_id INT NOT NULL,
  event_id INT NULL,
  device_uid VARCHAR(150) NULL,
  anomaly_type ENUM('duplicate_geolocation','device_mismatch','impossible_travel','other') DEFAULT 'duplicate_geolocation',
  details TEXT NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  resolved TINYINT(1) DEFAULT 0,
  resolved_by INT NULL,
  resolved_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL,
  FOREIGN KEY (resolved_by) REFERENCES admin_accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- AUDIT LOGS
-- ------------------------------------------------------------
CREATE TABLE audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id INT NULL,
  action VARCHAR(100) NOT NULL,
  module VARCHAR(60) NOT NULL,
  details TEXT NULL,
  ip_address VARCHAR(60) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES admin_accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- SETTINGS (key-value system settings)
-- ------------------------------------------------------------
CREATE TABLE settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(100) NOT NULL UNIQUE,
  setting_value TEXT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- STORED UPLOADS (durable copies of uploaded photos, keyed by their
-- /uploads/... path; the host's disk is wiped on restart). Also created
-- automatically on first use -- see services/uploadStore.js.
-- ------------------------------------------------------------
CREATE TABLE stored_uploads (
  path VARCHAR(255) NOT NULL PRIMARY KEY,
  mime_type VARCHAR(50) NOT NULL,
  data MEDIUMBLOB NOT NULL,
  size_bytes INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Indexes for common lookups
-- ------------------------------------------------------------
-- attendance(employee_id) is covered by uniq_emp_date_event, and
-- attendance_sessions(attendance_id) by idx_attendance_sessions_open, so
-- neither gets a separate single-column index.
CREATE INDEX idx_attendance_date ON attendance(attendance_date);
CREATE INDEX idx_attendance_sessions_open ON attendance_sessions(attendance_id, time_out);
CREATE INDEX idx_employees_dept ON employees(department_id);
CREATE INDEX idx_geofence_event ON geofences(event_id);
CREATE INDEX idx_employee_ratings_date ON employee_ratings(rating_date);
CREATE INDEX idx_employee_ratings_event ON employee_ratings(event_id);
CREATE INDEX idx_geo_anomalies_resolved ON geo_anomalies(resolved);
CREATE INDEX idx_employees_classification ON employees(classification);
CREATE INDEX idx_events_parent ON events(parent_event_id);
