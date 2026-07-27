import type { AgentBlock } from '../types';
import type { ApiOperation } from './apiSpecs';
import type { DirectCallResult } from './directApi';

// Keep a section readable on a phone screen — a plan with a very long field gets truncated
// rather than pushing the rest of the section off the row.
const MAX_VALUE_CHARS = 160;
// A list endpoint can return a lot of rows; cap how many get their own section.
const MAX_SECTIONS = 25;

// Matches the same base64 PDF data URI shape print.ts looks for. A label response can be
// hundreds of KB of base64, so it is described by size rather than printed.
const PDF_DATA_URI_RE = /data:application\/pdf[^,]*,([A-Za-z0-9+/=]+)/i;

/**
 * "inbound_plans" -> "inbound_plan", so each element titles as a singular thing. Attribute
 * names are otherwise shown exactly as the API returns them: re-casing them to Title style
 * would mean a fact saved to Memory no longer matches the name a template has to reference.
 */
function singularTitle(key: string): string {
  return /[^s]s$/.test(key) ? key.slice(0, -1) : key;
}

function formatScalar(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type Row = { label: string; value: string };

/**
 * Flatten one object into label/value rows. Labels use the attribute's own name only — nested
 * paths are not prefixed, per the display convention for these summaries. Null and undefined
 * attributes are omitted entirely rather than rendered as blanks.
 */
function toRows(node: Record<string, unknown>, rows: Row[] = []): Row[] {
  for (const [key, value] of Object.entries(node)) {
    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      // Nested collections stay summarized — expanding them here would bury the plan's own
      // fields under its children.
      if (value.some(isPlainObject)) {
        rows.push({ label: key, value: `${value.length} item(s)` });
      } else {
        rows.push({ label: key, value: value.map(formatScalar).join(', ') });
      }
      continue;
    }

    if (isPlainObject(value)) {
      toRows(value, rows);
      continue;
    }

    rows.push({ label: key, value: formatScalar(value) });
  }
  return rows;
}

function sectionsFromArray(key: string, items: unknown[]): AgentBlock[] {
  const title = singularTitle(key);
  const blocks: AgentBlock[] = [];
  items.slice(0, MAX_SECTIONS).forEach((item, i) => {
    const rows = isPlainObject(item) ? toRows(item) : [{ label: key, value: formatScalar(item) }];
    if (rows.length > 0) blocks.push({ kind: 'api_section', title: `${title} ${i + 1}`, rows });
  });
  if (items.length > MAX_SECTIONS) {
    blocks.push({
      kind: 'text',
      text: `_…and ${items.length - MAX_SECTIONS} more ${title.toLowerCase()}(s) not shown._`,
    });
  }
  return blocks;
}

type SectionBlock = Extract<AgentBlock, { kind: 'api_section' }>;

/** Mark the first section as the one to open on arrival. Returns false if there were none. */
function markPrimary(blocks: AgentBlock[]): boolean {
  const first = blocks.find((b): b is SectionBlock => b.kind === 'api_section');
  if (!first) return false;
  first.primary = true;
  return true;
}

function sectionsFromJson(parsed: unknown, op: ApiOperation): AgentBlock[] {
  if (Array.isArray(parsed)) {
    const blocks = sectionsFromArray(op.operationId, parsed);
    markPrimary(blocks);
    return blocks;
  }
  if (!isPlainObject(parsed)) return [{ kind: 'text', text: formatScalar(parsed) }];

  const blocks: AgentBlock[] = [];
  const topLevel: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || value === undefined) continue;
    // An array of objects is the thing worth breaking out — one section per element.
    if (Array.isArray(value) && value.some(isPlainObject)) {
      blocks.push(...sectionsFromArray(key, value));
    } else {
      topLevel[key] = value;
    }
  }

  // Open the first object of the collection — that's what the scan was for. Done before the
  // top-level section is prepended so a stray "2 total rows" card never wins the slot.
  const openedCollection = markPrimary(blocks);

  // Anything left at the top level (e.g. total_rows) goes in its own section above the rest.
  const topRows = toRows(topLevel);
  if (topRows.length > 0) {
    const top: SectionBlock = { kind: 'api_section', title: op.operationId, rows: topRows };
    if (!openedCollection) top.primary = true; // it's the only section, so it is the answer
    blocks.unshift(top);
  }
  return blocks;
}

/**
 * Render a direct API call's result as displayable blocks, so it shows up in the results view
 * the same way a Claude answer does. Without this a direct-API context renders nothing at all
 * unless "Show tool calls" is on, since only text/warning/api_section blocks display by default.
 */
export function summarizeApiResult(op: ApiOperation, result: DirectCallResult): AgentBlock[] {
  const ok = result.status >= 200 && result.status < 300;
  const title = op.summary?.trim() || op.operationId;
  const header: AgentBlock = {
    kind: 'text',
    text: `**${title}** — ${ok ? '✓' : '✕'} ${result.status} · \`${op.method.toUpperCase()} ${op.path}\``,
  };

  const bodyText = result.text.trim();

  if (!ok) {
    const shown = bodyText.length > 400 ? `${bodyText.slice(0, 400)}…` : bodyText;
    return [header, { kind: 'text', text: shown ? ['```', shown, '```'].join('\n') : '_No error detail returned._' }];
  }

  if (!bodyText) return [header, { kind: 'text', text: '_No response body._' }];

  const pdf = bodyText.match(PDF_DATA_URI_RE);
  if (pdf) {
    // 4 base64 chars encode 3 bytes; close enough for a human-facing size.
    const kb = Math.round((pdf[1].length * 3) / 4 / 1024);
    return [header, { kind: 'text', text: `Returned a **PDF document** (~${kb} KB).` }];
  }

  try {
    const sections = sectionsFromJson(JSON.parse(bodyText), op);
    return sections.length > 0 ? [header, ...sections] : [header, { kind: 'text', text: '_Empty JSON response._' }];
  } catch {
    // Not JSON — show it as-is, truncated. Covers text/plain label data.
    const shown = bodyText.length > 600 ? `${bodyText.slice(0, 600)}…` : bodyText;
    return [header, { kind: 'text', text: ['```', shown, '```'].join('\n') }];
  }
}
