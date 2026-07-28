import { AgentBlock, AppSettings, ContextNote, PendingPrompt } from '../types';
import {
  buildSystemPrompt,
  extractSignals,
  flagHallucinatedToolCalls,
  resolveMcpServers,
  RunCallbacks,
  RunResult,
} from './agentCommon';
import { debugLog } from './debugLog';
import { supportsAdaptiveThinking } from './models';

const MAX_CONTINUATIONS = 5;
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

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
export async function runAnthropicConversation(
  apiKey: string,
  settings: AppSettings,
  context: ContextNote | undefined,
  memory: ContextNote | undefined,
  initialMessages: any[],
  callbacks: RunCallbacks,
): Promise<RunResult> {
  const { usable, warnings: preflightWarnings } = await resolveMcpServers(settings);

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

  const system = buildSystemPrompt(context, memory);

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
    system,
  };
  // Only for models that accept it — see supportsAdaptiveThinking. Sending it to one that
  // doesn't fails the request rather than being ignored.
  if (supportsAdaptiveThinking(settings.model)) {
    baseBody.thinking = { type: 'adaptive' };
  }
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
  const runStart = Date.now();
  debugLog(
    `[claude] starting request — model=${settings.model}, mcp servers=${mcpServers.length}, ` +
      `messages=${messages.length}`,
  );

  while (true) {
    const requestNumber = continuations + 1;
    const reqStart = Date.now();
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...baseBody, messages }),
      });
    } catch (e: any) {
      console.error(`[claude] request ${requestNumber} network error after ${Date.now() - reqStart}ms:`, e);
      throw e;
    }
    response = await res.json();
    const reqElapsed = Date.now() - reqStart;
    if (!res.ok) {
      const message = response?.error?.message ?? `Request failed (${res.status})`;
      console.error(`[claude] request ${requestNumber} failed after ${reqElapsed}ms: HTTP ${res.status} — ${message}`);
      throw new Error(message);
    }
    debugLog(
      `[claude] request ${requestNumber} resolved in ${reqElapsed}ms — stop_reason=${response.stop_reason}, ` +
        `usage=${JSON.stringify(response.usage ?? {})}`,
    );

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

  debugLog(
    `[claude] conversation turn finished in ${Date.now() - runStart}ms across ${continuations + 1} request(s)`,
  );

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
