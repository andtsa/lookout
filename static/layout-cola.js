// ─── Cola (WebCola) constraint-layout engine ─────────────────────────────────
// An alternative to the d3-force simulation (simulation.js). Where force layout
// minimises a spring/charge energy that has no notion of edge crossings, Cola
// minimises a STRESS function subject to hard constraints:
//   • avoidOverlaps  — rectangular non-overlap (replaces our grouped collision)
//   • flowLayout('y')— directed edges point downward → layered, few crossings
//   • jaccardLinkLengths — ideal link lengths that spread dense neighbourhoods
// This produces far tidier, deterministic layouts (see the /cola-spike findings).
//
// Modes (cycled by the layering key):
//   • layered — flowLayout('y'): directed top-down hierarchy.
//   • radial  — layered solve, then polar-remapped so depth → radius: roots in
//               the centre, dependencies radiating outward.
//   • stress  — no flow: pure stress + non-overlap (organic, undirected).
//
// Edge labels are promoted to first-class Cola nodes (sized to their text) and
// each annotated edge is routed source → label → target, so avoidOverlaps keeps
// labels clear of nodes and of one another, and every label is always visible.
//
// Integration notes:
//   • WebCola's cola.d3adaptor relies on d3.event, which D3 v6+ removed, so we
//     DON'T use it. We drive cola.Layout directly with a synchronous solve.
//   • Positions live on the shared `nodes`/`labelNodes` objects, same as force,
//     so render.js / geometry.js / interaction.js don't care which engine ran.
//   • We install a small controller shim as `simulation` so the rest of the app
//     (drag reheat calls, the debug HUD) keeps working without branching.

import { nodes, edges, labelNodes, nodeLayer, simulation, setSimulation, setGraphIsSparse } from './state.js';
import { getViewportSize } from './geometry.js';
import { isNodeVisible, isEdgeExposed } from './lod.js';
import { rerenderEdges, updateContainers } from './render.js';
import {
  NODE_W, NODE_H, NODE_W_SM, NODE_H_SM,
  COLA_NODE_PAD, COLA_LINK_LENGTH, COLA_LINK_LENGTH_JACCARD, COLA_FLOW_GAP, COLA_ITERS,
  COLA_LABEL_CHAR_W, COLA_LABEL_H, COLA_LABEL_PAD, COLA_LABEL_MID_BAND, COLA_LABEL_OFFSET,
  COLA_RADIAL_SPAN, SPARSE_EDGE_RATIO,
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

// Polar remap of a solved layer layout: y (layer depth) → radius, x → angle, so
// the root layer sits near the centre and deeper layers radiate outward. rBase
// is chosen so arc length at the inner ring ≈ the layout's Cartesian width, which
// preserves in-layer spacing (no centre-crowding); outer rings only spread more.
function polarRemap(pts, center) {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity;
  for (const p of pts) { xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x); yMin = Math.min(yMin, p.y); }
  const W    = Math.max(1, xMax - xMin);
  const arc  = 2 * Math.PI * COLA_RADIAL_SPAN;
  const rBase = W / arc;
  for (const p of pts) {
    const r    = rBase + (p.y - yMin);              // outward by layer depth
    const frac = (p.x - xMin) / W - 0.5;            // −0.5..0.5 within layer
    const ang  = -Math.PI / 2 + frac * arc;         // fan centred at the top
    p.x = center.x + r * Math.cos(ang);
    p.y = center.y + r * Math.sin(ang);
  }
}

