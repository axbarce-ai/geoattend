require('dotenv').config();

// Event start/end times are stored as Philippine local time with no zone
// attached, and `new Date('2026-09-24 13:35:00')` parses them in the process's
// timezone. Hosts like Render run in UTC, which made ongoing events show as
// "Soon" (8 hours late) and blocked check-in. Must run before any Date is used.
// Deliberately ignores any TZ the host sets (containers often set TZ=UTC);
// override with APP_TIMEZONE if the app is ever used outside the Philippines.
process.env.TZ = process.env.APP_TIMEZONE || 'Asia/Manila';

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { accountRateLimitOptions } = require('./middleware/rateLimitKey');

const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const config = require('./config/config');

// ------------------------------------------------------------
// Safety nets
// ------------------------------------------------------------
// Prevent unexpected async errors from crashing the whole server.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ------------------------------------------------------------
// App configuration
// ------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

console.log(`Environment: ${NODE_ENV}`);

// ------------------------------------------------------------
// Security & Core Middleware
// ------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: false,
    // Google Sign-In's popup must be able to message the login page back.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
  })
);

app.use(
  cors({
    origin: true,
    credentials: true
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ------------------------------------------------------------
// Session
// ------------------------------------------------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_session_secret',

    resave: false,

    saveUninitialized: false,

    cookie: {
      secure: NODE_ENV === 'production',
      httpOnly: true,
      sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

// ------------------------------------------------------------
// API Rate Limiting
// ------------------------------------------------------------
// During local development, rate limiting is disabled so repeated
// login/testing requests will not be blocked.
//
// In production, the API is protected with a rate limiter.
//
// IMPORTANT:
// This is only the GLOBAL /api limiter.
// If login still says "Too many login attempts", there is
// another login-specific limiter inside authRoutes.js or
// employeeAuthRoutes.js.
// ------------------------------------------------------------

const apiLimiter = rateLimit({
  // Per signed-in account (or real client IP when signed out), not per Render
  // proxy or shared campus IP -- see middleware/rateLimitKey.js.
  ...accountRateLimitOptions,
  windowMs: 15 * 60 * 1000,

  // Production limit
  max: 1000,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    success: false,
    message: 'Too many requests. Please try again later.'
  }
});

// Apply the global API limiter ONLY in production.
if (NODE_ENV === 'production') {
  app.use('/api', apiLimiter);

  console.log('API rate limiting: ENABLED');
} else {
  console.log('API rate limiting: DISABLED (development mode)');
}

// ------------------------------------------------------------
// Static Assets & Uploaded Files
// ------------------------------------------------------------

app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'))
);

// Not on disk (the host wiped it on restart)? Serve the copy kept in the
// database -- see services/uploadStore.js.
app.use(
  '/uploads',
  require('./services/uploadStore').serveStoredUpload
);

app.use(
  '/public',
  express.static(path.join(__dirname, 'public'))
);

app.use(
  express.static(path.join(__dirname, 'public'))
);

// ------------------------------------------------------------
// Request Logging
// ------------------------------------------------------------
// Prints every API/page request to the terminal once it finishes, e.g.
//   [10:42:07] GET    /api/nav/employees 200 3ms
// Registered after the static handlers so asset/photo hits stay quiet.

const METHOD_COLORS = {
  GET: '\x1b[32m',
  POST: '\x1b[33m',
  PUT: '\x1b[34m',
  PATCH: '\x1b[36m',
  DELETE: '\x1b[31m'
};

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const time = new Date().toLocaleTimeString('en-GB');
    const color = METHOD_COLORS[req.method] || '\x1b[37m';
    const statusColor = res.statusCode >= 400 ? '\x1b[31m' : '\x1b[90m';
    console.log(
      `[${time}] ${color}${req.method.padEnd(6)}\x1b[0m ${req.originalUrl} ` +
      `${statusColor}${res.statusCode}\x1b[0m ${Date.now() - start}ms`
    );
  });
  next();
});

// ------------------------------------------------------------
// View Engine
// ------------------------------------------------------------

app.set('view engine', 'ejs');

app.set(
  'views',
  path.join(__dirname, 'views')
);

// ------------------------------------------------------------
// API Routes
// ------------------------------------------------------------

// Admin authentication
app.use(
  '/api/auth',
  require('./routes/authRoutes')
);

// Employee / mobile authentication
app.use(
  '/api/employee-auth',
  require('./routes/employeeAuthRoutes')
);

// Employees
app.use(
  '/api/employees',
  require('./routes/employeeRoutes')
);

