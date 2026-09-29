import Notifications from './notificationsModule';
import { Platform, Vibration } from 'react-native';
import { ensureNotificationPermission } from './eventReminders';

// Dedicated high-importance channel so the alert sounds and vibrates even
// with the phone in a pocket (Android channel settings can't be changed
// after creation, hence a new channel rather than reusing event-reminders).
const CHANNEL_ID = 'face-verification-required';
const VIBRATION_PATTERN = [0, 800, 400, 800, 400, 800];
// While a record stays flagged, the alert repeats at most this often.
const REPEAT_INTERVAL_MS = 2 * 60 * 1000;

let channelReady = false;
const lastAlertAt = {}; // attendanceId -> ms

async function ensureChannel() {
  if (channelReady || Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Face Verification Required',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: VIBRATION_PATTERN,
    sound: 'default',
    enableVibrate: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  channelReady = true;
}

// Sounds + vibrates the phone and posts a notification telling the employee
// their attendance was flagged (see detectGeoAnomaly on the backend) and
// needs face verification. Safe to call on every heartbeat: it only fires
// again once REPEAT_INTERVAL_MS has passed for the same record.
export async function alertFaceVerificationRequired(attendanceId, eventTitle) {
  const now = Date.now();
  if (lastAlertAt[attendanceId] && now - lastAlertAt[attendanceId] < REPEAT_INTERVAL_MS) return;
  lastAlertAt[attendanceId] = now;

  if (Platform.OS === 'web') return;
  Vibration.vibrate(VIBRATION_PATTERN);

  try {
    const granted = await ensureNotificationPermission();
    if (!granted) return;
    await ensureChannel();
    await Notifications.scheduleNotificationAsync({
      identifier: `face-verification-${attendanceId}`,
      content: {
        title: 'Face verification required',
        body: `Your phone reported the same location as another employee${eventTitle ? ` at "${eventTitle}"` : ''}. Verify your face now or your attendance will not be recorded.`,
        sound: 'default',
        vibrate: VIBRATION_PATTERN,
        priority: Notifications.AndroidNotificationPriority.MAX,
        data: { type: 'face_verification_required', attendanceId, eventTitle },
      },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
  } catch (e) {
    // Non-fatal — the vibration above and the in-app screen still fire.
  }
}

// Stops repeat alerts for a record once it's been verified.
export function clearFaceVerificationAlert(attendanceId) {
  delete lastAlertAt[attendanceId];
  if (!Notifications) return;
  Notifications.dismissNotificationAsync(`face-verification-${attendanceId}`).catch(() => {});
}
