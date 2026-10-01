const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { clientRateLimitOptions } = require('../middleware/rateLimitKey');
const authController = require('../controllers/authController');
const { requireAuth } = require('../middleware/authMiddleware');

// Only failed attempts count, so admins sharing the campus IP don't use up
// each other's allowance by logging in successfully.
const loginLimiter = rateLimit({
  ...clientRateLimitOptions,
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' }
});

router.post('/google', loginLimiter, authController.googleLogin);
router.post('/logout', authController.logout);
router.get('/me', requireAuth, authController.me);

module.exports = router;
