import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Image, ScrollView, Animated, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { makeRedirectUri } from 'expo-auth-session';
import * as Google from 'expo-auth-session/providers/google';
import { useAuth } from '../context/AuthContext';
import { colors, radius, shadow, CSPC_LOGO } from '../theme';
import { API_BASE_URL, ASSET_BASE_URL, GOOGLE_WEB_CLIENT_ID, GOOGLE_IOS_CLIENT_ID, GOOGLE_ANDROID_CLIENT_ID, isGoogleConfigured } from '../config';
import { notify } from '../utils/notify';
import FadeIn from '../components/FadeIn';

WebBrowser.maybeCompleteAuthSession();

// Google rejects the native OAuth redirect in Expo Go (its bundle/package isn't
// ours) and on a platform with no client ID of its own -- iOS showed "Access
// blocked: Authorization Error ... invalid_request". Those sign in through the
// server's /mobile/google-signin page instead, which hands the ID token back
// through the app's redirect URL.
const IS_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
const NATIVE_CLIENT_ID = Platform.OS === 'ios' ? GOOGLE_IOS_CLIENT_ID : Platform.OS === 'android' ? GOOGLE_ANDROID_CLIENT_ID : GOOGLE_WEB_CLIENT_ID;
const USE_WEB_BRIDGE = IS_EXPO_GO || !NATIVE_CLIENT_ID;

