// ─── DOM rendering ────────────────────────────────────────────────────────────
// Creates and updates SVG elements.  Does NOT set up event handlers (those live
// in interaction.js / app.js) and does NOT call buildSimulation.

import { NODE_W, NODE_H, NODE_W_SM, NODE_H_SM, CONTAINER_PAD, CONTAINER_LABEL_H, DIM_EDGE_OPACITY, EDGE_PARALLEL_GAP } from './constants.js';
import {
  nodes, edges, labelNodes, nodeLayer, edgeLayer, zoom, svg,
  parentDisplayMode, focusedNodeIds,
} from './state.js';
import { getEdgeEndpoints } from './geometry.js';
import { isNodeVisible, visibleDescendants, getVisibleProxy, isEdgeExposed } from './lod.js';

// Symbol-kind → corner-badge glyph. Colour comes from the `symkind-*` CSS class;
// the glyph disambiguates within a colour (e.g. class 'C' vs struct 'S'). Unknown
// (custom) kinds fall back to their first letter.
const SYM_GLYPH = {
  function: 'ƒ', method: 'ƒ',
  class: 'C', struct: 'S',
  interface: 'I', trait: 'T',
  enum: 'E',
  constant: 'K', variable: 'V', field: 'F',
  module: 'M', type: 'Y', macro: '!',
};
const glyphFor = k => (k ? (SYM_GLYPH[k] || k[0].toUpperCase()) : '');
const glyphX   = d => -(d.level >= 1 ? NODE_W_SM : NODE_W) / 2 + 10;
const glyphY   = d => -(d.level >= 1 ? NODE_H_SM : NODE_H) / 2 + 10;

// Inline description caption (shown under the node in 'inline' mode). Truncated
// so it stays a single readable line; the full text is available on hover.
const descCaption = s => (s ? (s.length > 42 ? s.slice(0, 41) + '…' : s) : '');
const descY = d => (d.level >= 1 ? NODE_H_SM : NODE_H) / 2 + 11;

// ─── Node rendering ───────────────────────────────────────────────────────────
// Renders ALL nodes at startup (invisible ones at opacity 0).
// refreshVisibility() later fades them in/out via transitions.

export function renderNodes() {
  // Sort parents before children — later DOM position = higher z-index
  const nodeList = Object.values(nodes).sort((a, b) => a.level - b.level);

  const sel = nodeLayer.selectAll('.node').data(nodeList, d => d.id);

  const enter = sel.enter().append('g')
    .attr('id',        d => `node-${d.id}`)
    .attr('class',     d => `node level-${d.level}${d.pin ? ' pinned' : ''}${d.source_missing ? ' broken-source' : ''}${d.nested ? ' node-nested' : ''}${d.kind ? ' kind-' + d.kind : ''}${d.symbol_kind ? ' symkind-' + d.symbol_kind : ''}`)
    .attr('data-id',   d => d.id)
    .attr('transform', d => `translate(${d.x},${d.y})`)
    .attr('opacity',        d => isNodeVisible(d) ? 1 : 0)
    .attr('pointer-events', d => isNodeVisible(d) ? 'all' : 'none');

  enter.append('rect')
    .attr('class',  'node-rect')
    .attr('x',      d => -(d.level >= 1 ? NODE_W_SM : NODE_W) / 2)
    .attr('y',      d => -(d.level >= 1 ? NODE_H_SM : NODE_H) / 2)
    .attr('width',  d =>  (d.level >= 1 ? NODE_W_SM : NODE_W))
    .attr('height', d =>  (d.level >= 1 ? NODE_H_SM : NODE_H))
    .attr('rx', 6);

  enter.append('rect').attr('class', 'container-rect');
  // Invisible wide border ring — the container's drag / scroll / hover handle.
  // The visible box fill is click-through (CSS) so edges inside it stay hoverable.
  enter.append('rect').attr('class', 'container-hit');

  enter.append('text')
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
    .text(d => d.label);

  // Symbol-kind glyph badge, top-left corner. Hidden by CSS on non-symbol nodes.
  enter.append('circle').attr('class', 'node-glyph-bg')
    .attr('cx', glyphX).attr('cy', glyphY).attr('r', 7);
  enter.append('text').attr('class', 'node-glyph')
    .attr('x', glyphX).attr('y', glyphY)
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .text(d => glyphFor(d.symbol_kind));

  // Description caption under the node — visible only in 'inline' mode (CSS).
  enter.append('text').attr('class', 'node-desc')
    .attr('x', 0).attr('y', descY)
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'hanging')
    .text(d => descCaption(d.description));

  // Merge to keep class in sync (pin state changes after drag)
  enter.merge(sel)
    .attr('class', d => `node level-${d.level}${d.pin ? ' pinned' : ''}${d.source_missing ? ' broken-source' : ''}${d.nested ? ' node-nested' : ''}${d.kind ? ' kind-' + d.kind : ''}${d.symbol_kind ? ' symkind-' + d.symbol_kind : ''}`);

  sel.exit().remove();
}

