import { AgentBlock, AppSettings, ContextNote, McpServerConfig, PendingPrompt, ScanEvent } from '../types';
import { getValidAccessToken } from './mcpOAuth';

const MAX_CONTINUATIONS = 5;
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface RunCallbacks {
  onBlocks: (blocks: AgentBlock[]) => void;
}

export interface RunResult {
  blocks: AgentBlock[];
  stopReason: string;
  memoryNotes: string[];
  pendingPrompt?: PendingPrompt;
  /** Full conversation so far — pass back into continueScan() to answer a pendingPrompt. */
  messages: any[];
}

/**
 * Resolve the bearer token to send with an MCP server, per its auth type.
 * OAuth servers return null when not yet connected (or refresh failed) —
 * callers must exclude those from the request rather than sending no token.
 */
async function resolveServerToken(server: McpServerConfig): Promise<string | null> {
  switch (server.authType) {
    case 'oauth':
      return getValidAccessToken(server);
    case 'token':
      return server.authorizationToken || null;
    default:
      return null;
  }
}

/** Replace {{fieldId}} occurrences in a context's instructions with collected prompt-field values. */
export function substituteFields(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, id) => (id in values ? values[id] : match));
}

const MEMORY_LINE_RE = /^memory:\s*(.+)$/i;
const ASK_LINE_RE = /^ask:\s*(.+)$/i;
const CHOOSE_LINE_RE = /^choose:\s*(.+)$/i;

/**
 * Tells Claude about the signal lines it can end a reply with:
 *  - MEMORY: <fact> — a concise, durable fact worth remembering across scans.
 *  - ASK: <question> — Claude needs a short free-text answer before it can finish.
 *  - CHOOSE: <question> | <opt1> | <opt2> | ... — Claude needs the user to pick one of a few options.
 * All are stripped from the displayed text and rendered by the app instead
 * (ASK/CHOOSE as an interactive prompt; MEMORY merged into the Memory context).
 */
const SIGNAL_INSTRUCTION =
  '\n\nYou may end your reply with special signal lines (each alone on its own line, at the very end):\n' +
  '- "MEMORY: <fact>" — a concise, durable fact worth remembering for future scans (e.g. a product ' +
  'identifier and its key attributes). Whenever a tool call returns identifying details about the scanned ' +
  'item — SKU, ASIN, UPC, product name, quantity, location/bin, price, condition, or similar — you MUST ' +
  'include one MEMORY line per distinct fact worth keeping, even if the answer already states it in prose. ' +
  'Skip a fact only if it is already listed verbatim in "Known context from previous scans" below, or if ' +
  'this scan used no tools and produced nothing new and reusable.\n' +
  '- "ASK: <question>" — if you need the user to type a short answer before you can finish (e.g. a ' +
  'quantity or a clarification), ask exactly one question this way instead of guessing.\n' +
  '- "CHOOSE: <question> | <option 1> | <option 2> | ..." — if the user needs to pick from a small set ' +
  'of options, ask this way instead of listing them in prose.\n' +
  'Use at most one of ASK or CHOOSE per reply, only when truly needed to proceed — otherwise just answer normally.';

function contentToBlocks(content: any[]): AgentBlock[] {
  const blocks: AgentBlock[] = [];
  // Each mcp_tool_result immediately follows the mcp_tool_use it answers within a turn's
  // content array, so track the most recently seen tool name to label results with it.
  let lastToolName: string | undefined;
  for (const block of content) {
    switch (block.type) {
      case 'text':
        blocks.push({ kind: 'text', text: block.text });
        break;
      // 'thinking' blocks are intentionally not surfaced — adaptive thinking
      // stays enabled in the request (it improves response quality), but the
      // reasoning itself is never shown in the app UI.
      case 'mcp_tool_use':
        lastToolName = block.name;
        blocks.push({
          kind: 'tool_use',
          server: block.server_name ?? 'mcp',
          tool: block.name,
          input: JSON.stringify(block.input),
        });
        break;
      case 'mcp_tool_result': {
        const parts = Array.isArray(block.content)
          ? block.content.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
          : String(block.content ?? '');
        blocks.push({ kind: 'tool_result', content: parts, isError: !!block.is_error, tool: lastToolName });
        break;
      }
    }
  }
  return blocks;
}

