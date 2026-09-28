const express = require('express');
const router = express.Router();
const geofenceController = require('../controllers/geofenceController');
const { requireAuth, requireEmployeeAuth, requireRole } = require('../middleware/authMiddleware');

router.get('/mobile/active', requireEmployeeAuth, geofenceController.getActiveForMobile);

router.use(requireAuth, requireRole('super_admin'));
router.get('/default-location', geofenceController.getDefaultLocation);
router.put('/default-location', geofenceController.saveDefaultLocation);
router.get('/', geofenceController.getGeofences);
router.post('/', geofenceController.createGeofence);
router.put('/:id', geofenceController.updateGeofence);
router.delete('/:id', geofenceController.deleteGeofence);
router.patch('/:id/toggle', geofenceController.toggleGeofence);

module.exports = router;
