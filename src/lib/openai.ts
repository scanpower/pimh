import { AgentBlock, AppSettings, ContextNote } from '../types';
import {
  buildSystemPrompt,
  extractSignals,
  flagHallucinatedToolCalls,
  resolveMcpServers,
  RunCallbacks,
  RunResult,
} from './agentCommon';
import { debugLog } from './debugLog';

const API_URL = 'https://api.openai.com/v1/responses';

/**
 * Turn the response's `output` items into display blocks.
 *
 * An `mcp_call` item carries both the invocation and its result, so it expands into a tool_use
 * plus a tool_result — the same pair the Anthropic path produces, which is what lets the shared
 * print trigger (a tool name containing "print") work identically under either provider.
 */
function outputToBlocks(output: any[]): AgentBlock[] {
  const blocks: AgentBlock[] = [];
  for (const item of output ?? []) {
    switch (item.type) {
      case 'message':
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' && part.text) blocks.push({ kind: 'text', text: part.text });
        }
        break;
      case 'mcp_call':
        blocks.push({
          kind: 'tool_use',
          server: item.server_label ?? 'mcp',
          tool: item.name,
          input: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        });
        blocks.push({
          kind: 'tool_result',
          content: item.error ? String(item.error) : String(item.output ?? ''),
          isError: !!item.error,
          tool: item.name,
        });
        break;
      case 'mcp_approval_request':
        // Requests are sent with require_approval:'never', so this shouldn't arrive. If a
        // server forces approval anyway, say so rather than looking like it silently no-oped.
        blocks.push({
          kind: 'warning',
          text: `${item.server_label ?? 'An MCP server'} asked for approval before running "${item.name}", which this app can't grant — the tool did not run.`,
        });
        break;
      // 'mcp_list_tools' is discovery noise, and reasoning items are deliberately not surfaced.
    }
  }
  return blocks;
}

/**
 * Drive one scan against the OpenAI Responses API, with enabled MCP servers attached as
 * `type: "mcp"` tool entries so the model can call them. OpenAI executes those calls itself and
 * returns the results inline, so unlike the Anthropic path there is no pause/continue loop.
 *
 * Called directly with fetch rather than the `openai` package for the same reason as the
 * Anthropic path: the official SDKs pull in Node built-ins that Metro/Hermes can't bundle.
 */
export async function runOpenAiConversation(
  apiKey: string,
  settings: AppSettings,
  context: ContextNote | undefined,
  memory: ContextNote | undefined,
  input: any[],
  callbacks: RunCallbacks,
): Promise<RunResult> {
  const { usable, warnings } = await resolveMcpServers(settings);

  const tools = usable.map(({ server, token }) => ({
    type: 'mcp' as const,
    server_label: server.name,
    server_url: server.url,
    ...(token ? { authorization: token } : {}),
    // The app has no approval UI, and a scan is an explicit user action already — without this
    // the API defaults to "always" and every tool call would stall on an approval request.
    require_approval: 'never' as const,
  }));

  const body: Record<string, unknown> = {
    model: settings.model,
    instructions: buildSystemPrompt(context, memory),
    input,
    // Scans carry customer and inventory data, and the API would otherwise retain each
    // response server-side by default. Nothing here depends on that retention: continuation
    // replays the prior output items through `input` rather than referencing a stored
    // response by id, so opting out costs no functionality.
    store: false,
  };
  if (tools.length > 0) body.tools = tools;

  const allBlocks: AgentBlock[] = [...warnings];
  if (allBlocks.length > 0) callbacks.onBlocks([...allBlocks]);

  const started = Date.now();
  debugLog(`[openai] starting request — model=${settings.model}, mcp servers=${tools.length}`);

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`[openai] network error after ${Date.now() - started}ms:`, e);
    throw e;
  }

  const response = await res.json();
  if (!res.ok) {
    const message = response?.error?.message ?? `Request failed (${res.status})`;
    console.error(`[openai] request failed after ${Date.now() - started}ms: HTTP ${res.status} — ${message}`);
    throw new Error(message);
  }
  debugLog(
    `[openai] resolved in ${Date.now() - started}ms — status=${response.status}, ` +
      `usage=${JSON.stringify(response.usage ?? {})}`,
  );

  const {
    blocks: extracted,
    memoryNotes,
    pendingPrompt,
  } = extractSignals(outputToBlocks(response.output));
  allBlocks.push(...flagHallucinatedToolCalls(extracted));
  callbacks.onBlocks([...allBlocks]);

  if (response.status === 'incomplete') {
    allBlocks.push({
      kind: 'warning',
      text: `The reply was cut short (${response.incomplete_details?.reason ?? 'incomplete'}).`,
    });
    callbacks.onBlocks([...allBlocks]);
  }

  // Keep the assistant's own output items in the transcript so continueScan() can append the
  // user's answer — the Responses API accepts prior output items back as input.
  const messages = [...input, ...(response.output ?? [])];

  return { blocks: allBlocks, stopReason: response.status ?? 'completed', memoryNotes, pendingPrompt, messages };
}
