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
    combo: 'E/C', desc: 'expand/collapse all',
    // Allow AltGr (Ctrl+Alt on Windows) but block plain Ctrl/Cmd combos.
    match: e => (e.key === 'e' || e.key === 'E' || e.key === 'c' || e.key === 'C')
      && !e.metaKey && !(e.ctrlKey && !e.altKey),
    run: (e, cx) => { if (e.key === 'c' || e.key === 'C') cx.collapseAll(); else cx.expandAll(); },
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
