import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, RefreshControl } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { getGeofences } from '../api/client';
import { colors, radius, shadow, shadowLg, type } from '../theme';
import BottomNav from '../components/BottomNav';
import StatusPill from '../components/StatusPill';
import ScheduleMapModal from '../components/ScheduleMapModal';
import FadeIn from '../components/FadeIn';
import Skeleton from '../components/Skeleton';
import AppHeader from '../components/AppHeader';
import { scheduleTodayEventReminders } from '../utils/eventReminders';

function isToday(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

function fmtTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtShortDate(dateStr) {
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function DashboardScreen({ navigation }) {
  const { employee } = useAuth();
  const [geofences, setGeofences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedSchedule, setSelectedSchedule] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await getGeofences();
      setGeofences(res.data || []);
    } catch (err) {
      // Non-fatal — dashboard still renders with empty schedule.
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Re-fetch whenever the Dashboard comes back into focus (e.g. returning from
  // Attendance/History/Profile), and poll every 30s while it stays visible, so a
  // newly admin-created event/geofence shows up without needing an app restart.
  useFocusEffect(
    useCallback(() => {
      load();
      const interval = setInterval(load, 30000);
      return () => clearInterval(interval);
    }, [load])
  );

  const activeEvent = geofences.find((g) => g.computed_status === 'active');
  const todaySchedule = geofences.filter((g) => g.computed_status !== 'expired' && isToday(g.start_datetime));
  const upcoming = geofences.filter((g) => g.computed_status === 'upcoming' && !isToday(g.start_datetime));

  // Reminds the employee about today's event(s) — a "starting soon" local
  // notification ahead of time, or a "happening now" nudge if it's already
  // active — so they don't need to have the app open to be reminded.
  useEffect(() => {
    if (todaySchedule.length) scheduleTodayEventReminders(todaySchedule);
  }, [todaySchedule]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstName = (employee?.full_name || 'User').split(' ')[0];

  return (
    <View style={styles.flex}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ padding: 20, paddingBottom: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        <FadeIn>
          <AppHeader />
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.welcome}>Welcome, {firstName}</Text>
              <View style={styles.geoStatusRow}>
                <View style={[styles.statusDot, { backgroundColor: loading ? colors.warning : activeEvent ? colors.success : colors.textSub }]} />
                <Text style={styles.geoStatus}>
                  {loading ? 'Checking events…' : activeEvent ? 'An event is happening now' : 'No active event right now'}
                </Text>
              </View>
            </View>
            <TouchableOpacity style={styles.avatarBtn} onPress={() => navigation.navigate('Profile', undefined, { pop: true })} activeOpacity={0.75}>
              <Ionicons name="person-outline" size={20} color={colors.primary} />
            </TouchableOpacity>
          </View>
        </FadeIn>

        {/* Active check-in card — indigo brand card mirroring the admin dashboard's stat/hero cards */}
        <FadeIn delay={60}>
          <View style={styles.attendanceCard}>
            <View style={styles.attendanceTopRow}>
              <Text style={styles.attendanceLabel}>Ongoing Now</Text>
              {activeEvent && (
                <View style={styles.liveBadge}>
                  <View style={styles.liveDot} />
                  <Text style={styles.liveBadgeText}>Live</Text>
                </View>
              )}
            </View>
            <Text style={styles.attendanceEventName}>{activeEvent ? activeEvent.title : 'No active event'}</Text>
            <View style={styles.venueRow}>
              <Ionicons name="location-outline" size={14} color="rgba(255,255,255,0.8)" />
              <Text style={styles.attendanceVenue}>{activeEvent ? (activeEvent.venue || '--') : '--'}</Text>
            </View>
            <TouchableOpacity
              style={[styles.btnPrimaryOnCard, !activeEvent && styles.btnDisabled]}
              disabled={!activeEvent}
              activeOpacity={0.85}
              onPress={() => navigation.navigate('Attendance', activeEvent ? { geofenceId: activeEvent.id } : undefined, { pop: true })}
            >
              {activeEvent && <Ionicons name="finger-print-outline" size={18} color={colors.primary} />}
              <Text style={styles.btnPrimaryOnCardText}>{activeEvent ? 'Mark Attendance' : 'No Active Event'}</Text>
            </TouchableOpacity>
          </View>
        </FadeIn>

        <Text style={styles.sectionTitle}>Today's Schedule</Text>
        {loading ? (
          <Skeleton rows={2} />
        ) : (
          <FadeIn delay={100}>
            <View style={styles.listCard}>
              {todaySchedule.length === 0 && <Text style={styles.emptyText}>No events scheduled today.</Text>}
              {todaySchedule.map((g, i) => (
                <TouchableOpacity
                  key={g.id}
                  style={[styles.eventItem, i === todaySchedule.length - 1 && styles.eventItemLast]}
                  onPress={() => navigation.navigate('Attendance', { geofenceId: g.id }, { pop: true })}
                  activeOpacity={0.6}
                >
                  <View style={styles.eventIconWrap}>
                    <Ionicons name="calendar-outline" size={18} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.eventTitle}>{g.title}</Text>
                    <Text style={styles.eventMeta}>{fmtTime(g.start_datetime)} • {g.venue || 'TBA'}</Text>
                  </View>
                  <StatusPill
                    label={g.computed_status === 'active' ? 'Ongoing' : 'Soon'}
                    variant={g.computed_status === 'active' ? 'success' : 'soon'}
                  />
                  <Ionicons name="chevron-forward" size={18} color={colors.textSub} />
                </TouchableOpacity>
              ))}
            </View>
          </FadeIn>
        )}

        <Text style={styles.sectionTitle}>Upcoming Schedule</Text>
        {loading ? (
          <Skeleton rows={2} style={{ marginBottom: 20 }} />
        ) : (
          <FadeIn delay={150}>
            <View style={[styles.listCard, { marginBottom: 20 }]}>
              {upcoming.length === 0 && <Text style={styles.emptyText}>No upcoming events.</Text>}
              {upcoming.map((g, i) => (
                <TouchableOpacity
                  key={g.id}
                  style={[styles.eventItem, i === upcoming.length - 1 && styles.eventItemLast]}
                  onPress={() => setSelectedSchedule(g)}
                  activeOpacity={0.6}
                >
                  <View style={styles.eventIconWrap}>
                    <Ionicons name="calendar-clear-outline" size={18} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.eventTitle}>{g.title}</Text>
                    <Text style={styles.eventMeta}>{fmtShortDate(g.start_datetime)} • {g.venue || 'TBA'}</Text>
                  </View>
                  <StatusPill label="Next" />
                  <Ionicons name="chevron-forward" size={18} color={colors.textSub} />
                </TouchableOpacity>
              ))}
            </View>
          </FadeIn>
        )}
      </ScrollView>

      <ScheduleMapModal
        visible={!!selectedSchedule}
        schedule={selectedSchedule}
        onClose={() => setSelectedSchedule(null)}
      />

      <BottomNav active="Dashboard" navigation={navigation} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  welcome: { ...type.title },
  geoStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  geoStatus: { ...type.caption },
  avatarBtn: {
    width: 44, height: 44, borderRadius: radius.pill, backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
  },
  attendanceCard: {
    backgroundColor: colors.primary,
    borderRadius: radius.xl,
    padding: 22,
    marginBottom: 8,
    ...shadowLg,
  },
  attendanceTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  attendanceLabel: { fontSize: 11, fontWeight: '700', color: 'rgba(255,255,255,0.7)', letterSpacing: 0.8, textTransform: 'uppercase' },
  liveBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.16)',
    paddingVertical: 4, paddingHorizontal: 10, borderRadius: radius.pill,
  },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success },
  liveBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  attendanceEventName: { color: '#fff', fontSize: 20, fontWeight: '700', marginTop: 8, marginBottom: 6, letterSpacing: -0.3 },
  venueRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  attendanceVenue: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '500' },
  btnPrimaryOnCard: {
    flexDirection: 'row', gap: 8, backgroundColor: '#fff', borderRadius: radius.md,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: 18,
  },
  btnDisabled: { opacity: 0.55 },
  btnPrimaryOnCardText: { color: colors.primary, fontWeight: '700', fontSize: 15 },
  sectionTitle: { ...type.overline, marginTop: 24, marginBottom: 10, marginLeft: 2 },
  listCard: {
    backgroundColor: colors.white, borderRadius: radius.lg, paddingHorizontal: 14,
    borderWidth: 1, borderColor: colors.border, ...shadow,
  },
  eventItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 12 },
  eventItemLast: { borderBottomWidth: 0 },
  eventIconWrap: {
    width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
  },
  eventTitle: { fontSize: 14, color: colors.textMain, fontWeight: '600' },
  eventMeta: { ...type.caption, marginTop: 2 },
  emptyText: { ...type.caption, paddingVertical: 20, textAlign: 'center' },
});
