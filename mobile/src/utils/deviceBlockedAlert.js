import Notifications from './notificationsModule';
import { Platform } from 'react-native';
import { ensureNotificationPermission } from './eventReminders';

// A phone notification (banner + sound) telling the employee their device
// was blacklisted, rejected or removed by an admin -- shown once when the app finds
// out, alongside the explanation on the Login screen it returns to.
export async function alertDeviceBlocked(message, deviceStatus) {
  try {
    const granted = await ensureNotificationPermission();
    if (!granted) return;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('account-alerts', {
        name: 'Account Alerts',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    await Notifications.scheduleNotificationAsync({
      identifier: 'device-blocked',
      content: {
        title: deviceStatus === 'rejected' ? 'Device rejected' : deviceStatus === 'removed' ? 'Device removed' : 'Device blacklisted',
        body: message,
        sound: true,
      },
      // Immediate; same form as utils/faceVerificationAlert.js.
      trigger: Platform.OS === 'android' ? { channelId: 'account-alerts' } : null,
    });
  } catch (e) {
    // The Login screen still shows the message, so nothing more to do.
  }
}