// ─── Edge rendering ───────────────────────────────────────────────────────────

export function renderEdges() {
  const edgeList = Object.values(edges);

  // Invisible wide hit areas (easier to click). Paths (not lines) so they follow
  // the curve of spread-apart parallel edges.
  const hitSel = edgeLayer.selectAll('.edge-hitarea-group').data(edgeList, d => d.id);
  hitSel.enter().append('g')
    .attr('class', 'edge-hitarea-group')
    .append('path').attr('class', 'edge-hitarea');
  hitSel.exit().remove();

  // Visible edge paths + annotation text
  const edgeSel = edgeLayer.selectAll('.edge-visual').data(edgeList, d => d.id);
  const edgeEnter = edgeSel.enter().append('g').attr('class', 'edge-visual');
  edgeEnter.append('path').attr('class', 'edge').attr('marker-end', 'url(#arrow)');
  edgeEnter.append('text').attr('class', 'edge-annotation');
  edgeSel.exit().remove();

  rerenderEdges();
}

// ─── Parallel-edge separation ─────────────────────────────────────────────────
// When several edges connect the same visible pair of nodes (in either
// direction), a straight line would draw them all on top of one another. We fan
// them apart into curves, and stack their labels.
//
// Per edge we return:
//   spread   signed perpendicular offset for the CURVE, computed in a canonical
//            frame (lower-id → higher-id endpoint) so both directions land on
//            consistent sides. A lone edge → 0 → plain straight line.
//   dy       VERTICAL label stagger (slot × gap). Labels must separate vertically
//            because the text is horizontal — the perpendicular curve offset only
//            does that for horizontal edges (for a top-to-bottom edge it shoves
//            labels sideways and long text overlaps). Stacking by dy works for any
//            orientation. For a horizontal edge dy equals the curve's own vertical
//            offset, so nothing changes there.
//   parallel true when the edge is one of ≥2 between the pair (drives label mode).

function computeParallelSpread() {
  const groups = new Map(); // canonical "a\0b" → [{ id, sign }]
  for (const e of Object.values(edges)) {
    const fp = getVisibleProxy(e.from), tp = getVisibleProxy(e.to);
    if (!fp || !tp || fp.id === tp.id) continue;
    const canonical = fp.id < tp.id;
    const key = canonical ? `${fp.id}\0${tp.id}` : `${tp.id}\0${fp.id}`;
    let arr = groups.get(key);
    if (!arr) groups.set(key, arr = []);
    arr.push({ id: e.id, sign: canonical ? 1 : -1 });
  }
  const info = new Map();
  for (const arr of groups.values()) {
    if (arr.length < 2) { info.set(arr[0].id, { spread: 0, dy: 0, parallel: false }); continue; }
    arr.sort((a, b) => (a.id < b.id ? -1 : 1)); // stable order within the group
    const n = arr.length;
    arr.forEach((it, i) => {
      const slot = i - (n - 1) / 2;
      info.set(it.id, {
        spread: slot * EDGE_PARALLEL_GAP * it.sign, // curve offset (direction-aware)
        dy: slot * EDGE_PARALLEL_GAP,               // label vertical stagger (always down the stack)
        parallel: true,
      });
    });
  }
  return info;
}

