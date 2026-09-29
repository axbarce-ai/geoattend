import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

// Expo Go on Android (SDK 53+) throws as soon as expo-notifications is loaded
// ("push notifications ... removed from Expo Go"), which crashed the whole app
// at startup. There it's simply not loaded and this exports null; every helper
// that posts a notification checks for that and skips it. Real builds (APK,
// development build) and iOS Expo Go load it normally.
const unsupported =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient && Platform.OS === 'android';

const Notifications = unsupported ? null : require('expo-notifications');

export default Notifications;
