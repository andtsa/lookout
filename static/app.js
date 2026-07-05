// ─── Entry point ──────────────────────────────────────────────────────────────
// Orchestrates initialisation, refresh cycles, and top-level event handling
// (keyboard shortcuts, window resize).  Module-specific logic lives in the
// imported modules; this file only wires them together.

import { fetchGraph, postSave } from './api.js';
import {
  nodes, edges, labelNodes, nodeLayer, svg, zoom,
  setNodes, setEdges, setSourceToNode, getDirty, setDirty,
  setParentDisplayMode, parentDisplayMode, clearFocus,
} from './state.js';
import { initialPosition } from './geometry.js';
import { isNodeVisible, globalExpand, globalCollapse } from './lod.js';
import { initLabelNodes, buildSimulation, centerGraph, scheduleCenterGraph } from './simulation.js';
import {
  renderNodes, renderEdges,
  updateContainers, rerenderEdges,
  updateLodIndicator, updateModeIndicator, updateFocusHighlights,
} from './render.js';
import { setupNodeInteractions, setupEdgeInteractions } from './interaction.js';
import { normaliseSource } from './code-panel.js';

// ─── Visibility refresh ───────────────────────────────────────────────────────
// Called whenever the LOD state changes (expand / collapse of any node).
// Updates DOM opacity, rebuilds the simulation, and refreshes all indicators.

export function refreshVisibility() {
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
  buildSimulation();
  updateModeIndicator();
  updateLodIndicator(d3.zoomTransform(svg.node()).k);
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', async e => {
  const inInput = document.activeElement.tagName === 'INPUT';

  // Ctrl/Cmd+S: save — works even when an input is focused
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (!getDirty()) return;
    await postSave();
    setDirty(false);
    return;
  }

  // Escape: clear all focused nodes (while input is open, let the browser handle it)
  if (e.key === 'Escape' && !inInput) {
    if (clearFocus()) refreshVisibility();
    return;
  }

  if (inInput) return;

  // G: toggle ghost / container mode
  if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    setParentDisplayMode(parentDisplayMode === 'ghost' ? 'container' : 'ghost');
    updateContainers();
    updateModeIndicator();
  }

  // +/= zoom in   −/_ zoom out
  if ((e.key === '+' || e.key === '=') && !e.ctrlKey && !e.metaKey)
    svg.transition().duration(250).call(zoom.scaleBy, 1.3);
  if (e.key === '-' && !e.ctrlKey && !e.metaKey)
    svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.3);

  // E / C: global expand / collapse one frontier level
  // Guard: allow AltGr (Ctrl+Alt on Windows) but block plain Ctrl/Cmd combos.
  const bracketGuard = !e.metaKey && !(e.ctrlKey && !e.altKey);
  if ((e.key === 'e' || e.key === 'E') && bracketGuard) {
    if (globalExpand()) refreshVisibility();
  }
  if ((e.key === 'c' || e.key === 'C') && bracketGuard) {
    if (globalCollapse()) refreshVisibility();
  }
});

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

  // Assign initial positions (roots first so children can reference parent pos)
  const sorted = Object.values(nodes).sort((a, b) => a.level - b.level);
  for (const node of sorted) {
    const pos = initialPosition(node, nodes);
    node.x = pos.x;
    node.y = pos.y;
  }

  initLabelNodes();
  renderNodes();
  renderEdges();
  updateLodIndicator(0);

  // Wire up LOD indicator to zoom events (avoids state.js → render.js import)
  zoom.on('zoom.lod', event => updateLodIndicator(event.transform.k));

  // Wire up node/edge interactions, passing refreshVisibility as a callback
  // so interaction.js does not need to import app.js (which would be circular).
  setupNodeInteractions(refreshVisibility);
  setupEdgeInteractions();

  buildSimulation();
  scheduleCenterGraph();
  svg.node().focus();
}

// ─── Window resize ────────────────────────────────────────────────────────────

let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (Object.keys(nodes).length > 0) centerGraph();
  }, 150);
});

init();
