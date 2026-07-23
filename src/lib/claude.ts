import { AgentBlock, AppSettings, ContextNote, ScanEvent } from '../types';

const MAX_CONTINUATIONS = 5;
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface RunCallbacks {
  onBlocks: (blocks: AgentBlock[]) => void;
}

function contentToBlocks(content: any[]): AgentBlock[] {
  const blocks: AgentBlock[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        blocks.push({ kind: 'text', text: block.text });
        break;
      case 'thinking':
        if (block.thinking) blocks.push({ kind: 'thinking', text: block.thinking });
        break;
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
  scan: ScanEvent,
  callbacks: RunCallbacks,
): Promise<{ blocks: AgentBlock[]; stopReason: string }> {
  const enabledServers = settings.mcpServers.filter((s) => s.enabled && s.url);
  const mcpServers = enabledServers.map((s) => ({
    type: 'url' as const,
    url: s.url,
    name: s.name,
    ...(s.authorizationToken ? { authorization_token: s.authorizationToken } : {}),
  }));
  const mcpTools = enabledServers.map((s) => ({
    type: 'mcp_toolset' as const,
    mcp_server_name: s.name,
  }));

  const system =
    context?.instructions ??
    'The user scanned a barcode. Identify the product or content and summarize it concisely.';

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

  const allBlocks: AgentBlock[] = [];
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

    allBlocks.push(...contentToBlocks(response.content));
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

  return { blocks: allBlocks, stopReason: response.stop_reason ?? 'end_turn' };
}
