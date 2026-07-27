export type Provider = 'anthropic' | 'openai';

export interface ModelOption {
  /** The literal string sent as `model` in the request. */
  id: string;
  /** What the model picker shows. */
  label: string;
  /** Compact name for the header, where a full model id would overflow the line. */
  short: string;
  provider: Provider;
}

/**
 * Models offered in Settings. `provider` decides which API a scan is sent to and which stored
 * key authenticates it — see agent.ts. Adding a model is just another entry here.
 */
export const MODELS: ModelOption[] = [
  { id: 'claude-opus-5', label: 'claude-opus-5', short: 'Opus 5', provider: 'anthropic' },
  { id: 'claude-sonnet-5', label: 'claude-sonnet-5', short: 'Sonnet 5', provider: 'anthropic' },
  { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5', short: 'Haiku 4.5', provider: 'anthropic' },
  // The GPT-5.6 family is three named tiers, not numbered size variants: Luna is the
  // fastest/cheapest, Terra balances cost against capability, Sol is the frontier model.
  // (A bare `gpt-5.6` also exists and routes to Sol.)
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', short: 'GPT Luna', provider: 'openai' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', short: 'GPT Terra', provider: 'openai' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', short: 'GPT Sol', provider: 'openai' },
];

/**
 * Which API a model id belongs to. Unknown ids fall back to Anthropic, matching the app's
 * original single-provider behaviour — a saved setting from before OpenAI support still works.
 */
export function providerFor(modelId: string): Provider {
  return MODELS.find((m) => m.id === modelId)?.provider ?? 'anthropic';
}

export function labelFor(modelId: string): string {
  return MODELS.find((m) => m.id === modelId)?.label ?? modelId;
}

/** Compact name for the header. Falls back to the raw id for a model not in the catalog. */
export function shortLabelFor(modelId: string): string {
  return MODELS.find((m) => m.id === modelId)?.short ?? modelId;
}
