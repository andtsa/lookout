// ─── Help panel ────────────────────────────────────────────────────────────────
// A modal overlay that aggregates every keyboard shortcut and pointer gesture
// (pulled from keybindings.js, so it can never drift from the real bindings) plus
// short "concepts" docs. Toggled with ? (see the binding in keybindings.js).

import { KEY_BINDINGS, POINTER_HINTS } from './keybindings.js';

// Short prose docs for the bigger ideas that aren't a single keystroke.
const CONCEPTS = [
  ['Layout engines', 'There two engines to pick from: a force-simulation (D3) engine, and a constraint-based engine (Cola). Toggle which one is used with `L`. Cola has three modes, you can cycle between them with `K`: "layered" orders the graph top-down, radial centre -> outward, and stress is undirected.'],
  ['Focus mode', 'On a dense graph edges are faded by default; Alt+click a node to reveal just its connections, Esc to clear. Sparse graphs (few edges) show everything with no focus needed.'],
  ['Level of detail', 'Alt+scroll a node or hovering over it and pressing `e` / `c` will expand / collapse its children. Shift+E / Shift+C expands / collapses the whole graph.'],
  ['Descriptions', 'Nodes and edges can carry a description. Hover to see it in a popup (after a short settle delay), or switch node descriptions to inline captions in the config panel.'],
  ['Config panel', 'P opens the settings panel, with engine, layout / physics parameters, colours, and behaviour. Changes apply live and persist to a per-project .vgraphtree.config.yaml.'],
  ['Editing', 'Right-click a node to rename / unpin, double-click to open its source, click an edge to annotate it, Shift+drag to pin. Ctrl+S saves; the discard button reloads from disk.'],
];

const panel = () => document.getElementById('help-panel');

// Append prose to `el`, rendering `backtick`-delimited runs as inline code chips
// (styled to match the key chips). Built from text nodes + <code> elements — no
// innerHTML, so arbitrary text is safe. Use backticks in any CONCEPTS / desc
// string to mark something as code, e.g. 'toggle with `L`' or '`.config.yaml`'.
function appendInline(el, text) {
  const parts = String(text).split(/`([^`]+)`/); // odd indices are the code runs
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const code = document.createElement('code');
      code.className = 'help-code';
      code.textContent = part;
      el.appendChild(code);
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  });
}

export function initHelpPanel() {
  const p = panel();
  p.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'help-card';

  const head = document.createElement('div');
  head.className = 'help-title';
  const title = document.createElement('span');
  title.textContent = 'help!';
  const close = document.createElement('button');
  close.className = 'help-close';
  close.textContent = '✕';
  close.title = 'Close (? or Esc)';
  close.addEventListener('click', closeHelp);
  head.append(title, close);
  card.appendChild(head);

  card.appendChild(shortcutSection('Keyboard', KEY_BINDINGS.map(b => [b.combo, b.desc])));
  card.appendChild(shortcutSection('Pointer',  POINTER_HINTS.map(b => [b.combo, b.desc])));
  card.appendChild(conceptSection('Concepts', CONCEPTS));

  const foot = document.createElement('div');
  foot.className = 'help-foot';
  foot.textContent = 'Press ? or Esc to close';
  card.appendChild(foot);

  p.appendChild(card);
  // Click the backdrop (but not the card) to dismiss.
  p.addEventListener('click', e => { if (e.target === p) closeHelp(); });
}

function shortcutSection(title, rows) {
  const sec = document.createElement('div');
  sec.className = 'help-section';
  sec.appendChild(sectionTitle(title));
  for (const [combo, desc] of rows) {
    const row = document.createElement('div');
    row.className = 'help-row';
    const kbd = document.createElement('kbd'); kbd.className = 'help-key'; kbd.textContent = combo;
    const d = document.createElement('span'); d.className = 'help-desc'; appendInline(d, desc);
    row.append(kbd, d);
    sec.appendChild(row);
  }
  return sec;
}

function conceptSection(title, rows) {
  const sec = document.createElement('div');
  sec.className = 'help-section';
  sec.appendChild(sectionTitle(title));
  for (const [heading, body] of rows) {
    const row = document.createElement('div');
    row.className = 'help-concept';
    const h = document.createElement('div'); h.className = 'help-concept-title'; h.textContent = heading;
    const b = document.createElement('div'); b.className = 'help-concept-body'; appendInline(b, body);
    row.append(h, b);
    sec.appendChild(row);
  }
  return sec;
}

function sectionTitle(text) {
  const t = document.createElement('div');
  t.className = 'help-section-title';
  t.textContent = text;
  return t;
}

export function isHelpOpen() { return !panel().classList.contains('hidden'); }
export function toggleHelp() { panel().classList.toggle('hidden'); }
export function closeHelp()  { panel().classList.add('hidden'); }
