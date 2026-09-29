import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius } from '../theme';

const ITEMS = [
  { key: 'Dashboard', label: 'Home', icon: 'home-outline', iconActive: 'home' },
  { key: 'History', label: 'Logs', icon: 'time-outline', iconActive: 'time' },
  { key: 'Profile', label: 'Profile', icon: 'person-outline', iconActive: 'person' },
];

// Bottom tab bar rendered inside each main screen (Home / Logs / Profile).
// The active tab gets a tinted pill behind a filled icon; the others stay
// as quiet outline icons.
export default function BottomNav({ active, navigation }) {
  return (
    <View style={styles.nav}>
      {ITEMS.map((item) => {
        const isActive = item.key === active;
        return (
          <TouchableOpacity
            key={item.key}
            style={styles.navItem}
            onPress={() => navigation.navigate(item.key, undefined, { pop: true })}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={item.label}
          >
            <View style={[styles.iconPill, isActive && styles.iconPillActive]}>
              <Ionicons
                name={isActive ? item.iconActive : item.icon}
                size={21}
                color={isActive ? colors.primary : colors.textSub}
              />
            </View>
            <Text style={[styles.label, isActive && styles.labelActive]}>{item.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  nav: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 8,
    paddingBottom: 20,
    paddingHorizontal: 12,
  },
  navItem: { flex: 1, alignItems: 'center', gap: 3 },
  iconPill: {
    width: 56, height: 30, borderRadius: radius.pill,
    alignItems: 'center', justifyContent: 'center',
  },
  iconPillActive: { backgroundColor: colors.primaryLight },
  label: { fontSize: 11, fontWeight: '600', color: colors.textSub },
  labelActive: { color: colors.primary, fontWeight: '700' },
});
