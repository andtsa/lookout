// ─── Cola (WebCola) constraint-layout engine ─────────────────────────────────
// An alternative to the d3-force simulation (simulation.js). Where force layout
// minimises a spring/charge energy that has no notion of edge crossings, Cola
// minimises a STRESS function subject to hard constraints:
//   • avoidOverlaps  — rectangular non-overlap (replaces our grouped collision)
//   • flowLayout('y')— directed edges point downward → layered, few crossings
//   • jaccardLinkLengths — ideal link lengths that spread dense neighbourhoods
// This produces far tidier, deterministic layouts (see the /cola-spike findings).
//
// Integration notes:
//   • WebCola's cola.d3adaptor relies on d3.event, which D3 v6+ removed, so we
//     DON'T use it. We drive cola.Layout directly: a synchronous solve, then a
//     tween from the old positions to the solved ones.
//   • Positions live on the shared `nodes` objects (n.x/n.y), same as force, so
//     render.js / geometry.js / interaction.js don't care which engine ran.
//   • We install a small controller shim as `simulation` so the rest of the app
//     (drag reheat calls, the debug HUD) keeps working without branching.

import { nodes, edges, labelNodes, nodeLayer, simulation, setSimulation } from './state.js';
import { getViewportSize } from './geometry.js';
import { isNodeVisible, isEdgeExposed } from './lod.js';
import { rerenderEdges, updateContainers } from './render.js';
import {
  NODE_W, NODE_H, NODE_W_SM, NODE_H_SM,
  COLA_NODE_PAD, COLA_LINK_LENGTH, COLA_LINK_LENGTH_JACCARD, COLA_FLOW_GAP,
  COLA_ITERS,
} from './constants.js';

// A stand-in for the d3 force simulation. Cola owns positions synchronously, so
// these are mostly no-ops — they exist purely so callers that poke `simulation`
// (interaction.js drag reheat, debug.js HUD) don't need to know the engine.
function colaController(vis) {
  const ctrl = {
    alpha: () => 0,
    alphaTarget: () => ctrl,   // chainable no-op: `.alphaTarget(x).restart()`
    restart: () => ctrl,
    stop: () => ctrl,
    tick: () => ctrl,
    nodes: () => vis,
    force: () => null,
    _engine: 'cola',
  };
  return ctrl;
}

const boxOf = n => (n.level >= 1 ? { w: NODE_W_SM, h: NODE_H_SM } : { w: NODE_W, h: NODE_H });

// Run one full (re)layout of the currently-visible graph with Cola.
//   alpha   — >= 1 means a full relayout (longer animation); lower = gentle.
//   layered — enforce directed top-down layering via flowLayout.
export function runColaLayout(alpha = 1, { layered = true } = {}) {
  // Stop whatever was running (a real force sim, or a prior cola controller).
  if (simulation) simulation.stop();

  const vis = Object.values(nodes).filter(isNodeVisible);
  if (vis.length === 0) { setSimulation(colaController(vis)); return; }
  const idx = new Map(vis.map((n, i) => [n.id, i]));

  // Cola nodes: rectangles (width/height drive non-overlap).
  //   • Pinned nodes are fixed at their pin.
  //   • Full relayout (alpha >= 1, e.g. engine switch / tidy): leave positions
  //     UNSEEDED so Cola finds a fresh global optimum — seeding from the tangled
  //     force layout traps it in a nearby, worse local minimum (~90 vs ~72 xings).
  //   • Incremental re-solve (alpha < 1, e.g. after expand): seed from current
  //     positions so the layout stays stable and doesn't teleport.
  const seed = alpha < 1;
  const cNodes = vis.map(n => {
    const b = boxOf(n);
    const c = { width: b.w + COLA_NODE_PAD, height: b.h + COLA_NODE_PAD };
    if (n.pin) { c.x = n.pin.x; c.y = n.pin.y; c.fixed = 1; }
    else if (seed) { c.x = n.x; c.y = n.y; }
    return c;
  });

  // Links: exposed semantic edges + parent→child. Unexposed edges (focus active)
  // are dropped so they don't constrain the layout — the focused subgraph rules.
  const cLinks = [];
  for (const e of Object.values(edges)) {
    if (!idx.has(e.from) || !idx.has(e.to) || !isEdgeExposed(e)) continue;
    cLinks.push({ source: idx.get(e.from), target: idx.get(e.to) });
  }
  for (const n of vis) {
    if (n.parent && idx.has(n.parent))
      cLinks.push({ source: idx.get(n.parent), target: idx.get(n.id) });
  }

  const { w, h } = getViewportSize();
  const layout = new cola.Layout()
    .size([w, h])
    .nodes(cNodes)
    .links(cLinks)
    .avoidOverlaps(true)
    .jaccardLinkLengths(COLA_LINK_LENGTH, COLA_LINK_LENGTH_JACCARD)
    .handleDisconnected(true);
  if (layered) layout.flowLayout('y', COLA_FLOW_GAP);

  // keepRunning=false → run the iteration budget synchronously and stop.
  const [i0, i1, i2] = COLA_ITERS;
  layout.start(i0, i1, i2, 0, false);

  // Apply the solved positions to the shared node objects IMMEDIATELY, so the
  // layout is correct the instant the solve returns — independent of whether the
  // animation below actually runs (it's rAF-driven, and rAF is throttled in a
  // hidden tab). Pinned nodes keep their exact pin.
  vis.forEach((n, i) => {
    n.x = n.pin ? n.pin.x : cNodes[i].x;
    n.y = n.pin ? n.pin.y : cNodes[i].y;
  });
  nodeLayer.selectAll('.node').attr('transform', d => `translate(${d.x},${d.y})`);

  // Cola doesn't model the annotation label phantoms, so park each at its edge
  // midpoint (the force sim's label-pull would converge here anyway). Without
  // this they'd render at stale positions, bunched away from their edge.
  for (const ln of Object.values(labelNodes)) {
    const e = edges[ln.edgeId];
    const a = e && nodes[e.from], b = e && nodes[e.to];
    if (a && b) { ln.x = (a.x + b.x) / 2; ln.y = (a.y + b.y) / 2; }
  }

  updateContainers();
  rerenderEdges();

  setSimulation(colaController(vis));
}
