const pool = require('../config/db');
const { logAction } = require('../services/auditService');

// The Position and Classification dropdowns of the Add/Edit Employee form.
// The whole list lives in the settings table as a JSON array (the same
// key-value store the office network allow-list uses), so an admin can add
// to it and delete any entry, built-in ones included, from the form's
// "+ Add new" window. Until a list is first changed, the defaults below are
// used; they match the mobile registration form (RegistrationScreen.js).
const KINDS = {
  position: 'employee_positions',
  classification: 'employee_classifications'
};
const DEFAULTS = {
  position: [
    'Instructor I', 'Instructor II', 'Instructor III', 'Assistant Professor', 'Associate Professor',
    'Professor', 'Department Dean', 'Program Chair', 'Guidance Counselor', 'Librarian',
    'Registrar Staff', 'Accounting Staff', 'Administrative Aide I', 'Administrative Aide II',
    'Administrative Aide III', 'Administrative Officer', 'Administrative Assistant'
  ],
  classification: [
    'Permanent Administrative', 'Permanent Academic', 'Casual Administrative',
    'COS Administrative', 'COS Academic', 'Job Order'
  ]
};
const MAX_LENGTH = { position: 120, classification: 50 }; // employees.position / employees.classification

async function readList(kind) {
  const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [KINDS[kind]]);
  if (!rows[0]) {
    // Never changed yet: the defaults, plus anything saved under the first
    // version's key (custom_positions / custom_classifications).
    const [legacy] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [`custom_${kind}s`]);
    let extra = [];
    try { extra = legacy[0] ? JSON.parse(legacy[0].setting_value) : []; } catch (e) { /* ignore */ }
    const list = [...DEFAULTS[kind]];
    for (const v of Array.isArray(extra) ? extra : []) {
      if (typeof v === 'string' && !list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
    }
    return list;
  }
  try {
    const list = JSON.parse(rows[0].setting_value);
    return Array.isArray(list) ? list.filter((v) => typeof v === 'string') : [...DEFAULTS[kind]];
  } catch (e) {
    return [...DEFAULTS[kind]];
  }
}

async function writeList(kind, list) {
  await pool.query(
    `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [KINDS[kind], JSON.stringify(list)]
  );
}

function kindFrom(req, res) {
  const { kind } = req.params;
  if (!KINDS[kind]) {
    res.status(404).json({ success: false, message: 'Unknown option list.' });
    return null;
  }
  return kind;
}

// GET /api/employee-options -> { positions: [...], classifications: [...] }
async function getOptions(req, res, next) {
  try {
    res.json({ success: true, data: { positions: await readList('position'), classifications: await readList('classification') } });
  } catch (err) {
    next(err);
  }
}

// POST /api/employee-options/:kind  body: { value }
async function addOption(req, res, next) {
  try {
    const kind = kindFrom(req, res);
    if (!kind) return;
    const value = String(req.body.value || '').trim().replace(/\s+/g, ' ');
    if (!value) return res.status(400).json({ success: false, message: `Enter a ${kind} name.` });
    if (value.length > MAX_LENGTH[kind]) {
      return res.status(400).json({ success: false, message: `Keep the ${kind} under ${MAX_LENGTH[kind]} characters.` });
    }
    if (value.toLowerCase() === 'others') {
      return res.status(400).json({ success: false, message: '"Others" is already an option.' });
    }
    const list = await readList(kind);
    if (list.some((v) => v.toLowerCase() === value.toLowerCase())) {
      return res.status(409).json({ success: false, message: `"${value}" is already in the list.` });
    }
    list.push(value); // appended, so the built-in order (Instructor I, II, III...) stays as is
    await writeList(kind, list);
    await logAction({ adminId: req.admin.id, action: 'create', module: `employee_${kind}_options`, details: { value }, ip: req.ip });
    res.status(201).json({ success: true, message: `${value} added.`, data: list });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/employee-options/:kind  body: { value }
// Any entry can be removed, built-in ones included. It only leaves the
// dropdown: employees who already have it keep it (the form shows it under
// "Others" with the text filled in).
async function removeOption(req, res, next) {
  try {
    const kind = kindFrom(req, res);
    if (!kind) return;
    const value = String(req.body.value || '');
    const list = await readList(kind);
    const next_ = list.filter((v) => v !== value);
    if (next_.length === list.length) {
      return res.status(404).json({ success: false, message: `"${value}" is not in the list.` });
    }
    await writeList(kind, next_);
    await logAction({ adminId: req.admin.id, action: 'delete', module: `employee_${kind}_options`, details: { value }, ip: req.ip });
    res.json({ success: true, message: `${value} removed.`, data: next_ });
  } catch (err) {
    next(err);
  }
}

module.exports = { getOptions, addOption, removeOption };
