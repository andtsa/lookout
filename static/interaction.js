// ─── User interaction ─────────────────────────────────────────────────────────
// Drag, rename, edge annotation, context menu.
// Call setupNodeInteractions(refreshFn) and setupEdgeInteractions() from
// app.js after renderNodes / renderEdges.

import {
  nodes, edges, labelNodes, simulation, layoutEngine, nodeDescriptionMode, hoverTipDelay,
  nodeLayer, edgeLayer, svg,
  scrollAccum, setHoveredNodeId, setSelectedEdgeId, setDirty, toggleFocusedNode,
} from './state.js';
import { updateDraggedLabels } from './layout-cola.js';
import {
  visibleDescendants, isLeafNode, flashLeaf, getVisibleProxy,
  expandNode, collapseDeepestIn,
} from './lod.js';
import { updateContainers, rerenderEdges } from './render.js';
import { buildSimulation } from './simulation.js';
import { getEdgeEndpoints } from './geometry.js';
import { patchNode, patchEdge } from './api.js';
import { openCodePanel, toggleCodePanel } from './code-panel.js';
import { SCROLL_THRESHOLD, DRAG_THRESHOLD, FOCUS_REHEAT_ALPHA } from './constants.js';

// ─── Hover tooltip (node / edge descriptions) ─────────────────────────────────

const hoverTip = document.getElementById('hover-tip');
let _tipTimer = null;

function showTip(text, x, y) {
  hoverTip.textContent = text;
  hoverTip.hidden = false;
  // Offset from the cursor and keep it inside the viewport.
  const left = Math.min(x + 14, window.innerWidth  - hoverTip.offsetWidth  - 8);
  const top  = Math.min(y + 14, window.innerHeight - hoverTip.offsetHeight - 8);
  hoverTip.style.left = `${Math.max(8, left)}px`;
  hoverTip.style.top  = `${Math.max(8, top)}px`;
}

// Arm the tooltip to appear only once the mouse has been still for hoverTipDelay.
// Called on every mouseenter/mousemove, so any movement resets the timer (and
// hides a shown tip), so the popup only surfaces when the pointer settles.
function scheduleTip(text, x, y) {
  clearTimeout(_tipTimer);
  if (!text) { hoverTip.hidden = true; return; }
  hoverTip.hidden = true; // hide while moving; re-appears when still
  _tipTimer = setTimeout(() => showTip(text, x, y), hoverTipDelay);
}
function cancelTip() { clearTimeout(_tipTimer); _tipTimer = null; hoverTip.hidden = true; }

// ─── Drag ─────────────────────────────────────────────────────────────────────

let _dragMoved  = false;  // true once pointer travels more than DRAG_THRESHOLD
let _dragOriginX = 0;     // pointer position at drag start (SVG coords)
let _dragOriginY = 0;

function dragStarted(event, d) {
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
    // NB: no `!event.active` guard here. Inside the drag handler the gesture is
    // already active (event.active >= 1), so that guard is always false — which
    // previously meant the sim never reheated, and a dragged non-expanded node
    // (e.g. a pinned top-level node) never re-rendered until a page refresh.
    _dragMoved = true;
    if (simulation) simulation.alphaTarget(0.3).restart();
    svg.classed('dragging', true);
  }
  const dx = event.x - d.fx;
  const dy = event.y - d.fy;
  d.fx = event.x;
  d.fy = event.y;
  d.x  = event.x;
  d.y  = event.y;

  // Move the whole expanded cluster together with the dragged container.
  const moved = new Set([d.id]);
  if (d.expandedDepth > 0) {
    for (const c of visibleDescendants(d)) {
      c.x += dx; c.y += dy;
      c.fx = c.x; c.fy = c.y;
      moved.add(c.id);
    }
  }

  // Render the moved node(s) immediately. Under d3-force the tick handler would
  // also do this, but the Cola engine doesn't tick continuously, so a drag would
  // otherwise not move until the next relayout.
  nodeLayer.selectAll('.node').each(function(n) {
    if (moved.has(n.id)) d3.select(this).attr('transform', `translate(${n.x},${n.y})`);
  });
  // Under Cola, no sim pulls the edge labels along, so recompute their positions
  // from the moved endpoints (the force engine's label-pull handles this itself).
  if (layoutEngine === 'cola') updateDraggedLabels(moved);
  if (d.expandedDepth > 0) updateContainers();
  rerenderEdges();
}

