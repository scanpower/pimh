import scanpowerSpec from '../apiSpecs/scanpower.json';
import { debugLog } from './debugLog';

/**
 * A header parameter that another operation in the same spec produces, rather than the user
 * supplying it. ScanPower's Amazon (SP-API) operations declare a required `x-access-token`
 * header, minted by `getAccessToken` — so the app can fetch it on demand instead of making
 * every such context carry a token by hand.
 */
export interface HeaderTokenSource {
  /** Header parameter this fills, named exactly as the spec names it. */
  header: string;
  /** Operation that mints the token. */
  operationId: string;
  /** Field of that operation's JSON response holding the token. */
  tokenField: string;
  /** Optional field holding the token's lifetime in seconds. */
  expiresInField?: string;
}

interface SpecRegistration {
  id: string;
  label: string;
  spec: any;
  /**
   * operationId of this spec's "mint a bearer token" call, for specs whose bearer_auth
   * operations require exchanging basic-auth credentials for a session token first (e.g.
   * ScanPower's getApiToken). Omit for specs with no such exchange step.
   */
  authOperationId?: string;
  /** Header parameters supplied by another operation — see HeaderTokenSource. */
  headerTokens?: HeaderTokenSource[];
}

/**
 * Registry of bundled OpenAPI specs. To support a new API, drop its spec JSON in
 * src/apiSpecs/ and add one entry here — everything else (catalog, operation lookup)
 * is derived automatically at import time.
 */
const REGISTRY: SpecRegistration[] = [
  {
    id: 'scanpower',
    label: 'ScanPower',
    spec: scanpowerSpec,
    authOperationId: 'getApiToken',
    headerTokens: [
      { header: 'x-access-token', operationId: 'getAccessToken', tokenField: 'access_token', expiresInField: 'expires_in' },
    ],
  },
];

export type ApiSecurity = 'basic' | 'bearer' | 'none';

export interface ApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  schema?: any;
  description?: string;
}

export interface ApiOperation {
  specId: string;
  specLabel: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  operationId: string;
  summary?: string;
  tags: string[];
  security: ApiSecurity;
  parameters: ApiParameter[];
  requestBodySchema?: any;
  /** Base URLs this operation can be called against, per the spec's `servers` list. */
  servers: string[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Follow a local JSON pointer ("#/components/parameters/x-access-token") within a spec. */
function resolveRef(spec: any, ref: string): any {
  if (!ref.startsWith('#/')) return undefined;
  let node = spec;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object' || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}

function securityOf(op: any): ApiSecurity {
  const sec = op.security as Array<Record<string, unknown>> | undefined;
  if (!sec || sec.length === 0) return 'none';
  if (sec.some((s) => 'bearer_auth' in s)) return 'bearer';
  if (sec.some((s) => 'basic_auth' in s)) return 'basic';
  return 'none';
}

function buildCatalog(id: string, label: string, spec: any): ApiOperation[] {
  const servers: string[] = Array.isArray(spec.servers) ? spec.servers.map((s: any) => s.url).filter(Boolean) : [];
  const paths = spec.paths ?? {};
  const operations: ApiOperation[] = [];

  for (const path of Object.keys(paths)) {
    const methods = paths[path];
    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (!op) continue;
      if (!op.operationId) continue; // skip anything we can't address by name
      operations.push({
        specId: id,
        specLabel: label,
        method,
        path,
        operationId: op.operationId,
        summary: op.summary,
        tags: op.tags ?? [],
        security: securityOf(op),
        // Parameters are commonly shared via $ref (x-access-token, paging params...). Resolve
        // them here — read raw, a $ref entry has no name/in/required at all, so the parameter
        // would silently ingest as nameless and be unusable downstream.
        parameters: (op.parameters ?? [])
          .map((p: any) => (p?.$ref ? resolveRef(spec, p.$ref) : p))
          .filter((p: any) => p && p.name)
          .map((p: any) => ({
            name: p.name,
            in: p.in,
            required: !!p.required,
            schema: p.schema,
            description: p.description,
          })),
        requestBodySchema: op.requestBody?.content?.['application/json']?.schema,
        servers,
      });
    }
  }
  return operations;
}

interface LoadedApiSpec {
  id: string;
  label: string;
  spec: any;
  authOperationId?: string;
  headerTokens: HeaderTokenSource[];
  operations: ApiOperation[];
}

const LOADED: LoadedApiSpec[] = REGISTRY.map(({ id, label, spec, authOperationId, headerTokens }) => ({
  id,
  label,
  spec,
  authOperationId,
  headerTokens: headerTokens ?? [],
  operations: buildCatalog(id, label, spec),
}));

debugLog(
  `[apiSpecs] ingested ${LOADED.length} spec(s): ` +
    LOADED.map((s) => `${s.id} (${s.operations.length} operations)`).join(', '),
);

/** All bundled specs, each with its flattened operation catalog. */
export function listApiSpecs(): { id: string; label: string; operations: ApiOperation[] }[] {
  return LOADED.map(({ id, label, operations }) => ({ id, label, operations }));
}

/** Every operation across every bundled spec, flattened — useful for a single "pick an API call" list. */
export function listAllOperations(): ApiOperation[] {
  return LOADED.flatMap((s) => s.operations);
}

export function getOperation(specId: string, operationId: string): ApiOperation | undefined {
  return LOADED.find((s) => s.id === specId)?.operations.find((o) => o.operationId === operationId);
}

/** The spec's declared "mint a bearer token" operation (see SpecRegistration.authOperationId), if any. */
export function getAuthOperation(specId: string): ApiOperation | undefined {
  const loaded = LOADED.find((s) => s.id === specId);
  if (!loaded?.authOperationId) return undefined;
  return loaded.operations.find((o) => o.operationId === loaded.authOperationId);
}

/** Spec label, used to match a spec to the MCP server configured for it (see directApi.ts). */
export function getSpecLabel(specId: string): string | undefined {
  return LOADED.find((s) => s.id === specId)?.label;
}

/** Where a spec-declared header token comes from, if this header has a registered source. */
export function headerTokenSource(specId: string, header: string): HeaderTokenSource | undefined {
  return LOADED.find((s) => s.id === specId)?.headerTokens.find((h) => h.header === header);
}

/**
 * Header parameters of this operation that the app fills in itself from another operation
 * (e.g. `x-access-token` via getAccessToken). Driven entirely by what the spec declares on the
 * operation, so it stays correct for operations outside the /api/az/ prefix — CreateBatchItems
 * requires the same token despite living under /graphql.
 */
export function autoFilledHeaders(op: ApiOperation): string[] {
  const sources = LOADED.find((s) => s.id === op.specId)?.headerTokens ?? [];
  return op.parameters
    .filter((p) => p.in === 'header' && sources.some((h) => h.header === p.name))
    .map((p) => p.name);
}