// Departments
app.use(
  '/api/departments',
  require('./routes/departmentRoutes')
);

// Admin-added positions / classifications for the employee form
app.use(
  '/api/employee-options',
  require('./routes/employeeOptionRoutes')
);

// Attendance
app.use(
  '/api/attendance',
  require('./routes/attendanceRoutes')
);

// Geo-fences
app.use(
  '/api/geofences',
  require('./routes/geofenceRoutes')
);

// Events
app.use(
  '/api/events',
  require('./routes/eventRoutes')
);

// Admin notification bell
app.use(
  '/api/admin-notifications',
  require('./routes/adminNotificationRoutes')
);

// OCR
app.use(
  '/api/ocr',
  require('./routes/ocrRoutes')
);

// Face verification
app.use(
  '/api/face',
  require('./routes/faceRoutes')
);

// Device management
app.use(
  '/api/devices',
  require('./routes/deviceRoutes')
);

// Reports
app.use(
  '/api/reports',
  require('./routes/reportRoutes')
);

// Certificates
app.use(
  '/api/certificates',
  require('./routes/certificateRoutes')
);

// Dashboard
app.use(
  '/api/dashboard',
  require('./routes/dashboardRoutes')
);

// Ratings
app.use(
  '/api/ratings',
  require('./routes/ratingRoutes')
);

// Admin accounts
app.use(
  '/api/admin-accounts',
  require('./routes/adminAccountRoutes')
);

// Office network (public IP) check for the mobile app + its admin settings
app.use(
  '/api/network',
  require('./routes/networkRoutes')
);

// ------------------------------------------------------------
// API Health Check
// ------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'GeoAttend API is running.',
    environment: NODE_ENV
  });
});

// ------------------------------------------------------------
// Sidebar Navigation
// ------------------------------------------------------------
// The dashboard switches sections client-side; it calls this on every
// sidebar click so each navigation shows up in the request log above.

app.get('/api/nav/:section', (req, res) => {
  res.json({ success: true, section: req.params.section });
});

// ------------------------------------------------------------
// Admin Dashboard
// ------------------------------------------------------------

// "/" plus one path per sidebar section (see VIEW_PATHS in public/js/app.js),
// so /dashboard, /employees, ... load the dashboard on that section.
const DASHBOARD_PATHS = [
  '/',
  '/dashboard',
  '/employees',
  '/departments',
  '/attendance',
  '/events',
  '/reports',
  '/geofences',
  '/verification',
  '/ratings',
  '/devices',
  '/settings'
];

app.get(DASHBOARD_PATHS, (req, res) => {
  res.render('dashboard', {
    googleMapsApiKey:
      process.env.GOOGLE_MAPS_API_KEY || '',

    // Pre-fills the admin login field (admin@my.cspc.edu.ph by default)
    defaultAdminEmail: config.email.defaultAdmin,

    // "Sign in with Google" on the admin login (hidden when unset)
    googleClientId: process.env.GOOGLE_CLIENT_ID || ''
  });
});

// ------------------------------------------------------------
// Mobile Page
// ------------------------------------------------------------

app.get('/mobile', (req, res) => {
  res.render('mobile', {
    googleClientId:
      process.env.GOOGLE_CLIENT_ID || ''
  });
});

// ------------------------------------------------------------
// Error Handling
// ------------------------------------------------------------

app.use(notFound);

app.use(errorHandler);

// ------------------------------------------------------------
// Start Server
// ------------------------------------------------------------

// Apply any pending schema upgrades before taking requests; a failure is
// logged and the server starts anyway.
require('./services/schemaUpgrades').run()
  .catch((err) => console.error('Schema upgrade failed:', err.message))
  .finally(() => app.listen(PORT, () => {
  console.log('');
  console.log('==========================================');
  console.log('       GeoAttend Server');
  console.log('==========================================');
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Environment: ${NODE_ENV}`);
  console.log(
    `API: http://localhost:${PORT}/api/health`
  );
  console.log('==========================================');
  console.log('');

  // Warm the face models in the background -- failures (e.g. model files
  // missing) are logged here and surface again on the first face request.
  require('./services/faceService').warmUp()
    .then(() => console.log('Face recognition models loaded.'))
    .catch((err) => console.error('Face model warm-up failed:', err.message));

  // Keep uploads/ filled with every captured photo (face verification, OCR,
  // registrations) from the shared database -- see services/uploadStore.js.
  require('./services/uploadStore').startDiskSync();
  }));
