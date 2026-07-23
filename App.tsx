import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import ScanScreen from './src/screens/ScanScreen';
import ContextsScreen from './src/screens/ContextsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import {
  DEFAULT_SETTINGS,
  loadApiKey,
  loadContexts,
  loadSettings,
  saveApiKey,
  saveContexts,
  saveSettings,
} from './src/lib/storage';
import { AppSettings, ContextNote } from './src/types';
import { colors } from './src/ui/theme';

type Tab = 'scan' | 'contexts' | 'settings';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'scan', label: 'Scan', icon: '▣' },
  { id: 'contexts', label: 'Contexts', icon: '≡' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

/**
 * Pulses opacity while `active`, to show "Claude" is working without a separate spinner row.
 * Wraps children in an Animated.View rather than animating a nested Animated.Text directly —
 * an Animated.Text nested inside a plain Text (an inline text span) doesn't reliably re-animate
 * on every frame, so it reads as a single flash rather than a continuous pulse.
 */
function ShimmerText({ active, style, children }: { active: boolean; style?: any; children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!active) {
      opacity.stopAnimation();
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.25, duration: 500, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, opacity]);

  return (
    <Animated.View style={{ opacity }}>
      <Text style={style}>{children}</Text>
    </Animated.View>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('scan');
  const [loaded, setLoaded] = useState(false);
  const [contexts, setContexts] = useState<ContextNote[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [apiKey, setApiKey] = useState('');
  const [scanResetSignal, setScanResetSignal] = useState(0);
  const [claudeRunning, setClaudeRunning] = useState(false);

  const handleTabPress = (id: Tab) => {
    if (id === 'scan' && tab === 'scan') {
      // Already on Scan — tapping it again acts like the "Scan again" button.
      setScanResetSignal((n) => n + 1);
    }
    setTab(id);
  };

  useEffect(() => {
    (async () => {
      const [ctx, s, key] = await Promise.all([loadContexts(), loadSettings(), loadApiKey()]);
      setContexts(ctx);
      setSettings(s);
      setApiKey(key);
      setLoaded(true);
    })();
  }, []);

  const handleContextsChange = useCallback((next: ContextNote[]) => {
    setContexts(next);
    saveContexts(next);
  }, []);

  const handleSettingsChange = useCallback((next: AppSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const handleApiKeyChange = useCallback((key: string) => {
    setApiKey(key);
    saveApiKey(key);
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>pimh</Text>
        <View style={styles.headerSubRow}>
          <Text style={styles.headerSub}>scan → context → </Text>
          <ShimmerText active={claudeRunning} style={[styles.headerSub, styles.headerSubClaude]}>
            Claude
          </ShimmerText>
        </View>
      </View>
      <View style={{ flex: 1 }}>
        {!loaded ? null : tab === 'scan' ? (
          <ScanScreen
            apiKey={apiKey}
            settings={settings}
            contexts={contexts}
            onContextsChange={handleContextsChange}
            resetSignal={scanResetSignal}
            onRunningChange={setClaudeRunning}
          />
        ) : tab === 'contexts' ? (
          <ContextsScreen contexts={contexts} onChange={handleContextsChange} />
        ) : (
          <SettingsScreen
            apiKey={apiKey}
            onApiKeyChange={handleApiKeyChange}
            settings={settings}
            onSettingsChange={handleSettingsChange}
          />
        )}
      </View>
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.id} style={styles.tabButton} onPress={() => handleTabPress(t.id)}>
            <Text style={[styles.tabIcon, tab === t.id && styles.tabActive]}>{t.icon}</Text>
            <Text style={[styles.tabLabel, tab === t.id && styles.tabActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  headerSubRow: { flexDirection: 'row', alignItems: 'baseline' },
  headerSub: { color: colors.textDim, fontSize: 12 },
  headerSubClaude: { color: colors.claude, fontWeight: '600' },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  tabButton: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  tabIcon: { color: colors.textDim, fontSize: 18 },
  tabLabel: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  tabActive: { color: colors.accent },
});
