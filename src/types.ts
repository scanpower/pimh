export interface ContextPromptField {
  id: string;
  /** Shown as the field's label in the pre-scan form. */
  label: string;
  type: 'text' | 'select';
  /** For type 'select' only. */
  options?: string[];
}

export interface ContextNote {
  id: string;
  name: string;
  /**
   * Instruction text sent to Claude as the system prompt when a barcode is
   * scanned. May reference promptFields values via {{fieldId}}.
   */
  instructions: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * The one special, non-selectable "Memory" note (there's exactly one).
   * Its `instructions` field holds facts auto-extracted from tool call
   * results across scans, appended to the system prompt on every scan
   * alongside the active context.
   */
  isMemory?: boolean;
  /**
   * Optional structured inputs collected from the user before a scan runs
   * with this context active — e.g. quantity, warehouse location. Values
   * are substituted into `instructions` via {{fieldId}} and also passed to
   * Claude alongside the scan.
   */
  promptFields?: ContextPromptField[];
  /**
   * An operation from a bundled OpenAPI spec (see src/lib/apiSpecs.ts) this
   * context calls directly, bypassing Claude/MCP entirely — for deterministic
   * lookups/actions that don't need model judgment.
   */
  apiOperation?: {
    specId: string;
    operationId: string;
    /**
     * Template per path/query/header parameter name — same {{fieldId}} substitution as
     * `instructions`, plus a reserved {{scan}} token for the scanned barcode value.
     */
    paramValues?: Record<string, string>;
    /** JSON request body template (POST/PUT/PATCH operations) — substituted, then JSON-parsed. */
    bodyTemplate?: string;
  };
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

/** A printer chosen via expo-print's selectPrinterAsync (iOS only). */
export interface PrinterConfig {
  name: string;
  url: string;
}

export interface AppSettings {
  model: string;
  mcpServers: McpServerConfig[];
  /** Show tool call/result cards in scan results. Off by default — most users just want the final answer. */
  showToolCalls: boolean;
  /**
   * Emit the verbose [directApi]/[claude]/[openai]/[print] traces. Those include request
   * bodies and resolved values, so they default to dev builds only. Errors log regardless.
   */
  debugLogging: boolean;
  /**
   * Default printer for contexts that trigger printing (instructions containing the word
   * "print"). iOS only — null means the system print dialog's printer picker is used instead.
   */
  printer: PrinterConfig | null;
}

export interface ScanEvent {
  data: string;
  type: string;
  timestamp: number;
}

export type AgentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; server: string; tool: string; input: string }
  /** `tool` is the name of the tool call this result answers, when known (see contentToBlocks). */
  | { kind: 'tool_result'; content: string; isError: boolean; tool?: string }
  | { kind: 'warning'; text: string }
  /**
   * One collapsible group of fields from a direct API response — e.g. a single inbound plan
   * out of an `inbound_plans` array. Labels keep the API's own attribute name verbatim, so a
   * value saved to Memory can be referenced by that same name; null attributes are dropped
   * rather than shown as empty.
   */
  | {
      kind: 'api_section';
      title: string;
      rows: { label: string; value: string }[];
      /** The section to open on arrival — the first object of the returned collection. */
      primary?: boolean;
    }
  /** Diagnostic record of one printContent() call — shown alongside tool results for debugging. */
  | { kind: 'print_log'; text: string; isError: boolean };

/** A question Claude needs answered before it can finish, parsed out of its reply. */
export type PendingPrompt =
  | { kind: 'ask'; question: string }
  | { kind: 'choose'; question: string; options: string[] };

export interface AgentRun {
  status: 'idle' | 'running' | 'done' | 'error';
  blocks: AgentBlock[];
  error?: string;
  stopReason?: string;
  /** Set when Claude is waiting on a free-text answer or a choice before it can continue. */
  pendingPrompt?: PendingPrompt;
  /** Conversation so far — needed to continue after the user answers a pendingPrompt. */
  messages?: any[];
}