// Run one full (re)layout of the currently-visible graph with Cola.
//   alpha — >= 1 means a full relayout (unseeded, fresh optimum); < 1 seeds from
//           current positions so an incremental re-solve stays stable.
//   mode  — 'layered' | 'radial' | 'stress'.
export function runColaLayout(alpha = 1, { mode = 'layered' } = {}) {
  if (simulation) simulation.stop();

  const vis = Object.values(nodes).filter(isNodeVisible);
  if (vis.length === 0) { setSimulation(colaController(vis)); return; }
  const idx = new Map(vis.map((n, i) => [n.id, i]));
  const seed = alpha < 1;
  const flow = mode === 'layered' || mode === 'radial';

  // Recompute the sparse flag (as buildSimulation does) — otherwise it stays at
  // whatever the force engine last set, and a stale `true` silently forces every
  // edge exposed, disabling focus mode. Must run before isEdgeExposed() below.
  const visSemanticEdges = Object.values(edges)
    .filter(e => idx.has(e.from) && idx.has(e.to)).length;
  setGraphIsSparse(visSemanticEdges <= vis.length * SPARSE_EDGE_RATIO);

  // Real nodes first (indices 0..vis.length-1 stay aligned with `vis`).
  const cNodes = vis.map(n => {
    const b = boxOf(n);
    const c = { width: b.w + COLA_NODE_PAD, height: b.h + COLA_NODE_PAD };
    if (n.pin) { c.x = n.pin.x; c.y = n.pin.y; c.fixed = 1; }
    else if (seed) { c.x = n.x; c.y = n.y; }
    return c;
  });

  const cLinks = [];

  // Every visible semantic edge is a layout link — regardless of focus/exposure.
  // Exposure is a VISUAL lens (which edges are highlighted), not a layout filter;
  // dropping unexposed edges would make the whole layout reshuffle on focus and,
  // with focus-mode-always-on, collapse the default view to just the parent tree.
  //
  // Edge labels are added as dummy nodes only for edges whose annotation is
  // actually shown (exposed + annotated): a label-sized node routed
  // source → label → target so avoidOverlaps keeps it clear of everything.
  const labelIndex = new Map();
  for (const e of Object.values(edges)) {
    if (!idx.has(e.from) || !idx.has(e.to)) continue;
    const ann = e.annotation;
    const ln  = labelNodes[e.id];
    if (isEdgeExposed(e) && ann && ln) {
      const li = cNodes.length;
      const c  = { width: ann.length * COLA_LABEL_CHAR_W + COLA_LABEL_PAD, height: COLA_LABEL_H + COLA_LABEL_PAD };
      if (seed && ln.x != null) { c.x = ln.x; c.y = ln.y; }
      cNodes.push(c);
      labelIndex.set(e.id, li);
      cLinks.push({ source: idx.get(e.from), target: li });
      cLinks.push({ source: li, target: idx.get(e.to) });
    } else {
      cLinks.push({ source: idx.get(e.from), target: idx.get(e.to) });
    }
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
  if (flow) layout.flowLayout('y', COLA_FLOW_GAP);

  // keepRunning=false → run the iteration budget synchronously and stop.
  const [i0, i1, i2] = COLA_ITERS;
  layout.start(i0, i1, i2, 0, false);

  // Radial: polar-remap the whole solved layout (real + label nodes together, so
  // labels stay beside their edges after the transform).
  if (mode === 'radial') polarRemap(cNodes, { x: w / 2, y: h / 2 });

  // Apply solved positions to the shared objects immediately (correctness is
  // independent of any animation, which is rAF-driven and throttled when hidden).
  vis.forEach((n, i) => {
    n.x = (n.pin && mode !== 'radial') ? n.pin.x : cNodes[i].x;
    n.y = (n.pin && mode !== 'radial') ? n.pin.y : cNodes[i].y;
  });
  // Snap each label onto its edge, near the midpoint. The solver placed the label
  // dummy off to a clear spot; we project that position onto the edge segment (so
  // the label sits ON its edge), clamp the along-edge parameter to a band around
  // the midpoint, and nudge it slightly perpendicular so the line doesn't cut
  // through the text. Projecting the *solved* point (not just using t=0.5) keeps
  // labels on crossing edges from stacking on the same midpoint.
  const half = COLA_LABEL_MID_BAND / 2;
  for (const [eid, li] of labelIndex) {
    const ln = labelNodes[eid];
    const e  = edges[eid];
    const a  = e && nodes[e.from], b = e && nodes[e.to];
    if (!ln || !a || !b) continue;
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    let t = ((cNodes[li].x - a.x) * abx + (cNodes[li].y - a.y) * aby) / len2;
    t = Math.max(0.5 - half, Math.min(0.5 + half, t));
    const len = Math.sqrt(len2);
    const nx = -aby / len, ny = abx / len; // unit normal to the edge
    ln.x = a.x + t * abx + nx * COLA_LABEL_OFFSET;
    ln.y = a.y + t * aby + ny * COLA_LABEL_OFFSET;
    ln._placed = true;
  }

  nodeLayer.selectAll('.node').attr('transform', d => `translate(${d.x},${d.y})`);
  updateContainers();
  rerenderEdges();

  setSimulation(colaController(vis));
}
