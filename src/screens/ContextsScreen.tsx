import React, { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { ContextNote, ContextPromptField } from '../types';
import { parseImportedContexts } from '../lib/storage';
import { autoFilledHeaders, listAllOperations } from '../lib/apiSpecs';
import { buildDefaultBodyTemplate, buildDefaultParamValues } from '../lib/apiDefaults';
import { colors } from '../ui/theme';

interface Props {
  contexts: ContextNote[];
  onChange: (contexts: ContextNote[]) => void;
}

interface Draft {
  id: string | null; // null = new note
  name: string;
  instructions: string;
  promptFields: ContextPromptField[];
  apiOperation?: ContextNote['apiOperation'];
}

function draftFromNote(item: ContextNote): Draft {
  return {
    id: item.id,
    name: item.name,
    instructions: item.instructions,
    promptFields: item.promptFields ?? [],
    apiOperation: item.apiOperation,
  };
}

function nextFieldId(existing: string[]): string {
  let n = existing.length + 1;
  let id = `field_${n}`;
  while (existing.includes(id)) {
    n++;
    id = `field_${n}`;
  }
  return id;
}

export default function ContextsScreen({ contexts, onChange }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const editingNote = draft?.id ? contexts.find((c) => c.id === draft.id) : null;
  const isEditingMemory = !!editingNote?.isMemory;
  const allOperations = useMemo(() => listAllOperations(), []);
  const selectedOp = draft?.apiOperation
    ? allOperations.find(
        (o) => o.specId === draft.apiOperation!.specId && o.operationId === draft.apiOperation!.operationId,
      )
    : undefined;

  const updateApiOperation = (patch: Partial<NonNullable<Draft['apiOperation']>>) => {
    setDraft((d) => (d && d.apiOperation ? { ...d, apiOperation: { ...d.apiOperation, ...patch } } : d));
  };

  // Memory has no "active" concept, so tapping it expands the card in place to
  // show its full contents instead of activating or jumping into edit mode.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Memory always sorts to the top of the list, regardless of storage order.
  const sortedContexts = useMemo(
    () => [...contexts].sort((a, b) => Number(!!b.isMemory) - Number(!!a.isMemory)),
    [contexts],
  );

  const setActive = (id: string) => {
    onChange(contexts.map((c) => ({ ...c, active: c.id === id })));
  };

  const remove = (note: ContextNote) => {
    if (note.isMemory) return; // Memory is app-managed and can't be deleted, only cleared.
    Alert.alert('Delete context', `Delete "${note.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => onChange(contexts.filter((c) => c.id !== note.id)),
      },
    ]);
  };

  const clearMemory = (note: ContextNote) => {
    Alert.alert('Clear memory', 'Erase everything remembered from previous scans?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () =>
          onChange(contexts.map((c) => (c.id === note.id ? { ...c, instructions: '', updatedAt: Date.now() } : c))),
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
          c.id === draft.id
            ? {
                ...c,
                name,
                instructions: draft.instructions,
                promptFields: draft.promptFields,
                apiOperation: draft.apiOperation,
                updatedAt: now,
              }
            : c,
        ),
      );
    } else {
      const note: ContextNote = {
        id: `ctx-${now}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        promptFields: draft.promptFields,
        apiOperation: draft.apiOperation,
        instructions: draft.instructions,
        // Memory always exists but is never "active" in the persona sense, so
        // check for a real active note rather than an empty list.
        active: !contexts.some((c) => c.active && !c.isMemory),
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

  const addField = () => {
    setDraft((d) => {
      if (!d) return d;
      const id = nextFieldId(d.promptFields.map((f) => f.id));
      return { ...d, promptFields: [...d.promptFields, { id, label: '', type: 'text' }] };
    });
  };

  const updateField = (idx: number, patch: Partial<ContextPromptField>) => {
    setDraft((d) => (d ? { ...d, promptFields: d.promptFields.map((f, i) => (i === idx ? { ...f, ...patch } : f)) } : d));
  };

  const removeField = (idx: number) => {
    setDraft((d) => (d ? { ...d, promptFields: d.promptFields.filter((_, i) => i !== idx) } : d));
  };

  const exportToClipboard = async () => {
    // Memory is app-managed and auto-repopulates — exporting it would just
    // create a confusing duplicate "Memory" note (without the flag) on import.
    const payload = contexts.filter((c) => !c.isMemory).map(({ name, instructions }) => ({ name, instructions }));
    await Clipboard.setStringAsync(JSON.stringify(payload, null, 2));
    Alert.alert('Exported', 'All context notes copied to clipboard as JSON.');
  };

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => setDraft({ id: null, name: '', instructions: '', promptFields: [] })}
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
        style={styles.list}
        data={sortedContexts}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ padding: 12, gap: 10 }}
        ListEmptyComponent={
          <Text style={[styles.dimText, { textAlign: 'center', marginTop: 32 }]}>
            No context notes yet. Create one — it drives what happens when you scan.
          </Text>
        }
        ListFooterComponent={
          sortedContexts.length > 0 ? (
            <Text style={[styles.dimText, styles.hint]}>
              Tap a note to make it active. The active note is sent to the model as instructions with every scan.
              {'\n'}Memory is included automatically and updates itself from tool call results — tap it to expand
              and see what's remembered.
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.card, item.active && styles.cardActive]}
            onPress={() => (item.isMemory ? toggleExpand(item.id) : setActive(item.id))}
            onLongPress={() => setDraft(draftFromNote(item))}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>
                {item.isMemory ? '🧠 ' : item.active ? '● ' : '○ '}
                {item.name}
              </Text>
              <View style={{ flexDirection: 'row', gap: 14 }}>
                <TouchableOpacity
                  onPress={() => setDraft(draftFromNote(item))}
                >
                  <Text style={styles.linkText}>Edit</Text>
                </TouchableOpacity>
                {!item.isMemory && (
                  <TouchableOpacity onPress={() => remove(item)}>
                    <Text style={[styles.linkText, { color: colors.danger }]}>Delete</Text>
                  </TouchableOpacity>
                )}
                {item.isMemory && (
                  <TouchableOpacity onPress={() => clearMemory(item)}>
                    <Text style={styles.linkText}>Clear</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
            <Text style={styles.cardBody} numberOfLines={expandedIds.has(item.id) ? undefined : 3}>
              {item.instructions ||
                (item.isMemory ? 'No memory yet — auto-populated from tool call results after scans.' : '')}
            </Text>
          </TouchableOpacity>
        )}
      />

      <Modal visible={draft !== null} animationType="slide" onRequestClose={() => setDraft(null)}>
        <KeyboardAvoidingView
          style={styles.modal}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Text style={styles.modalTitle}>{draft?.id ? 'Edit context' : 'New context'}</Text>
          <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
          >
            <TextInput
              style={styles.input}
              placeholder="Name"
              placeholderTextColor={colors.textDim}
              value={draft?.name ?? ''}
              onChangeText={(name) => setDraft((d) => (d ? { ...d, name } : d))}
            />
            <TextInput
              style={[styles.input, styles.multiline, { marginTop: 12 }]}
              placeholder="Instructions for the model — what should happen when a barcode is scanned?"
              placeholderTextColor={colors.textDim}
              value={draft?.instructions ?? ''}
              onChangeText={(instructions) => setDraft((d) => (d ? { ...d, instructions } : d))}
              multiline
              textAlignVertical="top"
            />
            {!isEditingMemory && draft && (
              <View style={{ marginTop: 16 }}>
                <Text style={styles.sectionLabel}>Prompt fields (optional)</Text>
                <Text style={[styles.dimText, styles.sectionHelp]}>
                  Collected in a quick form before a scan runs with this context active. Reference a
                  field's value in Instructions as {'{{'}fieldId{'}}'}.
                </Text>
                {draft.promptFields.map((field, idx) => (
                  <View key={field.id} style={styles.fieldRow}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <TextInput
                        style={[styles.input, { flex: 1 }]}
                        placeholder="Label"
                        placeholderTextColor={colors.textDim}
                        value={field.label}
                        onChangeText={(label) => updateField(idx, { label })}
                      />
                      <TouchableOpacity
                        onPress={() => updateField(idx, { type: field.type === 'select' ? 'text' : 'select' })}
                      >
                        <Text style={styles.linkText}>{field.type === 'select' ? 'Select' : 'Text'}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => removeField(idx)}>
                        <Text style={[styles.linkText, { color: colors.danger }]}>Remove</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={styles.fieldRef}>
                      {'{{'}
                      {field.id}
                      {'}}'}
                    </Text>
                    {field.type === 'select' && (
                      <TextInput
                        style={[styles.input, { marginTop: 6 }]}
                        placeholder="Options, comma separated"
                        placeholderTextColor={colors.textDim}
                        value={(field.options ?? []).join(', ')}
                        onChangeText={(text) =>
                          updateField(idx, {
                            options: text
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    )}
                  </View>
                ))}
                <TouchableOpacity style={styles.secondaryButton} onPress={addField}>
                  <Text style={styles.secondaryButtonText}>+ Add field</Text>
                </TouchableOpacity>
              </View>
            )}
            {!isEditingMemory && draft && (
              <View style={{ marginTop: 16 }}>
                <Text style={styles.sectionLabel}>Direct API call (optional)</Text>
                <Text style={[styles.dimText, styles.sectionHelp]}>
                  Skip the model entirely and call this operation straight from the scan — for lookups/actions
                  that don't need model judgment.
                </Text>
                {draft.apiOperation ? (
                  <View style={styles.fieldRow}>
                    <Text style={{ color: colors.text, fontWeight: '600' }}>
                      {draft.apiOperation.operationId}
                    </Text>
                    <Text style={styles.dimText}>{selectedOp?.summary ?? ''}</Text>
                    <View style={{ flexDirection: 'row', gap: 14, marginTop: 6 }}>
                      <TouchableOpacity onPress={() => setPickerOpen(true)}>
                        <Text style={styles.linkText}>Change</Text>
                      </TouchableOpacity>
                      {selectedOp && (
                        <TouchableOpacity
                          onPress={() =>
                            updateApiOperation({
                              paramValues: buildDefaultParamValues(selectedOp.parameters, draft.promptFields),
                              bodyTemplate: selectedOp.requestBodySchema
                                ? buildDefaultBodyTemplate(selectedOp.requestBodySchema, draft.promptFields)
                                : undefined,
                            })
                          }
                        >
                          <Text style={styles.linkText}>Auto-fill from scan/fields</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity onPress={() => setDraft((d) => (d ? { ...d, apiOperation: undefined } : d))}>
                        <Text style={[styles.linkText, { color: colors.danger }]}>Clear</Text>
                      </TouchableOpacity>
                    </View>

                    {selectedOp && selectedOp.parameters.length > 0 && (
                      <View style={{ marginTop: 10 }}>
                        <Text style={[styles.dimText, { marginBottom: 6 }]}>
                          Parameters — use {'{{'}scan{'}}'} for the barcode, {'{{'}fieldId{'}}'} for a prompt field, or a
                          remembered fact's name (e.g. {'{{'}asin{'}}'}) from Memory:
                        </Text>
                        {selectedOp.parameters.map((param) => {
                          const auto = autoFilledHeaders(selectedOp).includes(param.name);
                          return (
                          <View key={param.name} style={{ marginBottom: 8 }}>
                            <Text style={{ color: colors.textDim, fontSize: 11, marginBottom: 3 }}>
                              {param.name} ({param.in}
                              {param.required ? ', required' : ''}
                              {auto ? ' — filled automatically' : ''})
                            </Text>
                            <TextInput
                              style={styles.input}
                              placeholder={auto ? 'fetched for each scan — leave blank' : '{{scan}}'}
                              placeholderTextColor={colors.textDim}
                              value={draft.apiOperation?.paramValues?.[param.name] ?? ''}
                              onChangeText={(v) =>
                                updateApiOperation({
                                  paramValues: { ...draft.apiOperation?.paramValues, [param.name]: v },
                                })
                              }
                              autoCapitalize="none"
                              autoCorrect={false}
                            />
                          </View>
                          );
                        })}
                      </View>
                    )}

                    {selectedOp?.requestBodySchema && (
                      <View style={{ marginTop: 10 }}>
                        <Text style={[styles.dimText, { marginBottom: 6 }]}>JSON request body template:</Text>
                        <TextInput
                          style={[styles.input, styles.multiline]}
                          placeholder={'{"barcode_value":"{{scan}}"}'}
                          placeholderTextColor={colors.textDim}
                          value={draft.apiOperation?.bodyTemplate ?? ''}
                          onChangeText={(v) => updateApiOperation({ bodyTemplate: v })}
                          multiline
                          textAlignVertical="top"
                          autoCapitalize="none"
                          autoCorrect={false}
                          spellCheck={false}
                          keyboardType="ascii-capable"
                        />
                      </View>
                    )}
                  </View>
                ) : (
                  <TouchableOpacity style={styles.secondaryButton} onPress={() => setPickerOpen(true)}>
                    <Text style={styles.secondaryButtonText}>Choose operation</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <TouchableOpacity style={[styles.secondaryButton, { flex: 1 }]} onPress={() => setDraft(null)}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.primaryButton, { flex: 1 }]} onPress={saveDraft}>
              <Text style={styles.primaryButtonText}>Save</Text>
            </TouchableOpacity>
          </View>

          {/* Nested inside the editor's own Modal (rather than a sibling) — two sibling
              top-level Modals don't reliably stack on iOS, so opening this one while the
              editor is open would stay hidden behind it until the editor closed. */}
          <Modal visible={pickerOpen} animationType="slide" onRequestClose={() => setPickerOpen(false)}>
            <View style={styles.modal}>
              <Text style={styles.modalTitle}>Choose an API operation</Text>
              <FlatList
                style={{ flex: 1 }}
                data={allOperations}
                keyExtractor={(o) => `${o.specId}:${o.operationId}`}
                contentContainerStyle={{ gap: 8, paddingVertical: 8 }}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.fieldRow}
                    onPress={() => {
                      setDraft((d) =>
                        d
                          ? {
                              ...d,
                              apiOperation: {
                                specId: item.specId,
                                operationId: item.operationId,
                                paramValues: buildDefaultParamValues(item.parameters, d.promptFields),
                                bodyTemplate: item.requestBodySchema
                                  ? buildDefaultBodyTemplate(item.requestBodySchema, d.promptFields)
                                  : undefined,
                              },
                            }
                          : d,
                      );
                      setPickerOpen(false);
                    }}
                  >
                    <Text style={{ color: colors.textDim, fontSize: 11 }}>
                      {item.specLabel} · {item.method.toUpperCase()} {item.path}
                    </Text>
                    <Text style={{ color: colors.text, fontWeight: '600', marginTop: 2 }}>{item.operationId}</Text>
                    {item.summary ? <Text style={styles.dimText}>{item.summary}</Text> : null}
                  </TouchableOpacity>
                )}
              />
              <TouchableOpacity style={[styles.secondaryButton, { marginTop: 12 }]} onPress={() => setPickerOpen(false)}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </Modal>
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
  list: { flex: 1 },
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
  // Bounded height so the field scrolls internally once text overflows it, instead of growing
  // unbounded — an unbounded field can fill the whole screen above the keyboard, and a drag
  // started inside it gets captured as text selection rather than scrolling the outer form.
  multiline: { minHeight: 160, maxHeight: 260 },
  dimText: { color: colors.textDim },
  sectionLabel: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  sectionHelp: { fontSize: 12, lineHeight: 16, marginBottom: 10 },
  fieldRow: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  fieldRef: { color: colors.textDim, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginTop: 6 },
});
