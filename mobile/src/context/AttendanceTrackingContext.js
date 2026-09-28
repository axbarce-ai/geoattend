import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import * as Location from 'expo-location';
import { useAuth } from './AuthContext';
import { useLocationStatus } from './LocationStatusContext';
import { getGeofences, registerDevice, submitAttendance, sendHeartbeat, getMyHistory } from '../api/client';
import { navigationRef } from '../navigation/navigationRef';
import { notify } from '../utils/notify';
import { getDeviceUid, getDeviceInfo } from '../utils/device';
import { liveDurationSeconds } from '../utils/duration';
import { alertFaceVerificationRequired, clearFaceVerificationAlert } from '../utils/faceVerificationAlert';

// Point-in-polygon test (ray-casting), mirroring the backend's geofenceService
// so the app can tell "inside/outside" locally without waiting on a round trip.
// Coerced to Number like the backend's version, so string coordinates can
// never silently turn the math into string concatenation.
function isInsidePolygon(lat, lng, points) {
  lat = Number(lat);
  lng = Number(lng);
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = Number(points[i].lat), yi = Number(points[i].lng);
    const xj = Number(points[j].lat), yj = Number(points[j].lng);
    const intersect = (yi > lng) !== (yj > lng) && lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// GPS error allowance at the boundary, mirroring the backend's
// config.attendance.edgeToleranceMeters (keep the two in sync): a reading
// just outside the polygon still counts as inside when the edge is within
// the reading's own accuracy, capped at this many meters. Without it, phone
// GPS drift near the edge of a small geofence read employees who were
// physically inside as "outside", so they never got timed in.
const EDGE_TOLERANCE_METERS = 20;

// Shortest distance in meters from a point to the polygon's boundary (flat
// projection; accurate to well under a meter at geofence scale). Same math
// as geofenceService.distanceToPolygonEdgeMeters on the backend.
function distanceToEdgeMeters(lat, lng, points) {
  lat = Number(lat);
  lng = Number(lng);
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const xy = points.map((p) => ({ x: (Number(p.lng) - lng) * mPerDegLng, y: (Number(p.lat) - lat) * mPerDegLat }));
  let best = Infinity;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    const a = xy[j];
    const b = xy[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lenSq)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return best;
}

function isInsideGeofence(lat, lng, points, acc) {
  if (isInsidePolygon(lat, lng, points)) return true;
  const tol = Math.min(Number(acc) > 0 ? Number(acc) : 0, EDGE_TOLERANCE_METERS);
  return tol > 0 && distanceToEdgeMeters(lat, lng, points) <= tol;
}

// Whether an event's attendance window is open right now. The server's
// computed_status is only as fresh as the last geofence poll (up to 30s
// old), so an event that has just started is also recognized from its own
// start/end times. Falls back to computed_status if they can't be parsed.
function isEventActiveNow(g, nowMs = Date.now()) {
  const start = new Date(String(g.start_datetime || '').replace(' ', 'T')).getTime();
  const end = new Date(String(g.end_datetime || '').replace(' ', 'T')).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return g.computed_status === 'active';
  return nowMs >= start && nowMs <= end;
}

// How often the last known location is re-checked against the geofences
// even when no new GPS reading arrives. Android only reports a new reading
// after the phone moves (distanceInterval), so someone already standing
// inside when an event starts would otherwise wait for the next poll.
const REEVALUATE_MS = 5000;
// After a rejected time-in, wait this long before trying again, instead of
// resending on every GPS reading (every ~3s).
const CHECK_IN_RETRY_MS = 5000;

// How often a session already checked-in pings the server with the current
// location so it can auto time-out once the device has left the geofence for
// a couple of consecutive pings (see config.attendance.autoEndOutsideStreakThreshold
// on the backend). Kept a little above the backend's own
// heartbeatMinIntervalSeconds (20s default) so pings aren't silently dropped.
const HEARTBEAT_INTERVAL_MS = 25000;
// How often the list of active event geofences is refreshed, so a
// newly-started event is picked up without an app restart.
const GEOFENCE_POLL_MS = 30000;
// Consecutive local GPS readings outside the geofence (while a session is
// open) required before the app treats itself as "exited" for its OWN
// purposes -- freezing the displayed duration and locking in the exact
// reading to keep retrying to the server. GPS keeps working without
// connectivity, so this can be detected instantly even with no signal/WiFi;
// it's a separate, smaller confirmation than the server's own
// autoEndOutsideStreakThreshold (used once a ping actually reaches it),
// purely so the on-screen timer stops accumulating fictitious time while
// offline rather than only catching up once connectivity returns.
const LOCAL_OUTSIDE_CONFIRM_READINGS = 2;

// Today's date in the phone's local timezone as 'YYYY-MM-DD' -- matches the
// server's attendance_date. toISOString() gives the UTC date, which is still
// "yesterday" before 8:00 AM Philippine time.
function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const AttendanceTrackingContext = createContext(null);

export function AttendanceTrackingProvider({ children }) {
  const { employee, deviceStatus } = useAuth();
  const { locationEnabled } = useLocationStatus();
  // Tracking (auto time-in/out) is a location-dependent feature, so it's
  // gated on Location/GPS actually being on at the OS level, not just on
  // being signed in — see LocationStatusContext + LocationGateOverlay, which
  // blocks the UI the same moment this stops running.
  const trackingEnabled = !!employee && deviceStatus === 'approved' && locationEnabled;

  const [location, setLocation] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [geofences, setGeofences] = useState([]);
  // event_id -> { inside, geofence }
  const [presence, setPresence] = useState({});
  // event_id -> attendance record { id, time_in, time_out, total_duration_seconds,
  // open_session_time_in, session_count }, for anything open or completed
  // today — restored from the server on mount so tracking (and the
  // accumulated duration) survives an app restart, not just an in-memory submit.
  const [sessions, setSessions] = useState({});
  const [autoSubmitting, setAutoSubmitting] = useState({}); // event_id -> bool, guards against double-submits
  // event_id -> the server's reason for the last rejected auto time-in (e.g.
  // "GPS accuracy too low"), shown on the Attendance screen so a failed
  // check-in isn't indistinguishable from one that's still in progress.
  const [checkInErrors, setCheckInErrors] = useState({});

  const watchRef = useRef(null);
  const heartbeatTimers = useRef({}); // attendanceId -> interval
  const locationRef = useRef(null);
  // Android's mock-location flag for the latest reading (Fake GPS apps set
  // it); sent with every time-in and heartbeat so the server can refuse it.
  const mockedRef = useRef(false);
  const lastCheckInFailureRef = useRef({}); // event_id -> ms of the last rejected time-in
  // attendanceId -> true, once FaceVerificationScreen has been opened for it
  // this app session -- stops a still-pending anomaly from re-navigating
  // there on every periodic history refresh while the employee has
  // deliberately backed out of it and is doing something else in the app.
  // It's still re-checked (and will navigate again) on every fresh mount
  // (app open/resume), since that ref itself is reset by a remount.
  const promptedVerificationRef = useRef({});

  // Sends the employee straight to FaceVerificationScreen -- called both
  // right after a time-in that comes back flagged, and from
  // refreshSessionsFromHistory below for a flag that's still open from
  // earlier (app was closed/backgrounded before it got resolved).
  const goToFaceVerification = useCallback((attendanceId, eventTitle) => {
    if (!attendanceId) return;
    // Sound + vibration so an employee with the phone in their pocket still
    // notices; throttled internally, so it repeats while still flagged.
    alertFaceVerificationRequired(attendanceId, eventTitle);
    if (promptedVerificationRef.current[attendanceId]) return;
    // FaceVerification is only registered once the employee is past the
    // WaitingApproval / WifiCheck gates (see App.js RootNavigator). Tracking
    // can flag a record before that -- e.g. right after an app reload, while
    // WifiCheck is still showing -- so hold it and navigate as soon as the
    // screen exists (see the navigationRef 'state' listener below).
    const routeNames = navigationRef.isReady() ? navigationRef.getRootState()?.routeNames : null;
    if (!routeNames || !routeNames.includes('FaceVerification')) {
      pendingVerificationNavRef.current = { attendanceId, eventTitle };
      return;
    }
    pendingVerificationNavRef.current = null;
    promptedVerificationRef.current[attendanceId] = true;
    navigationRef.navigate('FaceVerification', { attendanceId, eventTitle });
  }, []);
  // A flagged record waiting for the FaceVerification screen to become
  // available -- { attendanceId, eventTitle } or null.
  const pendingVerificationNavRef = useRef(null);
  useEffect(() => {
    const unsubscribe = navigationRef.addListener('state', () => {
      const pending = pendingVerificationNavRef.current;
      if (!pending) return;
      // Deferred so it doesn't navigate in the middle of the navigator's
      // own screen-list swap.
      setTimeout(() => goToFaceVerification(pending.attendanceId, pending.eventTitle), 0);
    });
    return unsubscribe;
  }, [goToFaceVerification]);
  const sessionsRef = useRef({});
  const geofencesRef = useRef([]);
  const autoSubmittingRef = useRef({});
  const localOutsideStreakRef = useRef({}); // event_id -> consecutive local "outside" GPS readings while a session is open
  // event_id -> { attendanceId, observedAt (ISO), latitude, longitude } for a
  // confirmed-outside reading that hasn't been acknowledged by the server
  // yet (offline, or just hasn't gotten a heartbeat through). The heartbeat
  // loop below keeps retrying THIS exact frozen reading -- not whatever the
  // live location happens to be by the time connectivity returns -- so the
  // session is eventually closed using the moment the employee actually
  // left, not the moment the retry finally landed.
  const pendingExitRef = useRef({});

  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { geofencesRef.current = geofences; }, [geofences]);
  useEffect(() => { autoSubmittingRef.current = autoSubmitting; }, [autoSubmitting]);

  const deviceUid = useCallback(() => getDeviceUid(), []);

  const stopHeartbeat = (attendanceId) => {
    if (heartbeatTimers.current[attendanceId]) {
      clearInterval(heartbeatTimers.current[attendanceId]);
      delete heartbeatTimers.current[attendanceId];
    }
  };

  // Pings the server periodically for an open session so it can auto time-out
  // (set time_out) once the device has been outside the geofence for a
  // couple of consecutive pings. Runs regardless of which screen is focused —
  // this is what fixes sessions getting stuck "on-going" just because the
  // user navigated away from the Attendance screen. When the server reports
  // the session ended, this just stops the timer and refreshes from the
  // server's own totals — re-entering the geofence later (evaluateLocation
  // below) is what opens the NEXT session and its own heartbeat.
  //
  // If a local exit was detected while offline (pendingExitRef), this keeps
  // resending THAT frozen reading every tick -- not the live location, which
  // may already show the device back inside by the time connectivity
  // returns -- until the server acknowledges the session closed. Sending the
  // original captured coordinates/time repeatedly also naturally rebuilds
  // the server's own outside-streak the same way real-time pings would have.
  const startHeartbeat = useCallback((eventId, attendanceId) => {
    stopHeartbeat(attendanceId);
    heartbeatTimers.current[attendanceId] = setInterval(async () => {
      const pending = pendingExitRef.current[eventId];
      const usingPending = pending && pending.attendanceId === attendanceId;
      const coords = usingPending
        ? { latitude: pending.latitude, longitude: pending.longitude, accuracy: pending.accuracy }
        : locationRef.current;
      if (!coords && !(usingPending && pending.locationOff)) return;
      try {
        const result = await sendHeartbeat(
          attendanceId,
          coords?.latitude,
          coords?.longitude,
          usingPending ? pending.observedAt : undefined,
          {
            accuracy: coords?.accuracy,
            mocked: usingPending ? pending.mocked : mockedRef.current,
            locationOff: usingPending && pending.locationOff
          }
        );
        if (result?.data?.ended) {
          if (usingPending) delete pendingExitRef.current[eventId];
          stopHeartbeat(attendanceId);
          await refreshSessionsFromHistoryRef.current?.();
          notify('Time-Out Recorded', 'You left the event area, so your session was automatically timed out. Your total time keeps accumulating if you come back.');
        } else if (result?.data?.requiresFaceVerification) {
          // The server flagged this session mid-way (another employee's
          // device is reporting the same location) -- see detectGeoAnomaly.
          const geofence = geofencesRef.current.find((g) => g.event_id === eventId);
          goToFaceVerification(attendanceId, geofence?.title);
        } else if (result?.data && result.data.requiresFaceVerification === false) {
          clearFaceVerificationAlert(attendanceId);
        }
      } catch (e) {
        // Non-fatal — a missed ping just retries on the next tick, still
        // using the same frozen pending-exit reading if one is set, so a
        // connectivity gap doesn't lose track of when the employee actually left.
      }
    }, HEARTBEAT_INTERVAL_MS);
  }, [goToFaceVerification]);

  // Restores today's attendance state (open, completed, or in-between visits)
  // from the server — including the accumulated total_duration_seconds and
  // which session (if any) is currently open — so auto time-in doesn't fire
  // again for a session already open, and an already-open session resumes
  // its heartbeat immediately on app start, even if it was left open from a
  // previous app session.
  const refreshSessionsFromHistory = useCallback(async () => {
    try {
      const history = await getMyHistory();
      const today = localDateString();
      const todays = (history.data || []).filter((a) => a.attendance_date === today);
      const map = {};
      todays.forEach((a) => {
        map[a.event_id] = {
          id: a.id,
          time_in: a.time_in,
          time_out: a.time_out,
          total_duration_seconds: a.total_duration_seconds,
          open_session_time_in: a.open_session_time_in,
          session_count: a.session_count
        };
      });
      // A confirmed-but-not-yet-acknowledged local exit (see evaluateLocation)
      // must keep freezing its event's displayed duration even across this
      // refresh -- otherwise a history sync while still offline would let the
      // figure start climbing again with the true wall clock.
      Object.entries(pendingExitRef.current).forEach(([eventId, pending]) => {
        const session = map[eventId];
        if (session && session.id === pending.attendanceId && !session.time_out) {
          session.pendingExitAt = pending.observedAt;
        } else {
          // Either already closed server-side or no longer matches this
          // session — nothing left for this pending reading to do.
          delete pendingExitRef.current[eventId];
        }
      });
      setSessions(map);
      todays.forEach((a) => {
        if (!a.time_out) startHeartbeat(a.event_id, a.id);
      });
      // A record flagged by anomaly detection (requires_face_verification)
      // that's still unresolved -- e.g. the employee backed out of
      // FaceVerificationScreen, or closed the app before completing it --
      // gets re-prompted here rather than staying silently unconfirmed.
      // goToFaceVerification's own promptedVerificationRef guards against
      // this firing again for a record already shown this session, so it
      // only actually re-navigates on a fresh mount (app open/resume).
      const stillFlagged = todays.find((a) => a.requires_face_verification);
      if (stillFlagged) {
        goToFaceVerification(stillFlagged.id, stillFlagged.event_title);
      }
    } catch (e) {
      // Non-fatal — worst case auto time-in re-evaluates from a blank slate
      // and the backend's own duplicate check still protects against double entries.
    }
  }, [startHeartbeat, goToFaceVerification]);

  // startHeartbeat needs to call refreshSessionsFromHistory (to re-sync the
  // total after an auto-end), but refreshSessionsFromHistory also calls
  // startHeartbeat — a ref sidesteps the circular dependency without
  // re-creating the interval callback on every history refresh.
  const refreshSessionsFromHistoryRef = useRef(null);
  useEffect(() => { refreshSessionsFromHistoryRef.current = refreshSessionsFromHistory; }, [refreshSessionsFromHistory]);

  const refreshGeofences = useCallback(async () => {
    try {
      const res = await getGeofences();
      setGeofences(res.data || []);
    } catch (e) {
      // Non-fatal — next poll tries again.
    }
  }, []);

  // Automatically records a time-in the moment the device is detected inside
  // an active event's geofence — no button tap required. Also fires on a
  // RE-entry (the employee left and came back while the event is still
  // running): the backend opens a new session and keeps adding to the same
  // day's accumulated total rather than starting over.
  const autoCheckIn = useCallback(async (geofence, coords, acc) => {
    const eventId = geofence.event_id;
    if (autoSubmittingRef.current[eventId]) return;
    if (Date.now() - (lastCheckInFailureRef.current[eventId] || 0) < CHECK_IN_RETRY_MS) return;
    // Set synchronously: the state -> ref sync below only lands after a
    // re-render, and a second GPS reading can arrive before that.
    autoSubmittingRef.current = { ...autoSubmittingRef.current, [eventId]: true };
    setAutoSubmitting((prev) => ({ ...prev, [eventId]: true }));
    try {
      const result = await submitAttendance({
        employee_id: employee.id,
        device_uid: deviceUid(),
        event_id: eventId,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: acc,
        ...(mockedRef.current ? { mocked: true } : {})
      });
      delete lastCheckInFailureRef.current[eventId];
      setCheckInErrors((prev) => ({ ...prev, [eventId]: null }));
      if (result?.data?.id) {
        const nowIso = new Date().toISOString();
        setSessions((prev) => ({
          ...prev,
          [eventId]: {
            ...(prev[eventId] || {}),
            id: result.data.id,
            time_in: prev[eventId]?.time_in || nowIso,
            time_out: null,
            open_session_time_in: nowIso,
            session_count: (prev[eventId]?.session_count || 0) + 1
          }
        }));
        startHeartbeat(eventId, result.data.id);
        notify(
          result.data.action === 're_time_in' ? 'Time-In Recorded Again' : 'Time-In Recorded',
          result.data.action === 're_time_in'
            ? `Welcome back to "${geofence.title}" — you were automatically timed in again.`
            : `You entered "${geofence.title}" and were automatically timed in.`
        );
        // Unusual location activity was detected on this time-in (see
        // detectGeoAnomaly on the backend) -- send the employee straight
        // into on-device Face Verification. This is never something an
        // admin does on the employee's behalf; the attendance stays
        // unconfirmed until this employee proves it's them, right here.
        if (result.data.requiresFaceVerification) {
          goToFaceVerification(result.data.id, geofence.title);
        }
      }
    } catch (err) {
      // Expected rejections (outside geofence by the time the request lands,
      // event window closed, GPS accuracy too low, device not yet approved)
      // don't pop up an alert — the next location update just tries again —
      // but the reason is kept so the Attendance screen can show it.
      lastCheckInFailureRef.current[eventId] = Date.now();
      if (err?.response?.status === 409) {
        // The server already has a session open for this event (e.g. timed
        // in before an app restart and the history refresh failed). Sync
        // instead of retrying a time-in that can never succeed.
        await refreshSessionsFromHistoryRef.current?.();
        setCheckInErrors((prev) => ({ ...prev, [eventId]: null }));
        return;
      }
      const message = err?.response?.data?.message
        || (err?.request ? 'Could not reach the server to record your time-in. Retrying…' : 'Time-in failed. Retrying…');
      setCheckInErrors((prev) => ({ ...prev, [eventId]: message }));
    } finally {
      autoSubmittingRef.current = { ...autoSubmittingRef.current, [eventId]: false };
      setAutoSubmitting((prev) => ({ ...prev, [eventId]: false }));
    }
  }, [employee, deviceUid, startHeartbeat, goToFaceVerification]);

  // Core loop: whenever a fresh location comes in, check it against every
  // currently-active event geofence. Entering one with no OPEN session right
  // now -> auto time-in (which may be a first check-in or a re-entry after an
  // earlier auto time-out — either way the day's duration keeps accumulating).
  //
  // Leaving one with an OPEN session -> after LOCAL_OUTSIDE_CONFIRM_READINGS
  // consecutive outside readings, freeze that session's displayed duration
  // right here (pendingExitAt) and lock in this exact reading for the
  // heartbeat loop to keep retrying to the server (see startHeartbeat) —
  // this is what stops the on-screen/synced total from silently growing for
  // the entire time the device is outside the boundary with no connectivity
  // to report it. The server's own autoEndOutsideStreakThreshold still
  // decides when the session is actually closed (once a ping gets through);
  // this only prevents the CLOCK from running away in the meantime.
  //
  // `recheck` marks a re-evaluation of the last reading rather than a new
  // one: it can time in, but doesn't count toward the outside streak, which
  // must be made of separate GPS readings.
  const evaluateLocation = useCallback((coords, acc, observedAtMs, { recheck = false } = {}) => {
    const activeGeofences = geofencesRef.current.filter((g) => isEventActiveNow(g));
    const nextPresence = {};
    activeGeofences.forEach((g) => {
      if (!g.points || g.points.length < 3) return;
      const inside = isInsideGeofence(coords.latitude, coords.longitude, g.points, acc);
      nextPresence[g.event_id] = { inside, geofence: g };
      const existingSession = sessionsRef.current[g.event_id];
      // A session is already open for today when we have a record with no
      // time_out — that's the only case where we should NOT re-check-in.
      const hasOpenSession = existingSession && existingSession.id && !existingSession.time_out;
      if (inside && !hasOpenSession) {
        autoCheckIn(g, coords, acc);
      } else if (!inside && hasOpenSession) {
        if (recheck) return;
        const eventId = g.event_id;
        const streak = (localOutsideStreakRef.current[eventId] || 0) + 1;
        localOutsideStreakRef.current[eventId] = streak;
        if (streak >= LOCAL_OUTSIDE_CONFIRM_READINGS && !pendingExitRef.current[eventId]) {
          const observedAtIso = new Date(observedAtMs || Date.now()).toISOString();
          pendingExitRef.current[eventId] = {
            attendanceId: existingSession.id,
            observedAt: observedAtIso,
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy: acc,
            mocked: mockedRef.current
          };
          setSessions((prev) => ({
            ...prev,
            [eventId]: { ...(prev[eventId] || {}), pendingExitAt: observedAtIso }
          }));
        }
      } else if (inside) {
        localOutsideStreakRef.current[g.event_id] = 0;
        // Note: pendingExitRef is intentionally NOT cleared here — that
        // outside period still needs to reach the server so the session
        // closes with the correct duration before a fresh re-entry session
        // can open (see startHeartbeat/refreshSessionsFromHistory).
      }
    });
    setPresence(nextPresence);
  }, [autoCheckIn]);

  // One-time setup: permissions, device registration, initial history/geofence
  // load, and the continuous location watch. Everything below keeps running
  // for as long as the app is in the foreground, regardless of which screen
  // the employee is looking at.
  useEffect(() => {
    if (!trackingEnabled) return;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        if (!cancelled) setPermissionDenied(true);
        return;
      }
      if (!cancelled) setPermissionDenied(false);

      // GPS starts first so the phone already has a fix by the time the
      // server calls below finish (a sleeping server can take ~50s to answer).
      // Nothing is evaluated until refreshGeofences loads the event list,
      // which happens after today's sessions are restored, so this can't
      // cause a duplicate time-in.
      try {
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 2 },
          (loc) => {
            setLocation(loc.coords);
            locationRef.current = loc.coords;
            mockedRef.current = !!loc.mocked;
            setAccuracy(loc.coords.accuracy);
            // loc.timestamp is when the GPS chip actually took this reading —
            // works fine offline (no WiFi/data needed) and is what lets a
            // "left the geofence" moment be captured accurately even before
            // there's any connectivity to report it (see evaluateLocation).
            evaluateLocation(loc.coords, loc.coords.accuracy, loc.timestamp);
          }
        );
        if (cancelled) sub.remove();
        else watchRef.current = sub;
      } catch (e) {
        // GPS could have been switched off in the instant between the last
        // LocationStatusContext poll and this call — LocationGateOverlay
        // will catch it on its own next poll tick either way, so there's
        // nothing more to do here than avoid an unhandled rejection.
      }
      if (cancelled) return;

      try {
        // Same values the registration form showed and submitted.
        const device = getDeviceInfo();
        await registerDevice({
          employee_id: employee.id,
          device_uid: device.uid,
          model: device.model,
          brand: device.brand,
          os: device.os
        });
      } catch (e) {
        // Non-fatal here — submitAttendance will surface a clear "device not
        // registered/approved" message if it turns out to matter.
      }

      await refreshSessionsFromHistory();
      await refreshGeofences();
    })();

    const geofencePoll = setInterval(refreshGeofences, GEOFENCE_POLL_MS);
    const reevaluate = setInterval(() => {
      const coords = locationRef.current;
      if (coords) evaluateLocation(coords, coords.accuracy, undefined, { recheck: true });
    }, REEVALUATE_MS);

    return () => {
      cancelled = true;
      if (watchRef.current) watchRef.current.remove();
      watchRef.current = null;
      clearInterval(geofencePoll);
      clearInterval(reevaluate);
      Object.keys(heartbeatTimers.current).forEach(stopHeartbeat);
    };
  }, [trackingEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Location/GPS switched off while a session is open: the app can no longer
  // show the employee is inside, so the duration must stop right now and
  // only resume once Location is back on (a fresh auto time-in). Every open
  // session is frozen at this moment (pendingExitAt) and the server is told
  // to close it at that same time -- retried here, since the main tracking
  // loop and its heartbeats are stopped while Location is off. If it still
  // hasn't gone through when Location returns, the restarted heartbeat keeps
  // resending the same frozen location-off reading.
  useEffect(() => {
    if (!employee || deviceStatus !== 'approved' || locationEnabled) return;
    const offAt = new Date().toISOString();
    const last = locationRef.current;
    const frozen = {};
    Object.entries(sessionsRef.current).forEach(([eventId, s]) => {
      if (!s?.id || s.time_out) return;
      const existing = pendingExitRef.current[eventId];
      if (existing && existing.attendanceId === s.id) {
        // Already left the geofence earlier -- keep that earlier exit time.
        existing.locationOff = true;
        return;
      }
      pendingExitRef.current[eventId] = {
        attendanceId: s.id,
        observedAt: offAt,
        latitude: last?.latitude,
        longitude: last?.longitude,
        accuracy: last?.accuracy,
        mocked: mockedRef.current,
        locationOff: true
      };
      frozen[eventId] = offAt;
    });
    if (Object.keys(frozen).length) {
      setSessions((prev) => {
        const next = { ...prev };
        Object.entries(frozen).forEach(([eventId, at]) => {
          next[eventId] = { ...(next[eventId] || {}), pendingExitAt: at };
        });
        return next;
      });
    }

    let stopped = false;
    const flush = async () => {
      let anyEnded = false;
      for (const [eventId, pending] of Object.entries(pendingExitRef.current)) {
        if (stopped || !pending.locationOff) continue;
        try {
          const result = await sendHeartbeat(pending.attendanceId, pending.latitude, pending.longitude, pending.observedAt, {
            accuracy: pending.accuracy,
            mocked: pending.mocked,
            locationOff: true
          });
          if (result?.data?.ended) {
            delete pendingExitRef.current[eventId];
            anyEnded = true;
          }
        } catch (e) {
          // No connectivity -- retried on the next tick (or by the heartbeat
          // once Location is back on), still with the original off time.
        }
      }
      if (anyEnded && !stopped) {
        await refreshSessionsFromHistoryRef.current?.();
        notify('Time-Out Recorded', 'Your Location was turned off, so your session was timed out. Turn Location back on to continue your attendance.');
      }
    };
    flush();
    const retry = setInterval(flush, HEARTBEAT_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(retry);
    };
  }, [locationEnabled, employee, deviceStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-evaluate presence whenever the geofence list itself changes (e.g. a
  // new event just went active), using the last known location.
  useEffect(() => {
    if (locationRef.current) evaluateLocation(locationRef.current, locationRef.current.accuracy, undefined, { recheck: true });
  }, [geofences]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = {
    location,
    accuracy,
    permissionDenied,
    geofences,
    presence, // event_id -> { inside, geofence }
    sessions, // event_id -> { id, time_in, time_out, total_duration_seconds, open_session_time_in, session_count }
    isAutoSubmitting: (eventId) => !!autoSubmitting[eventId],
    checkInErrors, // event_id -> last server rejection message for auto time-in, or null
    // Live accumulated duration in seconds for an event's session today —
    // keeps ticking upward while a session is open, across however many
    // separate time-in/time-out dips have happened so far.
    getDurationSeconds: (eventId) => liveDurationSeconds(sessions[eventId]),
    refreshGeofences,
    refreshSessionsFromHistory,
    // Used by FaceVerificationScreen: refreshAfterVerification re-syncs
    // session state once a verification succeeds (so the Dashboard/
    // Attendance screens immediately reflect the now-confirmed record).
    refreshAfterVerification: refreshSessionsFromHistory,
    // clearPendingVerification resets that attendance id's "already
    // prompted" guard, called on both success (tidy, though moot since a
    // resolved record's requires_face_verification is 0 and won't match
    // again) and on Cancel -- clearing it there means the very next
    // meaningful history refresh (refreshSessionsFromHistory only runs at
    // specific moments: app mount, and a session auto-ending -- not a tight
    // poll) re-surfaces the prompt rather than only ever trying again on a
    // full app restart.
    clearPendingVerification: (attendanceId) => {
      if (attendanceId) delete promptedVerificationRef.current[attendanceId];
    }
  };

  return (
    <AttendanceTrackingContext.Provider value={value}>
      {children}
    </AttendanceTrackingContext.Provider>
  );
}

export const useAttendanceTracking = () => useContext(AttendanceTrackingContext);