// Path + curve-peak point for an edge given its endpoints and signed spread.
// spread 0 → straight line; else a quadratic whose apex sits `spread` px off the
// straight midpoint (control point at 2×spread so the apex lands exactly there).
function curveGeom(pts, spread) {
  const { x1, y1, x2, y2 } = pts;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  if (!spread) return { d: `M${x1},${y1}L${x2},${y2}`, px: mx, py: my };
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len; // unit normal
  return {
    d:  `M${x1},${y1}Q${mx + nx * spread * 2},${my + ny * spread * 2} ${x2},${y2}`,
    px: mx + nx * spread, py: my + ny * spread,
  };
}

// ─── Edge geometry update (called every simulation tick) ──────────────────────

export function rerenderEdges() {
  const spreadMap = computeParallelSpread();

  edgeLayer.selectAll('.edge-visual').each(function(d) {
    const fromProxy = getVisibleProxy(d.from);
    const toProxy   = getVisibleProxy(d.to);
    const vis      = !!(fromProxy && toProxy && fromProxy.id !== toProxy.id);
    const exposed  = vis && isEdgeExposed(d);
    const pts      = vis ? getEdgeEndpoints(d, getVisibleProxy) : null;
    const el       = d3.select(this);

    // Three opacity states: hidden (0), dim/unfocused (DIM_EDGE_OPACITY), full (1).
    const opacity = !vis ? '0' : !exposed ? DIM_EDGE_OPACITY : '1';
    el.style('opacity', opacity)
      .classed('edge-dim', vis && !exposed)
      .attr('pointer-events', exposed ? 'all' : 'none');
    if (!pts) return;

    const info = spreadMap.get(d.id) || { spread: 0, dy: 0, parallel: false };
    el.select('path.edge').attr('d', curveGeom(pts, info.spread).d);

    // Annotation: only show for exposed edges. Parallel edges stack their labels
    // vertically (dy) at the pair's midpoint so long horizontal text separates
    // regardless of edge orientation; a lone edge prefers its phantom-label
    // position, falling back to the midpoint.
    const ln = labelNodes[d.id];
    const mx = (pts.x1 + pts.x2) / 2, my = (pts.y1 + pts.y2) / 2;
    const tx = info.parallel ? mx : (ln && ln._placed) ? ln.x : mx;
    const ty = info.parallel ? my + info.dy : (ln && ln._placed) ? ln.y : my - 6;
    el.select('text.edge-annotation')
      .attr('x', tx).attr('y', ty).attr('text-anchor', 'middle')
      .text(exposed ? (d.annotation || '') : '');
  });

  edgeLayer.selectAll('.edge-hitarea-group').each(function(d) {
    const fromProxy = getVisibleProxy(d.from);
    const toProxy   = getVisibleProxy(d.to);
    const vis     = !!(fromProxy && toProxy && fromProxy.id !== toProxy.id);
    const exposed = vis && isEdgeExposed(d);
    const pts     = vis ? getEdgeEndpoints(d, getVisibleProxy) : null;
    const el      = d3.select(this);
    el.attr('pointer-events', exposed ? 'all' : 'none');
    if (pts) {
      el.select('path.edge-hitarea').attr('d', curveGeom(pts, (spreadMap.get(d.id) || {}).spread || 0).d);
    }
  });
}

// ─── Container / ghost mode ───────────────────────────────────────────────────
// A node becomes a container/ghost when expandedDepth >= 1.  The bounding box
// covers ALL visible descendants.  Processed deepest-first so nested container
// bounds are ready when outer bounds are computed.

