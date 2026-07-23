export interface ContextNote {
  id: string;
  name: string;
  /** Instruction text sent to Claude as the system prompt when a barcode is scanned. */
  instructions: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export type McpAuthType = 'none' | 'token' | 'oauth';

export interface McpOAuthConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /** Only for providers that require a confidential client; most mobile OAuth uses PKCE without one. */
  clientSecret?: string;
  scopes: string[];
}

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  authType: McpAuthType;
  /** Static bearer token, used when authType === 'token'. */
  authorizationToken?: string;
  /** OAuth client config, used when authType === 'oauth'. Tokens themselves are stored separately in SecureStore. */
  oauth?: McpOAuthConfig;
}

/** OAuth tokens for one MCP server. Stored in SecureStore, never in AsyncStorage settings. */
export interface StoredOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Undefined means the token doesn't expire or the provider didn't say. */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

export interface AppSettings {
  model: string;
  mcpServers: McpServerConfig[];
  /** Show tool call/result cards in scan results. Off by default — most users just want the final answer. */
  showToolCalls: boolean;
}

export interface ScanEvent {
  data: string;
  type: string;
  timestamp: number;
}

export type AgentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; server: string; tool: string; input: string }
  | { kind: 'tool_result'; content: string; isError: boolean }
  | { kind: 'warning'; text: string };

export interface AgentRun {
  status: 'idle' | 'running' | 'done' | 'error';
  blocks: AgentBlock[];
  error?: string;
  stopReason?: string;
}
