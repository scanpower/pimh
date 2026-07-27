import { AppSettings, ContextNote, ScanEvent } from '../types';
import { RunCallbacks, RunResult } from './agentCommon';
import { runAnthropicConversation } from './claude';
import { runOpenAiConversation } from './openai';
import { providerFor } from './models';
import { expandFieldAliases, parseMemoryFacts, substituteFields } from './templating';

export type { RunCallbacks, RunResult } from './agentCommon';

/** One key per provider. Only the selected model's provider key is required for a given scan. */
export interface ApiKeys {
  anthropic: string;
  openai: string;
}

/** Human-readable name of the key a model needs, for error messages. */
export function keyLabelFor(modelId: string): string {
  return providerFor(modelId) === 'openai' ? 'OpenAI API key' : 'Claude API key';
}

/** Whether the key the selected model needs has been set. */
export function hasKeyFor(modelId: string, keys: ApiKeys): boolean {
  return !!(providerFor(modelId) === 'openai' ? keys.openai : keys.anthropic).trim();
}

/**
 * Send one conversation to whichever provider the selected model belongs to. Both paths take
 * the same arguments and return the same RunResult, so everything downstream — signal lines,
 * memory, tool results, printing — is provider-independent.
 */
function runConversation(
  keys: ApiKeys,
  settings: AppSettings,
  context: ContextNote | undefined,
  memory: ContextNote | undefined,
  messages: any[],
  callbacks: RunCallbacks,
): Promise<RunResult> {
  if (providerFor(settings.model) === 'openai') {
    return runOpenAiConversation(keys.openai, settings, context, memory, messages, callbacks);
  }
  return runAnthropicConversation(keys.anthropic, settings, context, memory, messages, callbacks);
}

/**
 * Run a scan through the selected model. The active context note's instructions become the
 * system prompt (with any {{fieldId}} tokens substituted from fieldValues and Memory); enabled
 * MCP servers are attached so the model can execute tools (e.g. ScanPower).
 */
export async function runScan(
  keys: ApiKeys,
  settings: AppSettings,
  context: ContextNote | undefined,
  memory: ContextNote | undefined,
  scan: ScanEvent,
  fieldValues: Record<string, string> | undefined,
  callbacks: RunCallbacks,
): Promise<RunResult> {
  const resolvedContext = context
    ? {
        ...context,
        instructions: substituteFields(context.instructions, {
          ...parseMemoryFacts(memory?.instructions),
          ...expandFieldAliases(context.promptFields, fieldValues),
        }),
      }
    : context;

  const fieldLines =
    context?.promptFields && fieldValues
      ? context.promptFields
          .map((f) => `${f.label}: ${fieldValues[f.id] ?? ''}`)
          .filter((line) => line.split(': ')[1])
          .join('\n')
      : '';

  const scanLine = scan.data
    ? `Scanned barcode: ${scan.data}\nSymbology: ${scan.type}\nScanned at: ${new Date(scan.timestamp).toISOString()}`
    : `No barcode scanned — running the active context directly at ${new Date(scan.timestamp).toISOString()}.`;

  // A plain {role, content} user turn is accepted as-is by both the Messages API and the
  // Responses API, so the opening message needs no per-provider shaping.
  const initialMessages = [
    {
      role: 'user',
      content: scanLine + (fieldLines ? `\n\nProvided details:\n${fieldLines}` : ''),
    },
  ];

  return runConversation(keys, settings, resolvedContext, memory, initialMessages, callbacks);
}

/**
 * Answer a pendingPrompt (ASK or CHOOSE) and continue the same conversation. `priorMessages`
 * is in the wire format of whichever provider produced it, so switching models mid-conversation
 * is not supported — start a new scan instead.
 */
export async function continueScan(
  keys: ApiKeys,
  settings: AppSettings,
  context: ContextNote | undefined,
  memory: ContextNote | undefined,
  priorMessages: any[],
  answer: string,
  callbacks: RunCallbacks,
): Promise<RunResult> {
  const messages = [...priorMessages, { role: 'user', content: answer }];
  return runConversation(keys, settings, context, memory, messages, callbacks);
}
