# pimh — Physical Integration Mini Harness

An Expo / React Native (TypeScript) iOS app for warehouses that turns a phone into a
barcode-driven harness: scan a 1D barcode, run it through a user-selected **context
note**, and render the result — including printing labels/documents when the work
calls for it.

A context takes one of three paths:

- **A model** — the context's instructions become the system prompt, and the model can
  call tools on any enabled **MCP server** (e.g. ScanPower's inventory/shipment
  tools) to look things up or take action. Use this when the work needs judgment.
  Both Claude and GPT models are supported, with the same tool access either way.
- **Direct API call** — the context is wired to a single operation from a bundled
  OpenAPI spec and calls it straight over HTTPS, skipping Claude and MCP entirely.
  Use this when the work is deterministic (e.g. "print a label for this SKU"), where
  a model adds latency and cost for no benefit.
- **Both, chained** — the model runs first with its MCP tools, then the direct API
  call runs on what it found. Use this when the inputs need discovery but the action
  doesn't: *look this barcode up with `scout_search` and `get_inventory`, then print a
  label for it*. See [Chaining a model into an API call](#chaining-a-model-into-an-api-call).

## How it works

1. **Scan** a barcode (or type one in manually — the field can also be left empty for
   contexts that don't need a code at all).
2. If the active context defines **prompt fields**, a short form collects them first
   (e.g. quantity, condition).
3. Then, depending on the context:
   - **Direct API call** — the chosen operation's parameters and JSON body are built
     from templates and sent, and the response is summarized into the same results view
     a model's answer renders into. Each object in a returned collection (e.g. each
     inbound plan) gets its own collapsible section — the first opens automatically —
     with fields shown under the API's own attribute names (`v1_batch_id`, not a re-cased
     variant) and null attributes omitted. A PDF is noted by size rather than dumped, and
     the raw response stays available under *Show tool calls*. Tapping a value offers to
     **Copy** it or **Add to Memory**, which appends it as a `v1_batch_id: 31822` fact —
     reusable by a later scan as `{{v1_batch_id}}`, the same name the API uses.
     See [Direct API calls](#direct-api-calls) below.
   - **A model** — the context's instructions become the system prompt, sent with the
     scan and any collected fields. The model selected in Settings decides where the
     request goes and which key signs it: a Claude model to the Anthropic Messages API,
     a GPT model to the OpenAI Responses API. Either way it can call tools on the
     enabled MCP servers, and its reply is rendered as formatted markdown. It can also
     end with:
     - `ASK: <question>` or `CHOOSE: <question> | <opt1> | <opt2>` to collect a
       follow-up answer and continue the same conversation, or
     - `MEMORY: <key>: <value>` to append a durable fact to the auto-managed
       **Memory** context, which is included on every future scan.

     The two providers reach MCP differently — Anthropic through its server-side
     connector, OpenAI through `type: "mcp"` tool entries — but a context behaves the
     same on both, since the system prompt, signal lines and tool results are shared.
     A conversation can't be continued across a model switch, though: the transcript is
     in the provider's own format, so answering an `ASK` means staying on the model
     that asked.
   - **Both** — if the context's operation has *Run after the model* ticked, the model
     turn above happens first and the API call follows it, using the `MEMORY:` facts the
     model just reported. Its result is appended to the same results view.
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

Name matching ignores case and separators, so a Memory fact called `shipment_id` fills a
parameter the spec spells `shipmentId`. A **required** parameter with no template of its own
is filled from a same-named value automatically; optional ones are left alone, so a
remembered value can't silently narrow a query. Anything still unresolved fails before the
request with a message naming what's missing, rather than sending the literal token.

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

## Chaining a model into an API call

Tick **Run after the model, not instead of it** on a context's operation to run both: the
model gathers, the API acts. Leave the parameters that the model should supply blank.

The two halves talk through **Memory**. Before the scan, the app works out which values the
call will need — required parameters with no template, plus every `{{token}}` in the ones
that have templates — and appends them to the system prompt as an explicit contract:

```
When you are done, this app automatically calls the "itemLabel" API operation using
the facts you report. End your reply with one MEMORY line per value below, spelling
each key exactly as shown:
- MEMORY: condition: <value>
- MEMORY: title: <value>
- MEMORY: quantity: <value>
```

Those facts are then merged over the ones remembered from earlier scans, so a `title` the
model just found beats a `title` left over from the previous item — which is the whole
reason the fresh ones take precedence. Values collected by prompt fields are left out of
the contract entirely; the user has already supplied them.

Three things are deliberate about the sequencing:

- **An `ASK` or `CHOOSE` holds the call back.** The answer is often one of the values the
  call needs, so the API stage waits until the conversation actually finishes.
- **A missing value skips the call rather than failing it.** The results view gets a
  warning naming exactly which facts never arrived, and the model's answer stays on screen.
- **A failed call doesn't discard the model's work** either — same treatment.

Headers the spec can mint on its own (ScanPower's `x-access-token`) are never asked of the
model; they're fetched per call as usual.

One sharp edge worth knowing: a value the model *doesn't* report falls through to whatever
Memory already holds, which may describe the previous item. The contract asks for every
needed value on every scan to avoid this, but for a destructive or costly operation, prefer
a prompt field over trusting the fallback.

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
    agent.ts                Entry point for a scan: routes to the selected model's provider
    agentCommon.ts          System prompt, signal lines, MCP resolution — shared by providers
    claude.ts               Anthropic Messages API via fetch (MCP connector, adaptive thinking)
    openai.ts               OpenAI Responses API via fetch (MCP tools, no approval round-trip)
    models.ts               Model catalog: id, display label, provider
    templating.ts           {{scan}}/{{fieldId}}/memory-fact substitution and name matching
    debugLog.ts             Gate for verbose tracing (Settings → Verbose logging)
    apiSpecs.ts             Ingests src/apiSpecs/*.json into an operation catalog
    directApi.ts            Executes an operation: templating, auth, session token, logging
    apiDefaults.ts          Generates starter parameter/body templates from a schema
    apiSummary.ts           Turns an API response into collapsible result sections
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
- A [Claude API key](https://console.anthropic.com/) (`sk-ant-...`) and/or an
  [OpenAI API key](https://platform.openai.com/) (`sk-...`) — whichever the selected
  model needs; direct-API-only contexts use neither
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
1. Paste in your Claude API key, your OpenAI API key, or both.
2. Pick a model — this decides which API a scan is sent to and which key authenticates it.
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

- Both provider APIs are called directly via `fetch` rather than their official SDKs,
  since those pull in Node built-ins (e.g. `node:fs` for credential handling) that
  Metro/Hermes can't bundle for React Native.
- MCP works on both providers but by different mechanisms: Anthropic's is a server-side
  connector (`mcp_servers` + `mcp_toolset`), OpenAI's is a `type: "mcp"` entry in `tools`
  on `/v1/responses` sent with `require_approval: "never"`. A conversation can't be
  continued across a model switch, since the transcript is in the provider's own format.
- OpenAI requests are sent with `store: false`, so scans aren't retained server-side.
  Continuation replays prior output items through `input` rather than referencing a stored
  response, so nothing depends on that retention.
- API keys (Claude and OpenAI, stored separately) and MCP OAuth tokens are kept in the
  device Keychain via `expo-secure-store`, never in plain AsyncStorage. Direct-API session tokens are held
  in memory only.
- Printing uses `expo-print` (the system print dialog / AirPrint), so it works inside
  Expo Go with no custom native build required — this supports WiFi/AirPrint printers,
  not raw Bluetooth thermal printers.
- Verbose `[directApi]`/`[claude]`/`[openai]`/`[print]` tracing is gated by **Settings →
  Display → Verbose logging**, which defaults on in dev builds and off in a production
  build. Those lines include request bodies and remembered values, so leave it off for
  general use; errors are logged either way.
- **Settings → Danger zone → Reset app data** erases everything the app has stored —
  contexts and Memory, both API keys, MCP servers and their sign-ins, and all settings —
  behind two confirmations. There is no backup or undo; it is the only bulk clear, since
  the per-item ones (Clear memory, Disconnect, Remove server, blanking a key) each cover
  only their own data.
- Expo Go scopes stored data by the project `slug` in `app.json`; changing it resets
  the app to a fresh-install state (contexts, settings, API key, printer all cleared).
- The direct API path sends requests under real credentials with no model in the loop.
  [SECURITY-AUDIT.md](SECURITY-AUDIT.md) records its threat model, the injection and
  token-expiry issues already fixed, and what remains open.
