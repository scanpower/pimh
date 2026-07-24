import { ContextPromptField } from '../types';
import { ApiParameter } from './apiSpecs';

// Property/parameter names that almost always carry the scanned barcode value in ScanPower's API
// (asin, upc, barcode_value, etc.) — matched loosely since naming isn't fully consistent.
const BARCODE_NAME_RE = /barcode|upc|ean|asin|isbn|gtin/i;

function matchPromptField(name: string, promptFields: ContextPromptField[]): ContextPromptField | undefined {
  const lower = name.toLowerCase();
  return promptFields.find((f) => f.id.toLowerCase() === lower || f.label.toLowerCase() === lower);
}

/** A best-guess {{scan}} / {{fieldId}} token for a string-shaped value, or '' if nothing matches. */
function defaultStringToken(name: string, promptFields: ContextPromptField[]): string {
  if (BARCODE_NAME_RE.test(name)) return '{{scan}}';
  const field = matchPromptField(name, promptFields);
  return field ? `{{${field.id}}}` : '';
}

function defaultForSchema(schema: any, name: string, promptFields: ContextPromptField[]): any {
  const type = schema?.type;
  if (type === 'array') {
    return [defaultForSchema(schema.items ?? {}, name, promptFields)];
  }
  if (type === 'object' || schema?.properties) {
    return defaultObject(schema, promptFields);
  }
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  return defaultStringToken(name, promptFields);
}

function defaultObject(schema: any, promptFields: ContextPromptField[]): Record<string, any> {
  const props = schema?.properties ?? {};
  const required: string[] = schema?.required ?? Object.keys(props);
  const out: Record<string, any> = {};
  for (const name of required) {
    out[name] = defaultForSchema(props[name] ?? {}, name, promptFields);
  }
  return out;
}

/**
 * A starter JSON request body template for an operation — only the schema's *required*
 * properties are included, with {{scan}} / {{fieldId}} tokens pre-filled wherever a property
 * looks like a barcode/identifier or matches one of the context's prompt fields by name.
 * Numbers/booleans default to 0/false rather than a token, since an unresolved {{...}} token
 * left inside an unquoted JSON position (e.g. a number) would break JSON.parse after
 * substitution — edit those in by hand if a prompt field should drive them.
 */
export function buildDefaultBodyTemplate(schema: any, promptFields: ContextPromptField[]): string {
  return JSON.stringify(defaultObject(schema, promptFields), null, 2);
}

/** Starter param values for an operation's *required* parameters, guessed the same way. */
export function buildDefaultParamValues(
  parameters: ApiParameter[],
  promptFields: ContextPromptField[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const param of parameters) {
    if (!param.required) continue;
    const token = defaultStringToken(param.name, promptFields);
    if (token) out[param.name] = token;
  }
  return out;
}
