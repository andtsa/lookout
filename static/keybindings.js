// ─── Keybindings — single source of truth ─────────────────────────────────────
// Every keyboard shortcut and pointer gesture is declared here, together with
// the help text shown in the HUD. To add / change / remove a shortcut, edit the
// KEY_BINDINGS or POINTER_HINTS arrays below — nothing else needs to change: the
// dispatcher (setupKeybindings) and the help bar (renderHelpBar) are both driven
// off these lists.
//
// Handlers don't import the rest of the app directly (that would create import
// cycles and drag the whole dependency web in here). Instead each `run` receives
// a `cx` context object of small action callbacks, wired up once in app.js.

import { debugMode } from './state.js';

// ─── Keyboard shortcuts ────────────────────────────────────────────────────────
// Each entry:
//   combo       display string for the help bar
//   desc        what it does (help bar)
//   whileTyping if true, fires even while a text input is focused (default false)
//   match(e)    predicate against the KeyboardEvent
//   run(e, cx)  action; cx is the context object from app.js
export const KEY_BINDINGS = [
  {
    combo: 'Ctrl+S', desc: 'save', whileTyping: true,
    match: e => (e.ctrlKey || e.metaKey) && e.key === 's',
    run: (e, cx) => { e.preventDefault(); if (cx.getDirty()) cx.save(); },
  },
  {
    combo: 'Esc', desc: 'clear focus',
    match: e => e.key === 'Escape',
    run: (e, cx) => cx.clearFocus(),
  },
  {
    combo: 'A', desc: 'ghost/container',
    match: e => (e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !e.altKey,
    run: (e, cx) => cx.toggleDisplayMode(),
  },
  {
    combo: 'D', desc: 'force debug',
    match: e => (e.key === 'd' || e.key === 'D') && !e.ctrlKey && !e.metaKey && !e.altKey,
    run: (e, cx) => cx.toggleDebug(),
  },
  {
    combo: '+/−', desc: 'zoom',
    match: e => (e.key === '+' || e.key === '=' || e.key === '-') && !e.ctrlKey && !e.metaKey,
    run: (e, cx) => cx.zoomBy(e.key === '-' ? 1 / 1.3 : 1.3),
  },
  {
    combo: 'Shift+E/C', desc: 'expand/collapse all',
    // Allow AltGr (Ctrl+Alt on Windows) but block plain Ctrl/Cmd combos.
    match: e => (e.key === 'e' || e.key === 'E' || e.key === 'c' || e.key === 'C')
      && e.shiftKey && !e.metaKey && !(e.ctrlKey && !e.altKey),
    run: (e, cx) => { if (e.key === 'c' || e.key === 'C') cx.collapseAll(); else cx.expandAll(); },
  },
  {
    combo: 'E/C', desc: 'expand/collapse hovered',
    match: e => (e.key === 'e' || e.key === 'E' || e.key === 'c' || e.key === 'C')
      && !e.shiftKey && !e.metaKey && !(e.ctrlKey && !e.altKey),
    run: (e, cx) => { if (e.key === 'c' || e.key === 'C') cx.collapseHovered(); else cx.expandHovered(); },
  },
  {
    combo: 'P', desc: 'config panel',
    match: e => (e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && !e.altKey,
    run: (e, cx) => cx.toggleConfigPanel(),
  },
  {
    combo: 'L', desc: 'layout engine (force/cola)',
    match: e => (e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey,
    run: (e, cx) => cx.toggleEngine(),
  },
  {
    combo: 'K', desc: 'cola mode (layered/radial/stress)',
    match: e => (e.key === 'k' || e.key === 'K') && !e.ctrlKey && !e.metaKey && !e.altKey,
    run: (e, cx) => cx.cycleColaMode(),
  },
];

// ─── Pointer gestures (documentation only) ─────────────────────────────────────
// These are handled by D3 event bindings in interaction.js / render.js — they
// live here purely so the help bar has one source. Keep in sync when the gesture
// handlers change.
export const POINTER_HINTS = [
  { combo: 'Scroll',                desc: 'zoom' },
  { combo: 'Alt+scroll over node',  desc: 'expand/collapse' },
  { combo: 'Shift+drag',            desc: 'pin' },
  { combo: 'Alt+click',             desc: 'focus' },
  { combo: 'Dbl-click',             desc: 'open source' },
  { combo: 'Right-click',           desc: 'rename/unpin' },
  { combo: 'Click edge',            desc: 'annotate' },
];

// ─── Dispatcher ────────────────────────────────────────────────────────────────
// Attaches the global keydown listener. cx is the context object of action
// callbacks (see app.js). The first binding whose match() passes wins.
export function setupKeybindings(cx) {
  // Debug logger — capture phase on window, so it fires before every other
  // handler (and before any stopPropagation), recording every key the page
  // actually receives. Only active while debug mode is on (D key, or vgtDebug()
  // from the console if the keyboard itself isn't cooperating).
  //
  // Reading the output:
  //   • press keys and see NOTHING → the events aren't reaching the page at all
  //     (browser extension eating them, focus in another window/iframe, or an
  //     OS-level grab). The bug is outside this app.
  //   • a line logs but the action doesn't happen → check `matched` (no binding)
  //     and `blockedByInput` (a text field has focus and swallowed it).
  window.addEventListener('keydown', e => {
    if (!debugMode) return;
    const inInput = document.activeElement.tagName === 'INPUT';
    const b = KEY_BINDINGS.find(bb => bb.match(e));
    const mods = ['ctrl', 'meta', 'alt', 'shift'].filter(m => e[m + 'Key']).join('+') || 'none';
    const ae = document.activeElement;
    console.log('[keydown]', {
      key: e.key, code: e.code, mods, repeat: e.repeat,
      focus: (ae?.tagName || '?').toLowerCase() + (ae?.id ? '#' + ae.id : ''),
      matched: b ? b.combo : '(none)',
      blockedByInput: !!(inInput && b && !b.whileTyping),
      defaultPrevented: e.defaultPrevented,
    });
  }, true);

  document.addEventListener('keydown', e => {
    const inInput = document.activeElement.tagName === 'INPUT';
    for (const b of KEY_BINDINGS) {
      if (!b.match(e)) continue;
      // A text input swallows everything except the whileTyping shortcuts.
      if (inInput && !b.whileTyping) return;
      b.run(e, cx);
      return;
    }
  });
}

// ─── Help bar ──────────────────────────────────────────────────────────────────
// Renders the pointer gestures + keyboard shortcuts into the given element,
// straight from the arrays above so the docs can never drift from the bindings.
export function renderHelpBar(el) {
  if (!el) return;
  const hint = ({ combo, desc }) => `${combo}: ${desc}`;
  el.textContent = [...POINTER_HINTS, ...KEY_BINDINGS].map(hint).join(' · ');
}
