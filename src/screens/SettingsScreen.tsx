import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { AppSettings, McpAuthType, McpOAuthConfig, McpServerConfig } from '../types';
import { MODELS, providerFor } from '../lib/models';
import { connectMcpServer, deriveBaseUrl, disconnectMcpServer, getOAuthStatus, OAuthStatus } from '../lib/mcpOAuth';
import { printContent, selectPrinter } from '../lib/print';
import { colors } from '../ui/theme';

const AUTH_TYPES: { id: McpAuthType; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'token', label: 'Static token' },
  { id: 'oauth', label: 'OAuth' },
];

const EMPTY_OAUTH: McpOAuthConfig = {
  authorizationEndpoint: '',
  tokenEndpoint: '',
  clientId: '',
  scopes: [],
};

interface Props {
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  openAiKey: string;
  onOpenAiKeyChange: (key: string) => void;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

export default function SettingsScreen({
  apiKey,
  onApiKeyChange,
  openAiKey,
  onOpenAiKeyChange,
  settings,
  onSettingsChange,
}: Props) {
  const [keyDraft, setKeyDraft] = useState(apiKey);
  const [showKey, setShowKey] = useState(false);
  const [openAiDraft, setOpenAiDraft] = useState(openAiKey);
  const [showOpenAiKey, setShowOpenAiKey] = useState(false);
  const [selectingPrinter, setSelectingPrinter] = useState(false);
  const [testPrinting, setTestPrinting] = useState(false);

  const handleSelectPrinter = async () => {
    setSelectingPrinter(true);
    try {
      const printer = await selectPrinter();
      if (printer) onSettingsChange({ ...settings, printer });
    } catch (e: any) {
      Alert.alert('Printer selection failed', e?.message ?? String(e));
    } finally {
      setSelectingPrinter(false);
    }
  };

  // Prints a trivial known-good text job directly from a button tap, so a failure here isolates
  // the printer/expo-print setup itself from anything specific to PDFs or the scan-triggered path.
  const handleTestPrint = async () => {
    setTestPrinting(true);
    try {
      await printContent(`pimh test print\n${new Date().toString()}`, settings.printer);
      Alert.alert('Sent', 'Test print job sent — check the printer, and check the Metro logs for [print] lines.');
    } catch (e: any) {
      console.error('[print] test print failed:', e);
      Alert.alert('Test print failed', e?.message ?? String(e));
    } finally {
      setTestPrinting(false);
    }
  };

  const updateServer = (id: string, patch: Partial<McpServerConfig>) => {
    onSettingsChange({
      ...settings,
      mcpServers: settings.mcpServers.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  };

  const addServer = () => {
    const id = `mcp-${Date.now()}`;
    onSettingsChange({
      ...settings,
      mcpServers: [
        ...settings.mcpServers,
        { id, name: `server-${settings.mcpServers.length + 1}`, url: '', enabled: false, authType: 'none' },
      ],
    });
  };

  const removeServer = (server: McpServerConfig) => {
    Alert.alert('Remove MCP server', `Remove "${server.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          if (server.authType === 'oauth') disconnectMcpServer(server.id);
          onSettingsChange({
            ...settings,
            mcpServers: settings.mcpServers.filter((s) => s.id !== server.id),
          });
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 12, paddingBottom: 48, gap: 20 }}>
      <View>
        <Text style={styles.sectionTitle}>Claude API key</Text>
        <Text style={styles.helpText}>
          Stored securely on this device (Keychain). Get one at console.anthropic.com.
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="sk-ant-…"
            placeholderTextColor={colors.textDim}
            value={keyDraft}
            onChangeText={setKeyDraft}
            secureTextEntry={!showKey}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.secondaryButton} onPress={() => setShowKey((v) => !v)}>
            <Text style={styles.secondaryButtonText}>{showKey ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={[styles.primaryButton, { marginTop: 8 }]}
          onPress={() => {
            onApiKeyChange(keyDraft.trim());
            Alert.alert('Saved', keyDraft.trim() ? 'API key saved.' : 'API key cleared.');
          }}
        >
          <Text style={styles.primaryButtonText}>Save key</Text>
        </TouchableOpacity>
      </View>

      <View>
        <Text style={styles.sectionTitle}>OpenAI API key</Text>
        <Text style={styles.helpText}>
          Only needed for the GPT models below. Stored securely on this device (Keychain), separately
          from the Claude key. Get one at platform.openai.com.
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="sk-…"
            placeholderTextColor={colors.textDim}
            value={openAiDraft}
            onChangeText={setOpenAiDraft}
            secureTextEntry={!showOpenAiKey}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.secondaryButton} onPress={() => setShowOpenAiKey((v) => !v)}>
            <Text style={styles.secondaryButtonText}>{showOpenAiKey ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={[styles.primaryButton, { marginTop: 8 }]}
          onPress={() => {
            onOpenAiKeyChange(openAiDraft.trim());
            Alert.alert('Saved', openAiDraft.trim() ? 'OpenAI API key saved.' : 'OpenAI API key cleared.');
          }}
        >
          <Text style={styles.primaryButtonText}>Save key</Text>
        </TouchableOpacity>
      </View>

      <View>
        <Text style={styles.sectionTitle}>Model</Text>
        <Text style={styles.helpText}>
          The selected model decides which API a scan is sent to, and which key above
          authenticates it.
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {MODELS.map((m) => (
            <TouchableOpacity
              key={m.id}
              style={[styles.chip, settings.model === m.id && styles.chipActive]}
              onPress={() => onSettingsChange({ ...settings, model: m.id })}
            >
              <Text style={settings.model === m.id ? styles.chipTextActive : styles.chipText}>{m.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View>
        <Text style={styles.sectionTitle}>Display</Text>
        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleLabel}>Show tool calls and raw results</Text>
            <Text style={styles.helpText}>
              When on, tool calls and their raw results appear as 1-line expandable sections below
              the answer. Off by default — most scans just need the final answer.
            </Text>
          </View>
          <Switch
            value={settings.showToolCalls}
            onValueChange={(showToolCalls) => onSettingsChange({ ...settings, showToolCalls })}
            trackColor={{ true: colors.accent }}
          />
        </View>
        <View style={[styles.toggleRow, { marginTop: 14 }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleLabel}>Verbose logging</Text>
            <Text style={styles.helpText}>
              Writes request bodies, resolved parameters and printer details to the developer
              console. Useful when diagnosing a scan; leave off when the app is in general use,
              since those lines include customer and inventory data. Errors are logged either way.
            </Text>
          </View>
          <Switch
            value={settings.debugLogging}
            onValueChange={(debugLogging) => onSettingsChange({ ...settings, debugLogging })}
            trackColor={{ true: colors.accent }}
          />
        </View>
      </View>

      <View>
        <Text style={styles.sectionTitle}>Printer</Text>
        <Text style={styles.helpText}>
          {Platform.OS === 'ios'
            ? 'Contexts whose instructions mention "print" send that scan’s tool call results straight ' +
              'to this printer over WiFi (AirPrint), skipping the picker.'
            : 'Contexts whose instructions mention "print" send that scan’s tool call results to the ' +
              'system print dialog, where you pick a printer each time.'}
        </Text>
        {Platform.OS === 'ios' && (
          <>
            <View style={styles.toggleRow}>
              <Text style={[styles.toggleLabel, { flex: 1 }]}>{settings.printer?.name ?? 'No printer selected'}</Text>
              {settings.printer && (
                <TouchableOpacity onPress={() => onSettingsChange({ ...settings, printer: null })}>
                  <Text style={[styles.linkText, { color: colors.danger }]}>Clear</Text>
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity
              style={[styles.secondaryButton, { marginTop: 8 }]}
              onPress={handleSelectPrinter}
              disabled={selectingPrinter}
            >
              {selectingPrinter ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text style={styles.secondaryButtonText}>{settings.printer ? 'Change printer' : 'Select printer'}</Text>
              )}
            </TouchableOpacity>
          </>
        )}
        <TouchableOpacity
          style={[styles.secondaryButton, { marginTop: 8 }]}
          onPress={handleTestPrint}
          disabled={testPrinting}
        >
          {testPrinting ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={styles.secondaryButtonText}>Test print</Text>
          )}
        </TouchableOpacity>
      </View>

      <View>
        <Text style={styles.sectionTitle}>MCP tool connections</Text>
        <Text style={styles.helpText}>
          Enabled servers are attached to every scan so the selected model can call
          their tools (e.g. ScanPower inventory and listing tools). Most hosted MCP servers require OAuth
          — tap Connect to sign in; the token is refreshed automatically and stored in the device Keychain.
        </Text>
        {settings.mcpServers.map((server) => (
          <McpServerCard
            key={server.id}
            server={server}
            onUpdate={(patch) => updateServer(server.id, patch)}
            onRemove={() => removeServer(server)}
          />
        ))}
        <TouchableOpacity style={[styles.secondaryButton, { marginTop: 8 }]} onPress={addServer}>
          <Text style={styles.secondaryButtonText}>+ Add MCP server</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function McpServerCard({
  server,
  onUpdate,
  onRemove,
}: {
  server: McpServerConfig;
  onUpdate: (patch: Partial<McpServerConfig>) => void;
  onRemove: () => void;
}) {
  const [status, setStatus] = useState<OAuthStatus>({ connected: false });
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const refreshStatus = useCallback(async () => {
    if (server.authType !== 'oauth') return;
    const s = await getOAuthStatus(server.id);
    setStatus(s);
    setStatusLoaded(true);
  }, [server.authType, server.id]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const updateOAuth = (patch: Partial<McpOAuthConfig>) => {
    onUpdate({ oauth: { ...(server.oauth ?? EMPTY_OAUTH), ...patch } });
  };

  // Default the authorization/token URLs to the MCP server's base URL when
  // switching to OAuth (or when the server URL changes) and those fields are
  // still empty. Only fires on those transitions, so it never fights a user
  // who's already typed something into the fields.
  useEffect(() => {
    if (server.authType !== 'oauth') return;
    const base = deriveBaseUrl(server.url);
    if (!base) return;
    const authEmpty = !server.oauth?.authorizationEndpoint;
    const tokenEmpty = !server.oauth?.tokenEndpoint;
    if (authEmpty || tokenEmpty) {
      updateOAuth({
        authorizationEndpoint: authEmpty ? base : server.oauth?.authorizationEndpoint,
        tokenEndpoint: tokenEmpty ? base : server.oauth?.tokenEndpoint,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.authType, server.url]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await connectMcpServer(server);
      await refreshStatus();
      Alert.alert('Connected', `${server.name} is now connected.`);
    } catch (e: any) {
      Alert.alert('Connection failed', e?.message ?? String(e));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    await disconnectMcpServer(server.id);
    await refreshStatus();
  };

  return (
    <View style={styles.serverCard}>
      <View style={styles.serverHeader}>
        <TextInput
          style={[styles.input, styles.serverName]}
          value={server.name}
          onChangeText={(name) => onUpdate({ name: name.replace(/[^a-zA-Z0-9_-]/g, '-') })}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Switch
          value={server.enabled}
          onValueChange={(enabled) => onUpdate({ enabled })}
          trackColor={{ true: colors.accent }}
        />
      </View>
      <TextInput
        style={styles.input}
        placeholder="https://example.com/mcp"
        placeholderTextColor={colors.textDim}
        value={server.url}
        onChangeText={(url) => onUpdate({ url: url.trim() })}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />

      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        {AUTH_TYPES.map((t) => (
          <TouchableOpacity
            key={t.id}
            style={[styles.chip, server.authType === t.id && styles.chipActive]}
            onPress={() => onUpdate({ authType: t.id })}
          >
            <Text style={server.authType === t.id ? styles.chipTextActive : styles.chipText}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {server.authType === 'token' && (
        <TextInput
          style={styles.input}
          placeholder="Authorization token"
          placeholderTextColor={colors.textDim}
          value={server.authorizationToken ?? ''}
          onChangeText={(authorizationToken) => onUpdate({ authorizationToken })}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}

      {server.authType === 'oauth' && (
        <View>
          <TextInput
            style={styles.input}
            placeholder="Authorization URL"
            placeholderTextColor={colors.textDim}
            value={server.oauth?.authorizationEndpoint ?? ''}
            onChangeText={(v) => updateOAuth({ authorizationEndpoint: v.trim() })}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <TextInput
            style={styles.input}
            placeholder="Token URL"
            placeholderTextColor={colors.textDim}
            value={server.oauth?.tokenEndpoint ?? ''}
            onChangeText={(v) => updateOAuth({ tokenEndpoint: v.trim() })}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <TextInput
            style={styles.input}
            placeholder="Client ID"
            placeholderTextColor={colors.textDim}
            value={server.oauth?.clientId ?? ''}
            onChangeText={(v) => updateOAuth({ clientId: v.trim() })}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            placeholder="Client secret (optional — most mobile OAuth doesn't need one)"
            placeholderTextColor={colors.textDim}
            value={server.oauth?.clientSecret ?? ''}
            onChangeText={(v) => updateOAuth({ clientSecret: v })}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            placeholder="Scopes (space-separated, optional)"
            placeholderTextColor={colors.textDim}
            value={(server.oauth?.scopes ?? []).join(' ')}
            onChangeText={(v) => updateOAuth({ scopes: v.split(/\s+/).filter(Boolean) })}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <View style={styles.statusRow}>
            <View style={[styles.statusDot, status.connected ? styles.statusDotOn : styles.statusDotOff]} />
            <Text style={styles.dimText}>
              {!statusLoaded ? 'Checking…' : status.connected ? 'Connected' : 'Not connected'}
            </Text>
          </View>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <TouchableOpacity
              style={[styles.primaryButton, { flex: 1 }]}
              onPress={handleConnect}
              disabled={connecting}
            >
              {connecting ? (
                <ActivityIndicator color={colors.accentText} />
              ) : (
                <Text style={styles.primaryButtonText}>{status.connected ? 'Reconnect' : 'Connect'}</Text>
              )}
            </TouchableOpacity>
            {status.connected && (
              <TouchableOpacity style={styles.secondaryButton} onPress={handleDisconnect}>
                <Text style={styles.secondaryButtonText}>Disconnect</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      <TouchableOpacity onPress={onRemove} style={{ marginTop: 8 }}>
        <Text style={[styles.linkText, { color: colors.danger }]}>Remove server</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: 6 },
  helpText: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleLabel: { color: colors.text, fontSize: 15, marginBottom: 2 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    marginBottom: 8,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  primaryButtonText: { color: colors.accentText, fontWeight: '600' },
  secondaryButton: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryButtonText: { color: colors.text },
  chip: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: 13 },
  chipTextActive: { color: colors.accentText, fontSize: 13, fontWeight: '600' },
  serverCard: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  serverHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  serverName: { flex: 1, marginBottom: 0 },
  linkText: { color: colors.accent, fontSize: 13 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusDotOn: { backgroundColor: colors.success },
  statusDotOff: { backgroundColor: colors.textDim },
  dimText: { color: colors.textDim, fontSize: 12 },
});
