import scanpowerSpec from '../apiSpecs/scanpower.json';

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
}

/**
 * Registry of bundled OpenAPI specs. To support a new API, drop its spec JSON in
 * src/apiSpecs/ and add one entry here — everything else (catalog, operation lookup)
 * is derived automatically at import time.
 */
const REGISTRY: SpecRegistration[] = [
  { id: 'scanpower', label: 'ScanPower', spec: scanpowerSpec, authOperationId: 'getApiToken' },
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
        parameters: (op.parameters ?? []).map((p: any) => ({
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
  operations: ApiOperation[];
}

const LOADED: LoadedApiSpec[] = REGISTRY.map(({ id, label, spec, authOperationId }) => ({
  id,
  label,
  spec,
  authOperationId,
  operations: buildCatalog(id, label, spec),
}));

console.log(
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
