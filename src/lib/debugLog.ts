/**
 * Gate for the app's verbose diagnostic logging — the `[directApi]`, `[claude]`, `[openai]` and
 * `[print]` traces. Those lines include request bodies, resolved parameters and remembered
 * values, which is exactly what makes them useful while debugging on a device and exactly why
 * they shouldn't run unconditionally once the app is distributed more widely.
 *
 * Only informational logging goes through here. `console.error` / `console.warn` are left
 * ungated: a failure is worth surfacing whether or not anyone asked for verbose output.
 *
 * A module-level flag rather than a parameter, because the log sites are spread across modules
 * that have no reason to receive AppSettings (print.ts, apiSpecs.ts at import time).
 */

// Defaults to the dev build so Expo Go keeps its current output, and a production build starts
// quiet. App.tsx overrides this from the persisted setting once it loads.
let enabled = typeof __DEV__ !== 'undefined' ? __DEV__ : false;

export function setDebugLogging(on: boolean): void {
  enabled = on;
}

export function isDebugLogging(): boolean {
  return enabled;
}

export function debugLog(...args: unknown[]): void {
  if (enabled) console.log(...args);
}
