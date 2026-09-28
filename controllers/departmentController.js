const pool = require('../config/db');
const { logAction } = require('../services/auditService');

async function getDepartments(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT d.*, COUNT(e.id) AS employee_count
       FROM departments d LEFT JOIN employees e ON e.department_id = d.id AND e.is_approved = 1
       GROUP BY d.id ORDER BY d.name`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

async function createDepartment(req, res, next) {
  try {
    const { name, office, description } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Department name is required.' });

    const [result] = await pool.query(
      'INSERT INTO departments (name, office, description) VALUES (?, ?, ?)',
      [name, office || name, description || null]
    );
    await logAction({ adminId: req.admin.id, action: 'create', module: 'departments', details: { name }, ip: req.ip });
    res.status(201).json({ success: true, message: 'Department created.', data: { id: result.insertId } });
  } catch (err) {
    next(err);
  }
}

// PUT /api/departments/:id  body: { name, office, description }
// Employees point at the department by id, so a rename carries over to all
// of them. Employees whose office was just the old office name (the default
// when an admin registers someone) get the new office name too.
async function updateDepartment(req, res, next) {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: 'Department name is required.' });
    const office = String(req.body.office || '').trim() || name;
    const description = String(req.body.description || '').trim() || null;

    const [rows] = await pool.query('SELECT * FROM departments WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Department not found.' });
    const [dup] = await pool.query('SELECT id FROM departments WHERE name = ? AND id != ?', [name, req.params.id]);
    if (dup[0]) return res.status(409).json({ success: false, message: `A department named "${name}" already exists.` });

    await pool.query('UPDATE departments SET name = ?, office = ?, description = ? WHERE id = ?', [name, office, description, req.params.id]);
    const oldOffice = rows[0].office || rows[0].name;
    if (oldOffice !== office) {
      await pool.query('UPDATE employees SET office = ? WHERE department_id = ? AND office = ?', [office, req.params.id, oldOffice]);
    }
    await logAction({ adminId: req.admin.id, action: 'update', module: 'departments', details: { id: Number(req.params.id), from: rows[0].name, name, office }, ip: req.ip });
    res.json({ success: true, message: 'Department updated.' });
  } catch (err) {
    next(err);
  }
}

async function deleteDepartment(req, res, next) {
  try {
    const [result] = await pool.query('DELETE FROM departments WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Department not found.' });
    res.json({ success: true, message: 'Department deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getDepartments, createDepartment, updateDepartment, deleteDepartment };
