import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import FaceDetection from '@react-native-ml-kit/face-detection';
import { colors, radius, shadow } from '../theme';
import { verifyAttendanceFace } from '../api/client';
import { useAttendanceTracking } from '../context/AttendanceTrackingContext';
import AppHeader from '../components/AppHeader';

// Automatic, on-device re-verification: AttendanceTrackingContext navigates
// here the instant a geo-anomaly flags an attendance record (unusual
// location activity -- see controllers/attendanceController.js
// detectGeoAnomaly), and again on app resume if a flag is still
// unresolved (see refreshSessionsFromHistory there). This never happens at
// an admin's request -- the whole point is the EMPLOYEE proving it's really
// them, right here on their own device, before the flagged attendance can
// be confirmed. A failed or abandoned attempt leaves the record exactly as
// flagged as it already was; only a genuine match
// (controllers/attendanceController.js faceVerify) clears it.
//
// The capture algorithm (hold steady, then blink) is the same one
// RegistrationScreen.js uses, deliberately duplicated rather than shared so
// a future change to one doesn't silently change the other's behavior --
// keep both in sync if the underlying algorithm changes.
const DETECTION_TIMEOUT_MS = 12000;
const CONFIRM_FRAMES = 3;
const DETECTION_ATTEMPTS = 3;
const BLINK_TIMEOUT_MS = 8000;
const EYES_OPEN_THRESHOLD = 0.6;
const EYES_CLOSED_THRESHOLD = 0.3;
const MAX_BLINK_FACE_DROPOUT = 6;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function FaceVerificationScreen({ route, navigation }) {
  const { attendanceId, eventTitle } = route.params || {};
  const { clearPendingVerification, refreshAfterVerification } = useAttendanceTracking();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const verifyingRef = useRef(false);
  const startedRef = useRef(false);

  // 'idle' | 'scanning' | 'blink' | 'uploading' | 'success' | 'failed'
  const [stage, setStage] = useState('idle');
  const [liveFaceDetected, setLiveFaceDetected] = useState(false);
  const [blinkEyesClosed, setBlinkEyesClosed] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const scanPulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!permission) return;
    if (!permission.granted) {
      requestPermission();
      return;
    }
    // Auto-starts as soon as the camera is actually usable -- "automatic na
    // bubukas ang Face Verification screen" extends to the capture itself
    // starting on its own, not just the screen appearing with a button to tap.
    if (!startedRef.current) {
      startedRef.current = true;
      const t = setTimeout(() => runVerification(), 600);
      return () => clearTimeout(t);
    }
  }, [permission]);

  useEffect(() => () => { verifyingRef.current = false; }, []);

  useEffect(() => {
    if (stage !== 'scanning' && stage !== 'blink') return undefined;
    scanPulse.setValue(0);
    const loop = Animated.loop(
      Animated.timing(scanPulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.ease), useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [stage, scanPulse]);

  const detectFaceHold = async () => {
    const startedAt = Date.now();
    let holdStreak = 0;
    while (Date.now() - startedAt < DETECTION_TIMEOUT_MS) {
      if (!verifyingRef.current) return false;
      let photo;
      try {
        photo = await cameraRef.current.takePictureAsync({ quality: 0.3, skipProcessing: true, base64: false });
      } catch (err) {
        await wait(150);
        continue;
      }
      let faces = [];
      try {
        faces = await FaceDetection.detect(photo.uri, {
          performanceMode: 'fast', landmarkMode: 'none', contourMode: 'none', minFaceSize: 0.15,
        });
      } catch (err) { faces = []; }
      if (photo.uri) FileSystem.deleteAsync(photo.uri, { idempotent: true }).catch(() => {});

      const face = faces && faces[0];
      setLiveFaceDetected(!!face);
      holdStreak = face ? holdStreak + 1 : 0;
      if (holdStreak >= CONFIRM_FRAMES) return true;
    }
    return false;
  };

  const detectBlink = async () => {
    const startedAt = Date.now();
    let phase = 'awaiting-close';
    let noFaceStreak = 0;
    while (Date.now() - startedAt < BLINK_TIMEOUT_MS) {
      if (!verifyingRef.current) return false;
      let photo;
      try {
        photo = await cameraRef.current.takePictureAsync({ quality: 0.3, skipProcessing: true, base64: false });
      } catch (err) {
        await wait(150);
        continue;
      }
      let faces = [];
      try {
        faces = await FaceDetection.detect(photo.uri, {
          performanceMode: 'fast', landmarkMode: 'none', contourMode: 'none',
          classificationMode: 'all', minFaceSize: 0.15,
        });
      } catch (err) { faces = []; }
      if (photo.uri) FileSystem.deleteAsync(photo.uri, { idempotent: true }).catch(() => {});

      const face = faces && faces[0];
      setLiveFaceDetected(!!face);
      if (!face) {
        noFaceStreak += 1;
        if (noFaceStreak >= MAX_BLINK_FACE_DROPOUT) return false;
        continue;
      }
      noFaceStreak = 0;
      const { leftEyeOpenProbability: left, rightEyeOpenProbability: right } = face;
      if (left == null || right == null) continue;
      const openness = (left + right) / 2;
      if (phase === 'awaiting-close' && openness < EYES_CLOSED_THRESHOLD) {
        phase = 'awaiting-reopen';
        setBlinkEyesClosed(true);
      } else if (phase === 'awaiting-reopen' && openness > EYES_OPEN_THRESHOLD) {
        return true;
      }
    }
    return false;
  };

  const runVerification = async () => {
    if (!cameraRef.current || verifyingRef.current) return;
    setErrorMsg('');
    verifyingRef.current = true;

    let confirmed = false;
    let failedOnBlink = false;
    for (let i = 0; i < DETECTION_ATTEMPTS && !confirmed; i++) {
      if (!verifyingRef.current) return;
      setStage('scanning');
      const held = await detectFaceHold();
      if (!verifyingRef.current) return;
      let blinked = false;
      if (held) {
        setBlinkEyesClosed(false);
        setStage('blink');
        blinked = await detectBlink();
        if (!verifyingRef.current) return;
      }
      confirmed = held && blinked;
      failedOnBlink = held && !blinked;
      if (!confirmed && i < DETECTION_ATTEMPTS - 1) await wait(700);
    }

    if (!confirmed) {
      verifyingRef.current = false;
      setStage('failed');
      setErrorMsg(failedOnBlink
        ? "Couldn't confirm a blink. Keep your face in frame and blink normally, then try again."
        : "Couldn't detect your face. Make sure your face is centered and well-lit, then try again.");
      return;
    }

    setStage('uploading');
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7, skipProcessing: true });

      let latitude; let longitude;
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        latitude = loc?.coords?.latitude;
        longitude = loc?.coords?.longitude;
      } catch (e) {
        // Location is a nice-to-have on this record, not a requirement --
        // GPS already had to be on to reach this flagged state in the first place.
      }

      const formData = new FormData();
      formData.append('selfie', { uri: photo.uri, name: 'verify.jpg', type: 'image/jpeg' });
      formData.append('liveness_verified', 'true');
      formData.append('liveness_actions', 'hold,blink');
      if (latitude != null) formData.append('latitude', String(latitude));
      if (longitude != null) formData.append('longitude', String(longitude));

      const result = await verifyAttendanceFace(attendanceId, formData);
      verifyingRef.current = false;

      if (result?.success) {
        setStage('success');
        refreshAfterVerification?.();
        setTimeout(() => {
          clearPendingVerification?.(attendanceId);
          navigation.replace('Dashboard');
        }, 1600);
      } else {
        setStage('failed');
        setErrorMsg(result?.message || 'Verification failed. Please try again.');
      }
    } catch (err) {
      verifyingRef.current = false;
      setStage('failed');
      setErrorMsg(err?.response?.data?.message || "Couldn't verify your face. Please check your connection and try again.");
    }
  };

  // Backing out does NOT confirm the attendance -- it stays flagged
  // (requires_face_verification = 1) on the server exactly as it already
  // was. Clearing the "already prompted" guard means the next meaningful
  // history refresh (app resume, or a session auto-ending) brings this
  // screen right back up rather than only ever retrying on a full app restart.
  const handleCancel = () => {
    verifyingRef.current = false;
    clearPendingVerification?.(attendanceId);
    navigation.replace('Dashboard');
  };

  const ringScale = scanPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] });
  const ringOpacity = scanPulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.5, 0.15, 0] });

  let caption = 'Preparing camera…';
  if (stage === 'scanning') caption = !liveFaceDetected ? 'Center your face in the frame' : 'Hold still and look at the camera';
  else if (stage === 'blink') caption = blinkEyesClosed ? 'Great — now open your eyes' : 'Blink your eyes';
  else if (stage === 'uploading') caption = 'Verifying…';
  else if (stage === 'success') caption = 'Verified! Your attendance is confirmed.';
  else if (stage === 'failed') caption = errorMsg || 'Verification failed.';

  return (
    <View style={styles.flex}>
      <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
        <AppHeader title="Face Verification" />
      </View>

      <View style={styles.alertCard}>
        <Ionicons name="alert-circle" size={20} color={colors.warning} />
        <Text style={styles.alertText}>
          We noticed unusual activity on your check-in{eventTitle ? ` for "${eventTitle}"` : ''}. Please verify it's really you to confirm your attendance.
        </Text>
      </View>

      <View style={styles.cameraWrap}>
        {permission?.granted ? (
          <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="front" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.permissionFallback]}>
            <Ionicons name="camera-outline" size={40} color="#fff" />
            <Text style={styles.permissionText}>Camera access is needed to verify your identity.</Text>
            <TouchableOpacity style={styles.permissionBtn} onPress={requestPermission}>
              <Text style={styles.permissionBtnText}>Grant Camera Access</Text>
            </TouchableOpacity>
          </View>
        )}

        {(stage === 'scanning' || stage === 'blink') && (
          <Animated.View style={[styles.pulseRing, { transform: [{ scale: ringScale }], opacity: ringOpacity }]} />
        )}
        <View style={styles.guideOval} pointerEvents="none" />

        {stage === 'success' && (
          <View style={[StyleSheet.absoluteFill, styles.resultOverlay, { backgroundColor: 'rgba(5,205,153,0.85)' }]}>
            <Ionicons name="checkmark-circle" size={64} color="#fff" />
          </View>
        )}
        {stage === 'failed' && (
          <View style={[StyleSheet.absoluteFill, styles.resultOverlay, { backgroundColor: 'rgba(238,93,80,0.85)' }]}>
            <Ionicons name="close-circle" size={64} color="#fff" />
          </View>
        )}
      </View>

      <View style={styles.captionWrap}>
        <Text style={[styles.caption, stage === 'failed' && { color: colors.error }]}>{caption}</Text>
      </View>

      {stage === 'failed' && (
        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.retryBtn} onPress={runVerification} activeOpacity={0.85}>
            <Ionicons name="refresh" size={16} color="#fff" />
            <Text style={styles.retryBtnText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      )}

      {stage !== 'success' && (
        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
          <Text style={styles.cancelBtnText}>Cancel — I'll verify later</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  alertCard: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginHorizontal: 20, marginBottom: 14,
    backgroundColor: colors.warningBg, borderRadius: radius.md, padding: 14,
  },
  alertText: { flex: 1, color: colors.warningText, fontSize: 12.5, fontWeight: '600', lineHeight: 18 },
  cameraWrap: {
    marginHorizontal: 20, height: 340, borderRadius: radius.lg, overflow: 'hidden',
    backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', ...shadow,
  },
  permissionFallback: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12, backgroundColor: '#0B1220' },
  permissionText: { color: '#fff', textAlign: 'center', fontSize: 13, fontWeight: '600' },
  permissionBtn: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: 18 },
  permissionBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  guideOval: {
    position: 'absolute', width: 190, height: 250, borderRadius: 125,
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.55)',
  },
  pulseRing: {
    position: 'absolute', width: 190, height: 250, borderRadius: 125,
    borderWidth: 2, borderColor: '#fff',
  },
  resultOverlay: { alignItems: 'center', justifyContent: 'center' },
  captionWrap: { paddingHorizontal: 24, marginTop: 18, alignItems: 'center' },
  caption: { fontSize: 15, fontWeight: '800', color: colors.textMain, textAlign: 'center' },
  actionsRow: { alignItems: 'center', marginTop: 18 },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.primary,
    borderRadius: radius.md, paddingVertical: 13, paddingHorizontal: 26, ...shadow, shadowColor: colors.primary, shadowOpacity: 0.3,
  },
  retryBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  cancelBtn: { alignItems: 'center', marginTop: 20, marginBottom: 20 },
  cancelBtnText: { color: colors.textSub, fontWeight: '700', fontSize: 12.5 },
});