export function updateContainers() {
  const visibleNodes = Object.values(nodes)
    .filter(n => isNodeVisible(n))
    .sort((a, b) => b.level - a.level);   // deepest first

  for (const d of visibleNodes) {
    const el = nodeLayer.select(`[id="node-${d.id}"]`);

    if (d.expandedDepth === 0) {
      el.classed('node-ghost', false).classed('node-container', false);
      el.select('.node-rect').attr('display', null);
      el.select('.container-rect').attr('display', 'none');
      el.select('.container-hit').attr('display', 'none');
      el.select('text').attr('x', 0).attr('y', 0)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle');
      d.containerBounds = null;
      continue;
    }

    const desc = visibleDescendants(d);

    if (desc.length === 0 || parentDisplayMode === 'ghost') {
      el.classed('node-ghost', true).classed('node-container', false);
      el.select('.container-rect').attr('display', 'none');
      el.select('.container-hit').attr('display', 'none');
      el.select('.node-rect').attr('display', null);
      el.select('text').attr('x', 0).attr('y', 0)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle');
      d.containerBounds = null;
      continue;
    }

    el.classed('node-ghost', false).classed('node-container', true);
    el.select('.node-rect').attr('display', 'none');

    // Use actual footprint of descendants; nested containers use stored bounds
    const allBounds = desc.map(c => {
      if (c.containerBounds) {
        return {
          minX: c.containerBounds.x - d.x,
          maxX: c.containerBounds.x + c.containerBounds.w - d.x,
          minY: c.containerBounds.y - d.y,
          maxY: c.containerBounds.y + c.containerBounds.h - d.y,
        };
      }
      const cw = (c.level >= 1 ? NODE_W_SM : NODE_W) / 2;
      const ch = (c.level >= 1 ? NODE_H_SM : NODE_H) / 2;
      return {
        minX: c.x - d.x - cw, maxX: c.x - d.x + cw,
        minY: c.y - d.y - ch, maxY: c.y - d.y + ch,
      };
    });

    // Box hugs the descendants tightly (+ padding). Not recentred on the parent
    // pin — the old symmetric-around-pin growth doubled the box whenever children
    // sat off to one side, which both ballooned the container and left empty space
    // for foreign nodes to fall into.
    const minX = Math.min(...allBounds.map(b => b.minX)) - CONTAINER_PAD;
    const maxX = Math.max(...allBounds.map(b => b.maxX)) + CONTAINER_PAD;
    const minY = Math.min(...allBounds.map(b => b.minY)) - CONTAINER_PAD - CONTAINER_LABEL_H;
    const maxY = Math.max(...allBounds.map(b => b.maxY)) + CONTAINER_PAD;

    el.select('.container-rect')
      .attr('display', 'inline')
      .attr('x', minX).attr('y', minY)
      .attr('width',  maxX - minX)
      .attr('height', maxY - minY)
      .attr('rx', 10);

    // Header strip (label row only) is the actual pointer target — drag / hover /
    // alt+scroll / right-click all work by grabbing the container's header. The
    // rest of the box is click-through (see .container-rect pointer-events:none
    // in CSS) so edges routed underneath a container stay hoverable/clickable.
    el.select('.container-hit')
      .attr('display', 'inline')
      .attr('x', minX).attr('y', minY)
      .attr('width',  maxX - minX)
      .attr('height', CONTAINER_LABEL_H)
      .attr('rx', 10);

    el.select('text')
      .attr('x', minX + 10).attr('y', minY + CONTAINER_LABEL_H - 8)
      .attr('text-anchor', 'start').attr('dominant-baseline', 'middle');

    d.containerBounds = {
      x: d.x + minX, y: d.y + minY,
      w: maxX - minX,  h: maxY - minY,
    };
  }
}

// ─── Focus highlights ─────────────────────────────────────────────────────────
// Syncs the node-focused CSS class with the current focusedNodeIds set.
// Called from refreshVisibility (app.js) whenever focus or visibility changes.

export function updateFocusHighlights() {
  nodeLayer.selectAll('.node').each(function(d) {
    d3.select(this).classed('node-focused', focusedNodeIds.has(d.id));
  });
}

// ─── HUD ──────────────────────────────────────────────────────────────────────

export function updateLodIndicator(k) {
  const n = Object.values(nodes).filter(n => n.expandedDepth > 0).length;
  document.getElementById('lod-indicator').textContent =
    `k=${k.toFixed(2)}` + (n > 0 ? ` · ${n} expanded` : '');
}

export function updateModeIndicator() {
  const anyExpanded = Object.values(nodes).some(n => n.expandedDepth > 0);
  document.getElementById('mode-indicator').textContent =
    anyExpanded ? `${parentDisplayMode} (G)` : '';
}
