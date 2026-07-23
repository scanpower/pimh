import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import Markdown from 'react-native-markdown-display';
import { AgentBlock, AgentRun, AppSettings, ContextNote, ContextPromptField, ScanEvent } from '../types';
import { continueScan, runScan } from '../lib/claude';
import { colors } from '../ui/theme';
import { markdownItInstance, markdownRules, markdownStyles } from '../ui/markdown';

// 1D symbologies only, per app requirements.
const BARCODE_TYPES = [
  'upc_a',
  'upc_e',
  'ean13',
  'ean8',
  'code39',
  'code93',
  'code128',
  'itf14',
  'codabar',
] as const;

// Cap how many memory facts accumulate before we start dropping the oldest.
const MAX_MEMORY_LINES = 40;

interface Props {
  apiKey: string;
  settings: AppSettings;
  contexts: ContextNote[];
  onContextsChange: (contexts: ContextNote[]) => void;
  /** Bumped by the parent when the Scan tab is tapped while already active — acts like "Scan again". */
  resetSignal?: number;
  /** Notifies the parent when a Claude request is in flight, e.g. to animate the header. */
  onRunningChange?: (running: boolean) => void;
}

export default function ScanScreen({
  apiKey,
  settings,
  contexts,
  onContextsChange,
  resetSignal,
  onRunningChange,
}: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(true);
  const [lastScan, setLastScan] = useState<ScanEvent | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [run, setRun] = useState<AgentRun>({ status: 'idle', blocks: [] });
  const busyRef = useRef(false);

  const activeContext = contexts.find((c) => c.active);
  const memoryContext = contexts.find((c) => c.isMemory);

  const mergeMemoryNotes = useCallback(
    (notes: string[]) => {
      if (notes.length === 0) return;
      const updated = contexts.map((c) => {
        if (!c.isMemory) return c;
        const existingLines = c.instructions
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const newLines = notes.filter((n) => !existingLines.includes(n));
        if (newLines.length === 0) return c;
        const merged = [...existingLines, ...newLines].slice(-MAX_MEMORY_LINES);
        return { ...c, instructions: merged.join('\n'), updatedAt: Date.now() };
      });
      onContextsChange(updated);
    },
    [contexts, onContextsChange],
  );

  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  const toggleTool = useCallback((i: number) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  // Some contexts collect a few structured details before a scan runs (e.g. quantity,
  // warehouse) — shown as a small form. pendingFieldForm holds the scan that's waiting on it.
  const [pendingFieldForm, setPendingFieldForm] = useState<{ scan: ScanEvent; fields: ContextPromptField[] } | null>(
    null,
  );
  const [fieldFormValues, setFieldFormValues] = useState<Record<string, string>>({});
  const [answerText, setAnswerText] = useState('');

  const runWithFields = useCallback(
    async (scan: ScanEvent, fieldValues: Record<string, string> | undefined) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setLastScan(scan);
      setScanning(false);
      setExpandedTools(new Set());
      setAnswerText('');

      if (!apiKey) {
        setRun({
          status: 'error',
          blocks: [],
          error: 'No Claude API key set. Add one in Settings.',
        });
        busyRef.current = false;
        return;
      }

      setRun({ status: 'running', blocks: [] });
      try {
        const result = await runScan(apiKey, settings, activeContext, memoryContext, scan, fieldValues, {
          onBlocks: (blocks) => setRun({ status: 'running', blocks }),
        });
        setRun({
          status: 'done',
          blocks: result.blocks,
          stopReason: result.stopReason,
          pendingPrompt: result.pendingPrompt,
          messages: result.messages,
        });
        mergeMemoryNotes(result.memoryNotes);
      } catch (e: any) {
        setRun({
          status: 'error',
          blocks: [],
          error: e?.message ?? String(e),
        });
      } finally {
        busyRef.current = false;
      }
    },
    [apiKey, settings, activeContext, memoryContext, mergeMemoryNotes],
  );

  const startRun = useCallback(
    (scan: ScanEvent) => {
      if (busyRef.current || pendingFieldForm) return;
      if (activeContext?.promptFields && activeContext.promptFields.length > 0) {
        setScanning(false);
        setPendingFieldForm({ scan, fields: activeContext.promptFields });
        setFieldFormValues({});
        return;
      }
      void runWithFields(scan, undefined);
    },
    [activeContext, pendingFieldForm, runWithFields],
  );

  const submitFieldForm = () => {
    if (!pendingFieldForm) return;
    const { scan } = pendingFieldForm;
    const values = fieldFormValues;
    setPendingFieldForm(null);
    void runWithFields(scan, values);
  };

  const cancelFieldForm = () => {
    setPendingFieldForm(null);
    setScanning(true);
  };

  const submitPromptAnswer = useCallback(
    async (answer: string) => {
      const trimmed = answer.trim();
      if (!trimmed || !run.messages || busyRef.current) return;
      busyRef.current = true;
      setAnswerText('');
      const priorBlocks = run.blocks;
      setRun({ status: 'running', blocks: priorBlocks });
      try {
        const result = await continueScan(apiKey, settings, activeContext, memoryContext, run.messages, trimmed, {
          onBlocks: (blocks) => setRun({ status: 'running', blocks: [...priorBlocks, ...blocks] }),
        });
        setRun({
          status: 'done',
          blocks: [...priorBlocks, ...result.blocks],
          stopReason: result.stopReason,
          pendingPrompt: result.pendingPrompt,
          messages: result.messages,
        });
        mergeMemoryNotes(result.memoryNotes);
      } catch (e: any) {
        setRun({ status: 'error', blocks: priorBlocks, error: e?.message ?? String(e) });
      } finally {
        busyRef.current = false;
      }
    },
    [run.messages, run.blocks, apiKey, settings, activeContext, memoryContext, mergeMemoryNotes],
  );

  const onBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      if (!scanning || busyRef.current) return;
      startRun({ data: result.data, type: result.type, timestamp: Date.now() });
    },
    [scanning, startRun],
  );

  const submitManual = () => {
    // Empty input is allowed: some contexts don't need a scanned code at all
    // (they run purely off prompt fields / instructions), so Go must still work.
    const code = manualCode.trim();
    setManualCode('');
    startRun({ data: code, type: 'manual', timestamp: Date.now() });
  };

  // Collapse the camera + manual-entry area once the results list scrolls past
  // a small threshold, and restore it once scrolled back near the top.
  const [topHeight, setTopHeight] = useState(0);
  const [topCollapsed, setTopCollapsed] = useState(false);
  const collapseAnim = useRef(new Animated.Value(1)).current;
  const resultsScrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    Animated.timing(collapseAnim, {
      toValue: topCollapsed ? 0 : 1,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [topCollapsed, collapseAnim]);

  // Parent bumps resetSignal when the Scan tab is tapped while already active.
  useEffect(() => {
    if (resetSignal === undefined) return;
    setScanning(true);
    setTopCollapsed(false);
    setPendingFieldForm(null);
    resultsScrollRef.current?.scrollTo({ y: 0, animated: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  const handleResultsScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      if (y > 24 && !topCollapsed) setTopCollapsed(true);
      else if (y <= 4 && topCollapsed) setTopCollapsed(false);
    },
    [topCollapsed],
  );

  useEffect(() => {
    onRunningChange?.(run.status === 'running');
  }, [run.status, onRunningChange]);

  const indexedBlocks = run.blocks.map((block, i) => ({ block, i }));

  const renderBlock = (block: AgentBlock, i: number) => {
    switch (block.kind) {
      case 'text':
        return (
          <View key={i} style={styles.answerBlock}>
            <Markdown style={markdownStyles} markdownit={markdownItInstance} rules={markdownRules}>
              {block.text}
            </Markdown>
          </View>
        );
      case 'tool_use':
        return (
          <ToolLine
            key={i}
            title={`⚙ ${block.server} → ${block.tool}`}
            titleColor={colors.accent}
            body={block.input}
            expanded={expandedTools.has(i)}
            onToggle={() => toggleTool(i)}
          />
        );
      case 'tool_result':
        return (
          <ToolLine
            key={i}
            title={block.isError ? '✕ Tool error' : '✓ Tool result'}
            titleColor={block.isError ? colors.danger : colors.accent}
            borderColor={block.isError ? colors.danger : undefined}
            body={block.content}
            expanded={expandedTools.has(i)}
            onToggle={() => toggleTool(i)}
          />
        );
      case 'warning':
        return (
          <View key={i} style={styles.warningCard}>
            <Text style={styles.warningText}>⚠ {block.text}</Text>
          </View>
        );
    }
  };

  return (
    <>
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Animated.View
        style={{
          height: topHeight ? collapseAnim.interpolate({ inputRange: [0, 1], outputRange: [0, topHeight] }) : undefined,
          overflow: 'hidden',
        }}
      >
        <View onLayout={(e) => { if (!topHeight) setTopHeight(e.nativeEvent.layout.height); }}>
          <View style={styles.cameraBox}>
            {permission?.granted ? (
              scanning ? (
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
                  onBarcodeScanned={onBarcodeScanned}
                />
              ) : (
                <View style={styles.cameraPlaceholder}>
                  <TouchableOpacity style={styles.primaryButton} onPress={() => setScanning(true)}>
                    <Text style={styles.primaryButtonText}>Scan again</Text>
                  </TouchableOpacity>
                </View>
              )
            ) : (
              <View style={styles.cameraPlaceholder}>
                <Text style={styles.dimText}>Camera access is needed to scan barcodes.</Text>
                <TouchableOpacity style={styles.primaryButton} onPress={requestPermission}>
                  <Text style={styles.primaryButtonText}>Grant camera access</Text>
                </TouchableOpacity>
              </View>
            )}
            {scanning && permission?.granted && (
              <View pointerEvents="none" style={styles.reticle} />
            )}
          </View>

          <View style={styles.manualRow}>
            <TextInput
              style={styles.input}
              placeholder="Or type a barcode…"
              placeholderTextColor={colors.textDim}
              value={manualCode}
              onChangeText={setManualCode}
              onSubmitEditing={submitManual}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              returnKeyType="go"
            />
            <TouchableOpacity style={styles.primaryButton} onPress={submitManual}>
              <Text style={styles.primaryButtonText}>Go</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Animated.View>

      <View style={styles.contextBanner}>
        <Text style={styles.dimText} numberOfLines={1}>
          Context: <Text style={{ color: colors.text }}>{activeContext?.name ?? 'None'}</Text>
          {'   '}Model: <Text style={{ color: colors.text }}>{settings.model}</Text>
        </Text>
      </View>

      <ScrollView
        ref={resultsScrollRef}
        style={styles.results}
        contentContainerStyle={{ paddingBottom: 24 }}
        onScroll={handleResultsScroll}
        scrollEventThrottle={16}
      >
        {lastScan && lastScan.data && (
          <View style={styles.scanChip}>
            <Text style={styles.scanChipText}>
              {lastScan.data} <Text style={styles.dimText}>({lastScan.type})</Text>
            </Text>
          </View>
        )}
        {run.status === 'error' && <Text style={styles.errorText}>{run.error}</Text>}
        {/* Warnings first (need attention), then the formatted final answer, then raw tool
            call/result detail at the bottom — regardless of the order blocks arrived in. */}
        {indexedBlocks.filter(({ block }) => block.kind === 'warning').map(({ block, i }) => renderBlock(block, i))}
        {indexedBlocks.filter(({ block }) => block.kind === 'text').map(({ block, i }) => renderBlock(block, i))}
        {run.pendingPrompt && (
          <View style={styles.promptCard}>
            <Text style={styles.promptQuestion}>{run.pendingPrompt.question}</Text>
            {run.pendingPrompt.kind === 'choose' ? (
              <View style={styles.promptOptions}>
                {run.pendingPrompt.options.map((opt) => (
                  <TouchableOpacity
                    key={opt}
                    style={styles.promptOptionButton}
                    disabled={run.status === 'running'}
                    onPress={() => submitPromptAnswer(opt)}
                  >
                    <Text style={styles.promptOptionText}>{opt}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : (
              <View style={styles.promptAnswerRow}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  placeholder="Type your answer…"
                  placeholderTextColor={colors.textDim}
                  value={answerText}
                  onChangeText={setAnswerText}
                  onSubmitEditing={() => submitPromptAnswer(answerText)}
                  editable={run.status !== 'running'}
                  returnKeyType="send"
                />
                <TouchableOpacity
                  style={styles.primaryButton}
                  disabled={run.status === 'running'}
                  onPress={() => submitPromptAnswer(answerText)}
                >
                  <Text style={styles.primaryButtonText}>Send</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
        {settings.showToolCalls &&
          indexedBlocks
            .filter(({ block }) => block.kind === 'tool_use' || block.kind === 'tool_result')
            .map(({ block, i }) => renderBlock(block, i))}
        {run.status === 'idle' && !lastScan && (
          <Text style={[styles.dimText, { textAlign: 'center', marginTop: 24 }]}>
            Point the camera at a 1D barcode.{'\n'}The active context note decides what happens next.
          </Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>

    <Modal visible={pendingFieldForm !== null} animationType="slide" onRequestClose={cancelFieldForm}>
      <KeyboardAvoidingView style={styles.modal} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Text style={styles.modalTitle}>{activeContext?.name}</Text>
        <Text style={[styles.dimText, { marginBottom: 4 }]}>Fill in a few details before this scan runs.</Text>
        <ScrollView style={{ flex: 1 }}>
          {pendingFieldForm?.fields.map((field) => (
            <View key={field.id} style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>{field.label}</Text>
              {field.type === 'select' ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {(field.options ?? []).map((opt) => (
                    <TouchableOpacity
                      key={opt}
                      style={[styles.chip, fieldFormValues[field.id] === opt && styles.chipActive]}
                      onPress={() => setFieldFormValues((v) => ({ ...v, [field.id]: opt }))}
                    >
                      <Text style={fieldFormValues[field.id] === opt ? styles.chipTextActive : styles.chipText}>
                        {opt}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <TextInput
                  style={styles.input}
                  placeholderTextColor={colors.textDim}
                  value={fieldFormValues[field.id] ?? ''}
                  onChangeText={(v) => setFieldFormValues((prev) => ({ ...prev, [field.id]: v }))}
                />
              )}
            </View>
          ))}
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <TouchableOpacity style={[styles.secondaryButton, { flex: 1 }]} onPress={cancelFieldForm}>
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.primaryButton, { flex: 1 }]} onPress={submitFieldForm}>
            <Text style={styles.primaryButtonText}>Continue</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
    </>
  );
}

/** A tool call/result card: collapsed to one line, tap to expand the full title + body. */
function ToolLine({
  title,
  titleColor,
  body,
  borderColor,
  expanded,
  onToggle,
}: {
  title: string;
  titleColor: string;
  body: string;
  borderColor?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const header = `${expanded ? '▾' : '▸'} ${title}`;
  return (
    <TouchableOpacity
      style={[styles.toolCard, borderColor ? { borderColor } : null]}
      onPress={onToggle}
      activeOpacity={0.7}
    >
      {expanded ? (
        <>
          <Text style={[styles.toolTitle, { color: titleColor }]}>{header}</Text>
          <Text style={styles.toolBody}>{body}</Text>
        </>
      ) : (
        <Text numberOfLines={1} ellipsizeMode="tail">
          <Text style={[styles.toolTitleInline, { color: titleColor }]}>{header}</Text>
          <Text style={styles.toolBody}> {body}</Text>
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  cameraBox: {
    height: 204, // 15% smaller than the original 240
    backgroundColor: '#000',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    overflow: 'hidden',
  },
  cameraPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 16,
  },
  reticle: {
    position: 'absolute',
    left: '12%',
    right: '12%',
    top: '38%',
    height: 60,
    borderWidth: 2,
    borderColor: colors.accent,
    borderRadius: 8,
    opacity: 0.8,
  },
  manualRow: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { color: colors.accentText, fontWeight: '600' },
  contextBanner: { paddingHorizontal: 12, paddingBottom: 8 },
  results: { flex: 1, paddingHorizontal: 12 },
  scanChip: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 10,
  },
  scanChipText: { color: colors.text, fontVariant: ['tabular-nums'] },
  answerBlock: { marginBottom: 10 },
  toolCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  toolCardError: { borderColor: colors.danger },
  warningCard: {
    backgroundColor: colors.surface,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  warningText: { color: colors.warning, fontSize: 13 },
  toolTitle: { color: colors.accent, fontWeight: '600', marginBottom: 4 },
  toolTitleInline: { color: colors.accent, fontWeight: '600' },
  toolBody: { color: colors.textDim, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  errorText: { color: colors.danger, marginVertical: 8 },
  dimText: { color: colors.textDim },
  promptCard: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
  },
  promptQuestion: { color: colors.text, fontSize: 15, marginBottom: 10 },
  promptOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  promptOptionButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  promptOptionText: { color: colors.accentText, fontWeight: '600' },
  promptAnswerRow: { flexDirection: 'row', gap: 8 },
  modal: { flex: 1, backgroundColor: colors.bg, padding: 16, paddingTop: 64, gap: 12 },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  fieldGroup: { marginBottom: 14 },
  fieldLabel: { color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: 6 },
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
  secondaryButton: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryButtonText: { color: colors.text },
});
