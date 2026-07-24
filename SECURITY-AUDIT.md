# Security audit — direct API call path

**Date:** 2026-07-24
**Scope:** the direct-API-call feature added in `4165783` — `src/lib/directApi.ts`,
`src/lib/apiSpecs.ts`, `src/lib/apiDefaults.ts`, `src/apiSpecs/`, and the
`apiOperation` wiring in `ContextsScreen.tsx` / `ScanScreen.tsx` / `claude.ts`.

This path bypasses Claude and MCP entirely: a context wired to an `apiOperation`
builds an HTTP request from templates and sends it under the user's real ScanPower
credentials. There is no model in the loop to sanity-check the request, so input
handling here is load-bearing in a way it isn't on the Claude path.

## Threat model

Two inputs reaching a direct API request are **not** user-authored and should be
treated as untrusted:

1. **`{{scan}}`** — whatever the camera decodes. A barcode is attacker-supplied if
   an attacker can put a label in front of the scanner.
2. **Memory facts** — `parseMemoryFacts()` reads the Memory context, which is
   populated from `MEMORY:` lines Claude writes based on **MCP tool results**.
   External API responses therefore reach request templates transitively.

Prompt-field values are user-typed and lower risk, but flow through identically.

## Fixed

| # | Issue | Fix |
|---|---|---|
| F1 | **JSON injection into the request body.** Values were spliced into the body template *as text* before `JSON.parse`, so a value containing `"` could add keys or whole array elements. Verified: a crafted `{{scan}}` injected a second label item that would have printed. | Template is parsed first; `substituteInJson()` substitutes into parsed string leaves, so a value can never introduce JSON structure. Schema walked in parallel to type-coerce whole-token values (a leading-zero barcode stays a string). |
| F2 | **Ordinary data broke the call.** Any value with `"`, `\`, or a curly quote threw at parse — product titles routinely contain these. `normalizeSmartQuotes` also ran *after* substitution, corrupting typographic quotes inside real data. | Same fix as F1; smart-quote normalization now applies to the template only. |
| F3 | **Session token never expired.** `base64Decode` stripped base64url `-`/`_` as invalid, so the JWT `exp` claim never parsed, `expiresAt` was always `undefined`, and the token was cached for the whole app session with no refresh and no 401 recovery. | base64url translated before decode; added a 401 invalidate-and-retry-once using `clearSessionToken()`. |

## Open — security

### S1. Unverified credential mapping (Medium)
`basicAuthPairFor()` — [`src/lib/directApi.ts`](src/lib/directApi.ts)

ScanPower's REST auth is HTTP Basic → `getApiToken` → JWT, but `McpServerConfig`
has no username/password fields, so the mapping is a **guess**: for `authType:
'oauth'` the OAuth `clientId`/`clientSecret` are sent as the Basic username/password;
for `authType: 'token'` the static token is sent as the username with a blank
password. If the guess is wrong the app is transmitting OAuth client credentials to
an endpoint that isn't the OAuth token endpoint. Transport is HTTPS, so the
practical failure is auth rejection rather than exposure — but this should be
confirmed against real credentials, and ideally `McpServerConfig` should grow
explicit REST credential fields rather than overloading OAuth ones.

### S2. Header parameter values unvalidated (Low)
`callOperation()` — `headers[param.name] = resolved`

Resolved values are written straight into request headers with no filtering. A
value containing CR/LF is a header-injection vector. React Native's `fetch` very
likely rejects it, so this is defence-in-depth, but control characters should be
stripped (or the value rejected) rather than relying on the platform.

### S3. Residual: untrusted input still controls request *values* (Medium, by design)
F1 stopped untrusted data reshaping request *structure*. It does not stop it
supplying *values* — a memory fact or scanned barcode can still determine which SKU
gets a label, how many copies, etc. That is inherent to the feature. Mitigations
worth considering: showing a confirmation for state-changing operations, or
restricting which `values` keys a template may reference.

### S4. Verbose request logging (Low)
`[directApi]` logs the fully-resolved request body and parameters. Useful for
debugging, but that is product/customer data in Metro logs. Consider redacting or
gating behind a debug flag before any wider distribution.

### S5. API error text surfaced to the UI (Low)
Failures embed up to 200–300 characters of the raw API response into thrown errors,
which reach `Alert.alert`. An API error body could contain tokens or PII.

## Open — correctness / robustness

### C1. Unresolved `{{tokens}}` ship silently (Medium)
`substituteFields()` leaves an unmatched `{{token}}` as literal text, so a typo'd or
missing value is sent to the API verbatim — observed in practice with `{{title}}`
and `{{quantity}}`. There is no post-substitution validation pass. Should warn or
throw when tokens remain.

### C2. Region hardcoded (Medium)
`op.servers[0]` always selects `unity.scanpower.com` (us-east). The spec also lists
`west.scanpower.com` and `uk.scanpower.com`; users in those regions silently hit the
wrong endpoint. Needs a server/region setting.

### C3. Binary responses corrupted (Medium)
`callOperation` always reads `res.text()`. `itemLabel` exposes an editable `Accept`
header parameter — setting it to `application/pdf` returns raw binary that
`res.text()` mangles. Either handle binary (base64) or hide/pin that parameter.

### C4. Export/import drops the new config (Medium)
`exportToClipboard` and `parseImportedContexts` only carry `name` and
`instructions`, so `apiOperation` **and** `promptFields` are lost on a
round-trip — silent data loss for anyone sharing contexts.

### C5. No request timeout (Low)
No `AbortController` on any `fetch`; a hung connection hangs the scan indefinitely.

### C6. Concurrent token mint (Low)
Two simultaneous calls needing a token both mint one. Harmless but wasteful;
an in-flight promise should be shared.

### C7. `pickerOpen` not reset (Low)
Closing the context editor leaves `pickerOpen` at its previous value, so a stale
`true` can pop the operation picker open on the next edit.

## Open — design / style

### D1. Stringly-typed print trigger (Medium)
`ScanScreen.tsx` builds `` `${operationId} (${printTag})` `` so that the existing
`/print/i` regex over the tool *name* matches. A human-readable display label is
doing control-flow duty, and the tag leaks into UI text. An explicit
`shouldPrint: boolean` on the block would be clearer and decoupled.

### D2. `defaultObject` contradicts its docstring (Low)
`buildDefaultBodyTemplate` documents "only the schema's *required* properties", but
`defaultObject` falls back to **all** properties when `required` is absent.

### D3. Placeholder defaults are invalid values (Low)
Required numbers default to `0` (e.g. `label_width: 0`) — structurally valid JSON,
guaranteed to fail server-side, with nothing flagging it to the user.

### D4. Module coupling (Low)
`directApi.ts` imports `substituteFields` from `claude.ts`, coupling the REST path to
the LLM module. Templating belongs in its own module.
