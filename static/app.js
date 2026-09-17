// ─── Entry point ──────────────────────────────────────────────────────────────
// Orchestrates initialisation, refresh cycles, and top-level event handling
// (keyboard shortcuts, window resize).  Module-specific logic lives in the
// imported modules; this file only wires them together.

import { fetchGraph, postSave, postReload, fetchStatus } from './api.js';
import {
  nodes, edges, labelNodes, nodeLayer, svg, zoom,
  setNodes, setEdges, setSourceToNode, getDirty, setDirty,
  setParentDisplayMode, parentDisplayMode, clearFocus,
  setDebugMode, debugMode, hoveredNodeId,
  layoutEngine, setLayoutEngine, colaMode, setColaMode, COLA_MODES,
  scopeRootId, setScopeRootId, focusedNodeIds,
} from './state.js';
import { renderDebug, clearDebug } from './debug.js';
import { NESTED_SCALE, FOCUS_REHEAT_ALPHA } from './constants.js';
import { initialPosition } from './geometry.js';
import {
  isNodeVisible, globalExpand, globalCollapse,
  isLeafNode, expandNode, collapseDeepestIn, flashLeaf,
  MAX_ANCESTOR_WALK, noteCycle, ancestorChain,
} from './lod.js';
import { initLabelNodes, buildSimulation, centerGraph, scheduleCenterGraph } from './simulation.js';
import { runColaLayout } from './layout-cola.js';
import {
  renderNodes, renderEdges,
  updateContainers, rerenderEdges,
  updateLodIndicator, updateModeIndicator, updateFocusHighlights,
} from './render.js';
import { setupNodeInteractions, setupEdgeInteractions } from './interaction.js';
import { setupKeybindings, renderHelpBar } from './keybindings.js';
import { loadConfig, onConfigChange } from './config.js';
import { renderConfigPanel } from './config-panel.js';
import { initHelpPanel, toggleHelp, isHelpOpen, closeHelp } from './help.js';
import { normaliseSource } from './code-panel.js';

// ─── Visibility refresh ───────────────────────────────────────────────────────
// Called whenever the LOD state changes (expand / collapse of any node).
// Updates DOM opacity, rebuilds the simulation, and refreshes all indicators.

// alpha controls how hard the simulation reheats. Expand/collapse reveals or
// hides nodes and wants a full relayout (alpha 1); a focus toggle only changes
// which edges exert force, so it passes a low alpha for a gentle settle instead
// of flinging the whole graph around.
export function refreshVisibility(alpha = 1) {
  // Initialise label phantom nodes that just became visible for the first time
  for (const [eid, ln] of Object.entries(labelNodes)) {
    if (ln._placed) continue;
    const e = edges[eid];
    const src = nodes[e.from], tgt = nodes[e.to];
    if (src && tgt && isNodeVisible(src) && isNodeVisible(tgt)) {
      ln.x = (src.x + tgt.x) / 2;
      ln.y = (src.y + tgt.y) / 2;
      ln._placed = true;
    }
  }

  // Fade nodes in/out according to current visibility
  nodeLayer.selectAll('.node').each(function(d) {
    const vis = isNodeVisible(d);
    d3.select(this)
      .transition().duration(vis ? 350 : 200)
      .ease(vis ? d3.easeCubicOut : d3.easeCubicIn)
      .attr('opacity',        vis ? 1 : 0)
      .attr('pointer-events', vis ? 'all' : 'none');
  });

  updateContainers();
  updateFocusHighlights();
  // Dispatch to the active layout engine. Both write positions to the shared
  // node objects, so the rest of the refresh is engine-agnostic.
  if (layoutEngine === 'cola') runColaLayout(alpha, { mode: colaMode });
  else buildSimulation(alpha);
  // After the layout call: that's where graphIsSparse is recomputed, and edge
  // opacity depends on it — redrawing first would paint one frame with the
  // previous visibility's flag.
  rerenderEdges();
  updateModeIndicator();
  updateEngineIndicator();
  updateLodIndicator(d3.zoomTransform(svg.node()).k);
}

