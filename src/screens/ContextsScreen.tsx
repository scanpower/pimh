import React, { useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { ContextNote } from '../types';
import { parseImportedContexts } from '../lib/storage';
import { colors } from '../ui/theme';

interface Props {
  contexts: ContextNote[];
  onChange: (contexts: ContextNote[]) => void;
}

interface Draft {
  id: string | null; // null = new note
  name: string;
  instructions: string;
}

export default function ContextsScreen({ contexts, onChange }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);

  const setActive = (id: string) => {
    onChange(contexts.map((c) => ({ ...c, active: c.id === id })));
  };

  const remove = (note: ContextNote) => {
    Alert.alert('Delete context', `Delete "${note.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => onChange(contexts.filter((c) => c.id !== note.id)),
      },
    ]);
  };

  const saveDraft = () => {
    if (!draft) return;
    const name = draft.name.trim() || 'Untitled';
    const now = Date.now();
    if (draft.id) {
      onChange(
        contexts.map((c) =>
          c.id === draft.id ? { ...c, name, instructions: draft.instructions, updatedAt: now } : c,
        ),
      );
    } else {
      const note: ContextNote = {
        id: `ctx-${now}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        instructions: draft.instructions,
        active: contexts.length === 0,
        createdAt: now,
        updatedAt: now,
      };
      onChange([...contexts, note]);
    }
    setDraft(null);
  };

  const importNotes = (json: string, sourceLabel: string) => {
    try {
      const items = parseImportedContexts(json);
      const now = Date.now();
      const imported: ContextNote[] = items.map((item, i) => ({
        ...item,
        id: `ctx-${now}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        active: false,
        createdAt: now,
        updatedAt: now,
      }));
      onChange([...contexts, ...imported]);
      Alert.alert('Imported', `Added ${imported.length} context note(s) from ${sourceLabel}.`);
    } catch (e: any) {
      Alert.alert(
        'Import failed',
        `${e?.message ?? e}\n\nExpected JSON like:\n[{"name": "...", "instructions": "..."}]`,
      );
    }
  };

  const importFromClipboard = async () => {
    const text = await Clipboard.getStringAsync();
    if (!text.trim()) {
      Alert.alert('Clipboard empty', 'Copy a JSON array of context notes first.');
      return;
    }
    importNotes(text, 'clipboard');
  };

  const importFromFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/json', 'text/plain'],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    try {
      const text = await new File(result.assets[0].uri).text();
      importNotes(text, result.assets[0].name);
    } catch (e: any) {
      Alert.alert('Import failed', e?.message ?? String(e));
    }
  };

  const exportToClipboard = async () => {
    const payload = contexts.map(({ name, instructions }) => ({ name, instructions }));
    await Clipboard.setStringAsync(JSON.stringify(payload, null, 2));
    Alert.alert('Exported', 'All context notes copied to clipboard as JSON.');
  };

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => setDraft({ id: null, name: '', instructions: '' })}
        >
          <Text style={styles.primaryButtonText}>+ New</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={importFromClipboard}>
          <Text style={styles.secondaryButtonText}>Paste JSON</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={importFromFile}>
          <Text style={styles.secondaryButtonText}>Import file</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={exportToClipboard}>
          <Text style={styles.secondaryButtonText}>Export</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={contexts}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ padding: 12, gap: 10 }}
        ListEmptyComponent={
          <Text style={[styles.dimText, { textAlign: 'center', marginTop: 32 }]}>
            No context notes yet. Create one — it drives what Claude does when you scan.
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.card, item.active && styles.cardActive]}
            onPress={() => setActive(item.id)}
            onLongPress={() => setDraft({ id: item.id, name: item.name, instructions: item.instructions })}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>
                {item.active ? '● ' : '○ '}
                {item.name}
              </Text>
              <View style={{ flexDirection: 'row', gap: 14 }}>
                <TouchableOpacity
                  onPress={() => setDraft({ id: item.id, name: item.name, instructions: item.instructions })}
                >
                  <Text style={styles.linkText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => remove(item)}>
                  <Text style={[styles.linkText, { color: colors.danger }]}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
            <Text style={styles.cardBody} numberOfLines={3}>
              {item.instructions}
            </Text>
          </TouchableOpacity>
        )}
      />
      <Text style={[styles.dimText, styles.hint]}>
        Tap a note to make it active. The active note is sent to Claude as instructions with every scan.
      </Text>

      <Modal visible={draft !== null} animationType="slide" onRequestClose={() => setDraft(null)}>
        <KeyboardAvoidingView
          style={styles.modal}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Text style={styles.modalTitle}>{draft?.id ? 'Edit context' : 'New context'}</Text>
          <TextInput
            style={styles.input}
            placeholder="Name"
            placeholderTextColor={colors.textDim}
            value={draft?.name ?? ''}
            onChangeText={(name) => setDraft((d) => (d ? { ...d, name } : d))}
          />
          <TextInput
            style={[styles.input, styles.multiline]}
            placeholder="Instructions for Claude — what should happen when a barcode is scanned?"
            placeholderTextColor={colors.textDim}
            value={draft?.instructions ?? ''}
            onChangeText={(instructions) => setDraft((d) => (d ? { ...d, instructions } : d))}
            multiline
            textAlignVertical="top"
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity style={[styles.secondaryButton, { flex: 1 }]} onPress={() => setDraft(null)}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.primaryButton, { flex: 1 }]} onPress={saveDraft}>
              <Text style={styles.primaryButtonText}>Save</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  toolbar: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: 'center',
  },
  primaryButtonText: { color: colors.accentText, fontWeight: '600' },
  secondaryButton: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    alignItems: 'center',
  },
  secondaryButtonText: { color: colors.text },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  cardActive: { borderColor: colors.accent },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  cardTitle: { color: colors.text, fontWeight: '600', fontSize: 15, flex: 1, marginRight: 8 },
  cardBody: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  linkText: { color: colors.accent, fontSize: 13 },
  hint: { padding: 12, fontSize: 12, textAlign: 'center' },
  modal: { flex: 1, backgroundColor: colors.bg, padding: 16, paddingTop: 64, gap: 12 },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
  },
  multiline: { flex: 1, minHeight: 160 },
  dimText: { color: colors.textDim },
});