/**
 * Pull MEMORY/ASK/CHOOSE signal lines out of text blocks, returning the
 * cleaned blocks (never shown to the user) plus the extracted facts and any
 * pending prompt (last one wins if more than one appeared).
 */
function extractSignals(blocks: AgentBlock[]): {
  blocks: AgentBlock[];
  memoryNotes: string[];
  pendingPrompt?: PendingPrompt;
} {
  const memoryNotes: string[] = [];
  let pendingPrompt: PendingPrompt | undefined;
  const cleaned: AgentBlock[] = [];

  for (const block of blocks) {
    if (block.kind !== 'text') {
      cleaned.push(block);
      continue;
    }
    const kept: string[] = [];
    for (const line of block.text.split('\n')) {
      const memoryMatch = line.match(MEMORY_LINE_RE);
      const askMatch = line.match(ASK_LINE_RE);
      const chooseMatch = line.match(CHOOSE_LINE_RE);
      if (memoryMatch) {
        memoryNotes.push(memoryMatch[1].trim());
      } else if (askMatch) {
        pendingPrompt = { kind: 'ask', question: askMatch[1].trim() };
      } else if (chooseMatch) {
        const parts = chooseMatch[1]
          .split('|')
          .map((p) => p.trim())
          .filter(Boolean);
        const [question, ...options] = parts;
        if (question && options.length > 0) {
          pendingPrompt = { kind: 'choose', question, options };
        }
      } else {
        kept.push(line);
      }
    }
    const text = kept.join('\n').trim();
    if (text) cleaned.push({ kind: 'text', text });
  }

  return { blocks: cleaned, memoryNotes, pendingPrompt };
}

// Some models occasionally fall back to writing out a fake tool call and a fake result as
// literal text — most commonly when the system prompt tells Claude to use a tool (e.g. "use
// ScanPower to print...") but no matching MCP server was actually attached to this request, so
// there's no real tool for it to call. Flag it clearly rather than letting a fabricated "success"
// message go unnoticed — no tool_use block means nothing actually happened server-side.
const HALLUCINATED_TOOL_CALL_RE = /<function_calls>|<invoke\b|<function_results>/i;

function flagHallucinatedToolCalls(blocks: AgentBlock[]): AgentBlock[] {
  const hasRealToolUse = blocks.some((b) => b.kind === 'tool_use');
  const hasFakeCallText = blocks.some((b) => b.kind === 'text' && HALLUCINATED_TOOL_CALL_RE.test(b.text));
  if (hasRealToolUse || !hasFakeCallText) return blocks;
  return [
    {
      kind: 'warning',
      text:
        "Claude's reply looks like it wrote out a fake tool call instead of actually calling one — no tool " +
        "was really invoked, so nothing happened (e.g. nothing was printed). This usually means the MCP " +
        "server this context expects isn't enabled and connected — check Settings.",
    },
    ...blocks,
  ];
}

/**
 * Drive one full conversation turn-loop against the Messages API, starting
 * from `initialMessages`. Shared by runScan() (a fresh scan) and
 * continueScan() (answering a pendingPrompt) so both go through identical
 * system-prompt/tool/signal handling.
 *
 * Calls the Messages API directly with fetch rather than @anthropic-ai/sdk:
 * the official SDK imports Node's `node:fs` for credential-file handling, which
 * Metro/Hermes can't resolve in a React Native bundle. fetch avoids that entirely.
 *
 * Non-streaming: React Native's fetch does not support reading response-body
 * streams, so we use a plain POST and surface interim state via pause_turn
 * continuations instead of token-level streaming.
 */
