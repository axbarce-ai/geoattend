import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { CameraView } from 'expo-camera';

// Real-time face + blink detection for the face scan (registration and the
// post-anomaly re-verification). VisionCamera streams every preview frame
// into ML Kit's face detector natively and hands the results to JS, so a
// blink -- only ~100-300ms long -- is caught the moment it happens. The old
// approach took a full photo per check (2-3 a second at best) and regularly
// missed blinks entirely.
//
// Both libraries are native code that Expo Go doesn't ship, and the face
// detector creates its native objects at import time, so they're required
// lazily here: in Expo Go the require throws and we fall back to expo-camera
// (see utils/faceDetector.js for that dev-only path).
let VisionCamera = null;
let FaceDetector = null;
try {
  VisionCamera = require('react-native-vision-camera');
  FaceDetector = require('react-native-vision-camera-face-detector');
} catch (e) {
  VisionCamera = null;
  FaceDetector = null;
}

export const LIVE_FACE_DETECTION_AVAILABLE = !!(VisionCamera && FaceDetector);

// -- Liveness tuning --
const HOLD_MS = 700; // a frontal face must stay in view this long before the blink prompt
const MAX_HEAD_ANGLE = 25; // degrees of yaw/pitch still treated as "looking at the camera"
const FACE_LOST_MS = 1500; // face missing this long fails the current step
const EYES_OPEN = 0.6; // both eyes above this = open
const EYES_CLOSED = 0.3; // both eyes below this = closed
const MIN_OPEN_FRAMES = 2; // eyes must be seen open first, so already-closed eyes can't count as a blink
const MAX_CLOSED_MS = 1200; // longer than this is closing the eyes, not blinking

// The largest face is the person registering; anyone in the background is ignored.
function primaryFace(faces) {
  if (!faces || faces.length === 0) return null;
  let best = faces[0];
  for (const f of faces) {
    if (f.bounds.width * f.bounds.height > best.bounds.width * best.bounds.height) best = f;
  }
  return best;
}

function isFrontal(face) {
  return Math.abs(face.yawAngle || 0) <= MAX_HEAD_ANGLE && Math.abs(face.pitchAngle || 0) <= MAX_HEAD_ANGLE;
}

/**
 * Turns the camera's face stream into two awaitable liveness steps.
 * Pass `onFaces` to <LiveFaceCamera>, then:
 *   await waitForFaceHold(timeoutMs, isCancelled, onFacePresent)
 *   await waitForBlink(timeoutMs, isCancelled, onFacePresent, onEyesClosed)
 * Each resolves true on success, false on timeout/cancel/face lost.
 */
