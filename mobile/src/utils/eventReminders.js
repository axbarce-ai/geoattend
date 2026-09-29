import Notifications from './notificationsModule';
import { Platform } from 'react-native';

// How long before an event's start time to fire the local reminder.
const REMINDER_LEAD_MINUTES = 15;

// Makes reminders actually pop up (banner + sound) while the app is open,
// not just when it's backgrounded — Expo's default handler suppresses
// foreground alerts otherwise.
Notifications?.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let permissionRequested = false;

// Asks for notification permission once per app session. Safe to call
// repeatedly — after the first successful/denied request it just no-ops.
// Always false where notifications aren't available (Android Expo Go), so
// every caller skips posting one.
export async function ensureNotificationPermission() {
  if (!Notifications) return false;
  if (permissionRequested) return true;
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  permissionRequested = true;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('event-reminders', {
      name: 'Event Reminders',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  return finalStatus === 'granted';
}

// A stable, event-specific notification identifier so re-scheduling on every
// dashboard refresh replaces the same reminder instead of stacking up
// duplicates for the same event.
const identifierFor = (geofenceId) => `event-reminder-${geofenceId}`;

// Schedules a "starting soon" local reminder for every one of today's events
// that hasn't started yet, and an immediate "happening now" reminder for one
// that just became active — so the employee gets nudged about an event
// scheduled for today without needing to have the app open at exactly the
// right moment. Already-scheduled/already-notified events are skipped on
// repeat calls (the dashboard polls every 30s) via the stable identifier and
// an in-memory "already fired" set.
const notifiedActive = new Set();

export async function scheduleTodayEventReminders(todaySchedule) {
  const granted = await ensureNotificationPermission();
  if (!granted || !Array.isArray(todaySchedule)) return;

  const now = Date.now();

  for (const g of todaySchedule) {
    if (g.computed_status === 'expired') continue;
    const startMs = new Date(g.start_datetime).getTime();
    if (Number.isNaN(startMs)) continue;

    const identifier = identifierFor(g.id);

    if (g.computed_status === 'active') {
      // Event is happening right now — fire a one-time "starting now" nudge
      // instead of a scheduled reminder (the lead-time window already
      // passed), but only once per event per app session.
      if (!notifiedActive.has(g.id)) {
        notifiedActive.add(g.id);
        await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
        await Notifications.scheduleNotificationAsync({
          identifier,
          content: {
            title: 'Event happening now',
            body: `"${g.title}" is ongoing at ${g.venue || 'the scheduled venue'}. Walk into the area to be timed in automatically.`,
            sound: true,
          },
          trigger: null, // fire immediately
        });
      }
      continue;
    }

    // Upcoming today: schedule a reminder REMINDER_LEAD_MINUTES before start.
    const triggerMs = startMs - REMINDER_LEAD_MINUTES * 60 * 1000;
    if (triggerMs <= now) continue; // lead window already passed; nothing useful to schedule

    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title: 'Upcoming event today',
        body: `"${g.title}" starts at ${new Date(g.start_datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${g.venue || 'venue TBA'}.`,
        sound: true,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(triggerMs) },
    });
  }
}

export default scheduleTodayEventReminders;
