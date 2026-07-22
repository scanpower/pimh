export interface ContextNote {
  id: string;
  name: string;
  /** Instruction text sent to Claude as the system prompt when a barcode is scanned. */
  instructions: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  authorizationToken?: string;
  enabled: boolean;
}

export interface AppSettings {
  model: string;
  mcpServers: McpServerConfig[];
}

export interface ScanEvent {
  data: string;
  type: string;
  timestamp: number;
}

export type AgentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; server: string; tool: string; input: string }
  | { kind: 'tool_result'; content: string; isError: boolean };

export interface AgentRun {
  status: 'idle' | 'running' | 'done' | 'error';
  blocks: AgentBlock[];
  error?: string;
  stopReason?: string;
}
