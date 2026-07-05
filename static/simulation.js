// ─── Force simulation ─────────────────────────────────────────────────────────

import {
  nodes, edges, labelNodes, simulation, setSimulation,
  nodeLayer, svg, zoom, setGraphIsSparse,
} from './state.js';
import { getViewportSize, zoneToCoords, getEdgeEndpoints } from './geometry.js';
import { isNodeVisible, labelRadius, getVisibleProxy, isEdgeExposed } from './lod.js';
import { updateContainers, rerenderEdges } from './render.js';
import {
  CHARGE_LABEL_FACTOR, CHARGE_CONTAINER_SCALE, CHARGE_CONTAINER_MIN,
  CHARGE_CONTAINER_FALLBACK, CHARGE_CONNECTED, CHARGE_ISOLATED,
  LINK_DIST_PARENT, LINK_DIST_EDGE, LINK_STRENGTH_PARENT, LINK_STRENGTH_EDGE,
  COLLISION_RADIUS, CENTER_STRENGTH, LABEL_PULL_STRENGTH, ALPHA_DECAY,
  ZONE_STRENGTH, CENTER_PAD, CENTER_FIT_MARGIN, SPARSE_EDGE_RATIO,
} from './constants.js';

// ─── Label phantom nodes ──────────────────────────────────────────────────────
// Each annotated edge gets a lightweight phantom node attracted toward the edge
// midpoint so labels find a clear spot without overlapping real nodes.

export function initLabelNodes() {
  // Clear in-place (all importers share the same object via live binding)
  for (const k of Object.keys(labelNodes)) delete labelNodes[k];
  for (const [eid, edge] of Object.entries(edges)) {
    if (!edge.annotation) continue;
    labelNodes[eid] = {
      id: `label_${eid}`, edgeId: eid,
      x: 0, y: 0, vx: 0, vy: 0,
      _placed: false,
    };
  }
}

// ─── Build / rebuild simulation ───────────────────────────────────────────────