// Mirrors the #screen-login → #screen-choice flow from the CSPC GeoAttend web
// prototype, but using real Google Sign-In (expo-auth-session) instead of the
// browser-only Google Identity Services script.
export default function LoginScreen({ navigation }) {
  const { loginWithGoogle, staleSession, deviceBlockedNotice } = useAuth();
  const [authenticating, setAuthenticating] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const btnScale = useRef(new Animated.Value(1)).current;

  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    clientId: GOOGLE_WEB_CLIENT_ID,
    iosClientId: GOOGLE_IOS_CLIENT_ID || undefined,
    androidClientId: GOOGLE_ANDROID_CLIENT_ID || undefined,
  });

  useEffect(() => {
    if (response?.type === 'success') {
      const idToken = response.authentication?.idToken || response.params?.id_token;
      if (idToken) handleGoogleToken(idToken);
      else {
        setAuthenticating(false);
        setErrorMsg('Could not retrieve a Google identity token. Please try again.');
      }
    } else if (response?.type === 'error') {
      setAuthenticating(false);
      setErrorMsg('Google sign-in was cancelled or failed.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  const handleGoogleToken = async (idToken) => {
    setErrorMsg('');
    setAuthenticating(true);
    try {
      const result = await loginWithGoogle(idToken);
      if (!result.matched) {
        // No employee is linked to this Google account yet — proceed to device registration,
        // matching the web prototype's "Register this Device" step.
        navigation.replace('Registration');
      }
      // If matched, RootNavigator swaps to the Dashboard stack automatically.
    } catch (err) {
      if (err.response?.data?.message) {
        // Server reached and rejected the request — show its explanation.
        setErrorMsg(err.response.data.message);
      } else if (err.response) {
        // Something answered, but not our backend (e.g. Render's 404 for a
        // deleted service) — the build points at a stale apiBaseUrl.
        setErrorMsg(`Server at ${API_BASE_URL} responded with HTTP ${err.response.status}. This app build may be pointing at an old server address.`);
      } else if (err.code === 'ECONNABORTED') {
        setErrorMsg('The server took too long to respond (it may be waking up). Please try again in a minute.');
      } else if (err.request) {
        // Google auth succeeded (we have an idToken) but the app couldn't reach
        // the backend at all — no connectivity or a wrong apiBaseUrl.
        setErrorMsg(`Could not reach the server at ${API_BASE_URL}. Check your internet connection and try again.`);
      } else {
        setErrorMsg('Google sign-in failed. Please try again.');
      }
    } finally {
      setAuthenticating(false);
    }
  };

  const handlePress = () => {
    if (!isGoogleConfigured()) {
      notify(
        'Google Sign-In not configured',
        'Set googleWebClientId in mobile/app.json (extra) to the same OAuth Client ID used as GOOGLE_CLIENT_ID on the server.'
      );
      return;
    }
    setErrorMsg('');
    if (USE_WEB_BRIDGE) signInViaWebBridge();
    else promptAsync();
  };

  const signInViaWebBridge = async () => {
    setAuthenticating(true);
    try {
      const redirectUri = makeRedirectUri({ path: 'google-auth' });
      const url = `${ASSET_BASE_URL}/mobile/google-signin?return=${encodeURIComponent(redirectUri)}`;
      const result = await WebBrowser.openAuthSessionAsync(url, redirectUri);
      if (result.type !== 'success') {
        setAuthenticating(false);
        if (result.type !== 'cancel' && result.type !== 'dismiss') setErrorMsg('Google sign-in was cancelled or failed.');
        return;
      }
      const match = /[#&?]id_token=([^&#]+)/.exec(result.url || '');
      if (!match) {
        setAuthenticating(false);
        setErrorMsg('Could not retrieve a Google identity token. Please try again.');
        return;
      }
      await handleGoogleToken(decodeURIComponent(match[1]));
    } catch (e) {
      setAuthenticating(false);
      setErrorMsg(`Could not open Google sign-in at ${ASSET_BASE_URL}. Check your internet connection and try again.`);
    }
  };

  const btnPressIn = () => Animated.spring(btnScale, { toValue: 0.97, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  const btnPressOut = () => Animated.spring(btnScale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 6 }).start();

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ flexGrow: 1 }}>
      {/* Brand section — mirrors .brand-section in the CSPC GeoAttend web prototype */}
      <FadeIn delay={0}>
        <View style={styles.brandSection}>
          <View style={styles.logoContainer}>
            <Image source={CSPC_LOGO} style={styles.logoImage} resizeMode="contain" />
          </View>
          <Text style={styles.brandTitle}>CSPC GeoAttend</Text>
          <Text style={styles.brandSubtitle}>Employee Attendance</Text>
        </View>
      </FadeIn>

      <FadeIn delay={120}>
        <View style={styles.body}>
          <View style={styles.card}>
            {!!deviceBlockedNotice && (
              <View style={styles.blockedBanner}>
                <Ionicons name={deviceBlockedNotice.status === 'removed' ? 'trash-outline' : 'ban-outline'} size={20} color={colors.dangerText} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.blockedTitle}>{deviceBlockedNotice.status === 'removed' ? 'This device was removed' : 'Access blocked on this device'}</Text>
                  <Text style={styles.blockedText}>{deviceBlockedNotice.text}</Text>
                </View>
              </View>
            )}
            <Text style={styles.cardTitle}>Sign in</Text>
            <Text style={styles.cardLead}>Use your official CSPC Google account.</Text>

            <Animated.View style={{ width: '100%', transform: [{ scale: btnScale }] }}>
              <TouchableOpacity
                style={styles.googleBtn}
                onPress={handlePress}
                onPressIn={btnPressIn}
                onPressOut={btnPressOut}
                disabled={(!USE_WEB_BRIDGE && !request) || authenticating}
                activeOpacity={0.85}
              >
                {authenticating ? (
                  <ActivityIndicator color={colors.cspcBlue} />
                ) : (
                  <>
                    <Ionicons name="logo-google" size={20} color="#4285F4" />
                    <Text style={styles.googleBtnText}>Continue with Google</Text>
                  </>
                )}
              </TouchableOpacity>
            </Animated.View>

            {!!errorMsg && errorMsg !== deviceBlockedNotice?.text && <Text style={styles.errorText}>{errorMsg}</Text>}
            {!errorMsg && staleSession && (
              <Text style={styles.errorText}>Your session ended because your account record changed. Please sign in again.</Text>
            )}

            {__DEV__ && !!request?.redirectUri && (
              <TouchableOpacity
                onPress={() =>
                  notify(
                    'Redirect URI (dev only)',
                    request.redirectUri +
                      '\n\nCopy this exactly into Google Cloud Console → your OAuth Client → Authorized redirect URIs.'
                  )
                }
              >
                <Text style={styles.debugText}>DEV: tap to view redirect URI</Text>
              </TouchableOpacity>
            )}
          </View>
          <Text style={styles.secureTag}>Camarines Sur Polytechnic Colleges</Text>
        </View>
      </FadeIn>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  brandSection: {
    backgroundColor: colors.primary,
    paddingTop: 70,
    paddingBottom: 50,
    paddingHorizontal: 24,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    alignItems: 'center',
  },
  logoContainer: {
    width: 85, height: 85, borderRadius: 43,
    backgroundColor: '#fff', padding: 10,
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.5)',
    marginBottom: 16, alignItems: 'center', justifyContent: 'center',
  },
  logoImage: { width: '100%', height: '100%' },
  brandTitle: { color: '#fff', fontSize: 24, fontWeight: '700', letterSpacing: -0.3 },
  brandSubtitle: { color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 4 },
  body: { paddingHorizontal: 20, marginTop: -30 },
  card: {
    backgroundColor: colors.white,
    padding: 24,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    ...shadow,
  },
  cardTitle: { fontSize: 20, fontWeight: '700', color: colors.textMain, marginBottom: 4, letterSpacing: -0.2 },
  cardLead: { color: colors.textSub, fontSize: 14, marginBottom: 22, textAlign: 'center', fontWeight: '500' },
  googleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12,
    backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border,
    paddingVertical: 16, borderRadius: radius.md, width: '100%',
  },
  googleBtnText: { fontWeight: '600', color: colors.textMain, fontSize: 15 },
  blockedBanner: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start', width: '100%',
    backgroundColor: colors.dangerBg, borderRadius: radius.md, padding: 14, marginBottom: 18,
  },
  blockedTitle: { color: colors.dangerText, fontWeight: '700', fontSize: 14, marginBottom: 2 },
  blockedText: { color: colors.dangerText, fontSize: 12, lineHeight: 17 },
  errorText: { color: colors.error, fontSize: 12, marginTop: 12, textAlign: 'center' },
  debugText: { color: colors.textSub, fontSize: 10, marginTop: 14, textAlign: 'center', textDecorationLine: 'underline' },
  secureTag: { textAlign: 'center', color: colors.textSub, fontSize: 11, fontWeight: '600', marginTop: 24, letterSpacing: 0.3 },
});
