import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Modal, FlatList, Image, Animated, Easing } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system';
import FaceDetection from '@react-native-ml-kit/face-detection';
import { useAuth } from '../context/AuthContext';
import { colors, radius, shadow } from '../theme';
import { getDeviceInfo } from '../utils/device';
import { getDepartments, getEmployeeOptions } from '../api/client';
import FadeIn from '../components/FadeIn';
import PrimaryButton from '../components/PrimaryButton';

// Mirrors the backend's VALID_SUFFIXES list (controllers/employeeAuthController.js).
// '' (displayed as "None") is the default -- the field is optional.
const SUFFIX_OPTIONS = ['None', 'Jr.', 'Sr.', 'II', 'III', 'IV', 'V'];

// The Classification and Position lists are managed by the admin from the
// dashboard's employee form and loaded from /employee-auth/employee-options
// when this screen opens. These two are only the fallback for when that
// request fails, and match the server's defaults (employeeOptionController.js).
// Both are rendered with 'Others' appended (see DropdownFieldWithOthers
// below), which lets the employee type any value not on the list; the
// backend stores it as free text rather than enforcing this exact set.
const CLASSIFICATION_OPTIONS = [
  'Permanent Administrative', 'Permanent Academic', 'Casual Administrative',
  'COS Administrative', 'COS Academic', 'Job Order'
];

const POSITION_OPTIONS = [
  'Instructor I', 'Instructor II', 'Instructor III',
  'Assistant Professor', 'Associate Professor', 'Professor',
  'Department Dean', 'Program Chair', 'Guidance Counselor', 'Librarian',
  'Registrar Staff', 'Accounting Staff',
  'Administrative Aide I', 'Administrative Aide II', 'Administrative Aide III',
  'Administrative Officer', 'Administrative Assistant',
];

const GENDER_OPTIONS = ['Male', 'Female'];

// Resolves a value already on file (e.g. a returning employee's existing
// position/gender/classification, pre-filled from the backend) against one
// of the dropdown lists above. If it matches one of the listed options
// exactly, that option is selected outright. Otherwise -- a legacy value,
// or something previously typed into "Others" -- 'Others' is selected and
// the raw value is preserved in that field's free-text override, so
// nothing already on file is ever silently dropped or misrepresented just
// because the picker's fixed list doesn't happen to include it.
function resolveDropdownValue(raw, options) {
  if (!raw) return { selected: '', other: '' };
  return options.includes(raw) ? { selected: raw, other: '' } : { selected: 'Others', other: raw };
}

// A labeled dropdown field with a built-in "Others" option: picking it
// reveals a free-text input right below the field for anything not on the
// list. Shared by the Position, Gender, and Classification fields below
// (each otherwise needing near-identical label + touchable + modal-picker
// + conditional-text-input markup).
function DropdownFieldWithOthers({
  label, options, value, onSelect, otherValue, onOtherChange,
  pickerOpen, setPickerOpen, placeholder, otherPlaceholder, required
}) {
  return (
    <>
      <Text style={styles.inputLabel}>{label}{required ? ' *' : ''}</Text>
      <TouchableOpacity style={styles.dropdownInput} onPress={() => setPickerOpen(true)}>
        <Text style={value ? styles.dropdownValue : styles.dropdownPlaceholder}>{value || placeholder}</Text>
        <Text style={styles.dropdownCaret}>{'\u25BE'}</Text>
      </TouchableOpacity>
      {value === 'Others' && (
        <TextInput
          style={[styles.input, { marginTop: 8 }]}
          placeholder={otherPlaceholder}
          placeholderTextColor="#94A3B8"
          value={otherValue}
          onChangeText={onOtherChange}
          autoFocus
        />
      )}
      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setPickerOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>{label}</Text>
            <FlatList
              data={[...options, 'Others']}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.modalOption}
                  onPress={() => {
                    onSelect(item);
                    setPickerOpen(false);
                  }}
                >
                  <Text style={[styles.modalOptionText, item === value && styles.modalOptionTextActive]}>{item}</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

// Simplified face capture: a single "hold still and look at the camera" step
// instead of a multi-action nod/turn-left/turn-right sequence. This used to be
// a 3-step guided challenge (nod, then turn head left/right, each individually
// verified) -- that was accurate but fiddly in practice (easy to fumble the
// order, easy to end up pointing the phone somewhere with no face in frame at
// all and get a confusing "couldn't confirm" error). This single-step version
// keeps the same underlying protection (a live face must be sustained in
// frame for CONFIRM_FRAMES consecutive on-device ML Kit reads before anything
// is captured -- a photo of a photo or an empty frame never passes) while
// cutting the number of things that can go wrong for the person registering.
//
// A mandatory blink is layered on top of the hold (see detectBlink() below):
// once a face is held steady, the employee is prompted to blink, and a real
// eyes-open -> eyes-closed -> eyes-open cycle must be observed via ML Kit's
// per-eye "open probability" classification before capture continues. A
// still photo or a paused video frame held up to the camera can satisfy the
// "hold still" step, but can't blink on command -- this is what actually
// confirms a live person is in front of the camera, not just a face-shaped
// image.
const HOLD_STILL_CAPTION = 'Hold still and look at the camera';

// -- Real-time detection tuning --
const DETECTION_TIMEOUT_MS = 12000; // generous window so a slow phone or dim room can still catch up
const DETECTION_ATTEMPTS = 3; // retries allowed before aborting the whole capture
const CONFIRM_FRAMES = 3; // consecutive frames with a face present required before trusting it -- filters out single-frame ML Kit noise (e.g. a blink) without requiring any head movement

// -- Blink liveness tuning --
const BLINK_TIMEOUT_MS = 8000; // generous window for a natural blink after being prompted, before this attempt is abandoned
const EYES_OPEN_THRESHOLD = 0.6; // ML Kit eyeOpenProbability above this counts as "open"
const EYES_CLOSED_THRESHOLD = 0.3; // below this counts as "closed" -- the gap between the two thresholds avoids flicker right at the boundary
const MAX_BLINK_FACE_DROPOUT = 6; // consecutive missed reads before giving up on this attempt (face moved out of frame)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Slim 2-step progress indicator (Details -> Face Scan) shown at the top of
// both screens in the wizard -- the same "you are here" pattern GCash and
// similar KYC flows use so the person always knows how much is left.
// `dark` swaps the palette for use over the camera's dark background.
function StepProgress({ current, labels, dark }) {
  const dotIdleBorder = dark ? 'rgba(255,255,255,0.4)' : colors.border;
  const dotIdleText = dark ? 'rgba(255,255,255,0.7)' : colors.textSub;
  const labelIdle = dark ? 'rgba(255,255,255,0.65)' : colors.textSub;
  const labelActive = dark ? '#fff' : colors.primary;
  const connectorIdle = dark ? 'rgba(255,255,255,0.25)' : colors.border;

  return (
    <View style={styles.stepProgressRow}>
      {labels.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const dotBorderColor = done ? colors.success : active ? colors.primary : dotIdleBorder;
        return (
          <React.Fragment key={label}>
            <View style={styles.stepProgressItem}>
              <View style={[styles.stepDot, { borderColor: dotBorderColor }, done && styles.stepDotActive, active && { backgroundColor: colors.primary }]}>
                {done ? (
                  <Text style={styles.stepDotCheck}>{'\u2713'}</Text>
                ) : (
                  <Text style={[styles.stepDotNum, { color: active ? '#fff' : dotIdleText }]}>{i + 1}</Text>
                )}
              </View>
              <Text style={[styles.stepLabel, { color: done || active ? labelActive : labelIdle }]}>{label}</Text>
            </View>
            {i < labels.length - 1 && (
              <View style={[styles.stepConnector, { backgroundColor: done ? colors.success : connectorIdle }]} />
            )}
          </React.Fragment>
        );
      })}
    </View>
  );
}

