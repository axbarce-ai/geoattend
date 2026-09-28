const express = require('express');
const router = express.Router();
const employeeOptionController = require('../controllers/employeeOptionController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

// Same access as Departments: only super admins manage the employee form.
router.use(requireAuth, requireRole('super_admin'));
router.get('/', employeeOptionController.getOptions);
router.post('/:kind', employeeOptionController.addOption);
router.delete('/:kind', employeeOptionController.removeOption);

module.exports = router;
