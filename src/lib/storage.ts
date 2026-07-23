import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { AppSettings, ContextNote, McpServerConfig, StoredOAuthTokens } from '../types';

const CONTEXTS_KEY = 'midg.contexts.v1';
const SETTINGS_KEY = 'midg.settings.v1';
const API_KEY_KEY = 'midg.anthropic_api_key';
const OAUTH_KEY_PREFIX = 'midg.mcp_oauth.';

export const DEFAULT_SETTINGS: AppSettings = {
  model: 'claude-opus-4-8',
  showToolCalls: false,
  mcpServers: [
    {
      id: 'scanpower',
      name: 'scanpower',
      url: 'https://mcp.scanpower.com/mcp',
      enabled: false,
      authType: 'oauth',
      oauth: {
        authorizationEndpoint: 'https://mcp.scanpower.com',
        tokenEndpoint: 'https://mcp.scanpower.com',
        clientId: '',
        scopes: [],
      },
    },
  ],
};

/** Backfill fields for MCP server configs saved before OAuth support existed. */
function normalizeServer(s: any): McpServerConfig {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    enabled: !!s.enabled,
    authType: s.authType ?? (s.authorizationToken ? 'token' : 'none'),
    authorizationToken: s.authorizationToken ?? '',
    oauth: s.oauth,
  };
}

export const DEFAULT_CONTEXT: ContextNote = {
  id: 'default-lookup',
  name: 'Product lookup',
  instructions:
    'You are a product-scanning assistant for an e-commerce seller. The user scans a 1D barcode (usually a UPC/EAN). ' +
    'Identify the product if you can, and if MCP tools are available (e.g. ScanPower), use them to look up the item, ' +
    'current inventory, pricing, and profitability. Reply with a concise summary the user can read on a phone screen, ' +
    'leading with the product name and the single most important fact or recommended action.',
  active: true,
  createdAt: 0,
  updatedAt: 0,
};

export async function loadContexts(): Promise<ContextNote[]> {
  const raw = await AsyncStorage.getItem(CONTEXTS_KEY);
  if (!raw) return [DEFAULT_CONTEXT];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [DEFAULT_CONTEXT];
}

export async function saveContexts(contexts: ContextNote[]): Promise<void> {
  await AsyncStorage.setItem(CONTEXTS_KEY, JSON.stringify(contexts));
}

export async function loadSettings(): Promise<AppSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    return {
      ...parsed,
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers.map(normalizeServer) : [],
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export async function loadApiKey(): Promise<string> {
  return (await SecureStore.getItemAsync(API_KEY_KEY)) ?? '';
}

export async function saveApiKey(key: string): Promise<void> {
  if (key) await SecureStore.setItemAsync(API_KEY_KEY, key);
  else await SecureStore.deleteItemAsync(API_KEY_KEY);
}

function oauthKey(serverId: string): string {
  return `${OAUTH_KEY_PREFIX}${serverId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/** MCP OAuth tokens live in SecureStore only — never written to the AsyncStorage settings blob. */
export async function loadOAuthTokens(serverId: string): Promise<StoredOAuthTokens | null> {
  const raw = await SecureStore.getItemAsync(oauthKey(serverId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveOAuthTokens(serverId: string, tokens: StoredOAuthTokens): Promise<void> {
  await SecureStore.setItemAsync(oauthKey(serverId), JSON.stringify(tokens));
}

export async function clearOAuthTokens(serverId: string): Promise<void> {
  await SecureStore.deleteItemAsync(oauthKey(serverId));
}

/** Parse imported context notes. Accepts a JSON array of notes or a single note object. */
export function parseImportedContexts(json: string): Omit<ContextNote, 'id' | 'active' | 'createdAt' | 'updatedAt'>[] {
  const parsed = JSON.parse(json);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item, i) => {
    const name = typeof item.name === 'string' ? item.name : `Imported ${i + 1}`;
    const instructions =
      typeof item.instructions === 'string'
        ? item.instructions
        : typeof item.text === 'string'
          ? item.text
          : typeof item.content === 'string'
            ? item.content
            : null;
    if (instructions === null) {
      throw new Error(`Item ${i + 1} has no "instructions" field`);
    }
    return { name, instructions };
  });
}