// Registration sequence: Continue with Google (LoginScreen) -> employee details
// (step 1 below) -> guided, real-time-verified face registration (step 2
// below) -> submitted together to /api/employee-auth/link-device, which
// links the device AND enrolls the face in one request. Mirrors
// #screen-register in the CSPC GeoAttend web prototype, extended with a
// mandatory liveness check -- hold a face steady, then blink on command --
// instead of a single still selfie. Both are confirmed on-device via ML Kit
// (detectFaceHold(), then detectBlink()) before the flow automatically
// advances to capture.
export default function RegistrationScreen({ navigation }) {
  const { employee, pendingGoogle, completeRegistration, cancelRegistration } = useAuth();
  // Set once registration succeeds: from then on AuthContext has an
  // `employee`, and RootNavigator (App.js) swaps this whole stack out for
  // WaitingApproval/WifiCheck. This screen must not navigate or set state
  // after that -- a late navigation.replace('Login') sent while the stack
  // was being swapped is what left the app on a blank white screen.
  const registeredRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [step, setStep] = useState('details'); // 'details' | 'capture'

  // -- Step 1: employee details --
  const [employeeCode, setEmployeeCode] = useState('');
  const [surname, setSurname] = useState('');
  const [givenName, setGivenName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [suffix, setSuffix] = useState('None');
  const [suffixPickerOpen, setSuffixPickerOpen] = useState(false);
  const [departments, setDepartments] = useState([]); // [{ id, name }]
  const [department, setDepartment] = useState(null); // selected department name
  const [departmentPickerOpen, setDepartmentPickerOpen] = useState(false);
  const [position, setPosition] = useState('');
  const [positionOther, setPositionOther] = useState('');
  const [positionPickerOpen, setPositionPickerOpen] = useState(false);
  const [gender, setGender] = useState('');
  const [genderOther, setGenderOther] = useState('');
  const [genderPickerOpen, setGenderPickerOpen] = useState(false);
  const [classification, setClassification] = useState('');
  const [classificationOther, setClassificationOther] = useState('');
  const [classificationPickerOpen, setClassificationPickerOpen] = useState(false);
  const [positionOptions, setPositionOptions] = useState(POSITION_OPTIONS);
  const [classificationOptions, setClassificationOptions] = useState(CLASSIFICATION_OPTIONS);
  const [deviceInfo, setDeviceInfo] = useState('Detecting device...');

  // -- Step 2: guided, real-time-verified face capture --
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const [captureStage, setCaptureStage] = useState('ready'); // 'ready' | 'recording' | 'reviewing'
  // 'idle' | 'scanning' | 'confirmed' | 'failed' | 'finishing' -- drives the
  // real-time feedback UI (pulsing scan ring, success/fail pop, etc).
  const [stepStatus, setStepStatus] = useState('idle');
  const [liveFaceDetected, setLiveFaceDetected] = useState(false); // is a face visible in the most recent poll
  const [blinkEyesClosed, setBlinkEyesClosed] = useState(false); // has a closed-eyes frame been seen yet during the current blink attempt -- drives the "now open your eyes" prompt
  const [capturedPhoto, setCapturedPhoto] = useState(null); // { uri } -- final still frame, used for the face embedding
  const scanPulse = useRef(new Animated.Value(0)).current; // looping "scanning" ring while stepStatus === 'scanning'
  const resultPop = useRef(new Animated.Value(0)).current; // spring pop for the confirmed/failed icon
  const verifyingRef = useRef(false); // lets handleCancelRecording interrupt an in-progress sequence

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [lockInfo, setLockInfo] = useState(null); // { message } -- set on a 423 DoubleSafe lockout response

  useEffect(() => {
    if (!pendingGoogle) {
      // Cleared because registration just finished (or the user is already
      // signed in): RootNavigator handles where to go next.
      if (registeredRef.current || employee) return;
      navigation.replace('Login');
      return;
    }
    const existing = pendingGoogle.existingEmployee;
    if (existing) {
      // Returning employee, unrecognized device (see AuthContext.loginWithGoogle /
      // controllers/employeeAuthController.js googleLogin()) -- pre-fill everything
      // already on file instead of asking them to retype an account they already
      // have. They can still edit any field before continuing.
      setEmployeeCode(existing.employee_code || '');
      setSurname(existing.surname || pendingGoogle.google?.family_name || '');
      setGivenName(existing.given_name || pendingGoogle.google?.given_name || '');
      setMiddleName(existing.middle_name || '');
      setSuffix(existing.suffix ? existing.suffix : 'None');
      setDepartment(existing.department || null);
      const posResolved = resolveDropdownValue(existing.position || '', POSITION_OPTIONS);
      setPosition(posResolved.selected);
      setPositionOther(posResolved.other);
      const genResolved = resolveDropdownValue(existing.gender || '', GENDER_OPTIONS);
      setGender(genResolved.selected);
      setGenderOther(genResolved.other);
      const classResolved = resolveDropdownValue(existing.classification || '', CLASSIFICATION_OPTIONS);
      setClassification(classResolved.selected);
      setClassificationOther(classResolved.other);
    } else {
      // Pre-fill the Google-verified name so the employee usually just has to
      // fill in the Employee ID, splitting Google's given/family name into the
      // Surname / Given Name fields the admin record uses.
      setSurname(pendingGoogle.google?.family_name || '');
      setGivenName(pendingGoogle.google?.given_name || '');
    }
    (async () => {
      const info = getDeviceInfo();
      setDeviceInfo(`MODEL: ${info.model}\nBRAND: ${info.brand}\nOS: ${info.os}\nDEVICE ID: ${info.uid}`);
    })();
    (async () => {
      try {
        const res = await getDepartments();
        setDepartments(res.data || []);
      } catch (err) {
        // Non-fatal — the employee can still type/select once the list loads,
        // or retry; department is resolved/created server-side either way.
      }
    })();
    (async () => {
      try {
        const res = await getEmployeeOptions();
        const positions = Array.isArray(res.data?.positions) ? res.data.positions : POSITION_OPTIONS;
        const classifications = Array.isArray(res.data?.classifications) ? res.data.classifications : CLASSIFICATION_OPTIONS;
        if (!mountedRef.current) return;
        setPositionOptions(positions);
        setClassificationOptions(classifications);
        // A returning employee's values were matched against the fallback
        // lists above; match them again against the admin's current lists.
        if (existing) {
          const pos = resolveDropdownValue(existing.position || '', positions);
          setPosition(pos.selected);
          setPositionOther(pos.other);
          const cls = resolveDropdownValue(existing.classification || '', classifications);
          setClassification(cls.selected);
          setClassificationOther(cls.other);
        }
      } catch (err) {
        // Non-fatal — the built-in fallback lists stay in place.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGoogle]);

  const handleContinueToCapture = async () => {
    setErrorMsg('');
    // Every field on this form is required except Middle Name and Suffix.
    if (!employeeCode.trim() || !surname.trim() || !givenName.trim()) {
      setErrorMsg('Employee ID, Surname, and Given Name are required.');
      return;
    }
    if (!department) {
      setErrorMsg('Please select a Department.');
      return;
    }
    if (!position) {
      setErrorMsg('Please select a Position.');
      return;
    }
    if (!gender) {
      setErrorMsg('Please select a Gender.');
      return;
    }
    if (!classification) {
      setErrorMsg('Please select a Classification.');
      return;
    }
    // "Others" is a deliberate choice to specify something not on the list --
    // leaving its free-text field blank after picking it is almost certainly
    // a mistake, not an intentional empty value, so it's caught here rather
    // than silently submitting "Others" itself or an empty string.
    if (position === 'Others' && !positionOther.trim()) {
      setErrorMsg('Please specify your Position, or choose one from the list.');
      return;
    }
    if (gender === 'Others' && !genderOther.trim()) {
      setErrorMsg('Please specify your Gender, or choose one from the list.');
      return;
    }
    if (classification === 'Others' && !classificationOther.trim()) {
      setErrorMsg('Please specify your Classification, or choose one from the list.');
      return;
    }
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setErrorMsg('Camera access is required to complete face registration.');
        return;
      }
    }
    setStep('capture');
  };

  // Animates the current challenge's "scanning" ring while we're actively
  // polling for it, and stops cleanly the moment the step resolves.
  useEffect(() => {
    if (stepStatus !== 'scanning' && stepStatus !== 'blink') return undefined;
    scanPulse.setValue(0);
    const loop = Animated.loop(
      Animated.timing(scanPulse, { toValue: 1, duration: 1100, easing: Easing.out(Easing.ease), useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [stepStatus, scanPulse]);

  // Pops the confirmed (check) / failed (x) icon in with a little spring bounce.
  useEffect(() => {
    if (stepStatus === 'confirmed' || stepStatus === 'failed') {
      resultPop.setValue(0);
      Animated.spring(resultPop, { toValue: 1, useNativeDriver: true, friction: 4, tension: 90 }).start();
    }
  }, [stepStatus, resultPop]);

  // Polls the camera + on-device ML Kit face detector until a face is
  // actually, sustainedly present in frame (or DETECTION_TIMEOUT_MS runs
  // out). No head movement is required -- a single noisy ML Kit miss (e.g. a
  // blink) can't reset progress by itself, since only a face present for
  // CONFIRM_FRAMES consecutive reads counts as "held".
  const detectFaceHold = async () => {
    const startedAt = Date.now();
    let holdStreak = 0; // consecutive frames with a face present

    while (Date.now() - startedAt < DETECTION_TIMEOUT_MS) {
      if (!verifyingRef.current) return false; // cancelled

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
          performanceMode: 'fast',
          landmarkMode: 'none',
          contourMode: 'none',
          minFaceSize: 0.15,
        });
      } catch (err) {
        faces = [];
      }
      // Each poll frame is only needed for this one detection pass.
      if (photo.uri) FileSystem.deleteAsync(photo.uri, { idempotent: true }).catch(() => {});

      const face = faces && faces[0];
      setLiveFaceDetected(!!face);

      holdStreak = face ? holdStreak + 1 : 0;
      if (holdStreak >= CONFIRM_FRAMES) return true; // face held steady long enough
    }
    return false; // timed out without a sustained face
  };

  // Runs once a steady face has already been confirmed by detectFaceHold().
  // Waits for a genuine eyes-open -> eyes-closed -> eyes-open cycle -- i.e. an
  // actual blink -- using ML Kit's per-eye "open probability" classification
  // (only populated when classificationMode: 'all' is passed). This is the
  // step that defeats a photo (or a paused video frame) held up to the
  // camera: a static image can satisfy "hold a face steady" but its eye-open
  // probability never moves, so it can never complete the closed -> open
  // transition this function requires.
  const detectBlink = async () => {
    const startedAt = Date.now();
    let phase = 'awaiting-close'; // 'awaiting-close' -> 'awaiting-reopen' -> done
    let noFaceStreak = 0;

    while (Date.now() - startedAt < BLINK_TIMEOUT_MS) {
      if (!verifyingRef.current) return false; // cancelled

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
          performanceMode: 'fast',
          landmarkMode: 'none',
          contourMode: 'none',
          classificationMode: 'all', // needed for leftEyeOpenProbability / rightEyeOpenProbability
          minFaceSize: 0.15,
        });
      } catch (err) {
        faces = [];
      }
      if (photo.uri) FileSystem.deleteAsync(photo.uri, { idempotent: true }).catch(() => {});

      const face = faces && faces[0];
      setLiveFaceDetected(!!face);

      if (!face) {
        // A brief dropout (motion blur, a mistimed frame) shouldn't fail the
        // whole attempt by itself -- only give up once the face has been
        // missing for several consecutive reads.
        noFaceStreak += 1;
        if (noFaceStreak >= MAX_BLINK_FACE_DROPOUT) return false;
        continue;
      }
      noFaceStreak = 0;

      // ML Kit reports each eye separately; average them so one eye being
      // slightly obscured (hair, a tilted head) doesn't block detection.
      const { leftEyeOpenProbability: left, rightEyeOpenProbability: right } = face;
      if (left == null || right == null) continue; // classification not available for this particular frame
      const openness = (left + right) / 2;

      if (phase === 'awaiting-close' && openness < EYES_CLOSED_THRESHOLD) {
        phase = 'awaiting-reopen';
        setBlinkEyesClosed(true);
      } else if (phase === 'awaiting-reopen' && openness > EYES_OPEN_THRESHOLD) {
        return true; // full open -> closed -> open cycle observed: a real blink
      }
    }
    return false; // timed out without completing a full blink
  };

  // Runs the simplified single-step capture: wait for a live, steadily-held
  // face and a completed blink (retrying on a missed attempt before giving
  // up), then automatically captures the final still frame used for the
  // face embedding -- no button for the employee to press.
  const handleStartGuidedCapture = async () => {
    setErrorMsg('');
    if (!cameraRef.current) return;

    setCaptureStage('recording');
    verifyingRef.current = true;

    let confirmed = false;
    let failedOnBlink = false; // which step the last attempt failed on, so the error message matches
    for (let attempt = 0; attempt < DETECTION_ATTEMPTS && !confirmed; attempt++) {
      if (!verifyingRef.current) return;
      setStepStatus('scanning');
      const held = await detectFaceHold();
      if (!verifyingRef.current) return;

      let blinked = false;
      if (held) {
        setBlinkEyesClosed(false);
        setStepStatus('blink');
        blinked = await detectBlink();
        if (!verifyingRef.current) return;
      }

      confirmed = held && blinked;
      failedOnBlink = held && !blinked;
      if (!confirmed && attempt < DETECTION_ATTEMPTS - 1) {
        setStepStatus('failed');
        await wait(900); // let the "didn't catch that" feedback register before retrying
      }
    }

    if (!confirmed) {
      setStepStatus('failed');
      await wait(700);
      setErrorMsg(
        failedOnBlink
          ? "Couldn't confirm a blink. Keep your whole face in frame and blink normally when prompted, then try again."
          : "Couldn't detect your face. Make sure your face is centered and well-lit, then try again."
      );
      setStepStatus('idle');
      setCaptureStage('ready');
      verifyingRef.current = false;
      return;
    }

    setStepStatus('confirmed');
    await wait(550); // let the success pop register before capturing

    if (!verifyingRef.current) return;
    setStepStatus('finishing');
    try {
      // Automatic capture -- no button for the employee to press. This used
      // to also record a few seconds of video here as extra "proof of life"
      // evidence, on top of the already-completed hold + blink checks. That
      // recording step was removed: expo-camera's recordAsync()/
      // stopRecording() pairing has a race where stopping very soon after
      // starting can reject with "Recording was stopped before any data
      // could be produced" (surfaced to the employee as a console warning
      // overlay in dev builds), the video was never actually used anywhere
      // in the admin dashboard (video_path is stored but never read back),
      // and it isn't required by the backend (employeeAuthController.linkDevice
      // only requires the still image; a request with no video field
      // behaves exactly like it did when the video capture failed here
      // before). Removing it also makes the automatic capture feel
      // immediate rather than waiting through a multi-second recording.
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7, skipProcessing: true });
      setCapturedPhoto(photo);
      setCaptureStage('reviewing');
    } catch (err) {
      setErrorMsg('Could not finish capturing. Please try again.');
      setCaptureStage('ready');
    } finally {
      verifyingRef.current = false;
      setStepStatus('idle');
    }
  };

  const handleCancelRecording = () => {
    verifyingRef.current = false;
    setStepStatus('idle');
    setBlinkEyesClosed(false);
    setCaptureStage('ready');
  };

  const handleRetake = () => {
    setCapturedPhoto(null);
    setStepStatus('idle');
    setBlinkEyesClosed(false);
    setErrorMsg('');
    setLockInfo(null);
    setCaptureStage('ready');
  };

  // Stop any in-progress detection if the employee navigates away mid-sequence.
  useEffect(() => () => {
    verifyingRef.current = false;
  }, []);

  const handleSubmit = async () => {
    if (!capturedPhoto) return;
    setErrorMsg('');
    setLockInfo(null);
    setSubmitting(true);
    try {
      const device = getDeviceInfo();
      const formData = new FormData();
      formData.append('employee_code', employeeCode.trim().toUpperCase());
      formData.append('surname', surname.trim());
      formData.append('given_name', givenName.trim());
      if (middleName.trim()) formData.append('middle_name', middleName.trim());
      if (suffix !== 'None') formData.append('suffix', suffix);
      if (department) formData.append('department', department);
      // Each of these resolves to the typed free-text value when 'Others'
      // was picked, or the selected option otherwise -- the backend never
      // sees the literal string "Others" itself.
      const positionValue = position === 'Others' ? positionOther.trim() : position;
      if (positionValue) formData.append('position', positionValue);
      const genderValue = gender === 'Others' ? genderOther.trim() : gender;
      if (genderValue) formData.append('gender', genderValue);
      const classificationValue = classification === 'Others' ? classificationOther.trim() : classification;
      formData.append('classification', classificationValue);
      formData.append('device_uid', device.uid);
      formData.append('device_model', device.model);
      formData.append('device_brand', device.brand);
      formData.append('device_os', device.os);
      formData.append('liveness_verified', 'true');
      formData.append('liveness_actions', 'hold_still');
      formData.append('image', {
        uri: capturedPhoto.uri,
        name: 'face.jpg',
        type: 'image/jpeg',
      });
      registeredRef.current = true;
      await completeRegistration(formData);
      // RootNavigator (App.js) reacts to `employee` + `deviceStatus` automatically:
      // a 'pending' device is routed to the WaitingApproval screen, which will in
      // turn redirect to Home the moment an admin approves it.
    } catch (err) {
      registeredRef.current = false;
      if (!mountedRef.current) return;
      // DoubleSafe checkpoint (see employeeAuthController.linkDevice): registering a
      // new device for an identity that already has a face on file requires the live
      // selfie to match it. A 423 means too many failed attempts have locked the
      // account out for a cooldown -- that's not a "just try again" error, so it gets
      // its own persistent panel instead of the normal retry flow (see the reviewing
      // stage render below).
      if (err.response?.status === 423) {
        setLockInfo({ message: err.response?.data?.message || 'Too many failed identity checks. Please try again later or contact your administrator.' });
      } else {
        setErrorMsg(err.response?.data?.message || 'Registration failed. Please check your details and try again.');
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const handleCancel = () => {
    cancelRegistration();
    navigation.replace('Login');
  };

  if (step === 'capture') {
    const ringScale = scanPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });
    const ringOpacity = scanPulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.45, 0.12, 0] });
    const popScale = resultPop.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0.4, 1.15, 1] });

    let challengeCaption = '';
    if (stepStatus === 'scanning') {
      challengeCaption = !liveFaceDetected ? 'Center your face in the frame' : HOLD_STILL_CAPTION;
    }
    else if (stepStatus === 'blink') challengeCaption = blinkEyesClosed ? 'Great \u2014 now open your eyes' : 'Blink your eyes';
    else if (stepStatus === 'confirmed') challengeCaption = 'Confirmed!';
    else if (stepStatus === 'failed') challengeCaption = "Didn't catch that \u2014 let's try again";
    else if (stepStatus === 'finishing') challengeCaption = 'Hold still \u2014 capturing\u2026';

    // The guide ring's color IS the primary feedback signal (GCash-style: a
    // neutral ring while searching, green ONLY the instant the correct
    // action is actually confirmed, red on a miss). Merely detecting a face
    // is never enough to turn it green -- that would read as "you got it
    // right" before the prompted action has actually been verified.
    let ringVariant = styles.guideFrameSearching;
    if (captureStage === 'recording') {
      if (stepStatus === 'confirmed' || stepStatus === 'finishing') ringVariant = styles.guideFrameFound;
      else if (stepStatus === 'failed') ringVariant = styles.guideFrameFailed;
      // else (scanning): stays neutral regardless of liveFaceDetected --
      // "a face is visible" and "the correct action was confirmed" are
      // different facts, and only the badge/caption text conveys the former.
    }

    return (
      <View style={styles.cameraContainer}>
        {captureStage === 'reviewing' ? (
          <>
            <Image source={{ uri: capturedPhoto.uri }} style={styles.preview} />
            <View style={styles.topScrim} pointerEvents="none" />
            <View style={styles.videoBadge}>
              <View style={styles.videoBadgeIconWrap}>
                <Ionicons name="checkmark-circle" size={22} color={colors.success} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.videoBadgeTitle}>Liveness verified in real time</Text>
                <Text style={styles.videoBadgeSubtitle}>
                  Live face and blink detected on-device
                </Text>
              </View>
            </View>
            <View style={styles.bottomSheet}>
              <View style={styles.sheetHandle} />
              {lockInfo ? (
                <>
                  <View style={styles.lockPanel}>
                    <Ionicons name="lock-closed" size={26} color={colors.dangerText} style={{ marginBottom: 8 }} />
                    <Text style={styles.lockPanelTitle}>Identity Verification Locked</Text>
                    <Text style={styles.lockPanelText}>{lockInfo.message}</Text>
                  </View>
                  <TouchableOpacity style={styles.retakeBtn} onPress={handleCancel} disabled={submitting}>
                    <Text style={styles.retakeBtnText}>Back to Sign In</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  {!!errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}
                  <PrimaryButton title="Complete Registration" onPress={handleSubmit} loading={submitting} style={{ width: '100%' }} />
                  <TouchableOpacity style={styles.retakeBtn} onPress={handleRetake} disabled={submitting}>
                    <Text style={styles.retakeBtnText}>Retake Photo</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </>
        ) : (
          <>
            <CameraView ref={cameraRef} style={styles.camera} facing="front" mute>
              <View style={styles.topScrim} pointerEvents="none" />
              <View style={styles.topBar} pointerEvents="none">
                <StepProgress current={1} labels={['Details', 'Face Scan']} dark />
              </View>

              <View style={styles.guideFrameWrap}>
                <View style={[styles.guideFrame, ringVariant]} />
                {stepStatus === 'confirmed' && <View style={styles.guideFrameGlow} pointerEvents="none" />}
              </View>

              {captureStage === 'ready' ? (
                <View style={styles.readyCaptionWrap} pointerEvents="none">
                  <Text style={styles.guideText}>Center your face within the frame</Text>
                </View>
              ) : (
                <View style={styles.challengeOverlay} pointerEvents="none">
                  <View style={styles.challengeTopGroup}>
                    {stepStatus === 'finishing' ? (
                      <View style={styles.recBadge}>
                        <View style={styles.recDot} />
                        <Text style={styles.recBadgeText}>CAPTURING</Text>
                      </View>
                    ) : (
                      <View style={[styles.recBadge, styles.scanBadge]}>
                        <View style={[styles.recDot, liveFaceDetected ? styles.scanDotFound : styles.scanDotSearching]} />
                        <Text style={styles.recBadgeText}>{liveFaceDetected ? 'FACE FOUND' : 'SEARCHING\u2026'}</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.challengeBottomGroup}>
                    <View style={styles.challengeIconWrap}>
                      {(stepStatus === 'scanning' || stepStatus === 'blink') && (
                        <>
                          {/* Translucent "detecting" backdrop -- the loading indicator itself is meant to read as see-through, not a solid disc. */}
                          <View style={styles.scanBackdrop} />
                          <Animated.View style={[styles.scanRing, { transform: [{ scale: ringScale }], opacity: ringOpacity }]} />
                        </>
                      )}
                      {stepStatus === 'confirmed' || stepStatus === 'failed' ? (
                        <Animated.View style={{ transform: [{ scale: popScale }] }}>
                          <Ionicons
                            name={stepStatus === 'confirmed' ? 'checkmark-circle' : 'close-circle'}
                            size={44}
                            color={stepStatus === 'confirmed' ? colors.success : colors.error}
                          />
                        </Animated.View>
                      ) : (
                        <Ionicons
                          name={
                            stepStatus === 'finishing' ? 'checkmark-circle'
                              : stepStatus === 'blink' ? (blinkEyesClosed ? 'eye-off-outline' : 'eye-outline')
                              : 'scan-outline'
                          }
                          size={40}
                          color="#fff"
                        />
                      )}
                    </View>
                    <Text style={styles.challengeText}>{challengeCaption}</Text>
                  </View>
                </View>
              )}
            </CameraView>
            <View style={styles.bottomSheet}>
              <View style={styles.sheetHandle} />
              {!!errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}
              {captureStage === 'ready' ? (
                <>
                  <View style={styles.secureBadgeRow}>
                    <Ionicons name="shield-checkmark-outline" size={14} color={colors.textSub} />
                    <Text style={styles.secureBadgeText}>Secure Identity Verification</Text>
                  </View>
                  <Text style={styles.captureHint}>
                    Hold your face steady in the frame, then blink when prompted \u2014 we'll detect it live on-device and capture automatically. If this is a new device for an already-registered account, your face is also matched against your identity on file, just like GCash's DoubleSafe.
                  </Text>
                  <PrimaryButton title="Start Face Scan" onPress={handleStartGuidedCapture} style={{ width: '100%' }} />
                  <TouchableOpacity onPress={() => setStep('details')}>
                    <Text style={styles.backLink}>{'\u2190'} Back to details</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity onPress={handleCancelRecording} style={{ paddingVertical: 6 }}>
                  <Text style={styles.backLink}>Cancel</Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        )}
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingTop: 40 }}>
      <FadeIn>
        <StepProgress current={0} labels={['Details', 'Face Scan']} />
        <Text style={styles.header}>{pendingGoogle?.existingEmployee ? 'Verify This Device' : 'Device Registration'}</Text>
        <Text style={styles.subtext}>
          Signed in as {pendingGoogle?.google?.given_name || ''} {pendingGoogle?.google?.family_name || ''} ({pendingGoogle?.google?.email}).{' '}
          {pendingGoogle?.existingEmployee
            ? "This device isn't recognized yet, so we need to confirm it's really you. Your details are pre-filled — check them, then you'll be asked to verify your face to finish."
            : "Confirm your official employee details, then you'll be asked to register your face to finish."}
        </Text>
      </FadeIn>

      <FadeIn delay={80}>
        <View style={styles.card}>
        <Text style={styles.inputLabel}>Employee ID *</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. E001"
          placeholderTextColor="#94A3B8"
          autoCapitalize="characters"
          value={employeeCode}
          onChangeText={setEmployeeCode}
        />

        <Text style={styles.inputLabel}>Surname *</Text>
        <TextInput
          style={styles.input}
          placeholder="Dela Cruz"
          placeholderTextColor="#94A3B8"
          value={surname}
          onChangeText={setSurname}
        />

        <Text style={styles.inputLabel}>Given Name *</Text>
        <TextInput
          style={styles.input}
          placeholder="Juan"
          placeholderTextColor="#94A3B8"
          value={givenName}
          onChangeText={setGivenName}
        />

        <Text style={styles.inputLabel}>Middle Name</Text>
        <TextInput
          style={styles.input}
          placeholder="Optional"
          placeholderTextColor="#94A3B8"
          value={middleName}
          onChangeText={setMiddleName}
        />

        <Text style={styles.inputLabel}>Suffix Name</Text>
        <TouchableOpacity style={styles.dropdownInput} onPress={() => setSuffixPickerOpen(true)}>
          <Text style={suffix === 'None' ? styles.dropdownPlaceholder : styles.dropdownValue}>{suffix}</Text>
          <Text style={styles.dropdownCaret}>{'\u25BE'}</Text>
        </TouchableOpacity>

        <Text style={styles.inputLabel}>Department *</Text>
        <TouchableOpacity style={styles.dropdownInput} onPress={() => setDepartmentPickerOpen(true)}>
          <Text style={department ? styles.dropdownValue : styles.dropdownPlaceholder}>{department || 'Select department'}</Text>
          <Text style={styles.dropdownCaret}>{'\u25BE'}</Text>
        </TouchableOpacity>

        <DropdownFieldWithOthers
          label="Position"
          required
          options={positionOptions}
          value={position}
          onSelect={setPosition}
          otherValue={positionOther}
          onOtherChange={setPositionOther}
          pickerOpen={positionPickerOpen}
          setPickerOpen={setPositionPickerOpen}
          placeholder="Select position"
          otherPlaceholder="Enter your position"
        />

        <DropdownFieldWithOthers
          label="Gender"
          required
          options={GENDER_OPTIONS}
          value={gender}
          onSelect={setGender}
          otherValue={genderOther}
          onOtherChange={setGenderOther}
          pickerOpen={genderPickerOpen}
          setPickerOpen={setGenderPickerOpen}
          placeholder="Select gender"
          otherPlaceholder="Enter your gender"
        />

        <DropdownFieldWithOthers
          label="Classification"
          required
          options={classificationOptions}
          value={classification}
          onSelect={setClassification}
          otherValue={classificationOther}
          onOtherChange={setClassificationOther}
          pickerOpen={classificationPickerOpen}
          setPickerOpen={setClassificationPickerOpen}
          placeholder="Select classification"
          otherPlaceholder="Enter classification"
        />
        </View>

        <View style={styles.deviceCard}>
          <Text style={styles.deviceText}>{deviceInfo}</Text>
        </View>

        {!!errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}

        <PrimaryButton title="Continue to Face Registration" onPress={handleContinueToCapture} disabled={submitting} style={{ marginTop: 15 }} />
        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel} disabled={submitting}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      </FadeIn>

      {/* Simple modal-based dropdown for Suffix Name -- avoids pulling in a native
          picker dependency that would require a new dev-client build. */}
      <Modal visible={suffixPickerOpen} transparent animationType="fade" onRequestClose={() => setSuffixPickerOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setSuffixPickerOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Suffix Name</Text>
            <FlatList
              data={SUFFIX_OPTIONS}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.modalOption}
                  onPress={() => {
                    setSuffix(item);
                    setSuffixPickerOpen(false);
                  }}
                >
                  <Text style={[styles.modalOptionText, item === suffix && styles.modalOptionTextActive]}>{item}</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Department picker -- options come from GET /api/employee-auth/departments. */}
      <Modal visible={departmentPickerOpen} transparent animationType="fade" onRequestClose={() => setDepartmentPickerOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setDepartmentPickerOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Department</Text>
            {departments.length === 0 ? (
              <Text style={styles.modalEmptyText}>No departments available yet.</Text>
            ) : (
              <FlatList
                data={departments}
                keyExtractor={(item) => String(item.id)}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.modalOption}
                    onPress={() => {
                      setDepartment(item.name);
                      setDepartmentPickerOpen(false);
                    }}
                  >
                    <Text style={[styles.modalOptionText, item.name === department && styles.modalOptionTextActive]}>{item.name}</Text>
                  </TouchableOpacity>
                )}
              />
            )}
          </View>
        </TouchableOpacity>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { fontSize: 20, fontWeight: '800', color: colors.cspcBlue },
  subtext: { color: colors.textSub, fontSize: 13, marginTop: 6, marginBottom: 18, lineHeight: 18 },
  // Top-of-wizard step indicator (Details -> Face Scan), reused on both screens.
  stepProgressRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', marginBottom: 18 },
  stepProgressItem: { alignItems: 'center', width: 84 },
  stepDot: {
    width: 26, height: 26, borderRadius: 13, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent',
  },
  stepDotActive: { backgroundColor: colors.success },
  stepDotNum: { fontSize: 12, fontWeight: '800' },
  stepDotCheck: { color: '#fff', fontSize: 13, fontWeight: '800' },
  stepLabel: { fontSize: 10, fontWeight: '700', marginTop: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  stepConnector: { flex: 1, height: 2, marginTop: 12, maxWidth: 36 },
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: 18,
    borderWidth: 1, borderColor: colors.border, ...shadow, marginBottom: 15,
  },
  inputLabel: { fontSize: 10, fontWeight: '800', color: colors.cspcBlue, textTransform: 'uppercase', marginBottom: 6, marginTop: 10 },
  input: { borderWidth: 2, borderColor: colors.border, borderRadius: radius.sm, padding: 12, fontSize: 14, color: colors.textMain },
  dropdownInput: {
    borderWidth: 2, borderColor: colors.border, borderRadius: radius.sm, padding: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  dropdownPlaceholder: { fontSize: 14, color: '#94A3B8' },
  dropdownValue: { fontSize: 14, color: colors.textMain },
  dropdownCaret: { fontSize: 14, color: colors.textSub },
  deviceCard: { backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: 16, marginBottom: 8 },
  deviceText: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18, color: colors.textMain },
  errorText: { color: colors.error, fontSize: 12, marginVertical: 8, textAlign: 'center' },
  cancelBtn: { padding: 14, alignItems: 'center', marginTop: 4, marginBottom: 20 },
  cancelBtnText: { color: colors.textSub, fontWeight: '700', fontSize: 13 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: colors.white, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingTop: 12, paddingBottom: 24, maxHeight: '55%' },
  modalTitle: { fontSize: 13, fontWeight: '800', color: colors.cspcBlue, textTransform: 'uppercase', textAlign: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalOption: { paddingVertical: 16, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  modalOptionText: { fontSize: 15, color: colors.textMain, textAlign: 'center' },
  modalOptionTextActive: { color: colors.cspcBlue, fontWeight: '800' },
  modalEmptyText: { color: colors.textSub, fontSize: 13, textAlign: 'center', paddingVertical: 24, paddingHorizontal: 24 },

  // Step 2: guided, real-time-verified face capture
  cameraContainer: { flex: 1, backgroundColor: '#0B0F1A' },
  camera: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  preview: { flex: 1, resizeMode: 'cover' },
  // Soft dark gradient-like scrim behind the top status chrome (step
  // progress, REC/scanning badge) so it reads clearly over any background,
  // without needing to mask/punch a hole in the camera preview.
  topScrim: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 130,
    backgroundColor: 'rgba(11,15,26,0.55)',
  },
  topBar: { position: 'absolute', top: 14, left: 0, right: 0, paddingHorizontal: 20 },
  guideFrameWrap: { alignItems: 'center', justifyContent: 'center' },
  // Face-shaped (tall oval, not a circle) -- taller than it is wide, like an
  // actual face outline. The ring color IS the main real-time feedback
  // signal: neutral while searching, green ONLY the instant the correct
  // action is actually confirmed, red on a miss.
  guideFrame: {
    width: 226, height: 296, borderRadius: 148, borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.55)', alignSelf: 'center',
  },
  guideFrameFound: { borderColor: colors.success },
  guideFrameSearching: { borderColor: '#FFB547' },
  guideFrameFailed: { borderColor: colors.error },
  // Soft glow ring just outside the frame when the correct action is
  // confirmed -- a gentle "halo" rather than a hard second border.
  guideFrameGlow: {
    position: 'absolute', width: 242, height: 312, borderRadius: 156,
    borderWidth: 8, borderColor: colors.success, opacity: 0.18,
  },
  readyCaptionWrap: { position: 'absolute', bottom: 130, left: 0, right: 0 },
  guideText: {
    textAlign: 'center', color: '#fff', fontSize: 14, fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 8,
  },
  // Full-screen overlay while capturing -- status badge + progress dots
  // pinned near the top, the current instruction/result pinned near the
  // bottom, leaving the guideFrame clear in the middle.
  challengeOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'space-between', paddingVertical: 56, paddingHorizontal: 24,
  },
  challengeTopGroup: { alignItems: 'center' },
  challengeBottomGroup: { alignItems: 'center', width: '100%' },
  recBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: 'rgba(238,93,80,0.85)', paddingVertical: 6, paddingHorizontal: 12,
    borderRadius: 20, marginBottom: 14,
  },
  // Badge shown while actively polling for the current action (as opposed to
  // the red "CAPTURING" badge, only shown for the brief moment the final
  // photo is being taken at the very end).
  scanBadge: { backgroundColor: 'rgba(15,23,42,0.65)' },
  recDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff' },
  // "A face is visible" is a different, lower-stakes fact than "the correct
  // action was confirmed" -- deliberately never green, to avoid reading as
  // a success signal before the prompted action is actually verified.
  scanDotFound: { backgroundColor: colors.info },
  scanDotSearching: { backgroundColor: '#FFB547' },
  recBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  dotsRow: { flexDirection: 'row', gap: 8 },
  challengeDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.35)' },
  challengeDotActive: { backgroundColor: '#fff', width: 11, height: 11, borderRadius: 6 },
  challengeDotDone: { backgroundColor: colors.success },
  challengeDotFailed: { backgroundColor: colors.error, width: 11, height: 11, borderRadius: 6 },
  // Icon + its looping "scanning" indicator sit in a fixed-size box so
  // nothing nudges surrounding layout as it expands/fades.
  challengeIconWrap: { width: 72, height: 72, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  // Translucent "detecting" backdrop plate -- a soft, semi-see-through disc
  // rather than a solid one, so the loading indicator reads as active
  // without ever looking like an opaque, finished state.
  scanBackdrop: {
    position: 'absolute', width: 68, height: 68, borderRadius: 34,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  scanRing: {
    position: 'absolute', width: 64, height: 64, borderRadius: 32,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)',
  },
  challengeText: {
    color: '#fff', fontSize: 16, fontWeight: '800', textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.4)', textShadowRadius: 6,
  },
  // GCash-style bottom action sheet: a light, rounded-top card fixed to the
  // bottom of the dark camera view -- the light/dark contrast is the single
  // biggest visual signature of this style of verification screen.
  bottomSheet: {
    backgroundColor: colors.white, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    paddingTop: 10, paddingBottom: 28, paddingHorizontal: 24, alignItems: 'center', ...shadow,
  },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 16 },
  secureBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  secureBadgeText: { color: colors.textSub, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  captureHint: { color: colors.textSub, fontSize: 12, textAlign: 'center', lineHeight: 17, marginBottom: 16 },
  backLink: { color: colors.textSub, fontSize: 13, fontWeight: '600', marginTop: 14 },
  retakeBtn: { padding: 12, alignItems: 'center', marginTop: 6 },
  retakeBtnText: { color: colors.textSub, fontWeight: '700', fontSize: 13 },
  // Reviewing stage: badge overlaid on the captured still confirming the
  // hold + blink liveness check passed before this photo was taken.
  videoBadge: {
    position: 'absolute', top: 50, left: 20, right: 20,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: 'rgba(15,23,42,0.72)', borderRadius: radius.md, padding: 14,
  },
  videoBadgeIconWrap: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  videoBadgeTitle: { color: '#fff', fontWeight: '800', fontSize: 13 },
  videoBadgeSubtitle: { color: 'rgba(255,255,255,0.8)', fontSize: 11, marginTop: 3 },
  // DoubleSafe lockout panel -- shown instead of the normal Complete/Retake
  // buttons when the server reports too many failed identity-match attempts
  // (see employeeAuthController.linkDevice's 423 response). Stays on the
  // light sheet now, so it uses a softer tint than a dark-background alert would.
  lockPanel: {
    backgroundColor: colors.dangerBg, borderWidth: 1, borderColor: 'rgba(238,93,80,0.35)',
    borderRadius: radius.md, padding: 18, alignItems: 'center', marginBottom: 16, width: '100%',
  },
  lockPanelTitle: { color: colors.dangerText, fontWeight: '800', fontSize: 14, marginBottom: 6 },
  lockPanelText: { color: colors.textMain, fontSize: 12, textAlign: 'center', lineHeight: 17 },
});
