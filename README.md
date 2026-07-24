# pimh — Physical Integration Mini Harness

An Expo / React Native (TypeScript) iOS app for ScanPower that turns a phone into a
barcode-driven harness: scan a 1D barcode, run it through a user-selected **context
note**, and render the result — including printing labels/documents when the work
calls for it.

A context takes one of two paths:

- **Claude** — the context's instructions become the system prompt, and Claude can
  call tools on any enabled **MCP server** (e.g. ScanPower's inventory/shipment
  tools) to look things up or take action. Use this when the work needs judgment.
- **Direct API call** — the context is wired to a single operation from a bundled
  OpenAPI spec and calls it straight over HTTPS, skipping Claude and MCP entirely.
  Use this when the work is deterministic (e.g. "print a label for this SKU"), where
  a model adds latency and cost for no benefit.

## How it works

1. **Scan** a barcode (or type one in manually — the field can also be left empty for
   contexts that don't need a code at all).
2. If the active context defines **prompt fields**, a short form collects them first
   (e.g. quantity, condition).
3. Then, depending on the context:
   - **Direct API call** — the chosen operation's parameters and JSON body are built
     from templates and sent. See [Direct API calls](#direct-api-calls) below.
   - **Claude** — the context's instructions become the system prompt, sent with the
     scan and any collected fields. Claude may call MCP tools, and its reply is
     rendered as formatted markdown. It can also end with:
     - `ASK: <question>` or `CHOOSE: <question> | <opt1> | <opt2>` to collect a
       follow-up answer and continue the same conversation, or
     - `MEMORY: <key>: <value>` to append a durable fact to the auto-managed
       **Memory** context, which is included on every future scan.
4. **Printing** is triggered by the *tool that produced a result*, not by the wording
   of the context: any successful tool result whose tool name contains "print" (e.g.
   ScanPower's `print_item_labels`) is sent to the configured printer. For direct API
   calls, the operation's OpenAPI tags are also checked, so an operation like
   `itemLabel` — tagged `Printing` but without "print" in its id — still prints. PDF
   results print as real PDFs; anything else prints as plain text.

## Templating

Direct API parameters and JSON body templates use `{{token}}` substitution, resolved
from these sources (**later wins** on a name collision):

1. **Memory facts** — `key: value` lines in the Memory context, so `{{asin}}` picks up
   a fact remembered from an earlier scan.
2. **Prompt fields** — by field id (`{{field_1}}`) or by its label slugified
   (a field labelled "Quantity" is also `{{quantity}}`).
3. **`{{scan}}`** — the scanned barcode. Always wins, being the current input.

The body template is parsed as JSON *first* and values are substituted into the parsed
strings, so a quote or backslash in a value (a product title, say) can't break or
reshape the request. Where the operation's schema declares a number or boolean, a
value that is exactly one token is coerced to that type — so `"copies": "{{quantity}}"`
sends a number, while a barcode with a leading zero stays a string.

> Note: an unmatched token is currently sent through **literally** rather than raising
> an error. See [SECURITY-AUDIT.md](SECURITY-AUDIT.md) (C1).

## Direct API calls

Specs live in `src/apiSpecs/` and are ingested at import time into a flat catalog of
operations. To wire one up:

1. In **Contexts**, edit a context and choose an operation under *Direct API call*.
2. Fill in the parameter and JSON body templates — starter templates are generated
   from the operation's required schema fields, with `{{scan}}`/`{{fieldId}}` tokens
   pre-filled where a property looks like an identifier or matches a prompt field.
   Placeholder numbers default to `0` and need real values.
3. Scanning with that context active calls the operation directly.

**Authentication** reuses the credentials already configured for the matching MCP
server in Settings (matched by server name against the spec's label). For specs whose
REST auth is HTTP Basic → bearer token (ScanPower's `getApiToken`), the JWT is minted
on first use and held **in memory for the app session only** — never written to disk —
and re-minted on expiry or a 401.

**To add another API:** drop its OpenAPI JSON into `src/apiSpecs/` and add one entry
to the `REGISTRY` array in `src/lib/apiSpecs.ts` (optionally naming its
`authOperationId`). The operation catalog rebuilds automatically; no other code
changes are needed.

## Project structure

```
App.tsx                    Root component: tabs, header, settings/contexts load & save
SECURITY-AUDIT.md          Threat model and open findings for the direct API path
src/
  types.ts                 Shared type definitions (ContextNote, AppSettings, AgentBlock, ...)
  apiSpecs/                Bundled OpenAPI specs (scanpower.json)
  screens/
    ScanScreen.tsx          Camera + manual entry, runs scans, renders results, triggers printing
    ContextsScreen.tsx      Create/edit/activate contexts, Memory, prompt fields, API operation
    SettingsScreen.tsx      API key, model, MCP servers/OAuth, printer selection, display toggles
  lib/
    claude.ts               Calls the Claude Messages API directly via fetch (MCP connector,
                             adaptive thinking, ASK/CHOOSE/MEMORY signal lines, templating)
    apiSpecs.ts             Ingests src/apiSpecs/*.json into an operation catalog
    directApi.ts            Executes an operation: templating, auth, session token, logging
    apiDefaults.ts          Generates starter parameter/body templates from a schema
    mcpOAuth.ts             OAuth 2.0 + PKCE flow for MCP servers that require it
    print.ts                expo-print integration: PDF vs. plain-text printing, printer selection
    storage.ts              AsyncStorage (settings/contexts) + SecureStore (API key, OAuth tokens)
  ui/
    theme.ts                Color palette
    markdown.tsx            Markdown rendering config for Claude's answers
```

## Requirements

- Node.js and npm
- [Expo Go](https://expo.dev/go) on a physical iOS device (fastest way to test — this
  app targets iOS features like AirPrint), or an iOS Simulator
- A [Claude API key](https://console.anthropic.com/) (`sk-ant-...`) — needed for
  Claude-backed contexts; direct-API-only contexts don't use it
- Xcode + Command Line Tools if you want to run the iOS Simulator from this machine

## Setup

```bash
npm install
```

## Run

```bash
npx expo start
```

Then either:
- scan the QR code shown in the terminal with the **Expo Go** app on your phone, or
- press `i` in the terminal to launch the iOS Simulator (requires Xcode).

On first launch, open the **Settings** tab and:
1. Paste in your Claude API key.
2. Pick a model.
3. Optionally enable and configure an MCP server (e.g. ScanPower) — static token or
   OAuth, depending on what the server requires. This also supplies the credentials
   used for direct API calls against that provider's spec.
4. Optionally select a default printer (iOS only) for contexts that print.

Then go to the **Contexts** tab and create (or edit the default) context note describing
what should happen when a barcode is scanned, and switch to **Scan** to try it.

## Type checking

```bash
npx tsc --noEmit
```

## Notes

- The Claude Messages API is called directly via `fetch` rather than the
  `@anthropic-ai/sdk` package, since the SDK's use of Node's `node:fs` for credential
  handling can't be bundled for React Native by Metro/Hermes.
- API keys and MCP OAuth tokens are stored in the device Keychain via
  `expo-secure-store`, never in plain AsyncStorage. Direct-API session tokens are held
  in memory only.
- Printing uses `expo-print` (the system print dialog / AirPrint), so it works inside
  Expo Go with no custom native build required — this supports WiFi/AirPrint printers,
  not raw Bluetooth thermal printers.
- Expo Go scopes stored data by the project `slug` in `app.json`; changing it resets
  the app to a fresh-install state (contexts, settings, API key, printer all cleared).
- The direct API path sends requests under real credentials with no model in the loop.
  [SECURITY-AUDIT.md](SECURITY-AUDIT.md) records its threat model, the injection and
  token-expiry issues already fixed, and what remains open.
