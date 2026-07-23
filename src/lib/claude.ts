import { AgentBlock, AppSettings, ContextNote, McpServerConfig, ScanEvent } from '../types';
import { getValidAccessToken } from './mcpOAuth';

const MAX_CONTINUATIONS = 5;
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface RunCallbacks {
  onBlocks: (blocks: AgentBlock[]) => void;
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

const MEMORY_LINE_RE = /^memory:\s*(.+)$/i;

/**
 * Instructs Claude to end a reply with `MEMORY: <fact>` when a tool call
 * surfaced something concise and durable (an identifier, SKU, price, or
 * other attribute worth having on hand for future scans). Extracted lines
 * are stripped from the displayed text and merged into the Memory context.
 */
const MEMORY_INSTRUCTION =
  '\n\nIf a tool call surfaced a concise, durable fact worth remembering for future scans ' +
  '(e.g. a product identifier/SKU and its key attributes), end your reply with one line formatted ' +
  'exactly as "MEMORY: <fact>" — a single line, nothing else on it. Omit this line entirely if there ' +
  'is nothing new and reusable to remember.';

function contentToBlocks(content: any[]): AgentBlock[] {
  const blocks: AgentBlock[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        blocks.push({ kind: 'text', text: block.text });
        break;
      // 'thinking' blocks are intentionally not surfaced — adaptive thinking
      // stays enabled in the request (it improves response quality), but the
      // reasoning itself is never shown in the app UI.
      case 'mcp_tool_use':
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
        blocks.push({ kind: 'tool_result', content: parts, isError: !!block.is_error });
        break;
      }
    }
  }
  return blocks;
}

/** Pull "MEMORY: ..." lines out of text blocks, returning the cleaned blocks and the extracted facts. */
function extractMemory(blocks: AgentBlock[]): { blocks: AgentBlock[]; memoryNotes: string[] } {
  const memoryNotes: string[] = [];
  const cleaned: AgentBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== 'text') {
      cleaned.push(block);
      continue;
    }
    const kept: string[] = [];
    for (const line of block.text.split('\n')) {
      const match = line.match(MEMORY_LINE_RE);
      if (match) memoryNotes.push(match[1].trim());
      else kept.push(line);
    }
    const text = kept.join('\n').trim();
    if (text) cleaned.push({ kind: 'text', text });
  }
  return { blocks: cleaned, memoryNotes };
}

/**
 * Run a scan through Claude. The active context note's instructions become the
 * system prompt; enabled MCP servers are attached via the API's MCP connector so
 * Claude can execute tools (e.g. ScanPower) server-side.
 *
 * Calls the Messages API directly with fetch rather than @anthropic-ai/sdk:
 * the official SDK imports Node's `node:fs` for credential-file handling, which
 * Metro/Hermes can't resolve in a React Native bundle. fetch avoids that entirely.
 *
 * Non-streaming: React Native's fetch does not support reading response-body
 * streams, so we use a plain POST and surface interim state via pause_turn
 * continuations instead of token-level streaming.
 */
export async function runScan(
  apiKey: string,
  settings: AppSettings,
  context: ContextNote | undefined,
  memory: ContextNote | undefined,
  scan: ScanEvent,
  callbacks: RunCallbacks,
): Promise<{ blocks: AgentBlock[]; stopReason: string; memoryNotes: string[] }> {
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
    MEMORY_INSTRUCTION +
    (memoryText ? `\n\nKnown context from previous scans:\n${memoryText}` : '');

  const messages: any[] = [
    {
      role: 'user',
      content: `Scanned barcode: ${scan.data}\nSymbology: ${scan.type}\nScanned at: ${new Date(scan.timestamp).toISOString()}`,
    },
  ];

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

    const { blocks: newBlocks, memoryNotes: newMemoryNotes } = extractMemory(contentToBlocks(response.content));
    allBlocks.push(...newBlocks);
    memoryNotes.push(...newMemoryNotes);
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

  return { blocks: allBlocks, stopReason: response.stop_reason ?? 'end_turn', memoryNotes };
}
