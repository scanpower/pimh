import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { AppSettings, ContextNote, McpServerConfig, StoredOAuthTokens } from '../types';

const CONTEXTS_KEY = 'pimh.contexts.v1';
const SETTINGS_KEY = 'pimh.settings.v1';
const API_KEY_KEY = 'pimh.anthropic_api_key';
const OPENAI_API_KEY_KEY = 'pimh.openai_api_key';
const OAUTH_KEY_PREFIX = 'pimh.mcp_oauth.';

// The app stored under a `midg.` prefix before the midg -> pimw -> pimh renames. These are read
// once by migrateLegacyStorage() so an existing install keeps its contexts, API keys and MCP
// sign-ins; drop them (and the migration) once every install has launched on this build.
const LEGACY_CONTEXTS_KEY = 'midg.contexts.v1';
const LEGACY_SETTINGS_KEY = 'midg.settings.v1';
const LEGACY_API_KEY_KEY = 'midg.anthropic_api_key';
const LEGACY_OPENAI_API_KEY_KEY = 'midg.openai_api_key';
const LEGACY_OAUTH_KEY_PREFIX = 'midg.mcp_oauth.';


export const DEFAULT_SETTINGS: AppSettings = {
  model: 'claude-opus-5',
  showToolCalls: false,
  // Matches debugLog.ts's own default, so Expo Go keeps today's output and a production
  // build starts quiet. The Settings toggle overrides either way.
  debugLogging: typeof __DEV__ !== 'undefined' ? __DEV__ : false,
  printer: null,
  mcpServers: [
    {
      id: 'scanpower',
      name: 'scanpower',
      url: 'https://mcp.scanpower.com/mcp',
      enabled: false,
      authType: 'oauth',
      oauth: {
        authorizationEndpoint: 'https://mcp.scanpower.com/authorize',
        tokenEndpoint: 'https://mcp.scanpower.com/token',
        clientId: '',
        scopes: [],
      },
    },
  ],
};

/** Move one AsyncStorage value to its new key, leaving an already-migrated value alone. */
async function migrateAsyncKey(legacyKey: string, key: string): Promise<void> {
  if ((await AsyncStorage.getItem(key)) !== null) return; // already migrated, or written fresh
  const legacy = await AsyncStorage.getItem(legacyKey);
  if (legacy === null) return;
  await AsyncStorage.setItem(key, legacy);
  await AsyncStorage.removeItem(legacyKey);
}

/** As migrateAsyncKey, for Keychain items. */
async function migrateSecureKey(legacyKey: string, key: string): Promise<void> {
  try {
    if (await SecureStore.getItemAsync(key)) return;
    const legacy = await SecureStore.getItemAsync(legacyKey);
    if (!legacy) return;
    await SecureStore.setItemAsync(key, legacy);
    await SecureStore.deleteItemAsync(legacyKey);
  } catch {
    // A Keychain read/write failing shouldn't stop the app starting — worst case the item
    // stays under its old name and the user re-enters it.
  }
}

/**
 * One-time move of everything stored under the former `midg.` names to `pimh.`. Safe to run on
 * every launch: each item is copied only when nothing exists under the new key, and the old
 * copy is removed once it has, so a value written since the rename always wins. Must finish
 * before anything is loaded, or an existing install reads empty and then saves over its own
 * pre-rename data.
 */
export async function migrateLegacyStorage(): Promise<void> {
  await migrateAsyncKey(LEGACY_CONTEXTS_KEY, CONTEXTS_KEY);
  await migrateAsyncKey(LEGACY_SETTINGS_KEY, SETTINGS_KEY);
  await migrateSecureKey(LEGACY_API_KEY_KEY, API_KEY_KEY);
  await migrateSecureKey(LEGACY_OPENAI_API_KEY_KEY, OPENAI_API_KEY_KEY);

  // OAuth tokens are keyed per server id and SecureStore can't be enumerated, so the migrated
  // settings are the only record of which ids exist — hence after the settings move above.
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) return;
  try {
    const servers = JSON.parse(raw)?.mcpServers;
    if (!Array.isArray(servers)) return;
    for (const server of servers) {
      if (!server?.id) continue;
      const safeId = String(server.id).replace(/[^a-zA-Z0-9._-]/g, '_');
      await migrateSecureKey(`${LEGACY_OAUTH_KEY_PREFIX}${safeId}`, `${OAUTH_KEY_PREFIX}${safeId}`);
    }
  } catch {
    // Unreadable settings — nothing to learn about server ids, so nothing to migrate.
  }
}

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

/**
 * The context a fresh install starts on: look the scanned item up with ScanPower's get_inventory
 * tool, then print a label for it. A worked example of a chained context (apiOperation with
 * runAfterModel) — the model finds the FNSKU and title, and the itemLabel call turns them into a
 * label. Only `copies` is spelled by the API's schema rather than by the prompt field it comes
 * from; the rest of the body reads as written.
 */
