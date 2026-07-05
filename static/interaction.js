// ─── User interaction ─────────────────────────────────────────────────────────
// Drag, rename, edge annotation, context menu.
// Call setupNodeInteractions(refreshFn) and setupEdgeInteractions() from
// app.js after renderNodes / renderEdges.

import {
  nodes, edges, labelNodes, simulation,
  nodeLayer, edgeLayer, svg,
  scrollAccum, setHoveredNodeId, setSelectedEdgeId, setDirty, toggleFocusedNode,
} from './state.js';
import {
  visibleDescendants, isLeafNode, flashLeaf, getVisibleProxy,
  expandNode, collapseDeepestIn,
} from './lod.js';
import { updateContainers, rerenderEdges } from './render.js';
import { buildSimulation } from './simulation.js';
import { getEdgeEndpoints } from './geometry.js';
import { patchNode, patchEdge } from './api.js';
import { openCodePanel } from './code-panel.js';
import { SCROLL_THRESHOLD, DRAG_THRESHOLD } from './constants.js';

// ─── Drag ─────────────────────────────────────────────────────────────────────

let _dragShift  = false;
let _dragMoved  = false;  // true once pointer travels more than DRAG_THRESHOLD
let _dragOriginX = 0;     // pointer position at drag start (SVG coords)
let _dragOriginY = 0;

