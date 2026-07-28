import type { AgentBlock, AppSettings, ContextNote, McpServerConfig, PendingPrompt } from '../types';
import { getValidAccessToken } from './mcpOAuth';

/**
 * Provider-independent pieces of a scan run: the system prompt, the signal-line contract, and
 * MCP server resolution. Both the Anthropic (claude.ts) and OpenAI (openai.ts) request paths
 * build on these so a context behaves the same whichever model is selected.
 */

export interface RunCallbacks {
  onBlocks: (blocks: AgentBlock[]) => void;
}

export interface RunResult {
  blocks: AgentBlock[];
  stopReason: string;
  memoryNotes: string[];
  pendingPrompt?: PendingPrompt;
  /**
   * Conversation so far, in the selected provider's own wire format — pass back into
   * continueScan() to answer a pendingPrompt. Opaque, and only meaningful to the provider
   * that produced it.
   */
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

export interface ResolvedMcpServer {
  server: McpServerConfig;
  token: string | null;
}

/**
 * Split the enabled MCP servers into those usable on this request and warnings for those that
 * are enabled but not connected. An OAuth server with no token is excluded rather than sent
 * unauthenticated, which would fail server-side with a less obvious error.
 */
export async function resolveMcpServers(
  settings: AppSettings,
): Promise<{ usable: ResolvedMcpServer[]; warnings: AgentBlock[] }> {
  const candidates = settings.mcpServers.filter((s) => s.enabled && s.url);
  const resolved = await Promise.all(candidates.map(async (s) => ({ server: s, token: await resolveServerToken(s) })));

  const isUnconnectedOAuth = (r: ResolvedMcpServer) => r.server.authType === 'oauth' && r.token === null;
  return {
    usable: resolved.filter((r) => !isUnconnectedOAuth(r)),
    warnings: resolved.filter(isUnconnectedOAuth).map(({ server: s }) => ({
      kind: 'warning' as const,
      text: `${s.name} is enabled but not connected — go to Settings and tap Connect.`,
    })),
  };
}

const MEMORY_LINE_RE = /^memory:\s*(.+)$/i;
const ASK_LINE_RE = /^ask:\s*(.+)$/i;
const CHOOSE_LINE_RE = /^choose:\s*(.+)$/i;

/**
 * Tells the model about the signal lines it can end a reply with:
 *  - MEMORY: <key>: <value> — a durable fact worth remembering across scans.
 *  - ASK: <question> — the model needs a short free-text answer before it can finish.
 *  - CHOOSE: <question> | <opt1> | <opt2> | ... — the user should pick one of a few options.
 * All are stripped from the displayed text and rendered by the app instead
 * (ASK/CHOOSE as an interactive prompt; MEMORY merged into the Memory context).
 */
export const SIGNAL_INSTRUCTION =
  '\n\nYou may end your reply with special signal lines (each alone on its own line, at the very end):\n' +
  '- "MEMORY: <key>: <value>" — a concise, durable fact worth remembering for future scans, phrased as a ' +
  'short lowercase key, a colon, then the value (e.g. "MEMORY: asin: B08XYZ123", "MEMORY: condition: New") ' +
  '— one fact per line, one key per line. Prefer short conventional keys (asin, sku, upc, title, condition, ' +
  'quantity, price, location) over restating them in a sentence, since these get parsed back out by key ' +
  'for reuse elsewhere in the app. Whenever a tool call returns identifying details about the scanned item ' +
  '— SKU, ASIN, UPC, product name, quantity, location/bin, price, condition, or similar — you MUST include ' +
  'one MEMORY line per distinct fact worth keeping, even if the answer already states it in prose. Skip a ' +
  'fact only if it is already listed verbatim in "Known context from previous scans" below, or if this scan ' +
  'used no tools and produced nothing new and reusable.\n' +
  '- "ASK: <question>" — if you need the user to type a short answer before you can finish (e.g. a ' +
  'quantity or a clarification), ask exactly one question this way instead of guessing.\n' +
  '- "CHOOSE: <question> | <option 1> | <option 2> | ..." — if the user needs to pick from a small set ' +
  'of options, ask this way instead of listing them in prose.\n' +
  'Use at most one of ASK or CHOOSE per reply, only when truly needed to proceed — otherwise just answer normally.';

/**
 * Extra instructions for a context whose direct API call runs *after* the model rather than
 * instead of it (apiOperation.runAfterModel). The model's job in that case is to gather the
 * values the call needs and report them as MEMORY lines, which is the channel the API stage
 * reads — so the names have to be spelled exactly as the operation will look them up.
 *
 * Remembered facts are deliberately not filtered out of `neededNames`: Memory persists across
 * scans, so a fact left over from the previous item would otherwise silently satisfy the call
 * and act on the wrong product.
 */
export function buildApiStageInstruction(operationId: string, neededNames: string[]): string {
  if (neededNames.length === 0) return '';
  return (
    `\n\nWhen you are done, this app automatically calls the "${operationId}" API operation using the ` +
    `facts you report. End your reply with one MEMORY line per value below, spelling each key exactly ` +
    `as shown:\n` +
    neededNames.map((name) => `- MEMORY: ${name}: <value>`).join('\n') +
    `\nEvery one must describe the item scanned in THIS conversation — use your tools to determine them, ` +
    `and do not carry a value over from "Known context from previous scans" unless you have confirmed it ` +
    `still applies. If one can only come from the user, ask for it with ASK rather than guessing; the API ` +
    `call is held until you have what you need.`
  );
}

/** The active context's instructions, plus the signal contract and any remembered facts. */
export function buildSystemPrompt(context: ContextNote | undefined, memory: ContextNote | undefined): string {
  const memoryText = memory?.instructions?.trim();
  return (
    (context?.instructions ?? 'The user scanned a barcode. Identify the product or content and summarize it concisely.') +
    SIGNAL_INSTRUCTION +
    (memoryText ? `\n\nKnown context from previous scans:\n${memoryText}` : '')
  );
}

/**
 * Pull MEMORY/ASK/CHOOSE signal lines out of text blocks, returning the
 * cleaned blocks (never shown to the user) plus the extracted facts and any
 * pending prompt (last one wins if more than one appeared).
 */
export function extractSignals(blocks: AgentBlock[]): {
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
// literal text — most commonly when the system prompt tells the model to use a tool (e.g. "use
// ScanPower to print...") but no matching MCP server was actually attached to this request, so
// there's no real tool for it to call. Flag it clearly rather than letting a fabricated "success"
// message go unnoticed — no tool_use block means nothing actually happened server-side.
const HALLUCINATED_TOOL_CALL_RE = /<function_calls>|<invoke\b|<function_results>/i;

export function flagHallucinatedToolCalls(blocks: AgentBlock[]): AgentBlock[] {
  const hasRealToolUse = blocks.some((b) => b.kind === 'tool_use');
  const hasFakeCallText = blocks.some((b) => b.kind === 'text' && HALLUCINATED_TOOL_CALL_RE.test(b.text));
  if (hasRealToolUse || !hasFakeCallText) return blocks;
  return [
    {
      kind: 'warning',
      text:
        "The model's reply looks like it wrote out a fake tool call instead of actually calling one — no tool " +
        'was really invoked, so nothing happened (e.g. nothing was printed). This usually means the MCP ' +
        "server this context expects isn't enabled and connected — check Settings.",
    },
    ...blocks,
  ];
}
