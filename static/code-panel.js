// ─── Code panel & directory browser ──────────────────────────────────────────

import { nodes, sourceToNode, nodeLayer, svg, zoom } from './state.js';
import { fetchFile } from './api.js';
import { getViewportSize } from './geometry.js';

// ─── DOM references ───────────────────────────────────────────────────────────

const codePanel        = document.getElementById('code-panel');
const codePanelPath    = document.getElementById('code-panel-path');
const codePanelContent = document.getElementById('code-panel-content');
const codePanelBack    = document.getElementById('code-panel-back');
const codePanelResize  = document.getElementById('code-panel-resize');

let codePanelFileParent = null;  // path to re-open when ↩ is clicked
let _openSource         = null;  // source currently shown (for dbl-click toggle)

// ─── Panel open / close ───────────────────────────────────────────────────────

export async function openCodePanel(nodeOrPath) {
  const node   = typeof nodeOrPath === 'string' ? null : nodeOrPath;
  const source = node ? node.source : nodeOrPath;   // node.source is a plain path (symbol split off)
  if (!source && source !== '') return;
  _openSource = source;

  // Show the symbol name in the header when this node points at one.
  codePanelPath.textContent  = node && node.symbol ? `${source} :: ${node.symbol}` : source;
  codePanelContent.innerHTML = '<pre style="color:var(--text-faint);padding:8px 12px">Loading…</pre>';
  codePanel.classList.add('open');

  try {
    const data = await fetchFile(source);
    if (data.type === 'directory') renderDirectoryInPanel(data);
    else                           renderFileInPanel(data, source, node);
  } catch (e) {
    codePanelContent.innerHTML =
      `<pre style="color:#fb4934;padding:8px 12px">Error: ${e.message}</pre>`;
  }
}

function renderFileInPanel(data, path, node) {
  codePanelPath.textContent = node && node.symbol ? `${path} :: ${node.symbol}` : path;
  const parts = path.replace(/\/+$/, '').split('/');
  parts.pop();
  codePanelFileParent  = parts.join('/');
  codePanelBack.hidden = false;

  const pre  = document.createElement('pre');
  const code = document.createElement('code');
  code.className   = langClass(path);
  code.textContent = data.lines.join('\n');
  pre.appendChild(code);
  codePanelContent.innerHTML = '';
  codePanelContent.appendChild(pre);
  if (window.hljs) hljs.highlightElement(code);

  // Symbol node → scroll to and highlight the target line. `line` (1-based) is
  // authoritative; otherwise search the file for the symbol name.
  if (node && (node.line || node.symbol)) {
    const target = node.line || findSymbolLine(data.lines, node.symbol);
    if (target) highlightLine(code, data.lines, target);
  }
}

// ─── Symbol location within a file ─────────────────────────────────────────────

// First 1-based line whose text contains the symbol as a whole word, or null.
function findSymbolLine(lines, symbol) {
  if (!symbol) return null;
  const re = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return null;
}

// Char offset (into lines.join('\n')) of the start of a 1-based line.
function lineStartOffset(lines, line) {
  let off = 0;
  for (let i = 0; i < line - 1; i++) off += lines[i].length + 1; // +1 for the '\n'
  return off;
}

// Locate (textNode, offset) for a character offset within a highlighted element.
// hljs wraps text in spans but preserves textContent, so char offsets still align.
function offsetToNode(root, charOffset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0, n;
  while ((n = walker.nextNode())) {
    const len = n.textContent.length;
    if (acc + len >= charOffset) return { node: n, offset: charOffset - acc };
    acc += len;
  }
  return null;
}

// Highlight a 1-based line and scroll it into view. Uses a DOM Range over the
// line's text to get its real position — robust to line wrapping (pre-wrap) and
// preserving hljs syntax highlighting.
function highlightLine(code, lines, line) {
  const startOff = lineStartOffset(lines, line);
  const endOff   = startOff + (lines[line - 1] ? lines[line - 1].length : 0);
  const s = offsetToNode(code, startOff);
  const e = offsetToNode(code, endOff);
  if (!s || !e) return;

  const range = document.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  const rect     = range.getBoundingClientRect();
  const contRect = codePanelContent.getBoundingClientRect();
  const top      = rect.top - contRect.top + codePanelContent.scrollTop;

  const bar = document.createElement('div');
  bar.className    = 'code-line-highlight';
  bar.style.top    = `${top}px`;
  bar.style.height = `${Math.max(rect.height, 16)}px`;
  codePanelContent.style.position = 'relative';
  codePanelContent.appendChild(bar);

  codePanelContent.scrollTop = Math.max(0, top - codePanelContent.clientHeight * 0.35);
}