function dragEnded(event, d) {
  svg.classed('dragging', false);
  if (!_dragMoved) { d.fx = null; d.fy = null; return; } // click, not a drag
  if (!event.active && simulation) simulation.alphaTarget(0);

  // Nested nodes' positions are outer-owned: a drag persists as a pin in the
  // state file (keyed by the namespaced id), same as any other node below.

  // Decide pin vs release based on whether Shift is held *now*, at release —
  // this lets you start a plain drag and commit it as a pin (or not) by the
  // state of the key when you let go, rather than when you grabbed the node.
  const shiftAtRelease = event.sourceEvent && event.sourceEvent.shiftKey;
  if (shiftAtRelease) {
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
  const edge = edges[edgeId];
  if (!edge) return;
  // Nested (included) edges are read-only — no annotation editing.
  if (nodes[edge.from]?.nested || nodes[edge.to]?.nested) return;
  setSelectedEdgeId(edgeId);

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
  // Nested (included) nodes have read-only *content* (no rename), but their
  // position is editable — so unpin (reset to auto-placement) still applies.
  document.getElementById('ctx-rename').style.display = d.nested ? 'none' : 'block';
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
      nodeTip(event, d);
    })
    // Reset the settle-timer as the mouse moves within the node.
    .on('mousemove.tip', nodeTip)
    .on('mouseleave.lod', function(event, d) {
      setHoveredNodeId(null);
      scrollAccum[d.id] = 0;
      d3.select(this)
        .classed('node-lod-target', false)
        .classed('node-leaf-hover', false);
      cancelTip();
    });

  // In 'hover' mode a node's description is shown only in the settle tooltip.
  function nodeTip(event, d) {
    if (nodeDescriptionMode === 'hover' && d.description)
      scheduleTip(d.description, event.clientX, event.clientY);
  }

  // Alt+scroll over a node: per-node expand / collapse.
  // Plain scroll is left alone so it bubbles to the d3 zoom on <svg> — that way
  // zoom works everywhere, including over nodes (global expand/collapse is E/C).
  allNodes.on('wheel.lod', function(event, d) {
    if (!event.altKey) return; // let plain scroll zoom the canvas
    event.stopPropagation();
    event.preventDefault();
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

  // Alt+click: toggle focus (deliberate — a plain click does nothing, so casual
  // clicking never shuffles the map). D3 fires a synthetic click after a drag;
  // suppress it if the pointer moved.
  allNodes.on('click', (event, d) => {
    event.stopPropagation();
    if (_dragMoved) { _dragMoved = false; return; }
    if (!event.altKey) return;             // plain click: no-op
    toggleFocusedNode(d.id);
    refreshFn(FOCUS_REHEAT_ALPHA);         // relayout so the focused subgraph opens up
  });

  // Double click: toggle the source panel — open it (or switch to this node),
  // or close it if it's already showing this node.
  allNodes.on('dblclick', (event, d) => {
    event.stopPropagation();
    if (d.source) toggleCodePanel(d);
  });

  // Right-click: context menu (rename, unpin, open source).
  allNodes.on('contextmenu', (event, d) => {
    event.preventDefault();
    showContextMenu(event, d);
  });
}

export function setupEdgeInteractions() {
  const select = (event, d) => { event.stopPropagation(); selectEdge(d.id); };
  const visualFor = id => edgeLayer.selectAll('.edge-visual').filter(x => x.id === id);

  // Hover the (wide) hit area → highlight the whole edge immediately; the
  // description tooltip waits until the mouse settles (scheduleTip).
  function onEnter(event, d) {
    visualFor(d.id).classed('edge-hover', true);
    scheduleTip(d.description, event.clientX, event.clientY);
  }
  function onMove(event, d) {
    scheduleTip(d.description, event.clientX, event.clientY);
  }
  function onLeave(event, d) {
    visualFor(d.id).classed('edge-hover', false);
    cancelTip();
  }

  edgeLayer.selectAll('.edge-hitarea-group')
    .on('click', select)
    .on('mouseenter', onEnter)
    .on('mousemove', onMove)
    .on('mouseleave', onLeave);

  // The annotation label lives in a separate group (.edge-visual) from the
  // invisible hit line (.edge-hitarea-group) — often floating off the line
  // entirely (its phantom-node position) — so mouse events there never bubble
  // into the hitarea-group's own listeners (siblings, not ancestor/descendant).
  // Mirror click + hover onto it directly so hovering/clicking the label works
  // exactly like hovering/clicking the line.
  edgeLayer.selectAll('.edge-visual').select('text.edge-annotation')
    .on('click', select)
    .on('mouseenter', onEnter)
    .on('mousemove', onMove)
    .on('mouseleave', onLeave);
}
