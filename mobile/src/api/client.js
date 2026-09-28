import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../config';
import { getDeviceUid } from '../utils/device';

export { API_BASE_URL };

const api = axios.create({ baseURL: API_BASE_URL, timeout: 15000 });

// Face uploads get far longer than the 15s default: the server runs face
// recognition on the photo, which is slow on a small hosting instance, and a
// free Render instance that has gone to sleep takes ~50s just to wake up.
// Timing out early showed a generic "Registration failed" even though the
// server would have succeeded.
const FACE_UPLOAD_TIMEOUT_MS = 120000;

api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('employee_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Lets the server refuse every request from a device an admin has
  // blacklisted or rejected (code DEVICE_BLOCKED below).
  config.headers['X-Device-Uid'] = getDeviceUid();
  return config;
});

// Set by AuthContext on mount. Lets any API call anywhere in the app trigger
// a clean sign-out when the server reports this device's cached employee_id
// no longer exists (e.g. the employee record was deleted/recreated by an
// admin) — instead of every screen having to special-case that error itself.
let staleSessionHandler = null;
export function setStaleSessionHandler(fn) {
  staleSessionHandler = fn;
}

// Set by AuthContext. Called with (message, deviceStatus) when the server
// reports this device was blacklisted/rejected by an admin.
let deviceBlockedHandler = null;
export function setDeviceBlockedHandler(fn) {
  deviceBlockedHandler = fn;
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const code = error?.response?.data?.code;
    if ((code === 'EMPLOYEE_NOT_FOUND' || code === 'STALE_REFERENCE') && staleSessionHandler) {
      staleSessionHandler();
    }
    if (code === 'DEVICE_BLOCKED' && deviceBlockedHandler) {
      deviceBlockedHandler(error.response.data.message, error.response.data.deviceStatus);
    }
    return Promise.reject(error);
  }
);

export async function registerDevice(payload) {
  const { data } = await api.post('/devices/register', payload);
  return data;
}

// POST /api/employee-auth/google { credential, device_uid } — credential is the
// Google ID token. device_uid lets the server report this specific device's
// approval status (an employee may have more than one registered device).
// Login is usually the first request after the free Render instance has gone
// to sleep, so it gets the same long timeout as face uploads.
export async function googleLogin(credential, deviceUid) {
  const { data } = await api.post(
    '/employee-auth/google',
    { credential, device_uid: deviceUid },
    { timeout: FACE_UPLOAD_TIMEOUT_MS }
  );
  return data;
}

// GET /api/employee-auth/departments — public, used by the Device Registration
// screen to populate the Department dropdown before the employee has a token.
export async function getDepartments() {
  const { data } = await api.get('/employee-auth/departments');
  return data;
}

// GET /api/employee-auth/employee-options — public. The Position and
// Classification lists the admin manages from the dashboard, as
// { positions: [...], classifications: [...] }.
export async function getEmployeeOptions() {
  const { data } = await api.get('/employee-auth/employee-options');
  return data;
}

// POST /api/employee-auth/link-device (multipart) — confirms the pending Google
// sign-in against an admin-provisioned (or newly self-provisioned) employee
// record, registers this device, AND enrolls the captured face — all in one
// request. `formData` must contain employee_code, surname, given_name,
// middle_name, suffix, device_uid, device_model, device_brand, device_os,
// pendingToken, and an `image` file field (the captured selfie).
export async function linkDevice(formData) {
  const { data } = await api.post('/employee-auth/link-device', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: FACE_UPLOAD_TIMEOUT_MS
  });
  return data;
}

// GET /api/employee-auth/device-status — polled by the "Waiting for Approval"
// screen to detect the moment an admin approves this device. device_uid
// scopes the check to this physical device, since an employee may have more
// than one registered device with different statuses.
export async function getDeviceStatus(deviceUid) {
  const { data } = await api.get('/employee-auth/device-status', { params: { device_uid: deviceUid } });
  return data;
}

export async function submitAttendance(payload) {
  const { data } = await api.post('/attendance/submit', payload);
  return data;
}

// POST /api/attendance/:id/heartbeat — sent periodically while an attendance
// session is open, so the server can auto-close it (set time_out) once the
// employee has been outside the geofence for a couple of consecutive pings.
// `observedAt` (optional, ISO string) is when this GPS reading was actually
// taken on-device -- important when this ping is a delayed retry of a
// reading captured while offline, so the server closes the session at the
// moment the employee actually left rather than whenever the retry lands.
// `accuracy` (meters) and `mocked` (Android's mock-location flag) belong to
// that same reading. `locationOff` tells the server the phone's Location was
// switched off, so it closes the session immediately at `observedAt`.
export async function sendHeartbeat(attendanceId, latitude, longitude, observedAt, { accuracy, mocked, locationOff } = {}) {
  const body = {};
  if (latitude != null) body.latitude = latitude;
  if (longitude != null) body.longitude = longitude;
  if (observedAt) body.observed_at = observedAt;
  if (accuracy != null) body.accuracy = accuracy;
  if (mocked) body.mocked = true;
  if (locationOff) body.location_off = true;
  const { data } = await api.post(`/attendance/${attendanceId}/heartbeat`, body);
  return data;
}

// GET /api/attendance/my-history — used to restore attendance state (including
// accumulated duration across all of today's time-in/time-out sessions) after
// an app restart/refresh, not just from local storage.
export async function getMyHistory() {
  const { data } = await api.get('/attendance/my-history');
  return data;
}

// GET /api/attendance/:id/sessions — the individual time-in/time-out dips
// behind one day's summary row, e.g. for a "9:03 AM–9:41 AM, 10:15 AM–…" breakdown.
export async function getAttendanceSessions(attendanceId) {
  const { data } = await api.get(`/attendance/${attendanceId}/sessions`);
  return data;
}

// POST /api/attendance/:id/face-verify (multipart) — the automatic, on-device
// re-verification FaceVerificationScreen triggers the moment a geo-anomaly
// flags an attendance record (see AttendanceTrackingContext.js). `formData`
// must contain a `selfie` file field, `liveness_verified` ('true'),
// `liveness_actions`, and optionally `latitude`/`longitude`. The backend
// runs a real 1:1 match against this employee's own enrolled face(s) --
// this can genuinely fail (wrong person, no face detected, liveness not
// completed), in which case the attendance stays unconfirmed.
export async function verifyAttendanceFace(attendanceId, formData) {
  const { data } = await api.post(`/attendance/${attendanceId}/face-verify`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: FACE_UPLOAD_TIMEOUT_MS
  });
  return data;
}

// GET /api/geofences/mobile/active — the employee-facing endpoint (active + upcoming
// events only). This is what actually connects an admin-created event/geofence to the
// mobile app; the plain '/geofences' route is admin-only and will 403 for employee tokens.
export async function getGeofences() {
  const { data } = await api.get('/geofences/mobile/active');
  return data;
}

// GET /api/network/check — whether this phone's current connection is the
// office network, judged by the server from the connection's public IP (the
// same for the main router and every extender/repeater on that provider
// line). Returns { ip, enforced, allowed }.
export async function checkOfficeNetwork() {
  const { data } = await api.get('/network/check');
  return data;
}

export default api;
