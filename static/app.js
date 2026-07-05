// ─── Entry point ──────────────────────────────────────────────────────────────
// Orchestrates initialisation, refresh cycles, and top-level event handling
// (keyboard shortcuts, window resize).  Module-specific logic lives in the
// imported modules; this file only wires them together.

import { fetchGraph, postSave, postReload, fetchStatus } from './api.js';
import {
  nodes, edges, labelNodes, nodeLayer, svg, zoom,
  setNodes, setEdges, setSourceToNode, getDirty, setDirty,
  setParentDisplayMode, parentDisplayMode, clearFocus,
  setDebugMode, debugMode,
  layoutEngine, setLayoutEngine, colaMode, setColaMode, COLA_MODES,
} from './state.js';
import { renderDebug, clearDebug } from './debug.js';
import { NESTED_SCALE, FOCUS_REHEAT_ALPHA } from './constants.js';
import { initialPosition } from './geometry.js';
import { isNodeVisible, globalExpand, globalCollapse } from './lod.js';
import { initLabelNodes, buildSimulation, centerGraph, scheduleCenterGraph } from './simulation.js';
import { runColaLayout } from './layout-cola.js';
import {
  renderNodes, renderEdges,
  updateContainers, rerenderEdges,
  updateLodIndicator, updateModeIndicator, updateFocusHighlights,
} from './render.js';
import { setupNodeInteractions, setupEdgeInteractions } from './interaction.js';
import { setupKeybindings, renderHelpBar } from './keybindings.js';
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
  rerenderEdges();
  updateFocusHighlights();
  // Dispatch to the active layout engine. Both write positions to the shared
  // node objects, so the rest of the refresh is engine-agnostic.
  if (layoutEngine === 'cola') runColaLayout(alpha, { mode: colaMode });
  else buildSimulation(alpha);
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

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
// All bindings and their help text live in keybindings.js. Here we only supply
// the actions they invoke (the context object), then hand off to the dispatcher.

const keyContext = {
  getDirty,
  save: async () => { await postSave(); setDirty(false); },
  clearFocus: () => { if (clearFocus()) refreshVisibility(FOCUS_REHEAT_ALPHA); },
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
  zoomBy: factor => svg.transition().duration(250).call(zoom.scaleBy, factor),
  expandAll:   () => { if (globalExpand())   refreshVisibility(); },
  collapseAll: () => { if (globalCollapse()) refreshVisibility(); },
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
    let a = nodes[node.parent];
    while (a && a.nested) a = nodes[a.parent];
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
  setupNodeInteractions(refreshVisibility);
  setupEdgeInteractions();

  buildSimulation();
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
