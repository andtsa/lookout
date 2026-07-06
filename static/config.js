// ─── Config store ─────────────────────────────────────────────────────────────
// Runtime source of truth for personal settings: schema defaults overlaid with
// the per-project dotfile (loaded from GET /config, persisted via PUT /config).
// A valid change is applied live (engine / cola mode / layout parameter / colour)
// and persisted; the layout code needs no changes because the tunable constants
// are live `export let` bindings updated via setTunable().
//
// FUTURE (global + per-project override): the backend already merges a list of
// sources; when a global source is added this store is unaffected — it just
// receives the merged map from GET /config.

import { allFields, fieldByKey, validateField } from './config-schema.js';
import { setTunable } from './constants.js';
import { setLayoutEngine, setColaMode } from './state.js';

let values = {};              // key → current value
let dotfilePath = '';         // writable file path (for display)
const listeners = new Set();  // (field, value) → void, notified on every valid change

export function configValue(key) { return values[key]; }
export function configPath()     { return dotfilePath; }
export function onConfigChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Apply a validated value to wherever it's consumed.
function applyField(f, v) {
  switch (f.target) {
    case 'engine':   setLayoutEngine(v); break;
    case 'colaMode': setColaMode(v); break;
    case 'const':    setTunable(f.key, v); break;
    case 'color':    document.documentElement.style.setProperty(f.cssVar, v); break;
  }
}

// Load defaults + dotfile overrides and apply them. Call once, early in init,
// BEFORE the first layout so the default engine/params take effect immediately.
export async function loadConfig() {
  for (const f of allFields()) values[f.key] = f.default;
  try {
    const j = await (await fetch('/config')).json();
    dotfilePath = j.path || '';
    for (const [k, v] of Object.entries(j.config || {})) {
      const f = fieldByKey(k);
      if (f && validateField(f, v) == null) values[k] = v; // ignore unknown / invalid
    }
  } catch { /* no backend / no file — defaults stand */ }
  for (const f of allFields()) applyField(f, values[f.key]);
  return values;
}

// Set one setting. Rejects (returns false) invalid values without applying or
// persisting — the panel shows the hint instead.
export function setConfig(key, value) {
  const f = fieldByKey(key);
  if (!f || validateField(f, value) != null) return false;
  values[key] = value;
  applyField(f, value);
  persist();
  for (const fn of listeners) fn(f, value);
  return true;
}

// Debounced write of the full value map to the dotfile.
let _persist;
function persist() {
  clearTimeout(_persist);
  _persist = setTimeout(() => {
    fetch('/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: values }),
    }).catch(() => {});
  }, 400);
}
