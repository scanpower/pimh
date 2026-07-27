import { ContextPromptField } from '../types';

/** Replace {{fieldId}} occurrences in a context's instructions with collected prompt-field values. */
export function substituteFields(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, id) => (id in values ? values[id] : match));
}

function slugifyLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Prompt field values are collected keyed by field id (e.g. "field_1"), but it's natural to
 * reference a field by its label instead when hand-writing a {{...}} template — add a
 * label-slug alias for each field (e.g. "Quantity" -> {{quantity}}) alongside its id, so
 * either works. Label aliases never override an existing id/key with the same name.
 */
export function expandFieldAliases(
  promptFields: ContextPromptField[] | undefined,
  fieldValues: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...(fieldValues ?? {}) };
  for (const field of promptFields ?? []) {
    const value = fieldValues?.[field.id];
    if (value === undefined) continue;
    const slug = slugifyLabel(field.label);
    if (slug && !(slug in out)) out[slug] = value;
  }
  return out;
}

const MEMORY_FACT_RE = /^\s*([A-Za-z][A-Za-z0-9 _-]{0,39}?)\s*:\s*(.+?)\s*$/;

/**
 * Parse "Key: value" style lines out of the Memory context's free-text notes (the format the
 * MEMORY: signal lines are asked to use, e.g. "asin: B08XYZ123") into a lookup keyed the same
 * way prompt-field labels are — so a {{fieldId}}-style template can also pull in a remembered
 * fact by name (e.g. {{asin}}) when nothing else supplies it. Lines that don't look like
 * "key: value" are skipped; later lines win on a repeated key, matching how Memory keeps its
 * most recent facts toward the end.
 */
export function parseMemoryFacts(memoryText: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (memoryText ?? '').split('\n')) {
    const match = line.match(MEMORY_FACT_RE);
    if (!match) continue;
    const slug = slugifyLabel(match[1]);
    if (slug) out[slug] = match[2].trim();
  }
  return out;
}
