import Anthropic from '@anthropic-ai/sdk';
import { AgentBlock, AppSettings, ContextNote, ScanEvent } from '../types';

const MAX_CONTINUATIONS = 5;

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
 * Non-streaming: React Native's fetch does not support response-body streams,
 * so we use create() and surface interim state via pause_turn continuations.
 */
export async function runScan(
  apiKey: string,
  settings: AppSettings,
  context: ContextNote | undefined,
  scan: ScanEvent,
  callbacks: RunCallbacks,
): Promise<{ blocks: AgentBlock[]; stopReason: string }> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const enabledServers = settings.mcpServers.filter((s) => s.enabled && s.url);
  const mcpServers = enabledServers.map((s) => ({
    type: 'url' as const,
    url: s.url,
    name: s.name,
    ...(s.authorizationToken ? { authorization_token: s.authorizationToken } : {}),
  }));
  const tools = enabledServers.map((s) => ({
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

  const baseParams: any = {
    model: settings.model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system,
  };
  if (mcpServers.length > 0) {
    baseParams.mcp_servers = mcpServers;
    baseParams.tools = tools;
    baseParams.betas = ['mcp-client-2025-11-20'];
  }

  const allBlocks: AgentBlock[] = [];
  let response: any;
  let continuations = 0;

  while (true) {
    response =
      mcpServers.length > 0
        ? await client.beta.messages.create({ ...baseParams, messages })
        : await client.messages.create({ ...baseParams, messages });

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
