const express = require('express');
const router = express.Router();
const ocrController = require('../controllers/ocrController');
const { requireAuth, requireRole, requireEmployeeAuth } = require('../middleware/authMiddleware');
const { uploadOcr } = require('../middleware/uploadMiddleware');

// Both super_admin and OCR-only 'admin' accounts can use this module.
router.use('/records', requireAuth, requireRole('super_admin', 'admin'));
router.use('/verify', requireAuth, requireRole('super_admin', 'admin'));

// Mobile employee-facing OCR verify endpoint
router.post('/mobile/verify', requireEmployeeAuth, uploadOcr.single('image'), ocrController.verifyId);

router.post('/verify', uploadOcr.single('image'), ocrController.verifyId);
router.get('/records', ocrController.getOcrRecords);
router.delete('/records/:id', ocrController.deleteOcrRecord);

module.exports = router;