async function runConversation(
  apiKey: string,
  settings: AppSettings,
  context: ContextNote | undefined,
  memory: ContextNote | undefined,
  initialMessages: any[],
  callbacks: RunCallbacks,
): Promise<RunResult> {
  const candidates = settings.mcpServers.filter((s) => s.enabled && s.url);
  const resolved = await Promise.all(
    candidates.map(async (s) => ({ server: s, token: await resolveServerToken(s) })),
  );

  const notConnected = resolved.filter((r) => r.server.authType === 'oauth' && r.token === null);
  const usable = resolved.filter((r) => !(r.server.authType === 'oauth' && r.token === null));

  const mcpServers = usable.map(({ server: s, token }) => ({
    type: 'url' as const,
    url: s.url,
    name: s.name,
    ...(token ? { authorization_token: token } : {}),
  }));
  const mcpTools = usable.map(({ server: s }) => ({
    type: 'mcp_toolset' as const,
    mcp_server_name: s.name,
  }));

  const preflightWarnings: AgentBlock[] = notConnected.map(({ server: s }) => ({
    kind: 'warning',
    text: `${s.name} is enabled but not connected — go to Settings and tap Connect.`,
  }));

  const memoryText = memory?.instructions?.trim();
  const system =
    (context?.instructions ??
      'The user scanned a barcode. Identify the product or content and summarize it concisely.') +
    SIGNAL_INSTRUCTION +
    (memoryText ? `\n\nKnown context from previous scans:\n${memoryText}` : '');

  const messages: any[] = [...initialMessages];

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (mcpServers.length > 0) {
    headers['anthropic-beta'] = 'mcp-client-2025-11-20';
  }

  const baseBody: Record<string, unknown> = {
    model: settings.model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system,
  };
  if (mcpServers.length > 0) {
    baseBody.mcp_servers = mcpServers;
    baseBody.tools = mcpTools;
  }

  const allBlocks: AgentBlock[] = [...preflightWarnings];
  const memoryNotes: string[] = [];
  let pendingPrompt: PendingPrompt | undefined;
  if (allBlocks.length > 0) callbacks.onBlocks([...allBlocks]);

  let response: any;
  let continuations = 0;

  while (true) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...baseBody, messages }),
    });
    response = await res.json();
    if (!res.ok) {
      const message = response?.error?.message ?? `Request failed (${res.status})`;
      throw new Error(message);
    }

    const {
      blocks: extractedBlocks,
      memoryNotes: newMemoryNotes,
      pendingPrompt: newPendingPrompt,
    } = extractSignals(contentToBlocks(response.content));
    const newBlocks = flagHallucinatedToolCalls(extractedBlocks);
    allBlocks.push(...newBlocks);
    memoryNotes.push(...newMemoryNotes);
    if (newPendingPrompt) pendingPrompt = newPendingPrompt;
    callbacks.onBlocks([...allBlocks]);

    if (response.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS) {
      // Server-side tool loop paused; re-send with the assistant turn appended to resume.
      continuations++;
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    break;
  }

  if (response.stop_reason === 'refusal') {
    allBlocks.push({
      kind: 'text',
      text: 'Claude declined this request for safety reasons.',
    });
  }

  // Keep the assistant's final turn in the transcript so continueScan() can append the user's answer.
  messages.push({ role: 'assistant', content: response.content });

  return {
    blocks: allBlocks,
    stopReason: response.stop_reason ?? 'end_turn',
    memoryNotes,
    pendingPrompt,
    messages,
  };
}

/**
 * Run a scan through Claude. The active context note's instructions become the
 * system prompt (with any {{fieldId}} tokens substituted from fieldValues);
 * enabled MCP servers are attached via the API's MCP connector so Claude can
 * execute tools (e.g. ScanPower) server-side.
 */
export async function runScan(
  apiKey: string,
  settings: AppSettings,
  context: ContextNote | undefined,
  memory: ContextNote | undefined,
  scan: ScanEvent,
  fieldValues: Record<string, string> | undefined,
  callbacks: RunCallbacks,
): Promise<RunResult> {
  const resolvedContext =
    context && fieldValues ? { ...context, instructions: substituteFields(context.instructions, fieldValues) } : context;

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

  const initialMessages = [
    {
      role: 'user',
      content: scanLine + (fieldLines ? `\n\nProvided details:\n${fieldLines}` : ''),
    },
  ];

  return runConversation(apiKey, settings, resolvedContext, memory, initialMessages, callbacks);
}

/** Answer a pendingPrompt (ASK or CHOOSE) and continue the same conversation. */
export async function continueScan(
  apiKey: string,
  settings: AppSettings,
  context: ContextNote | undefined,
  memory: ContextNote | undefined,
  priorMessages: any[],
  answer: string,
  callbacks: RunCallbacks,
): Promise<RunResult> {
  const messages = [...priorMessages, { role: 'user', content: answer }];
  return runConversation(apiKey, settings, context, memory, messages, callbacks);
}
