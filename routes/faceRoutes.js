const express = require('express');
const router = express.Router();
const faceController = require('../controllers/faceController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const { uploadFace } = require('../middleware/uploadMiddleware');

// Same access as OCR Verification — both super_admin and the OCR/Face-only 'admin' role.
router.use('/records', requireAuth, requireRole('super_admin', 'admin'));
router.use('/verify', requireAuth, requireRole('super_admin', 'admin'));

router.post('/verify', uploadFace.single('image'), faceController.verifyFace);
router.get('/records', faceController.getFaceRecords);
router.delete('/records/:id', faceController.deleteFaceRecord);

module.exports = router;