// HUD readout of the active layout engine (and Cola's layering sub-mode).
function updateEngineIndicator() {
  const el = document.getElementById('engine-indicator');
  if (!el) return;
  el.textContent = layoutEngine === 'cola'
    ? `engine: cola (${colaMode})`
    : 'engine: force';
}

// ─── Scope ("cd" into a node) ───────────────────────────────────────────────
// Entering a node hides everything outside its subtree and promotes its children
// to the top level. The scope lives in the URL hash (#scope=<id>) so a refresh
// keeps you where you were, and browser back/forward walk the scope history.

function scopeFromHash() {
  const m = /^#scope=(.*)$/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

// Apply a scope (null = whole graph). `push` records it in browser history;
// popstate / init apply a scope that's already in the URL, so they don't.
function setScope(id, { push = true } = {}) {
  if (id !== null && (!nodes[id] || isLeafNode(nodes[id]))) id = null;
  if (id === scopeRootId) return;
  const prev = scopeRootId;
  setScopeRootId(id);

  // Going up: expand the path from the new scope down to the node we came out
  // of, so its contents stay in view and it's obvious where you were.
  if (prev !== null && nodes[prev]) {
    const chain = ancestorChain(prev);
    const start = id === null ? 0 : chain.findIndex(n => n.id === id) + 1;
    if (start > 0 || id === null) chain.slice(start).forEach(expandNode);
  }
  // Focus on nodes that are now out of scope would silently dim every edge.
  for (const fid of [...focusedNodeIds]) {
    if (!nodes[fid] || !isNodeVisible(nodes[fid])) focusedNodeIds.delete(fid);
  }

  if (push) {
    const hash = id === null ? '' : `#scope=${encodeURIComponent(id)}`;
    history.pushState(null, '', `${location.pathname}${location.search}${hash}`);
  }
  renderScopeBar();
  refreshVisibility(1);
  scheduleCenterGraph();
}

function enterScope(d) {
  if (isLeafNode(d)) { flashLeaf(d.id); return; }
  setScope(d.id);
}

function leaveScope() {
  if (scopeRootId === null) return;
  setScope(nodes[scopeRootId]?.parent ?? null);
}

// Breadcrumb bar: root / ancestor / … / scope, each segment clickable.
function renderScopeBar() {
  const bar = document.getElementById('scope-bar');
  bar.replaceChildren();
  bar.hidden = scopeRootId === null;
  if (scopeRootId === null) return;
  const crumb = (label, id) => {
    const b = document.createElement('button');
    b.className = 'scope-crumb';
    b.textContent = label;
    if (id === scopeRootId) b.disabled = true;
    else b.addEventListener('click', () => { setScope(id); svg.node().focus(); });
    bar.appendChild(b);
  };
  crumb('/', null);
  ancestorChain(scopeRootId).forEach((n, i) => {
    if (i > 0) bar.appendChild(document.createTextNode(' / '));
    crumb(n.label, n.id);
  });
}

window.addEventListener('popstate', () => setScope(scopeFromHash(), { push: false }));

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
// All bindings and their help text live in keybindings.js. Here we only supply
// the actions they invoke (the context object), then hand off to the dispatcher.

const keyContext = {
  getDirty,
  save: async () => { await postSave(); setDirty(false); },
  toggleHelp: toggleHelp,
  // Esc closes the help panel first if it's open, otherwise clears focus.
  clearFocus: () => {
    if (isHelpOpen()) { closeHelp(); return; }
    if (clearFocus()) refreshVisibility(FOCUS_REHEAT_ALPHA);
  },
  toggleDisplayMode: () => {
    setParentDisplayMode(parentDisplayMode === 'ghost' ? 'container' : 'ghost');
    updateContainers();
    updateModeIndicator();
  },
  // Toggle the force-debug overlay (draw once now — a settled sim won't tick).
  toggleDebug: () => {
    setDebugMode(!debugMode);
    if (debugMode) renderDebug(); else clearDebug();
  },
  toggleConfigPanel: () => document.getElementById('config-panel').classList.toggle('hidden'),
  zoomBy: factor => svg.transition().duration(250).call(zoom.scaleBy, factor),
  expandAll:   () => { if (globalExpand())   refreshVisibility(); },
  collapseAll: () => { if (globalCollapse()) refreshVisibility(); },
  // Plain E/C: expand/collapse just the node/container currently under the
  // cursor (hoveredNodeId), mirroring the Alt+scroll per-node gesture.
  expandHovered: () => {
    const d = nodes[hoveredNodeId];
    if (!d) return;
    if (isLeafNode(d)) { flashLeaf(d.id); return; }
    expandNode(d);
    refreshVisibility();
  },
  collapseHovered: () => {
    const d = nodes[hoveredNodeId];
    if (!d) return;
    if (isLeafNode(d)) { flashLeaf(d.id); return; }
    collapseDeepestIn(d);
    refreshVisibility();
  },
  enterHovered: () => { const d = nodes[hoveredNodeId]; if (d) enterScope(d); },
  leaveScope,
  // Switch layout engine (force ↔ cola) and relayout.
  toggleEngine: () => {
    setLayoutEngine(layoutEngine === 'cola' ? 'force' : 'cola');
    refreshVisibility(1);
  },
  // Cycle Cola's layout mode (layered → radial → stress); only relayouts when cola is active.
  cycleColaMode: () => {
    setColaMode(COLA_MODES[(COLA_MODES.indexOf(colaMode) + 1) % COLA_MODES.length]);
    if (layoutEngine === 'cola') refreshVisibility(1); else updateEngineIndicator();
  },
};
setupKeybindings(keyContext);

// Console fallback for toggling debug mode without the keyboard — handy when the
// reason you want the key logger is that key presses aren't registering. Run
// `vgtDebug()` (or `vgtDebug(false)`) in the devtools console.
window.vgtDebug = (on = true) => {
  setDebugMode(on);
  if (on) renderDebug(); else clearDebug();
  console.log('[vgtDebug] debug mode', on ? 'ON — keydown logging active' : 'off');
};

// ─── Nested map placement ───────────────────────────────────────────────────
// Nested (included) nodes carry their inner map's absolute pins. Recenter each
// inner map's bounding box on its mount node and scale it down, so the
// subproject's designed layout is preserved as a compact cluster. The shifted
// value becomes the node's pin, so buildSimulation fixes it (fx/fy) → rigid.

function placeNestedClusters() {
  // Group nested nodes by their mount (nearest non-nested ancestor). A nested
  // node the user has manually moved (pin came from the state file) keeps that
  // position instead of being auto-placed.
  const groups = {};
  for (const node of Object.values(nodes)) {
    if (!node.nested) continue;
    if (node.pin_from_state && node.pin) {
      node.x = node.pin.x;
      node.y = node.pin.y;
      continue;
    }
    // Nearest non-nested ancestor = the mount this inner map hangs off. Capped:
    // a self-parented node would otherwise spin here forever, and this runs
    // during init() before the first paint — so the tab would hang white.
    let a = nodes[node.parent];
    let steps = 0;
    while (a && a.nested && steps++ <= MAX_ANCESTOR_WALK) a = nodes[a.parent];
    if (a && a.nested) { noteCycle(node.id); continue; }  // never reached a mount
    if (!a) continue;
    (groups[a.id] ||= []).push(node);
  }

  for (const [mountId, group] of Object.entries(groups)) {
    const mount = nodes[mountId];
    if (!mount) continue;

    // Bounding-box center of the group's inner pins.
    const pinned = group.filter(n => n.pin);
    let cx = 0, cy = 0;
    if (pinned.length) {
      const xs = pinned.map(n => n.pin.x), ys = pinned.map(n => n.pin.y);
      cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    }

    for (const n of group) {
      if (n.pin) {
        n.x = mount.x + (n.pin.x - cx) * NESTED_SCALE;
        n.y = mount.y + (n.pin.y - cy) * NESTED_SCALE;
        n.pin = { x: n.x, y: n.y };  // fixed relative to the mount → rigid cluster
      } else {
        n.x = mount.x + (Math.random() - 0.5) * 60;
        n.y = mount.y + (Math.random() - 0.5) * 60;
      }
    }
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  // Load personal config first so the default engine, layout params, and colours
  // are in effect before the first layout / render.
  await loadConfig();

  const data = await fetchGraph();

  setNodes(data.nodes);

  // Build edges map
  setEdges({});
  for (const e of (data.edges || [])) edges[e.id] = e;

  // Attach per-node LOD state and source index
  const srcMap = {};
  for (const node of Object.values(nodes)) {
    node.expandedDepth   = 0;
    node.containerBounds = null;
    if (node.source) srcMap[normaliseSource(node.source)] = node;
  }
  setSourceToNode(srcMap);

  // Assign initial positions (roots first so children can reference parent pos).
  // Nested nodes are placed afterward, relative to their mount.
  const sorted = Object.values(nodes).sort((a, b) => a.level - b.level);
  for (const node of sorted) {
    if (node.nested) continue;
    const pos = initialPosition(node, nodes);
    node.x = pos.x;
    node.y = pos.y;
  }
  placeNestedClusters();

  // Restore the scope from the URL before the first render / layout, so a
  // refresh inside a subgraph never flashes the whole graph.
  const initialScope = scopeFromHash();
  if (initialScope !== null && nodes[initialScope] && !isLeafNode(nodes[initialScope])) {
    setScopeRootId(initialScope);
  } else if (initialScope !== null) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  renderScopeBar();

  initLabelNodes();
  renderNodes();
  renderEdges();
  updateLodIndicator(0);
  updateEngineIndicator();
  renderHelpBar(document.getElementById('key-hints'));

  // Wire up LOD indicator to zoom events (avoids state.js → render.js import)
  zoom.on('zoom.lod', event => updateLodIndicator(event.transform.k));

  // Wire up node/edge interactions, passing refreshVisibility as a callback
  // so interaction.js does not need to import app.js (which would be circular).
  setupNodeInteractions(refreshVisibility, enterScope);
  setupEdgeInteractions();

  // Render the config panel, and relayout when a non-colour setting changes
  // (colour changes only touch CSS variables, no relayout needed).
  renderConfigPanel(document.getElementById('config-panel'));
  initHelpPanel();
  // Relayout only for settings that affect layout; colour / description-mode
  // changes are pure visual toggles that applyField already handled.
  onConfigChange(field => {
    if (['engine', 'colaMode', 'const'].includes(field.target)) refreshVisibility(1);
    else if (field.target === 'declutter') rerenderEdges(); // re-place labels now
  });

  // Initial layout via the configured engine.
  if (layoutEngine === 'cola') runColaLayout(1, { mode: colaMode });
  else buildSimulation();
  scheduleCenterGraph();
  svg.node().focus();

  // Reflect the backend's dirty flag — it survives page refresh (unsaved edits
  // live in the server's in-memory graph), so the indicator must come from there.
  try {
    const st = await fetchStatus();
    setDirty(!!st.dirty);
  } catch { /* status is best-effort */ }
}

// Discard: tell the backend to re-parse config + state from disk (dropping any
// unsaved in-memory edits), then hard-reload the page to render the clean graph.
document.getElementById('discard-btn').addEventListener('click', async () => {
  if (!confirm('Discard all unsaved edits and reload from disk?')) return;
  await postReload();
  window.location.reload();
});

// ─── Window resize ────────────────────────────────────────────────────────────

let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (Object.keys(nodes).length > 0) centerGraph();
  }, 150);
});

init();
