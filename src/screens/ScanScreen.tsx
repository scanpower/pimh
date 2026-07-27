import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
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
import * as Clipboard from 'expo-clipboard';
import Markdown from 'react-native-markdown-display';
import { AgentBlock, AgentRun, AppSettings, ContextNote, ContextPromptField, ScanEvent } from '../types';
import { continueScan, expandFieldAliases, parseMemoryFacts, runScan } from '../lib/claude';
import { getOperation } from '../lib/apiSpecs';
import { callOperation } from '../lib/directApi';
import { summarizeApiResult } from '../lib/apiSummary';
import { printContent } from '../lib/print';
import { colors } from '../ui/theme';
import { markdownItInstance, markdownRules, markdownStyles } from '../ui/markdown';

// A tool result is auto-printed when the tool that produced it has "print" in its name
// (e.g. print_item_labels) — a substring match, since tool names are snake_case identifiers
// rather than prose (no need for the word-boundary care that free-text instructions would need).
const PRINT_TOOL_RE = /print/i;

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

// Upper bound on how much of a tool result body is handed to <Text> — see ToolLine.
const MAX_TOOL_BODY_CHARS = 2000;

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

  // Any tool result produced by a tool whose name contains "print" (e.g. print_item_labels)
  // is sent straight to the configured printer — independent of the active context's wording.
  const maybePrintToolResults = useCallback(
    async (newBlocks: AgentBlock[]) => {
      const results = newBlocks.filter(
        (b) => b.kind === 'tool_result' && !b.isError && b.tool && PRINT_TOOL_RE.test(b.tool),
      ) as Extract<AgentBlock, { kind: 'tool_result' }>[];
      if (results.length === 0) return; // nothing print-related happened this step — stay quiet
      console.log(
        `[print] ${results.length} tool result(s) from a "print"-named tool ` +
          `(printer: ${settings.printer ? settings.printer.name : 'none saved'})`,
      );
      // Printed one at a time (not merged into a single job) since a result may be an actual
      // PDF — merging a PDF data URI with plain text wouldn't make sense. Each attempt gets its
      // own print_log block (shown alongside Tool result cards) regardless of outcome: expo-print
      // can resolve successfully on iOS even when the physical printer never gets/renders the
      // job, so seeing exactly what was sent and where is the only way to confirm what happened.
      for (const [i, r] of results.entries()) {
        try {
          const { call } = await printContent(r.content, settings.printer);
          setRun((prev) => ({
            ...prev,
            blocks: [
              ...prev.blocks,
              {
                kind: 'print_log',
                isError: false,
                text: `[${i + 1}/${results.length}] ${r.tool} → ${call.target}\nmode: ${call.mode}\n${call.detail}\nPrint.printAsync() resolved.`,
              },
            ],
          }));
        } catch (e: any) {
          console.error('[print] printContent failed:', e);
          const call = e?.call as { mode: string; target: string; detail: string } | undefined;
          const detail = e?.message || String(e);
          setRun((prev) => ({
            ...prev,
            blocks: [
              ...prev.blocks,
              {
                kind: 'print_log',
                isError: true,
                text:
                  (call
                    ? `[${i + 1}/${results.length}] ${r.tool} → ${call.target}\nmode: ${call.mode}\n${call.detail}\n`
                    : '') + `FAILED: ${detail}`,
              },
            ],
          }));
          // Printing is a silent background side effect of the scan finishing — a card in the
          // (opt-in) Tool result section isn't enough on its own, so surface it directly too.
          Alert.alert('Print failed', detail);
        }
      }
    },
    [settings.printer],
  );

  // Tapping a value in an API result section offers to copy it or keep it. "Add to Memory"
  // writes "Label: value", the shape parseMemoryFacts() reads back, so a fact captured here
  // becomes available to later scans as a {{token}} as well as being shown to Claude.
  const handleValuePress = useCallback(
    (label: string, value: string) => {
      Alert.alert(label, value, [
        {
          text: 'Copy',
          onPress: () => {
            void Clipboard.setStringAsync(value);
          },
        },
        { text: 'Add to Memory', onPress: () => mergeMemoryNotes([`${label}: ${value}`]) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [mergeMemoryNotes],
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

      // A context wired to a direct API operation bypasses Claude/MCP entirely — it's a
      // deterministic REST call, so there's no model judgment to apply.
      if (activeContext?.apiOperation) {
        const { specId, operationId, paramValues, bodyTemplate } = activeContext.apiOperation;
        setRun({ status: 'running', blocks: [] });
        try {
          const op = getOperation(specId, operationId);
          if (!op) throw new Error(`Operation "${operationId}" not found in spec "${specId}".`);
          const values: Record<string, string> = {
            ...parseMemoryFacts(memoryContext?.instructions),
            ...expandFieldAliases(activeContext.promptFields, fieldValues),
            scan: scan.data,
          };
          const result = await callOperation(op, settings, values, paramValues, bodyTemplate);
          // maybePrintToolResults triggers off the tool name containing "print" — operationIds
          // like "itemLabel" don't, even though the spec tags it "Printing", so fall back to the
          // operation's own tags to decide whether this result should auto-print.
          const printTag = (op.tags ?? []).find((t) => PRINT_TOOL_RE.test(t));
          const tool = PRINT_TOOL_RE.test(operationId) || !printTag ? operationId : `${operationId} (${printTag})`;
          const block: AgentBlock = {
            kind: 'tool_result',
            content: result.text,
            isError: result.status < 200 || result.status >= 300,
            tool,
          };
          // Pair the raw result with a rendered summary, so a direct API scan reads like a
          // Claude answer instead of showing nothing until "Show tool calls" is switched on.
          const summary = summarizeApiResult(op, result);
          const blocks = [...summary, block];
          // Open the section the summarizer flagged (the first object of the collection) so the
          // answer is on screen without a tap; the rest stay collapsed to keep the list scannable.
          setExpandedTools(new Set(blocks.flatMap((b, i) => (b.kind === 'api_section' && b.primary ? [i] : []))));
          setRun({ status: 'done', blocks });
          void maybePrintToolResults([block]);
        } catch (e: any) {
          setRun({ status: 'error', blocks: [], error: e?.message ?? String(e) });
        } finally {
          busyRef.current = false;
        }
        return;
      }

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
        void maybePrintToolResults(result.blocks);
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
    [apiKey, settings, activeContext, memoryContext, mergeMemoryNotes, maybePrintToolResults],
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
        void maybePrintToolResults(result.blocks);
      } catch (e: any) {
        setRun({ status: 'error', blocks: priorBlocks, error: e?.message ?? String(e) });
      } finally {
        busyRef.current = false;
      }
    },
    [run.messages, run.blocks, apiKey, settings, activeContext, memoryContext, mergeMemoryNotes, maybePrintToolResults],
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
  // Only auto-collapse/expand the header when the results actually overflow the visible area.
  // Without this, short output (e.g. an answer plus a warning card) can fit exactly around the
  // collapse threshold: scrolling past it collapses the header, which frees up enough room that
  // the content now fits entirely, snapping the scroll position back — which then re-expands the
  // header, endlessly oscillating and never letting the scroll settle at the true bottom.
  const [resultsViewportHeight, setResultsViewportHeight] = useState(0);
  const [resultsContentHeight, setResultsContentHeight] = useState(0);
  const resultsOverflow = resultsContentHeight > resultsViewportHeight + 1;

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
      if (!resultsOverflow) return; // nothing to scroll — leave the header alone
      const y = e.nativeEvent.contentOffset.y;
      if (y > 24 && !topCollapsed) setTopCollapsed(true);
      else if (y <= 4 && topCollapsed) setTopCollapsed(false);
    },
    [topCollapsed, resultsOverflow],
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
      case 'api_section':
        return (
          <ApiSection
            key={i}
            title={block.title}
            rows={block.rows}
            expanded={expandedTools.has(i)}
            onToggle={() => toggleTool(i)}
            onValuePress={handleValuePress}
          />
        );
      case 'print_log':
        return (
          <ToolLine
            key={i}
            title={block.isError ? '✕ Print failed' : '🖨 Print call'}
            titleColor={block.isError ? colors.danger : colors.accent}
            borderColor={block.isError ? colors.danger : undefined}
            body={block.text}
            expanded={expandedTools.has(i)}
            onToggle={() => toggleTool(i)}
          />
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
        onLayout={(e) => setResultsViewportHeight(e.nativeEvent.layout.height)}
        onContentSizeChange={(_, height) => setResultsContentHeight(height)}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
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
        {indexedBlocks
          .filter(({ block }) => block.kind === 'api_section')
          .map(({ block, i }) => renderBlock(block, i))}
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
            .filter(
              ({ block }) => block.kind === 'tool_use' || block.kind === 'tool_result' || block.kind === 'print_log',
            )
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
        <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
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

/**
 * One group of fields from a direct API response — e.g. a single inbound plan. Collapsed shows
 * the title and field count; expanded lists each attribute as `Label  value`. Null attributes
 * were already dropped upstream (see apiSummary.toRows), so every row here has a value.
 */
function ApiSection({
  title,
  rows,
  expanded,
  onToggle,
  onValuePress,
}: {
  title: string;
  rows: { label: string; value: string }[];
  expanded: boolean;
  onToggle: () => void;
  onValuePress: (label: string, value: string) => void;
}) {
  // The card is a plain View with the header and each row as separate touch targets: nesting
  // a row's touchable inside a card-wide one would make every tap ambiguous and dim the whole
  // card on press. Row keys carry the index because flattening nested objects can legitimately
  // produce two rows with the same label (e.g. an OperationId at two depths).
  return (
    <View style={styles.sectionCard}>
      <TouchableOpacity style={styles.sectionHeader} onPress={onToggle} activeOpacity={0.7}>
        <Text style={styles.sectionTitle}>
          {expanded ? '▾' : '▸'} {title}
        </Text>
        <Text style={styles.sectionCount}>{rows.length}</Text>
      </TouchableOpacity>
      {expanded &&
        rows.map((row, idx) => (
          <TouchableOpacity
            key={`${row.label}-${idx}`}
            style={styles.sectionRow}
            onPress={() => onValuePress(row.label, row.value)}
            activeOpacity={0.6}
          >
            <Text style={styles.sectionRowLabel}>{row.label}</Text>
            <Text style={styles.sectionRowValue}>{row.value}</Text>
          </TouchableOpacity>
        ))}
    </View>
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
  // A tool result can be enormous — a label response is a PDF data URI of ~240,000 characters.
  // numberOfLines only clips what's *drawn*: the full string is still laid out and measured,
  // which corrupts the enclosing ScrollView's content height and leaves the bottom of the
  // results unreachable whenever "Show tool calls" is on. Cap what reaches Text instead.
  const shown =
    body.length > MAX_TOOL_BODY_CHARS
      ? `${body.slice(0, MAX_TOOL_BODY_CHARS)}…\n\n[truncated — ${body.length} characters total]`
      : body;
  return (
    <TouchableOpacity
      style={[styles.toolCard, borderColor ? { borderColor } : null]}
      onPress={onToggle}
      activeOpacity={0.7}
    >
      {expanded ? (
        <>
          <Text style={[styles.toolTitle, { color: titleColor }]}>{header}</Text>
          <Text style={styles.toolBody}>{shown}</Text>
        </>
      ) : (
        <Text numberOfLines={1} ellipsizeMode="tail">
          <Text style={[styles.toolTitleInline, { color: titleColor }]}>{header}</Text>
          <Text style={styles.toolBody}> {shown}</Text>
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
  sectionCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { color: colors.accent, fontWeight: '700', fontSize: 14, flex: 1 },
  sectionCount: { color: colors.textDim, fontSize: 11 },
  sectionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 8 },
  // Fixed-width label column so values line up down the section.
  sectionRowLabel: { color: colors.textDim, fontSize: 12, width: 132 },
  sectionRowValue: { color: colors.text, fontSize: 13, flex: 1 },
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
