# GeoAttend Pro

**GeoAttend Pro** is a geofenced attendance monitoring system built for
institutional use (CSPC — Camarines Sur Polytechnic Colleges). It combines
GPS geofencing, OCR ID verification, and live face verification to record
attendance for scheduled events (e.g. flag ceremonies, meetings), with a
full admin dashboard for managing employees, departments, events, and
reports.

The system has two front-ends served by the same Node/Express backend:

- **Admin Dashboard** (`/`) — desktop web app for super admins and
  verification-only admins.
- **Mobile Web App** (`/mobile`) — the employee-facing portal (Google
  Sign-In, device binding, geofenced check-in/out, attendance history).

A native Expo mobile app also lives under [`mobile/`](mobile) for
on-device face registration and push-style attendance flows.

---

## Features

- **Geofenced attendance** — draw a geofence per event on Google Maps;
  employees can only check in/out from inside it. Live GPS containment
  checks run client-side and are re-validated server-side.
- **Recurring events** — weekly recurring schedules (e.g. every Monday
  flag ceremony) expand into individual dated occurrences automatically.
- **OCR ID Verification** — scan an employee ID card with the device
  camera; Tesseract OCR extracts the name/employee code/position and
  cross-checks it against the employee record.
- **Live Face Verification** — selfie-based identity verification with an
  in-browser **liveness challenge** (blink / turn head / nod) that must be
  completed before the captured frame is matched against enrolled faces
  via an ONNX face-recognition model. See
  [`FACE_VERIFICATION_README.md`](FACE_VERIFICATION_README.md) for details.
- **Mobile self-registration** — Google Sign-In → device details (Employee
  ID, Department, Position, Classification) → **Face Registration**, which
  runs the exact same liveness challenge as Face Verification above before
  enrolling the selfie as that employee's permanent face record.
- **Reports** — filterable by department, year, month, employee, event,
  and duty status, with CSV/Excel export and an on-screen summary.
- **Role-based admin accounts** — `super_admin` (full access) vs. `admin`
  (restricted to the Verification section only).
- **Device management** — bind an employee's phone to their account and
  approve/blacklist devices from the dashboard.
- **Ratings & certificates, batch employee import, audit logging**, and
  more — see [`CHANGELOG_ENHANCEMENTS.md`](CHANGELOG_ENHANCEMENTS.md) for
  the full history of additions.

---

## Tech stack

| Layer      | Technology |
|------------|------------|
| Backend    | Node.js, Express, MySQL (`mysql2`) |
| Views      | EJS (server-rendered dashboard/mobile shell) + vanilla JS frontend |
| Auth       | JWT (admin + employee sessions), Google Sign-In (employee login) |
| OCR        | `tesseract.js` |
| Face ID    | `onnxruntime-node` + `sharp` (ONNX face-recognition model) |
| Exports    | `json2csv`, `exceljs` |
| Mobile app | Expo / React Native (see `mobile/`) |

---

## Getting started

### 1. Prerequisites
- Node.js 18+
- A MySQL 8+ server
- (Optional, for Face Verification) a compatible ONNX face-recognition
  model — see [`models/README.md`](models/README.md)

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment
Copy `.env` and fill in your own values (a template with every recognized
variable already exists at the project root):

```
# Server
PORT=3000
NODE_ENV=development

# Database (MySQL)
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=geoattend_pro

# Auth
JWT_SECRET=change_me
JWT_EXPIRES_IN=8h
SESSION_SECRET=change_me

# Default admin seeded by database/seed.js
DEFAULT_ADMIN_EMAIL=admin@my.cspc.edu.ph
DEFAULT_ADMIN_PASSWORD=password

# Google Maps (admin dashboard map rendering)
GOOGLE_MAPS_API_KEY=

# Google Sign-In (mobile web app "Continue with Google")
GOOGLE_CLIENT_ID=
GOOGLE_ANDROID_CLIENT_ID=

# Face Verification (optional — see models/README.md)
# FACE_MODEL_PATH=
# FACE_INPUT_SIZE=
# FACE_MATCH_THRESHOLD=
```

