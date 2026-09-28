const pool = require('../config/db');
const { localDate } = require('../services/dateService');

// GET /api/dashboard/stats
async function getStats(req, res, next) {
  try {
    const today = localDate();

    const [[totalEmployees]] = await pool.query('SELECT COUNT(*) AS count FROM employees WHERE is_approved = 1');
    const [[fullTime]] = await pool.query(`SELECT COUNT(*) AS count FROM employees WHERE is_approved = 1 AND status = 'Full-time'`);
    const [[partTime]] = await pool.query(`SELECT COUNT(*) AS count FROM employees WHERE is_approved = 1 AND status = 'Part-time'`);
    const [[inactive]] = await pool.query(`SELECT COUNT(*) AS count FROM employees WHERE is_approved = 1 AND status = 'Inactive'`);
    const [[departments]] = await pool.query('SELECT COUNT(*) AS count FROM departments');
    const [[activeEvents]] = await pool.query(
      `SELECT COUNT(*) AS count FROM events WHERE NOW() BETWEEN start_datetime AND end_datetime`
    );
    const [[activeGeofences]] = await pool.query('SELECT COUNT(*) AS count FROM geofences WHERE is_active = 1');
    const [[devices]] = await pool.query(`SELECT COUNT(*) AS count FROM mobile_devices WHERE status = 'approved'`);
    const [[todayPresent]] = await pool.query(
      `SELECT COUNT(*) AS count FROM attendance WHERE attendance_date = ? AND attendance_status = 'Present'`,
      [today]
    );
    const [[todayLate]] = await pool.query(
      `SELECT COUNT(*) AS count FROM attendance WHERE attendance_date = ? AND attendance_status = 'Late'`,
      [today]
    );

    // Grouped into the same three permanence tiers as the Employees table's
    // classification badge coloring (public/js/app.js classificationBadgeClass):
    // Permanent (Permanent Administrative/Academic), COS (COS
    // Administrative/Academic), and Casual/Job Order (Casual Administrative,
    // Job Order). A fully custom classification typed into the mobile app's
    // "Others" field falls into Other rather than being silently dropped
    // from the count.
    const [classificationBreakdown] = await pool.query(
      `SELECT
         CASE
           WHEN classification LIKE 'Permanent%' THEN 'Permanent'
           WHEN classification LIKE 'COS%' THEN 'COS'
           WHEN classification IN ('Casual Administrative', 'Job Order') THEN 'Casual/Job Order'
           ELSE 'Other'
         END AS classification,
         COUNT(*) AS count
       FROM employees WHERE is_approved = 1 GROUP BY classification`
    );
    // Always return all four buckets, even if one currently has zero employees.
    const classificationMap = { Permanent: 0, COS: 0, 'Casual/Job Order': 0, Other: 0 };
    for (const row of classificationBreakdown) classificationMap[row.classification] = row.count;

    // "Needs attention" counts: things waiting on an admin.
    const [[pendingDevices]] = await pool.query(`SELECT COUNT(*) AS count FROM mobile_devices WHERE status = 'pending'`);
    const [[openAnomalies]] = await pool.query('SELECT COUNT(*) AS count FROM geo_anomalies WHERE resolved = 0');
    const [[lockedFaces]] = await pool.query(
      'SELECT COUNT(*) AS count FROM employees WHERE is_approved = 1 AND face_locked_until IS NOT NULL AND face_locked_until > NOW()'
    );

    // Present / Late per day for the last 7 days (today included), oldest
    // first. Days with no attendance are filled in with zeros.
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(localDate(d));
    }
    const [trendRows] = await pool.query(
      `SELECT DATE_FORMAT(attendance_date, '%Y-%m-%d') AS day,
              SUM(attendance_status = 'Present') AS present,
              SUM(attendance_status = 'Late') AS late
       FROM attendance WHERE attendance_date BETWEEN ? AND ?
       GROUP BY attendance_date`,
      [days[0], days[6]]
    );
    const trendByDay = Object.fromEntries(trendRows.map((r) => [r.day, r]));
    const trend = days.map((day) => ({
      date: day,
      present: Number(trendByDay[day]?.present || 0),
      late: Number(trendByDay[day]?.late || 0)
    }));

    // Events running right now, with how many employees have checked in.
    const [ongoingEvents] = await pool.query(
      `SELECT ev.id, ev.title, ev.venue, ev.start_datetime, ev.end_datetime,
              (SELECT COUNT(DISTINCT a.employee_id) FROM attendance a
                WHERE a.event_id = ev.id AND a.attendance_status IN ('Present','Late')) AS checked_in
       FROM events ev
       WHERE NOW() BETWEEN ev.start_datetime AND ev.end_datetime AND ev.is_recurring_parent = 0
       ORDER BY ev.end_datetime ASC LIMIT 3`
    );

    res.json({
      success: true,
      data: {
        totalEmployees: totalEmployees.count,
        fullTime: fullTime.count,
        partTime: partTime.count,
        inactive: inactive.count,
        departments: departments.count,
        activeEvents: activeEvents.count,
        activeGeofences: activeGeofences.count,
        registeredDevices: devices.count,
        todayPresent: todayPresent.count,
        todayLate: todayLate.count,
        classificationBreakdown: classificationMap,
        pendingDevices: pendingDevices.count,
        openAnomalies: openAnomalies.count,
        lockedFaces: lockedFaces.count,
        trend,
        ongoingEvents
      }
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/dashboard/department-attendance?event_id=&date=&department_id=&classification=
// Total employees vs. employees who attended, grouped by department — powers
// the Dashboard "Department Attendance" grouped bar chart.
async function getDepartmentAttendance(req, res, next) {
  try {
    const { event_id, date, department_id, classification } = req.query;

    // Build the employee-join condition (beyond the department match) separately
    // so it can be embedded directly in the LEFT JOIN's ON clause — filtering
    // employees inside the JOIN condition (not a WHERE) keeps departments with
    // zero matching employees in the results, showing 0 instead of disappearing.
    let empJoinExtra = '';
    const empParams = [];
    if (classification && classification !== 'all') { empJoinExtra += ' AND e.classification = ?'; empParams.push(classification); }

    let attWhere = 'WHERE 1=1';
    const attParams = [];
    if (event_id) { attWhere += ' AND a.event_id = ?'; attParams.push(event_id); }
    if (date) { attWhere += ' AND a.attendance_date = ?'; attParams.push(date); }
    if (department_id) { attWhere += ' AND emp.department_id = ?'; attParams.push(department_id); }
    if (classification && classification !== 'all') { attWhere += ' AND emp.classification = ?'; attParams.push(classification); }

    let deptWhere = '';
    const deptParams = [];
    if (department_id) { deptWhere = 'WHERE d.id = ?'; deptParams.push(department_id); }

    const [totals] = await pool.query(
      `SELECT d.id, d.name, COUNT(e.id) AS total_employees
       FROM departments d
       LEFT JOIN employees e ON e.department_id = d.id AND e.is_approved = 1 ${empJoinExtra}
       ${deptWhere}
       GROUP BY d.id ORDER BY d.name`,
      [...empParams, ...deptParams]
    );

    const [attended] = await pool.query(
      `SELECT emp.department_id, COUNT(DISTINCT a.employee_id) AS attended_count
       FROM attendance a
       JOIN employees emp ON a.employee_id = emp.id
       ${attWhere} AND a.attendance_status IN ('Present','Late')
       GROUP BY emp.department_id`,
      attParams
    );
    const attendedByDept = Object.fromEntries(attended.map((r) => [r.department_id, r.attended_count]));

    const data = totals.map((d) => ({
      department: d.name,
      total_employees: d.total_employees,
      attended: attendedByDept[d.id] || 0
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// GET /api/dashboard/recent-activity?limit=10
// Powers the Dashboard's "Recent Activity" feed — a light read of audit_logs
// (already written by every admin-facing action) joined to the admin's name.
async function getRecentActivity(req, res, next) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const [rows] = await pool.query(
      `SELECT al.id, al.action, al.module, al.created_at, aa.full_name AS admin_name
       FROM audit_logs al
       LEFT JOIN admin_accounts aa ON aa.id = al.admin_id
       ORDER BY al.created_at DESC
       LIMIT ?`,
      [limit]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStats, getDepartmentAttendance, getRecentActivity };