export function buildSimulation() {
  if (simulation) simulation.stop();

  const simNodes = Object.values(nodes).filter(n => isNodeVisible(n));
  const visIds   = new Set(simNodes.map(n => n.id));

  // Update sparsity flag BEFORE isEdgeExposed is called below.
  // Sparse = visible semantic edges ≤ SPARSE_EDGE_RATIO × visible nodes.
  const visSemanticEdgeCount = Object.values(edges)
    .filter(e => visIds.has(e.from) && visIds.has(e.to)).length;
  setGraphIsSparse(visSemanticEdgeCount <= simNodes.length * SPARSE_EDGE_RATIO);

  // Semantic edges + weak parent→child links.
  // Unexposed edges (focus mode active, neither endpoint focused) are excluded
  // entirely — they exert no force so the simulation can still reach equilibrium.
  const simLinks = [];
  for (const edge of Object.values(edges)) {
    if (visIds.has(edge.from) && visIds.has(edge.to) && isEdgeExposed(edge))
      simLinks.push({ source: edge.from, target: edge.to, type: 'edge' });
  }
  for (const n of simNodes) {
    if (n.parent && visIds.has(n.parent))
      simLinks.push({ source: n.parent, target: n.id, type: 'parent' });
  }

  // Label phantom nodes only for exposed edges — unexposed labels are excluded
  // from the simulation entirely (no charge, no collision contribution).
  const visLabelNodes = Object.values(labelNodes).filter(ln => {
    const e = edges[ln.edgeId];
    return e && visIds.has(e.from) && visIds.has(e.to) && isEdgeExposed(e);
  });

  const allSimNodes = [...simNodes, ...visLabelNodes];

  // Nodes participating in at least one visible edge (semantic or parent-child)
  const connectedIds = new Set();
  for (const lnk of simLinks) {
    connectedIds.add(typeof lnk.source === 'object' ? lnk.source.id : lnk.source);
    connectedIds.add(typeof lnk.target === 'object' ? lnk.target.id : lnk.target);
  }

  const { w: vw, h: vh } = getViewportSize();

  const sim = d3.forceSimulation(allSimNodes)
    .force('charge', d3.forceManyBody().strength(d => {
      if (d.edgeId) return -(labelRadius(d) * CHARGE_LABEL_FACTOR);
      if (d.expandedDepth > 0) {
        // Scale with container footprint so repulsion reaches the border
        const b = d.containerBounds;
        const footprint = b ? Math.sqrt(b.w * b.h) : CHARGE_CONTAINER_FALLBACK;
        return -Math.max(CHARGE_CONTAINER_MIN, footprint * CHARGE_CONTAINER_SCALE);
      }
      if (connectedIds.has(d.id)) return CHARGE_CONNECTED;
      return CHARGE_ISOLATED;
    }))
    .force('link', d3.forceLink(simLinks).id(d => d.id)
      .distance(d => d.type === 'parent' ? LINK_DIST_PARENT : LINK_DIST_EDGE)
      .strength(d => d.type === 'parent' ? LINK_STRENGTH_PARENT : LINK_STRENGTH_EDGE))
    .force('collision', d3.forceCollide().radius(d => d.edgeId ? labelRadius(d) : COLLISION_RADIUS))
    .force('cx', d3.forceX(vw / 2).strength(d => d.edgeId ? 0 : CENTER_STRENGTH))
    .force('cy', d3.forceY(vh / 2).strength(d => d.edgeId ? 0 : CENTER_STRENGTH))
    // Pull each label toward the midpoint of the two edge border endpoints
    .force('label-pull', () => {
      for (const ln of visLabelNodes) {
        const e = edges[ln.edgeId];
        const pts = getEdgeEndpoints(e, getVisibleProxy);
        if (!pts) continue;
        ln.vx += ((pts.x1 + pts.x2) / 2 - ln.x) * LABEL_PULL_STRENGTH;
        ln.vy += ((pts.y1 + pts.y2) / 2 - ln.y) * LABEL_PULL_STRENGTH;
      }
    })
    .alphaDecay(ALPHA_DECAY)
    .on('tick', () => {
      nodeLayer.selectAll('.node')
        .attr('transform', d => `translate(${d.x},${d.y})`);
      rerenderEdges();
      updateContainers();
    });

  setSimulation(sim);

  // Apply pin / zone constraints
  for (const n of simNodes) {
    if (n.pin) {
      n.fx = n.pin.x;
      n.fy = n.pin.y;
    } else if (!n.zone) {
      n.fx = null;
      n.fy = null;
    }
    if (n.zone) {
      const t = zoneToCoords(n.zone);
      sim.force(`ax-${n.id}`, d3.forceX(t.x).strength(ZONE_STRENGTH))
         .force(`ay-${n.id}`, d3.forceY(t.y).strength(ZONE_STRENGTH));
    }
  }
}

// ─── Graph centering ──────────────────────────────────────────────────────────

export function centerGraph() {
  const { w: viewW, h: viewH } = getViewportSize();
  if (viewW < 50) return;

  const level0 = Object.values(nodes).filter(n => n.level === 0);
  if (level0.length === 0) return;

  const xs    = level0.map(n => n.x);
  const ys    = level0.map(n => n.y);
  const minX  = Math.min(...xs) - CENTER_PAD;
  const maxX  = Math.max(...xs) + CENTER_PAD;
  const minY  = Math.min(...ys) - CENTER_PAD;
  const maxY  = Math.max(...ys) + CENTER_PAD;
  const graphW   = maxX - minX;
  const graphH   = maxY - minY;
  const fitScale = Math.min(viewW / graphW, viewH / graphH) * CENTER_FIT_MARGIN;
  const tx = viewW / 2 - (minX + graphW / 2) * fitScale;
  const ty = viewH / 2 - (minY + graphH / 2) * fitScale;

  const t = d3.zoomIdentity.translate(tx, ty).scale(fitScale);
  svg.call(zoom.transform, t);
}

export function scheduleCenterGraph() {
  requestAnimationFrame(() => {
    const { w } = getViewportSize();
    if (w >= 50) {
      centerGraph();
    } else {
      const ro = new ResizeObserver(() => {
        if (getViewportSize().w >= 50) { ro.disconnect(); centerGraph(); }
      });
      ro.observe(svg.node());
    }
  });
}
