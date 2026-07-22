import React, { useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { AppSettings, McpServerConfig } from '../types';
import { colors } from '../ui/theme';

const MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];

interface Props {
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

export default function SettingsScreen({ apiKey, onApiKeyChange, settings, onSettingsChange }: Props) {
  const [keyDraft, setKeyDraft] = useState(apiKey);
  const [showKey, setShowKey] = useState(false);

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
        { id, name: `server-${settings.mcpServers.length + 1}`, url: '', authorizationToken: '', enabled: false },
      ],
    });
  };

  const removeServer = (server: McpServerConfig) => {
    Alert.alert('Remove MCP server', `Remove "${server.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          onSettingsChange({
            ...settings,
            mcpServers: settings.mcpServers.filter((s) => s.id !== server.id),
          }),
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
        <Text style={styles.sectionTitle}>Model</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {MODELS.map((m) => (
            <TouchableOpacity
              key={m}
              style={[styles.chip, settings.model === m && styles.chipActive]}
              onPress={() => onSettingsChange({ ...settings, model: m })}
            >
              <Text style={settings.model === m ? styles.chipTextActive : styles.chipText}>{m}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View>
        <Text style={styles.sectionTitle}>MCP tool connections</Text>
        <Text style={styles.helpText}>
          Enabled servers are attached to every scan via the Claude API MCP connector, so Claude can call
          their tools (e.g. ScanPower inventory and listing tools). Most hosted MCP servers need an OAuth
          bearer token, not a plain API key.
        </Text>
        {settings.mcpServers.map((server) => (
          <View key={server.id} style={styles.serverCard}>
            <View style={styles.serverHeader}>
              <TextInput
                style={[styles.input, styles.serverName]}
                value={server.name}
                onChangeText={(name) =>
                  updateServer(server.id, { name: name.replace(/[^a-zA-Z0-9_-]/g, '-') })
                }
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Switch
                value={server.enabled}
                onValueChange={(enabled) => updateServer(server.id, { enabled })}
                trackColor={{ true: colors.accent }}
              />
            </View>
            <TextInput
              style={styles.input}
              placeholder="https://example.com/mcp"
              placeholderTextColor={colors.textDim}
              value={server.url}
              onChangeText={(url) => updateServer(server.id, { url: url.trim() })}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <TextInput
              style={styles.input}
              placeholder="Authorization token (optional)"
              placeholderTextColor={colors.textDim}
              value={server.authorizationToken ?? ''}
              onChangeText={(authorizationToken) => updateServer(server.id, { authorizationToken })}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity onPress={() => removeServer(server)}>
              <Text style={[styles.linkText, { color: colors.danger }]}>Remove server</Text>
            </TouchableOpacity>
          </View>
        ))}
        <TouchableOpacity style={[styles.secondaryButton, { marginTop: 8 }]} onPress={addServer}>
          <Text style={styles.secondaryButtonText}>+ Add MCP server</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: 6 },
  helpText: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginBottom: 10 },
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
  serverHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  serverName: { flex: 1 },
  linkText: { color: colors.accent, fontSize: 13 },
});