function renderDirectoryInPanel(data) {
  codePanelBack.hidden      = true;
  codePanelFileParent       = null;
  codePanelPath.textContent = data.path;

  const container = document.createElement('div');
  container.className = 'dir-listing';

  // Breadcrumb nav
  const nav   = document.createElement('div');
  nav.className = 'dir-nav';
  const parts = data.path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 0) {
    const span = document.createElement('span');
    span.textContent = '/';
    nav.appendChild(span);
  } else {
    const rootBtn = document.createElement('button');
    rootBtn.className = 'dir-nav-part';
    rootBtn.textContent = '~';
    rootBtn.addEventListener('click', () => openCodePanel(''));
    nav.appendChild(rootBtn);
    parts.forEach((part, i) => {
      const sep = document.createElement('span');
      sep.className   = 'dir-nav-sep';
      sep.textContent = '/';
      nav.appendChild(sep);
      const btn = document.createElement('button');
      btn.className   = 'dir-nav-part';
      btn.textContent = part;
      if (i < parts.length - 1) {
        const target = parts.slice(0, i + 1).join('/');
        btn.addEventListener('click', () => openCodePanel(target));
      }
      nav.appendChild(btn);
    });
  }
  container.appendChild(nav);

  // Entry list
  const list = document.createElement('div');
  list.className = 'dir-entries';

  for (const entry of data.entries) {
    const row = document.createElement('div');
    row.className = `dir-entry ${entry.is_dir ? 'dir-entry-dir' : 'dir-entry-file'}`;

    const icon = document.createElement('span');
    icon.className   = 'dir-entry-icon';
    icon.textContent = entry.is_dir ? '▸' : '·';
    row.appendChild(icon);

    const nameEl = document.createElement('span');
    nameEl.className   = 'dir-entry-name';
    nameEl.textContent = entry.name + (entry.is_dir ? '/' : '');
    row.appendChild(nameEl);

    const matchedNode = findNodeBySource(entry.path);
    if (matchedNode) {
      const badge = document.createElement('span');
      badge.className   = 'dir-node-badge';
      badge.textContent = matchedNode.label;
      badge.title       = 'Jump to node in graph';
      badge.addEventListener('click', e => { e.stopPropagation(); zoomToNode(matchedNode); });
      row.appendChild(badge);
    }

    row.addEventListener('click', () => openCodePanel(entry.path));
    list.appendChild(row);
  }
  container.appendChild(list);

  // Footer
  const dirs    = data.entries.filter(e => e.is_dir).length;
  const files   = data.entries.length - dirs;
  const footer  = document.createElement('div');
  footer.className   = 'dir-footer';
  footer.textContent = [
    dirs  && `${dirs}  dir${dirs  !== 1 ? 's' : ''}`,
    files && `${files} file${files !== 1 ? 's' : ''}`,
  ].filter(Boolean).join(', ');
  container.appendChild(footer);

  codePanelContent.innerHTML = '';
  codePanelContent.appendChild(container);
}

// ─── Zoom to node ─────────────────────────────────────────────────────────────

export function zoomToNode(node) {
  const { w: viewW, h: viewH } = getViewportSize();
  const k  = d3.zoomTransform(svg.node()).k;
  const tx = viewW / 2 - node.x * k;
  const ty = viewH / 2 - node.y * k;
  svg.transition().duration(600)
     .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));

  codePanel.classList.remove('open');
  codePanelContent.innerHTML = '';

  // Flash the target node
  const sel = nodeLayer.selectAll('.node').filter(d => d.id === node.id);
  sel.classed('node-flash', true);
  setTimeout(() => sel.classed('node-flash', false), 1200);
}

// ─── Source path helpers ──────────────────────────────────────────────────────

export function normaliseSource(s) {
  return (s || '').replace(/\/+$/, '').replace(/\\/g, '/');
}
export function findNodeBySource(path) {
  return sourceToNode[normaliseSource(path)] || null;
}
function langClass(path) {
  const ext = path.split('.').pop().toLowerCase();
  const map = {
    rs: 'rust', js: 'javascript', ts: 'typescript',
    yaml: 'yaml', yml: 'yaml', html: 'html',
    css: 'css', toml: 'toml', md: 'markdown', json: 'json',
  };
  return map[ext] ? `language-${map[ext]}` : '';
}

// ─── Panel event wiring (runs at import time) ─────────────────────────────────

export function closeCodePanel() {
  codePanel.classList.remove('open');
  codePanelContent.innerHTML = '';
  _openSource = null;
  svg.node().focus();
}

// Double-click behaviour: if the panel is already open on this node's source,
// close it; otherwise open it (so double-clicking a different node switches).
export function toggleCodePanel(nodeOrPath) {
  const source = typeof nodeOrPath === 'string' ? nodeOrPath : nodeOrPath.source;
  if (codePanel.classList.contains('open') && _openSource === source) closeCodePanel();
  else openCodePanel(nodeOrPath);
}

document.getElementById('code-panel-close').addEventListener('click', closeCodePanel);

codePanelBack.addEventListener('click', () => {
  if (codePanelFileParent !== null) openCodePanel(codePanelFileParent);
});

// Resize handle — drag the left edge to resize the panel
let _resizing = false;
codePanelResize.addEventListener('mousedown', e => {
  e.preventDefault();
  _resizing = true;
  codePanelResize.classList.add('dragging');
});
document.addEventListener('mousemove', e => {
  if (!_resizing) return;
  const newWidth = window.innerWidth - e.clientX;
  const min = parseInt(getComputedStyle(codePanel).minWidth);
  const max = parseInt(getComputedStyle(codePanel).maxWidth);
  codePanel.style.width = Math.min(max, Math.max(min, newWidth)) + 'px';
});
document.addEventListener('mouseup', () => {
  if (!_resizing) return;
  _resizing = false;
  codePanelResize.classList.remove('dragging');
});
