import { AppSettings, McpServerConfig } from '../types';
import { ApiOperation, getAuthOperation, getSpecLabel } from './apiSpecs';
import { substituteFields } from './templating';

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** UTF-8-safe base64 encode — Hermes doesn't provide a global btoa/Buffer. */
function base64Encode(input: string): string {
  const bytes = Array.from(input).flatMap((ch) => {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) return [code];
    // Minimal UTF-8 encoding, enough for typical credential characters.
    if (code < 0x800) {
      return [0xc0 | (code >> 6), 0x80 | (code & 0x3f)];
    }
    return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)];
  });

  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0xf) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
  }
  return out;
}

function base64Decode(input: string): string {
  // JWT payloads are base64url — '-' and '_' stand in for '+' and '/'. Translate them back
  // before decoding; stripping them as "invalid" instead silently corrupts the payload.
  const clean = input.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const lookup = (c: string) => BASE64_CHARS.indexOf(c);
  let out = '';
  for (let i = 0; i < clean.length; i += 4) {
    const n0 = lookup(clean[i]);
    const n1 = lookup(clean[i + 1]);
    const n2 = clean[i + 2] !== undefined ? lookup(clean[i + 2]) : -1;
    const n3 = clean[i + 3] !== undefined ? lookup(clean[i + 3]) : -1;
    out += String.fromCharCode((n0 << 2) | (n1 >> 4));
    if (n2 >= 0) out += String.fromCharCode(((n1 & 0xf) << 4) | (n2 >> 2));
    if (n3 >= 0) out += String.fromCharCode(((n2 & 0x3) << 6) | n3);
  }
  return out;
}

/**
 * iOS's keyboard silently converts straight quotes to curly "smart quotes" while typing — an easy
 * way to end up with invalid JSON in a hand-edited body template — so normalize them back before
 * parsing rather than requiring the user to disable Smart Punctuation system-wide.
 */
function normalizeSmartQuotes(text: string): string {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

/** A template string that is nothing but a single {{token}}, e.g. "{{quantity}}". */
const WHOLE_TOKEN_RE = /^\{\{\w+\}\}$/;

/**
 * Coerce a substituted value to the type the schema declares, but only when the template was
 * exactly one token (so the value isn't part of a larger string). Identifiers that merely look
 * numeric — a barcode with a leading zero — keep their string form unless the schema actually
 * asks for a number, which is why this consults the schema instead of sniffing the value.
 */
function coerceToSchemaType(resolved: string, template: string, schema: any): string | number | boolean {
  if (!WHOLE_TOKEN_RE.test(template)) return resolved;
  const type = schema?.type;
  if (type === 'number' || type === 'integer') {
    const n = Number(resolved);
    return resolved.trim() !== '' && Number.isFinite(n) ? n : resolved;
  }
  if (type === 'boolean') {
    if (/^\s*true\s*$/i.test(resolved)) return true;
    if (/^\s*false\s*$/i.test(resolved)) return false;
  }
  return resolved;
}

/**
 * Substitute {{...}} tokens into an already-parsed JSON body, walking the parsed value rather
 * than the raw template text. This is what keeps a substituted value from introducing JSON
 * structure: a quote or backslash inside a product title stays inside the string it belongs to
 * instead of terminating it, so neither a scanned barcode nor a remembered fact can reshape the
 * request. `schema` is walked in parallel purely to type-coerce whole-token values.
 */
function substituteInJson(node: any, schema: any, values: Record<string, string>): any {
  if (typeof node === 'string') {
    return coerceToSchemaType(substituteFields(node, values), node, schema);
  }
  if (Array.isArray(node)) {
    return node.map((item) => substituteInJson(item, schema?.items, values));
  }
  if (node && typeof node === 'object') {
    const props = schema?.properties ?? {};
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = substituteInJson(value, props[key], values);
    }
    return out;
  }
  return node;
}

