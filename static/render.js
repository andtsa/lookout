// ─── DOM rendering ────────────────────────────────────────────────────────────
// Creates and updates SVG elements.  Does NOT set up event handlers (those live
// in interaction.js / app.js) and does NOT call buildSimulation.

import { NODE_W, NODE_H, NODE_W_SM, NODE_H_SM, CONTAINER_PAD, CONTAINER_LABEL_H, DIM_EDGE_OPACITY } from './constants.js';
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

  // Invisible wide hit areas (easier to click)
  const hitSel = edgeLayer.selectAll('.edge-hitarea-group').data(edgeList, d => d.id);
  hitSel.enter().append('g')
    .attr('class', 'edge-hitarea-group')
    .append('line').attr('class', 'edge-hitarea');
  hitSel.exit().remove();

  // Visible edge lines + annotation text
  const edgeSel = edgeLayer.selectAll('.edge-visual').data(edgeList, d => d.id);
  const edgeEnter = edgeSel.enter().append('g').attr('class', 'edge-visual');
  edgeEnter.append('line').attr('class', 'edge').attr('marker-end', 'url(#arrow)');
  edgeEnter.append('text').attr('class', 'edge-annotation');
  edgeSel.exit().remove();

  rerenderEdges();
}

// ─── Edge geometry update (called every simulation tick) ──────────────────────

export function rerenderEdges() {
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

    el.select('line.edge')
      .attr('x1', pts.x1).attr('y1', pts.y1)
      .attr('x2', pts.x2).attr('y2', pts.y2);

    // Annotation: only show for exposed edges; prefer phantom label node position
    const ln = labelNodes[d.id];
    const tx = (ln && ln._placed) ? ln.x : (pts.x1 + pts.x2) / 2;
    const ty = (ln && ln._placed) ? ln.y : (pts.y1 + pts.y2) / 2 - 6;
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
      el.select('line.edge-hitarea')
        .attr('x1', pts.x1).attr('y1', pts.y1)
        .attr('x2', pts.x2).attr('y2', pts.y2);
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