export const DEFAULT_CONTEXT: ContextNote = {
  id: 'print-item-label',
  name: 'Print Item Label',
  instructions:
    'You are a warehouse assistant for an e-commerce seller. The user scans a 1D barcode and wants an item ' +
    'label printed for it.\n\n' +
    'Call the ScanPower get_inventory tool with the scanned barcode to identify the item, and report its FNSKU ' +
    'and product title — the label is generated from those. If get_inventory returns more than one match, use ' +
    'CHOOSE to let the user pick which one. If it returns nothing, say so plainly and do not invent an FNSKU: a ' +
    'guessed barcode prints a label that sends the item to the wrong place.\n\n' +
    'Keep your reply to one short line naming the item — the label prints on its own once you are done.',
  active: true,
  createdAt: 0,
  updatedAt: 0,
  promptFields: [{ id: 'quantity', label: 'Quantity', type: 'text' }],
  apiOperation: {
    specId: 'scanpower',
    operationId: 'itemLabel',
    runAfterModel: true,
    // `copies` is the field the schema defines for the label count — it's declared a number, so
    // the quantity typed into the prompt field is coerced from text on the way out. Accept is
    // left unset deliberately: asking for application/pdf returns raw binary, which the response
    // is not currently read as (see SECURITY-AUDIT C3), whereas the default is a data URI that
    // print.ts already handles.
    bodyTemplate: `{
  "label_width": 2.25,
  "label_height": 1,
  "items": [
    {
      "barcode_value": "{{fnsku}}",
      "copies": "{{quantity}}",
      "condition": "New",
      "title": "{{title}}"
    }
  ]
}`,
  },
};

export const DEFAULT_MEMORY_CONTEXT: ContextNote = {
  id: 'memory',
  name: 'Memory',
  instructions: '',
  active: false,
  createdAt: 0,
  updatedAt: 0,
  isMemory: true,
};

export async function loadContexts(): Promise<ContextNote[]> {
  const raw = await AsyncStorage.getItem(CONTEXTS_KEY);
  let contexts: ContextNote[];
  if (!raw) {
    contexts = [DEFAULT_CONTEXT];
  } else {
    try {
      const parsed = JSON.parse(raw);
      contexts = Array.isArray(parsed) ? parsed : [DEFAULT_CONTEXT];
    } catch {
      contexts = [DEFAULT_CONTEXT];
    }
  }
  // The Memory note is always present — inject it for installs from before this existed.
  if (!contexts.some((c) => c.isMemory)) {
    contexts = [...contexts, { ...DEFAULT_MEMORY_CONTEXT }];
  }
  return contexts;
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

/** Stored separately from the Anthropic key — a scan uses whichever the selected model needs. */
export async function loadOpenAiKey(): Promise<string> {
  return (await SecureStore.getItemAsync(OPENAI_API_KEY_KEY)) ?? '';
}

export async function saveOpenAiKey(key: string): Promise<void> {
  if (key) await SecureStore.setItemAsync(OPENAI_API_KEY_KEY, key);
  else await SecureStore.deleteItemAsync(OPENAI_API_KEY_KEY);
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

/** Delete a Keychain item, tolerating one that was never written. */
async function deleteSecure(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Nothing stored under that key — nothing to undo.
  }
}

/**
 * Erase everything this app has persisted: contexts and Memory, the settings blob, both API
 * keys and every MCP server's OAuth tokens. Irreversible, and the caller is responsible for
 * confirming intent first (see SettingsScreen) and for reloading its own state afterwards.
 *
 * `servers` is required because SecureStore can't be enumerated — OAuth tokens are keyed per
 * server id, so the configured servers are the only way to know which entries exist.
 */
export async function resetAllData(servers: McpServerConfig[]): Promise<void> {
  await Promise.all([
    // Legacy names too, so a reset still erases everything if the migration never ran.
    AsyncStorage.multiRemove([CONTEXTS_KEY, SETTINGS_KEY, LEGACY_CONTEXTS_KEY, LEGACY_SETTINGS_KEY]),
    deleteSecure(API_KEY_KEY),
    deleteSecure(OPENAI_API_KEY_KEY),
    deleteSecure(LEGACY_API_KEY_KEY),
    deleteSecure(LEGACY_OPENAI_API_KEY_KEY),
    ...servers.flatMap((s) => {
      const safeId = String(s.id).replace(/[^a-zA-Z0-9._-]/g, '_');
      return [clearOAuthTokens(s.id), deleteSecure(`${LEGACY_OAUTH_KEY_PREFIX}${safeId}`)];
    }),
  ]);
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
