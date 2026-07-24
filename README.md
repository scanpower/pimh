# pimh — Physical Integration Mini Harness

An Expo / React Native (TypeScript) iOS app for ScanPower that turns a phone into a
barcode-driven Claude agent: scan a 1D barcode, send it to Claude along with a
user-selected **context note** as instructions, optionally let Claude call MCP tools
(e.g. ScanPower's inventory/shipment tools) to look things up or take action, and
render the result — including printing labels/documents when a context calls for it.

## How it works

1. **Scan** a barcode (or type one in manually — the field can also be left empty for
   contexts that don't need a code at all).
2. The active **context note**'s instructions become the system prompt sent to Claude,
   along with the scan and any **prompt fields** the context collected first (e.g.
   quantity, warehouse).
3. Claude can call tools on any enabled **MCP server** (e.g. ScanPower) to look up or
   act on the scanned item.
4. Claude's reply is rendered as formatted markdown. It can also:
   - end with `ASK: <question>` or `CHOOSE: <question> | <opt1> | <opt2>` to collect a
     follow-up answer and continue the same conversation, or
   - end with `MEMORY: <fact>` to append a durable fact to the auto-managed **Memory**
     context, which is included on every future scan.
5. If the active context's instructions mention the word "print", that scan's tool
   results are sent to the configured printer (PDF results print as real PDFs; anything
   else prints as plain text).

## Project structure

```
App.tsx                    Root component: tabs, header, settings/contexts load & save
src/
  types.ts                 Shared type definitions (ContextNote, AppSettings, AgentBlock, ...)
  screens/
    ScanScreen.tsx          Camera + manual entry, runs scans, renders results, triggers printing
    ContextsScreen.tsx      Create/edit/activate context notes, Memory context, prompt fields
    SettingsScreen.tsx      API key, model, MCP servers/OAuth, printer selection, display toggles
  lib/
    claude.ts               Calls the Claude Messages API directly via fetch (MCP connector,
                             adaptive thinking, ASK/CHOOSE/MEMORY signal-line parsing)
    mcpOAuth.ts              OAuth 2.0 + PKCE flow for MCP servers that require it
    print.ts                 expo-print integration: PDF vs. plain-text printing, printer selection
    storage.ts                AsyncStorage (settings/contexts) + SecureStore (API key, OAuth tokens)
  ui/
    theme.ts                 Color palette
    markdown.tsx              Markdown rendering config for Claude's answers
```

## Requirements

- Node.js and npm
- [Expo Go](https://expo.dev/go) on a physical iOS device (fastest way to test — this
  app targets iOS features like AirPrint), or an iOS Simulator
- A [Claude API key](https://console.anthropic.com/) (`sk-ant-...`)
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
   OAuth, depending on what the server requires.
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
- API keys and OAuth tokens are stored in the device Keychain via `expo-secure-store`,
  never in plain AsyncStorage.
- Printing uses `expo-print` (the system print dialog / AirPrint), so it works inside
  Expo Go with no custom native build required — this supports WiFi/AirPrint printers,
  not raw Bluetooth thermal printers.
