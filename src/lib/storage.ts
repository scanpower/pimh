import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { AppSettings, ContextNote } from '../types';

const CONTEXTS_KEY = 'midg.contexts.v1';
const SETTINGS_KEY = 'midg.settings.v1';
const API_KEY_KEY = 'midg.anthropic_api_key';

export const DEFAULT_SETTINGS: AppSettings = {
  model: 'claude-opus-4-8',
  mcpServers: [
    {
      id: 'scanpower',
      name: 'scanpower',
      url: 'https://mcp.scanpower.com/mcp',
      authorizationToken: '',
      enabled: false,
    },
  ],
};

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
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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
