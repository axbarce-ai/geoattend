import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, Platform, Linking
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { checkOfficeNetwork } from '../api/client';
import { colors, radius, shadow } from '../theme';
import { notify } from '../utils/notify';
import { useAuth } from '../context/AuthContext';

// Runs right after Google login / device registration, before the Dashboard is
// reached (see App.js — this is the only screen in the authenticated stack
// until it's satisfied). It confirms the phone is on the office's internet
// connection, used as a second signal (alongside GPS geofencing in
// AttendanceScreen) that the user is physically on site. Once confirmed, it
// calls markWifiVerified() (AuthContext) rather than navigating anywhere
// itself — App.js's RootNavigator reacts to that state and swaps this screen
// out for the Dashboard stack on its own.
//
// The check is done by the SERVER from the connection's public IP (see
// services/networkService.js), not from the Wi-Fi name: the main router and
// every extender / repeater / secondary router on the same provider line
// share that public IP, so the employee can join whichever one has signal,
// whatever its SSID. Mobile data has a different IP and won't pass.
export default function WifiCheckScreen() {
  const { markWifiVerified } = useAuth();
  const [phase, setPhase] = useState('checking'); // checking | matched | mismatch | error
  const [currentIp, setCurrentIp] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  const checkNetwork = useCallback(async () => {
    setPhase('checking');
    setErrorMsg('');
    try {
      const res = await checkOfficeNetwork();
      setCurrentIp(res.data?.ip || null);
      if (res.data?.allowed) {
        setPhase('matched');
        notify('Connected', 'You are on the office network.', [
          { text: 'Continue', onPress: () => markWifiVerified() }
        ]);
      } else {
        setPhase('mismatch');
      }
    } catch (e) {
      const status = e.response?.status;
      setErrorMsg(
        !e.response
          ? 'Could not reach the server. Check that you are connected to the internet.'
          : e.response.data?.message
            || (status >= 500
              ? `The server is unavailable right now (error ${status}). Try again in a few minutes.`
              : `Could not verify your network (error ${status}).`)
      );
      setPhase('error');
    }
  }, [markWifiVerified]);

  useEffect(() => {
    checkNetwork();
  }, [checkNetwork]);

  const openWifiSettings = () => {
    if (Platform.OS === 'android') {
      Linking.sendIntent('android.settings.WIFI_SETTINGS').catch(() => Linking.openSettings());
    } else {
      Linking.openSettings();
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, flexGrow: 1, justifyContent: 'center' }}>
      <View style={styles.card}>
        <View style={styles.heroIcon}>
          <Ionicons name="wifi" size={28} color={colors.primary} />
        </View>
        <Text style={styles.title}>Verifying Location Network</Text>
        <Text style={styles.subtitle}>
          To confirm you're within the designated area, connect to the office Wi-Fi. Any router, extender or repeater on the office internet connection works.
        </Text>

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Your network IP</Text>
          <Text style={styles.infoValue}>{currentIp || '—'}</Text>
        </View>

        {phase === 'checking' && (
          <View style={styles.centerRow}>
            <ActivityIndicator color={colors.cspcBlue} />
            <Text style={styles.statusText}>Checking network…</Text>
          </View>
        )}

        {phase === 'matched' && (
          <View style={[styles.statusBanner, { backgroundColor: colors.successBg }]}>
            <View style={styles.bannerRow}>
              <Ionicons name="checkmark-circle" size={18} color={colors.successText} />
              <Text style={[styles.statusBannerText, { color: colors.successText }]}>Connected to the office network</Text>
            </View>
          </View>
        )}

        {phase === 'mismatch' && (
          <View style={[styles.statusBanner, { backgroundColor: '#FEE2E2' }]}>
            <Text style={[styles.statusBannerText, { color: colors.error }]}>
              You're not on the office network. Connect to the office Wi-Fi (not mobile data), then recheck.
            </Text>
          </View>
        )}

        {!!errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}

        {(phase === 'mismatch' || phase === 'error') && (
          <>
            <TouchableOpacity style={styles.btnGold} onPress={openWifiSettings}>
              <Text style={styles.btnGoldText}>Open Wi-Fi Settings</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnOutline} onPress={checkNetwork}>
              <Text style={styles.btnOutlineText}>I've connected, check again</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: 22,
    borderWidth: 1, borderColor: colors.border, ...shadow,
  },
  heroIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 14 },
  bannerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  title: { fontSize: 19, fontWeight: '700', color: colors.textMain, textAlign: 'center', letterSpacing: -0.2 },
  subtitle: { color: colors.textSub, fontSize: 13, textAlign: 'center', marginTop: 8, marginBottom: 18, lineHeight: 18 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  infoLabel: { fontSize: 11, color: colors.textSub, fontWeight: '700', textTransform: 'uppercase' },
  infoValue: { fontSize: 13, color: colors.textMain, fontWeight: '700' },
  centerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 20 },
  statusText: { color: colors.textSub, fontSize: 13 },
  statusBanner: { borderRadius: radius.sm, padding: 14, marginTop: 16 },
  statusBannerText: { fontWeight: '700', fontSize: 13, textAlign: 'center' },
  errorText: { color: colors.error, fontSize: 12, marginTop: 10, textAlign: 'center' },
  btnGold: { backgroundColor: colors.primary, borderRadius: radius.md, padding: 14, alignItems: 'center', marginTop: 16, ...shadow, shadowColor: colors.primary, shadowOpacity: 0.3 },
  btnGoldText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  btnOutline: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, alignItems: 'center', marginTop: 12 },
  btnOutlineText: { color: colors.primary, fontWeight: '700', fontSize: 14 },
});