### 4. Set up the database
Run the base schema, then every migration in order (each migration file is
safe to re-run — they all use `IF NOT EXISTS` guards):

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS geoattend_pro"
mysql -u root -p geoattend_pro < database/schema.sql
mysql -u root -p geoattend_pro < database/migration_v2.sql
mysql -u root -p geoattend_pro < database/migration_v3.sql
mysql -u root -p geoattend_pro < database/migration_v4.sql
mysql -u root -p geoattend_pro < database/migration_v5.sql
mysql -u root -p geoattend_pro < database/migration_v6.sql
mysql -u root -p geoattend_pro < database/migration_v7.sql
mysql -u root -p geoattend_pro < database/migration_v8.sql
mysql -u root -p geoattend_pro < database/migration_v9.sql
mysql -u root -p geoattend_pro < database/migration_v10.sql
mysql -u root -p geoattend_pro < database/migration_v11.sql
mysql -u root -p geoattend_pro < database/migration_v15_cspc_email_domain.sql
```

> `schema.sql` already reflects the final shape of every table (including
> the migrations), so a **brand-new** database only strictly needs
> `schema.sql`. Run the migrations too if you're upgrading an existing
> database that predates them.

Seed a default admin account and a small set of sample employees/departments:
```bash
npm run seed
```

### 5. Run the server
```bash
npm start        # production
npm run dev       # nodemon, auto-restart on file changes
```

The admin dashboard is now at `http://localhost:3000/`, and the mobile web
app at `http://localhost:3000/mobile`. Log in with the `DEFAULT_ADMIN_EMAIL`
/ `DEFAULT_ADMIN_PASSWORD` you set above (defaults to
`admin@my.cspc.edu.ph` / `password` if left unset — **change this before any
real deployment**).

---

## Building the local (LAN) Android app

To build **GeoAttend (Local)**, an APK that connects to the server on this
PC over Wi-Fi instead of Render (and what to do when the PC's IP changes),
see [`mobile/BUILD-LOCAL.md`](mobile/BUILD-LOCAL.md).

---

## Project structure

```
controllers/     Route handlers (one per resource: employees, attendance, face, reports, ...)
routes/          Express routers, mounted under /api/* in server.js
services/        Business logic shared across controllers (geofencing, OCR, face, audit, certificates)
middleware/      Auth (JWT), file upload (multer), error handling
config/          Environment-driven configuration (config.js) + DB pool (db.js)
database/        schema.sql + numbered migrations + database/seed.js
models/          ONNX face-recognition model lives here (not committed — see models/README.md)
views/           EJS shells for the admin dashboard (dashboard.ejs) and mobile web app (mobile.ejs)
public/          Static assets — public/js/app.js (dashboard) and public/js/mobile-app.js (mobile)
uploads/         Runtime-generated: OCR scans, face captures, employee photos, selfies
mobile/          Separate Expo/React Native app (on-device registration + attendance)
```

### Key frontend modules
- `public/js/app.js` → `G_App` — the entire admin dashboard's frontend
  logic (one namespace per section: `employees`, `attendance`, `events`,
  `reports`, `ocr`, `face`, `geofence`, `mobile`, `ratings`, `settings`, …).
- `public/js/mobile-app.js` — the employee-facing mobile web app logic
  (Google Sign-In, device registration, geofenced check-in/out).

---

## Notes on the codebase

- Every admin API route requires a valid JWT (`Authorization: Bearer <token>`
  or the `token` cookie/query param) via `middleware/authMiddleware.js`.
  Most routes also gate by role (`super_admin` vs. `admin`).
- Employee-facing (mobile) routes use a separate employee JWT — see
  `requireEmployeeAuth` in the same middleware file.
- `CHANGELOG_ENHANCEMENTS.md` and `FACE_VERIFICATION_README.md` document
  specific feature additions in more depth, including known limitations
  and things to double-check before a production deploy (they were
  written without a live MySQL instance to test against — verify
  end-to-end before relying on any of it in production).

---

## License

Internal/institutional project — no license file included. Add one if you
intend to distribute this codebase publicly.
