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

// ─── Panel open / close ───────────────────────────────────────────────────────

export async function openCodePanel(nodeOrPath) {
  const source = typeof nodeOrPath === 'string' ? nodeOrPath : nodeOrPath.source;
  if (!source && source !== '') return;

  codePanelPath.textContent  = source;
  codePanelContent.innerHTML = '<pre style="color:var(--text-faint);padding:8px 12px">Loading…</pre>';
  codePanel.classList.add('open');

  try {
    const data = await fetchFile(source);
    if (data.type === 'directory') renderDirectoryInPanel(data);
    else                           renderFileInPanel(data, source);
  } catch (e) {
    codePanelContent.innerHTML =
      `<pre style="color:#fb4934;padding:8px 12px">Error: ${e.message}</pre>`;
  }
}

function renderFileInPanel(data, path) {
  codePanelPath.textContent = path;
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

document.getElementById('code-panel-close').addEventListener('click', () => {
  codePanel.classList.remove('open');
  codePanelContent.innerHTML = '';
  svg.node().focus();
});

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