export function useLivenessDetector() {
  const listenerRef = useRef(null);

  const onFaces = useCallback((faces) => {
    const listener = listenerRef.current;
    if (listener) listener(primaryFace(faces), Date.now());
  }, []);

  const run = useCallback((timeoutMs, isCancelled, handler) => new Promise((resolve) => {
    const startedAt = Date.now();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      listenerRef.current = null;
      resolve(value);
    };
    // Covers timeout/cancel even when no frames are arriving at all.
    const timer = setInterval(() => {
      if (isCancelled() || Date.now() - startedAt > timeoutMs) finish(false);
    }, 100);
    listenerRef.current = (face, now) => {
      if (done) return;
      if (isCancelled()) return finish(false);
      const result = handler(face, now);
      if (result !== undefined) finish(result);
    };
  }), []);

  const waitForFaceHold = useCallback((timeoutMs, isCancelled, onFacePresent) => {
    let heldSince = null;
    let lastSeen = 0;
    return run(timeoutMs, isCancelled, (face, now) => {
      onFacePresent?.(!!face);
      if (face && isFrontal(face)) {
        if (heldSince === null) heldSince = now;
        lastSeen = now;
        if (now - heldSince >= HOLD_MS) return true;
      } else if (now - lastSeen > 300) {
        // A single dropped frame doesn't reset the hold; looking away does.
        heldSince = null;
      }
      return undefined;
    });
  }, [run]);

  const waitForBlink = useCallback((timeoutMs, isCancelled, onFacePresent, onEyesClosed) => {
    let phase = 'open';
    let openFrames = 0;
    let closedAt = 0;
    let lastSeen = Date.now();
    let trackingId = null;
    return run(timeoutMs, isCancelled, (face, now) => {
      onFacePresent?.(!!face);
      if (!face) return now - lastSeen > FACE_LOST_MS ? false : undefined;
      lastSeen = now;

      // A different tracked face (someone swapped in front of the camera)
      // restarts the blink from scratch.
      if (face.trackingId != null) {
        if (trackingId !== null && face.trackingId !== trackingId) {
          phase = 'open';
          openFrames = 0;
          onEyesClosed?.(false);
        }
        trackingId = face.trackingId;
      }

      const left = face.leftEyeOpenProbability;
      const right = face.rightEyeOpenProbability;
      if (left == null || right == null || left < 0 || right < 0) return undefined; // not classified this frame

      // Both eyes must agree, so a wink or one eye hidden by hair isn't a blink.
      const open = left > EYES_OPEN && right > EYES_OPEN;
      const closed = left < EYES_CLOSED && right < EYES_CLOSED;

      if (phase === 'open') {
        if (open) openFrames += 1;
        else if (closed && openFrames >= MIN_OPEN_FRAMES) {
          phase = 'closed';
          closedAt = now;
          onEyesClosed?.(true);
        }
      } else if (phase === 'closed') {
        if (open) return true; // open -> closed -> open: a real blink, reported immediately
        if (now - closedAt > MAX_CLOSED_MS) {
          phase = 'open';
          openFrames = 0;
          onEyesClosed?.(false);
        }
      }
      return undefined;
    });
  }, [run]);

  return { onFaces, waitForFaceHold, waitForBlink };
}

const VisionFaceCamera = forwardRef(function VisionFaceCamera({ style, isActive = true, onFaces }, ref) {
  const onFacesRef = useRef(onFaces);
  onFacesRef.current = onFaces;

  // Built once: the library's useFaceDetectorOutput() memoizes on a fresh
  // options object, which would rebuild the output (and reconfigure the
  // camera session) on every re-render.
  const faceOutput = useMemo(() => FaceDetector.createFaceDetectorOutput({
    cameraFacing: 'front',
    performanceMode: 'fast',
    runClassifications: true, // eye-open probabilities
    trackingEnabled: true,
    minFaceSize: 0.2,
    onFacesDetected: (faces) => onFacesRef.current?.(faces),
    onError: (err) => console.warn('Face detection error:', err?.message),
  }), []);

  const photoOutput = VisionCamera.usePhotoOutput({
    targetResolution: VisionCamera.CommonResolutions.HD_4_3,
    quality: 0.85,
    qualityPrioritization: 'speed',
  });

  const outputs = useMemo(() => [faceOutput, photoOutput], [faceOutput, photoOutput]);

  useImperativeHandle(ref, () => ({
    takePhoto: async () => {
      const file = await photoOutput.capturePhotoToFile({ enableShutterSound: false }, {});
      const uri = file.filePath.startsWith('file://') ? file.filePath : `file://${file.filePath}`;
      return { uri };
    },
  }), [photoOutput]);

  return (
    <VisionCamera.Camera
      style={style}
      device="front"
      isActive={isActive}
      outputs={outputs}
      onError={(err) => console.warn('Camera error:', err?.message)}
    />
  );
});

const ExpoGoFaceCamera = forwardRef(function ExpoGoFaceCamera({ style }, ref) {
  const cameraRef = useRef(null);
  useImperativeHandle(ref, () => ({
    takePhoto: () => cameraRef.current.takePictureAsync({ quality: 0.7, skipProcessing: true }),
  }), []);
  return <CameraView ref={cameraRef} style={style} facing="front" mute />;
});

/**
 * Front camera for the face scan. The ref exposes `takePhoto()` -> { uri }.
 * Render overlays as siblings, not children (iOS doesn't draw children over
 * the preview).
 */
const LiveFaceCamera = forwardRef(function LiveFaceCamera(props, ref) {
  return LIVE_FACE_DETECTION_AVAILABLE
    ? <VisionFaceCamera ref={ref} {...props} />
    : <ExpoGoFaceCamera ref={ref} {...props} />;
});

export default LiveFaceCamera;
