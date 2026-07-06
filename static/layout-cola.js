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
  COLA_NODE_PAD, COLA_LINK_LENGTH, COLA_LINK_LENGTH_JACCARD, COLA_FLOW_GAP, COLA_ITERS,
  COLA_LABEL_CHAR_W, COLA_LABEL_H, COLA_LABEL_PAD, COLA_LABEL_MID_BAND, COLA_LABEL_OFFSET,
  COLA_RADIAL_SPAN, SPARSE_EDGE_RATIO, COLA_ANIM_MS_FULL, COLA_ANIM_MS_GENTLE,
} from './constants.js';

// In-flight layout tween (d3.timer). Cola solves synchronously to target
// positions; this animates the nodes/labels from where they are to those targets
// so a re-layout glides instead of teleporting. A new solve interrupts the old
// tween (start-from-wherever-we-are), so rapid re-layouts don't stack or snap.
let _anim = null;
function stopAnim() { if (_anim) { _anim.stop(); _anim = null; } }

// Tween real nodes (vis[i] → targets[i]) and labels (labelNodes[eid] → labelTargets)
// over `dur` ms, re-rendering edges/containers each frame so everything moves
// together. Positions reach the exact targets on completion.
function animateTo(vis, targets, labelTargets, dur) {
  stopAnim();
  const from    = vis.map(n => ({ x: n.x, y: n.y }));
  const labFrom = new Map();
  for (const [eid, p] of labelTargets) {
    const ln = labelNodes[eid];
    labFrom.set(eid, (ln && ln.x != null) ? { x: ln.x, y: ln.y } : { x: p.x, y: p.y });
  }
  const apply = (e) => {
    vis.forEach((n, i) => { n.x = from[i].x + (targets[i].x - from[i].x) * e; n.y = from[i].y + (targets[i].y - from[i].y) * e; });
    for (const [eid, p] of labelTargets) {
      const ln = labelNodes[eid]; if (!ln) continue;
      const f = labFrom.get(eid);
      ln.x = f.x + (p.x - f.x) * e; ln.y = f.y + (p.y - f.y) * e; ln._placed = true;
    }
    nodeLayer.selectAll('.node').attr('transform', d => `translate(${d.x},${d.y})`);
    updateContainers();
    rerenderEdges();
  };
  _anim = d3.timer(elapsed => {
    const k = Math.min(1, elapsed / dur);
    apply(d3.easeCubicOut(k));
    if (k >= 1) stopAnim();
  });
}

// A stand-in for the d3 force simulation. Cola owns positions via the tween above,
// so these are mostly no-ops — they exist purely so callers that poke `simulation`
// (interaction.js drag reheat, debug.js HUD) don't need to know the engine.
function colaController(vis) {
  const ctrl = {
    alpha: () => 0,
    alphaTarget: () => ctrl,   // chainable no-op: `.alphaTarget(x).restart()`
    restart: () => ctrl,
    stop: () => { stopAnim(); return ctrl; },
    tick: () => ctrl,
    nodes: () => vis,
    force: () => null,
    _engine: 'cola',
  };
  return ctrl;
}

// The node's own text-fit box (set by renderNodes/resizeNodeBox before any
// layout ever runs — see geometry.js measureNodeBox), NOT a fixed size, so
// Cola's avoidOverlaps respects each node's real width.
const boxOf = n => ({ w: n.w, h: n.h });

// Recompute Cola-placed label positions from the CURRENT endpoint positions,
// using each label's stored along-edge parameter (_t) and the standard perpendicular
// offset. Called during a drag so labels follow their edges (the Cola engine has no
// ticking sim to pull them along, unlike the force engine). Only touches labels Cola
// placed (those with _t); pass the moved node ids to limit work to affected edges.
export function updateDraggedLabels(movedIds) {
  for (const eid of Object.keys(labelNodes)) {
    const ln = labelNodes[eid];
    if (ln._t == null) continue;
    const e = edges[eid];
    if (!e || (movedIds && !movedIds.has(e.from) && !movedIds.has(e.to))) continue;
    const a = nodes[e.from], b = nodes[e.to];
    if (!a || !b) continue;
    const abx = b.x - a.x, aby = b.y - a.y;
    const len = Math.sqrt(abx * abx + aby * aby) || 1;
    ln.x = a.x + ln._t * abx + (-aby / len) * COLA_LABEL_OFFSET;
    ln.y = a.y + ln._t * aby + (abx / len) * COLA_LABEL_OFFSET;
  }
}

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
  stopAnim(); // interrupt any prior tween (e.g. previous engine was force)

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

  // Target positions for real nodes — computed, NOT written to node.x/y yet, so
  // animateTo() can tween from the current positions to these.
  const targets = vis.map((n, i) =>
    (n.pin && mode !== 'radial') ? { x: n.pin.x, y: n.pin.y } : { x: cNodes[i].x, y: cNodes[i].y });
  const tpos = new Map(vis.map((n, i) => [n.id, targets[i]]));

  // Target label positions: snap each onto its edge, near the midpoint, using the
  // TARGET node positions. The solver placed the label dummy off to a clear spot;
  // we project that onto the edge segment (so the label sits ON its edge), clamp
  // the along-edge parameter to a band around the midpoint, and nudge it slightly
  // perpendicular so the line doesn't cut through the text. Projecting the *solved*
  // point (not just t=0.5) keeps labels on crossing edges from stacking.
  const labelTargets = new Map();
  const half = COLA_LABEL_MID_BAND / 2;
  for (const [eid, li] of labelIndex) {
    const e = edges[eid];
    const a = e && tpos.get(e.from), b = e && tpos.get(e.to);
    if (!a || !b) continue;
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    let t = ((cNodes[li].x - a.x) * abx + (cNodes[li].y - a.y) * aby) / len2;
    t = Math.max(0.5 - half, Math.min(0.5 + half, t));
    const len = Math.sqrt(len2);
    const nx = -aby / len, ny = abx / len; // unit normal to the edge
    labelTargets.set(eid, { x: a.x + t * abx + nx * COLA_LABEL_OFFSET, y: a.y + t * aby + ny * COLA_LABEL_OFFSET });
    labelNodes[eid]._t = t; // remember along-edge position so drag can follow the edge
  }

  // Glide from the current layout to the solved one.
  animateTo(vis, targets, labelTargets, alpha >= 1 ? COLA_ANIM_MS_FULL : COLA_ANIM_MS_GENTLE);

  setSimulation(colaController(vis));
}