function dragStarted(event, d) {
  _dragShift   = event.sourceEvent && event.sourceEvent.shiftKey;
  _dragMoved   = false;
  _dragOriginX = event.x;
  _dragOriginY = event.y;
  // Don't heat the simulation yet — wait until the threshold is crossed so
  // a plain click doesn't kick off an unnecessary physics burst.
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(event, d) {
  // Ignore tiny movements so clicks don't accidentally become drags.
  if (!_dragMoved) {
    const dx = event.x - _dragOriginX;
    const dy = event.y - _dragOriginY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
    // Threshold crossed — upgrade to a real drag and heat the simulation.
    _dragMoved = true;
    if (!event.active && simulation) simulation.alphaTarget(0.3).restart();
    svg.classed('dragging', true);
  }
  const dx = event.x - d.fx;
  const dy = event.y - d.fy;
  d.fx = event.x;
  d.fy = event.y;
  d.x  = event.x;
  d.y  = event.y;

  // Move the whole expanded cluster together
  if (d.expandedDepth > 0) {
    const desc    = visibleDescendants(d);
    const descIds = new Set(desc.map(c => c.id));
    for (const c of desc) {
      c.x += dx; c.y += dy;
      c.fx = c.x; c.fy = c.y;
    }
    nodeLayer.selectAll('.node').each(function(n) {
      if (n.id === d.id || descIds.has(n.id))
        d3.select(this).attr('transform', `translate(${n.x},${n.y})`);
    });
    updateContainers();
    rerenderEdges();
  }
}

function dragEnded(event, d) {
  svg.classed('dragging', false);
  if (!_dragMoved) { d.fx = null; d.fy = null; return; } // click, not a drag
  if (!event.active && simulation) simulation.alphaTarget(0);

  if (_dragShift) {
    d.pin = { x: d.fx, y: d.fy };
    nodeLayer.selectAll('.node').filter(n => n.id === d.id).classed('pinned', true);
    setDirty(true);
    patchNode(d.id, { pin: { x: d.fx, y: d.fy } });
  } else if (d.pin) {
    // Re-pin at new position for already-pinned nodes
    d.pin = { x: d.fx, y: d.fy };
    setDirty(true);
    patchNode(d.id, { pin: { x: d.fx, y: d.fy } });
  } else {
    d.fx = null;
    d.fy = null;
  }

  // Release cluster descendants and let simulation settle
  if (d.expandedDepth > 0) {
    for (const c of visibleDescendants(d)) {
      if (!c.pin) { c.fx = null; c.fy = null; }
    }
    if (simulation) simulation.alphaTarget(0.2).restart();
  }
}

// ─── Rename box ───────────────────────────────────────────────────────────────
// Single fixed box at bottom-left, shared by node rename and edge annotation.

const renameBox      = document.getElementById('rename-box');
const renameBoxLabel = document.getElementById('rename-box-label');
const renameBoxInput = document.getElementById('rename-box-input');
let   _renameCleanup = null;

export function openRenameBox(label, value, onCommit, onCancel) {
  if (_renameCleanup) _renameCleanup(false);

  renameBoxLabel.textContent = label;
  renameBoxInput.value       = value;
  renameBox.hidden           = false;

  let done = false;

  function commit() {
    if (done) return;
    done = true;
    renameBox.hidden = true;
    _renameCleanup   = null;
    onCommit(renameBoxInput.value.trim());
    svg.node().focus();
  }
  function cancel() {
    if (done) return;
    done = true;
    renameBox.hidden = true;
    _renameCleanup   = null;
    if (onCancel) onCancel();
    svg.node().focus();
  }
  function keydown(e) {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { cancel(); }
  }

  renameBoxInput.addEventListener('blur',    commit,  { once: true });
  renameBoxInput.addEventListener('keydown', keydown);

  _renameCleanup = (shouldCommit) => {
    done = true;
    renameBoxInput.removeEventListener('blur',    commit);
    renameBoxInput.removeEventListener('keydown', keydown);
    renameBox.hidden = true;
    if (shouldCommit) onCommit(renameBoxInput.value.trim());
    else if (onCancel) onCancel();
    _renameCleanup = null;
  };

  requestAnimationFrame(() => { renameBoxInput.focus(); renameBoxInput.select(); });
}

// ─── Node label editing ───────────────────────────────────────────────────────

export function startLabelEdit(d) {
  const nodeEl = nodeLayer.selectAll('.node').filter(n => n.id === d.id);
  nodeEl.classed('node-renaming', true);

  openRenameBox(
    `node: ${d.label}`,
    d.label,
    (newLabel) => {
      newLabel = newLabel || d.label;
      nodeEl.classed('node-renaming', false);
      d.label = newLabel;
      nodeEl.select('text').text(newLabel);
      setDirty(true);
      patchNode(d.id, { label: newLabel });
    },
    () => nodeEl.classed('node-renaming', false),
  );
}

// ─── Edge annotation editing ──────────────────────────────────────────────────

export function selectEdge(edgeId) {
  setSelectedEdgeId(edgeId);
  const edge = edges[edgeId];
  if (!edge) return;

  const edgeVisual = edgeLayer.selectAll('.edge-visual').filter(d => d.id === edgeId);
  edgeVisual.classed('edge-renaming', true);

  openRenameBox(
    `edge: ${edge.from} → ${edge.to}`,
    edge.annotation || '',
    (val) => {
      edge.annotation = val || null;
      edgeVisual.classed('edge-renaming', false);
      const pts = getEdgeEndpoints(edge, getVisibleProxy);
      if (labelNodes[edgeId]) {
        if (!val) delete labelNodes[edgeId];
      } else if (val) {
        labelNodes[edgeId] = {
          id: `label_${edgeId}`, edgeId,
          x: pts ? (pts.x1 + pts.x2) / 2 : 0,
          y: pts ? (pts.y1 + pts.y2) / 2 : 0,
          vx: 0, vy: 0, _placed: !!pts,
        };
      }
      rerenderEdges();
      buildSimulation();
      setDirty(true);
      patchEdge(edgeId, { annotation: val || null });
      setSelectedEdgeId(null);
    },
    () => {
      edgeVisual.classed('edge-renaming', false);
      setSelectedEdgeId(null);
    },
  );
}

// ─── Context menu ─────────────────────────────────────────────────────────────

const ctxMenu = document.getElementById('context-menu');
let ctxNode = null;

export function showContextMenu(event, d) {
  ctxNode = d;
  ctxMenu.style.left = `${event.clientX}px`;
  ctxMenu.style.top  = `${event.clientY}px`;
  ctxMenu.classList.add('visible');
  document.getElementById('ctx-unpin').style.display = d.pin ? 'block' : 'none';
}

export function hideContextMenu() {
  ctxMenu.classList.remove('visible');
  ctxNode = null;
}

// Context menu item handlers (wired at import time)
document.getElementById('ctx-rename').addEventListener('click', () => {
  if (!ctxNode) return;
  const d = ctxNode;
  hideContextMenu();
  startLabelEdit(d);
});

document.getElementById('ctx-unpin').addEventListener('click', () => {
  if (!ctxNode) return;
  const d = ctxNode;
  hideContextMenu();
  d.pin = null; d.fx = null; d.fy = null;
  nodeLayer.selectAll('.node').filter(n => n.id === d.id).classed('pinned', false);
  if (simulation) simulation.alphaTarget(0.2).restart();
  setDirty(true);
  patchNode(d.id, { pin: null });
});

document.getElementById('ctx-open-source').addEventListener('click', () => {
  if (!ctxNode) return;
  const d = ctxNode;
  hideContextMenu();
  if (d.source) openCodePanel(d);
});

svg.on('click.context', hideContextMenu);

// ─── Event setup ──────────────────────────────────────────────────────────────
// Call these from app.js after renderNodes() / renderEdges().

// refreshFn = app.js's refreshVisibility, passed as a callback to avoid
// an import cycle (interaction.js → app.js → interaction.js).
export function setupNodeInteractions(refreshFn) {
  const allNodes = nodeLayer.selectAll('.node');

  // Drag
  allNodes.call(d3.drag()
    .on('start', dragStarted)
    .on('drag',  dragged)
    .on('end',   dragEnded));

  // Hover LOD cue
  allNodes
    .on('mouseenter.lod', function(event, d) {
      setHoveredNodeId(d.id);
      d3.select(this).classed('node-lod-target', true);
      if (isLeafNode(d)) d3.select(this).classed('node-leaf-hover', true);
    })
    .on('mouseleave.lod', function(event, d) {
      setHoveredNodeId(null);
      scrollAccum[d.id] = 0;
      d3.select(this)
        .classed('node-lod-target', false)
        .classed('node-leaf-hover', false);
    });

  // Scroll: per-node expand / collapse
  allNodes.on('wheel.lod', function(event, d) {
    event.stopPropagation();
    scrollAccum[d.id] = (scrollAccum[d.id] || 0) + event.deltaY;
    if (scrollAccum[d.id] > SCROLL_THRESHOLD) {
      scrollAccum[d.id] = 0;
      if (isLeafNode(d)) { flashLeaf(d.id); return; }
      collapseDeepestIn(d);
      refreshFn();
    } else if (scrollAccum[d.id] < -SCROLL_THRESHOLD) {
      scrollAccum[d.id] = 0;
      if (isLeafNode(d)) { flashLeaf(d.id); return; }
      expandNode(d);
      refreshFn();
    }
  });

  // Single click: toggle focus on this node.
  // D3 drag fires a synthetic click after drag end — suppress it if the pointer moved.
  allNodes.on('click', (event, d) => {
    event.stopPropagation();
    if (_dragMoved) { _dragMoved = false; return; }
    toggleFocusedNode(d.id);
    refreshFn();
  });

  // Double click: open code panel.
  allNodes.on('dblclick', (event, d) => {
    event.stopPropagation();
    if (d.source) openCodePanel(d);
  });

  // Right-click: context menu (rename, unpin, open source).
  allNodes.on('contextmenu', (event, d) => {
    event.preventDefault();
    showContextMenu(event, d);
  });
}

export function setupEdgeInteractions() {
  edgeLayer.selectAll('.edge-hitarea-group')
    .on('click', (event, d) => {
      event.stopPropagation();
      selectEdge(d.id);
    });
}
