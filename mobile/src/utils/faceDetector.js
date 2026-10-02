import { LIVE_FACE_DETECTION_AVAILABLE } from '../components/LiveFaceCamera';

// Real-time face/blink detection (components/LiveFaceCamera.js) is native
// code that Expo Go doesn't include -- it only works in a development build
// or the installed app.
export const FACE_DETECTION_AVAILABLE = LIVE_FACE_DETECTION_AVAILABLE;

// Dev-only escape hatch for Expo Go: skip the on-device hold + blink check
// and just capture after a short countdown. The server still rejects a photo
// with no face in it (faceService "No face was detected"), but there is no
// blink liveness here, so release builds never take this path -- they ship
// the detector and always run the real check.
export const USE_EXPO_GO_FACE_FALLBACK = !FACE_DETECTION_AVAILABLE && __DEV__;

export const EXPO_GO_FALLBACK_LIVENESS_ACTIONS = 'expo_go_dev_no_mlkit';