/** Decode a JWT's payload to read its `exp` claim, without verifying the signature. */
function decodeJwtExpiry(jwt: string): number | undefined {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return undefined;
    const json = JSON.parse(base64Decode(payload));
    return typeof json.exp === 'number' ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Credentials configured on an MCP server, expressed as an HTTP Basic auth pair —
 * reused as-is for specs whose REST auth is HTTP Basic → bearer token exchange:
 *  - authType 'oauth': the OAuth client id/secret (a confidential client's Basic
 *    credentials per RFC 6749 §2.3.1) double as the API's basic-auth username/password.
 *  - authType 'token': the static token is sent as the Basic auth username with a
 *    blank password.
 */
function basicAuthPairFor(server: McpServerConfig): { username: string; password: string } | null {
  if (server.authType === 'oauth' && server.oauth?.clientId) {
    return { username: server.oauth.clientId, password: server.oauth.clientSecret ?? '' };
  }
  if (server.authType === 'token' && server.authorizationToken) {
    return { username: server.authorizationToken, password: '' };
  }
  return null;
}

/** Find the MCP server configured for a spec, matched by name against the spec's label. */
function findServerForSpec(settings: AppSettings, specId: string): McpServerConfig | undefined {
  const label = getSpecLabel(specId);
  if (!label) return undefined;
  return settings.mcpServers.find((s) => s.name.trim().toLowerCase() === label.toLowerCase());
}

interface SessionToken {
  token: string;
  expiresAt?: number;
}

// In-memory only, keyed by specId — intentionally separate from the persisted MCP
// OAuth tokens in SecureStore. Each app session mints its own bearer token(s) on
// first use and holds them only for the life of the running app.
const sessionTokens = new Map<string, SessionToken>();

async function mintBearerToken(specId: string, settings: AppSettings): Promise<string> {
  const authOp = getAuthOperation(specId);
  if (!authOp) throw new Error(`No auth operation registered for spec "${specId}".`);

  const server = findServerForSpec(settings, specId);
  if (!server) {
    throw new Error(`No MCP server named "${getSpecLabel(specId)}" found in Settings to authenticate with.`);
  }
  const pair = basicAuthPairFor(server);
  if (!pair) {
    throw new Error(
      `"${server.name}" has no usable credentials for direct API calls — set a static token or OAuth client id.`,
    );
  }

  const base = authOp.servers[0];
  if (!base) throw new Error(`Spec "${specId}" has no server URL for its auth operation.`);
  const url = `${base}${authOp.path}`;

  const res = await fetch(url, {
    method: authOp.method.toUpperCase(),
    headers: {
      Authorization: `Basic ${base64Encode(`${pair.username}:${pair.password}`)}`,
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${authOp.operationId} failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const token = body.trim();
  sessionTokens.set(specId, { token, expiresAt: decodeJwtExpiry(token) });
  console.log(`[directApi] minted a new session token for "${specId}" via ${authOp.operationId}`);
  return token;
}

/**
 * Return a valid bearer token for a spec's direct API calls, minting a new one via
 * the matched MCP server's configured credentials if there's no cached token or the
 * cached one is expired/expiring soon. Session-scoped — never persisted to disk.
 */
export async function getBearerToken(specId: string, settings: AppSettings): Promise<string> {
  const cached = sessionTokens.get(specId);
  const isFresh = cached && (!cached.expiresAt || cached.expiresAt - Date.now() > 60_000);
  if (isFresh) return cached.token;
  return mintBearerToken(specId, settings);
}

export function clearSessionToken(specId: string): void {
  sessionTokens.delete(specId);
}

export interface DirectCallResult {
  status: number;
  contentType: string;
  text: string;
}

/**
 * Execute an operation directly against its REST API, bypassing Claude/MCP entirely.
 *
 * `values` is the substitution source for {{...}} tokens in `paramValues`/`bodyTemplate` —
 * conventionally `{ scan: <barcode>, ...promptFieldValues }`. Path/query/header parameters
 * are resolved from `paramValues` (a per-parameter-name template); an empty/missing template
 * means that parameter is omitted from the request. `bodyTemplate`, if set, is substituted
 * and then JSON-parsed to form the request body.
 */
export async function callOperation(
  op: ApiOperation,
  settings: AppSettings,
  values: Record<string, string>,
  paramValues: Record<string, string> | undefined,
  bodyTemplate: string | undefined,
): Promise<DirectCallResult> {
  const base = op.servers[0];
  if (!base) throw new Error(`Operation "${op.operationId}" has no server URL.`);

  let path = op.path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {};
  const resolvedParams: Record<string, string> = {};

  for (const param of op.parameters) {
    const template = paramValues?.[param.name];
    if (!template) continue;
    const resolved = substituteFields(template, values);
    if (!resolved) continue;
    resolvedParams[param.name] = resolved;
    if (param.in === 'path') {
      path = path.replace(`{${param.name}}`, encodeURIComponent(resolved));
    } else if (param.in === 'query') {
      query.set(param.name, resolved);
    } else if (param.in === 'header') {
      headers[param.name] = resolved;
    }
  }

  console.log(
    `[directApi] ${op.operationId} resolved parameters: ${JSON.stringify(resolvedParams)} ` +
      `(from templates: ${JSON.stringify(paramValues ?? {})})`,
  );

  if (op.security === 'bearer') {
    headers.Authorization = `Bearer ${await getBearerToken(op.specId, settings)}`;
  } else if (op.security === 'basic') {
    const server = findServerForSpec(settings, op.specId);
    const pair = server && basicAuthPairFor(server);
    if (!pair) {
      throw new Error(`No usable credentials found for "${getSpecLabel(op.specId)}" to call "${op.operationId}".`);
    }
    headers.Authorization = `Basic ${base64Encode(`${pair.username}:${pair.password}`)}`;
  }

  let body: string | undefined;
  if (bodyTemplate && bodyTemplate.trim()) {
    // Parse the template first, then substitute into the parsed value — never splice raw values
    // into JSON text (see substituteInJson). Smart quotes are normalized on the template only,
    // so typographic quotes inside the substituted data are left as the data the API should get.
    const template = normalizeSmartQuotes(bodyTemplate);
    let parsed: any;
    try {
      parsed = JSON.parse(template);
    } catch (e: any) {
      throw new Error(`Body template is not valid JSON: ${e?.message ?? e}\n\nTemplate:\n${template}`);
    }
    body = JSON.stringify(substituteInJson(parsed, op.requestBodySchema, values));
    headers['Content-Type'] = 'application/json';
  }

  const qs = query.toString();
  const url = `${base}${path}${qs ? `?${qs}` : ''}`;

  console.log(`[directApi] ${op.method.toUpperCase()} ${url}`);
  console.log(`[directApi] ${op.operationId} request body: ${body ?? '(none)'}`);

  const send = () => fetch(url, { method: op.method.toUpperCase(), headers, body });
  let res = await send();

  // A cached token can be rejected before we believe it expires — it may have been revoked
  // server-side, or its exp claim may not have been readable. Drop it, mint a fresh one and
  // retry exactly once, so an expired session doesn't 401 every call until the app restarts.
  if (res.status === 401 && op.security === 'bearer') {
    console.log(`[directApi] ${op.operationId} got 401 — re-minting the session token and retrying once`);
    clearSessionToken(op.specId);
    headers.Authorization = `Bearer ${await getBearerToken(op.specId, settings)}`;
    res = await send();
  }

  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (!res.ok) {
    console.error(`[directApi] ${op.operationId} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return { status: res.status, contentType, text };
}
