// ─── Force simulation ─────────────────────────────────────────────────────────

import {
  nodes, edges, labelNodes, simulation, setSimulation,
  nodeLayer, svg, zoom, setGraphIsSparse, debugMode,
} from './state.js';
import { renderDebug } from './debug.js';
import { getViewportSize, zoneToCoords, getEdgeEndpoints, containerCenter, containerRadius, nodeCollisionRadius } from './geometry.js';
import { isNodeVisible, labelRadius, getVisibleProxy, visibleDescendants, isEdgeExposed } from './lod.js';
import { updateContainers, rerenderEdges } from './render.js';
import {
  CHARGE_LABEL_FACTOR, CHARGE_CONTAINER_PER_CHILD, CHARGE_CONTAINER_MIN,
  CHARGE_PER_EDGE, CHARGE_ISOLATED, CHARGE_DISTANCE_MAX,
  LINK_DIST_PARENT, LINK_DIST_EDGE,
  LINK_STRENGTH_PARENT, LINK_STRENGTH_EDGE, LINK_STRENGTH_UNEXPOSED,
  COLLISION_ITERATIONS, VELOCITY_DECAY, COLLIDE_STRENGTH,
  CENTER_STRENGTH, LABEL_PULL_STRENGTH, LABEL_DECLUTTER_STRENGTH, ALPHA_DECAY,
  ZONE_STRENGTH, PARENT_PIN_STRENGTH, CENTER_PAD, CENTER_FIT_MARGIN, SPARSE_EDGE_RATIO,
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

export function buildSimulation(alpha = 1) {
  if (simulation) simulation.stop();

  const simNodes = Object.values(nodes).filter(n => isNodeVisible(n));
  const visIds   = new Set(simNodes.map(n => n.id));

  // Sparsity flag — feeds isEdgeExposed (rendering dim + weak-link decision below).
  // Sparse = visible semantic edges ≤ SPARSE_EDGE_RATIO × visible nodes → all
  // edges exposed, so focus is a no-op on sparse graphs.
  const visSemanticEdgeCount = Object.values(edges)
    .filter(e => visIds.has(e.from) && visIds.has(e.to)).length;
  setGraphIsSparse(visSemanticEdgeCount <= simNodes.length * SPARSE_EDGE_RATIO);

  // Semantic edges + weak parent→child links. Every visible edge is included, but
  // unexposed ones (focus active, neither endpoint focused) get a much weaker
  // spring so the focused subgraph dominates the layout.
  const simLinks = [];
  for (const edge of Object.values(edges)) {
    if (visIds.has(edge.from) && visIds.has(edge.to))
      simLinks.push({ source: edge.from, target: edge.to, type: 'edge', exposed: isEdgeExposed(edge) });
  }
  for (const n of simNodes) {
    if (n.parent && visIds.has(n.parent))
      simLinks.push({ source: n.parent, target: n.id, type: 'parent' });
  }

  // Label phantom nodes only for exposed edges — dim edges hide their annotation,
  // so their phantom label doesn't belong in the sim.
  const visLabelNodes = Object.values(labelNodes).filter(ln => {
    const e = edges[ln.edgeId];
    return e && visIds.has(e.from) && visIds.has(e.to) && isEdgeExposed(e);
  });

  const allSimNodes = [...simNodes, ...visLabelNodes];

  // Degree per node = number of incident visible SEMANTIC edges (in + out).
  // Parent-child links are structural, not semantic, so they don't count here —
  // charge scales with how connected a node is in the graph, not the tree.
  const degree = new Map();
  for (const lnk of simLinks) {
    if (lnk.type !== 'edge') continue;
    const s = typeof lnk.source === 'object' ? lnk.source.id : lnk.source;
    const t = typeof lnk.target === 'object' ? lnk.target.id : lnk.target;
    degree.set(s, (degree.get(s) || 0) + 1);
    degree.set(t, (degree.get(t) || 0) + 1);
  }

  const { w: vw, h: vh } = getViewportSize();

  // The effective pin of a node's parent, if the parent has one. Such nodes are
  // anchored to that pin instead of the viewport centre.
  const parentPinOf = (n) => {
    if (!n || !n.parent) return null;
    const p = nodes[n.parent];
    return p && p.pin ? p.pin : null;
  };

  const sim = d3.forceSimulation(allSimNodes)
    .force('charge', d3.forceManyBody().strength(d => {
      if (d.edgeId) return -(labelRadius(d) * CHARGE_LABEL_FACTOR);
      if (d.expandedDepth > 0) {
        // Scale with the number of DIRECT visible children — not rendered size
        // (feedback loop) and not recursive descendants (nesting compounds and
        // over-inflates deep containers).
        const kids = (d.children || [])
          .filter(cid => { const c = nodes[cid]; return c && isNodeVisible(c); }).length;
        return -Math.max(CHARGE_CONTAINER_MIN, kids * CHARGE_CONTAINER_PER_CHILD);
      }
      // Repulsion proportional to degree: a hub with many edges clears more
      // space; a node with no visible edges gets the gentle isolated charge.
      const deg = degree.get(d.id) || 0;
      return deg === 0 ? CHARGE_ISOLATED : deg * CHARGE_PER_EDGE;
    }).distanceMax(CHARGE_DISTANCE_MAX))
    .force('link', d3.forceLink(simLinks).id(d => d.id)
      .distance(d => d.type === 'parent' ? LINK_DIST_PARENT : LINK_DIST_EDGE)
      .strength(d => d.type === 'parent' ? LINK_STRENGTH_PARENT
        : (d.exposed ? LINK_STRENGTH_EDGE : LINK_STRENGTH_UNEXPOSED)))
    // Labels keep clear of each other (and node centres). Real nodes/containers
    // are spaced by the grouped collision below, so they sit at radius 0 here.
    .force('label-collision', d3.forceCollide()
      .radius(d => d.edgeId ? labelRadius(d) : 0)
      .iterations(COLLISION_ITERATIONS))
    // Center gravity — skipped for labels and for children of a pinned parent
    // (those are anchored to the parent pin below instead).
    .force('cx', d3.forceX(vw / 2).strength(d => (d.edgeId || parentPinOf(d)) ? 0 : CENTER_STRENGTH))
    .force('cy', d3.forceY(vh / 2).strength(d => (d.edgeId || parentPinOf(d)) ? 0 : CENTER_STRENGTH))
    // Grouped collision — the core spacing force. Elements collide ONLY within
    // their sibling group (same parent = same LoD). A leaf/collapsed node is a
    // circle sized to its OWN text-fit box (nodeCollisionRadius — half-diagonal
    // of node.w/h + NODE_COLLISION_MARGIN, so wider/longer-labelled nodes claim
    // more space); an expanded container is a circle (containerRadius around its
    // box) that represents its whole subtree to the parent group. So a container
    // keeps its contents clear of everything outside it, while its children
    // collide amongst themselves in their own group. Pushing a container moves
    // its whole cluster (its box follows its children).
    .force('grouped-collide', () => {
      // Bucket visible real nodes by parent (their collision group).
      const groups = new Map();
      for (const n of simNodes) {
        const key = n.parent || '';
        const isC = n.expandedDepth > 0 && n.containerBounds;
        const c = isC ? containerCenter(n.containerBounds) : n;
        const item = {
          node: n, isC, x: c.x, y: c.y,
          r: isC ? containerRadius(n.containerBounds) : nodeCollisionRadius(n),
        };
        let arr = groups.get(key);
        if (!arr) { arr = []; groups.set(key, arr); }
        arr.push(item);
      }
      const apply = (it, vx, vy) => {
        it.node.vx += vx; it.node.vy += vy;
        if (it.isC) for (const d of visibleDescendants(it.node)) { d.vx += vx; d.vy += vy; }
      };
      const S = COLLIDE_STRENGTH;
      for (const items of groups.values()) {
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            const a = items[i], b = items[j];
            let dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
            const minDist = a.r + b.r;
            if (dist >= minDist) continue;
            if (dist < 1e-6) { dx = 1; dy = 0; dist = 1; } // coincident centres
            const p = (minDist - dist) * S * 0.5;          // each side moves half
            const ux = dx / dist, uy = dy / dist;
            apply(a, -ux * p, -uy * p);
            apply(b,  ux * p,  uy * p);
          }
        }
      }
    })
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
    // Push labels out of container boxes they don't belong to. The label-pull
    // above can drop a label onto an unrelated container's box; here we shove it
    // back out along the radius of that container's circle. A label whose edge is
    // internal to the container (an endpoint is a descendant) belongs inside and
    // is left alone. Only labels move — no feedback into container size.
    .force('label-declutter', () => {
      const containers = simNodes.filter(n => n.expandedDepth > 0 && n.containerBounds);
      if (!containers.length) return;
      const under = (nodeId, contId) => {
        let n = nodes[nodeId];
        while (n) { if (n.id === contId) return true; n = n.parent ? nodes[n.parent] : null; }
        return false;
      };
      for (const ln of visLabelNodes) {
        const e = edges[ln.edgeId];
        for (const c of containers) {
          if (under(e.from, c.id) || under(e.to, c.id)) continue; // belongs inside
          const cc = containerCenter(c.containerBounds);
          const rr = containerRadius(c.containerBounds) + labelRadius(ln);
          let dx = ln.x - cc.x, dy = ln.y - cc.y, dist = Math.hypot(dx, dy);
          if (dist >= rr) continue;
          if (dist < 1e-6) { dx = 1; dy = 0; dist = 1; }
          const push = (rr - dist) * LABEL_DECLUTTER_STRENGTH;
          ln.vx += (dx / dist) * push;
          ln.vy += (dy / dist) * push;
        }
      }
    })
    .velocityDecay(VELOCITY_DECAY)
    .alphaDecay(ALPHA_DECAY)
    .on('tick', () => {
      nodeLayer.selectAll('.node')
        .attr('transform', d => `translate(${d.x},${d.y})`);
      rerenderEdges();
      updateContainers();
      if (debugMode) renderDebug();
    });

  // d3.forceSimulation starts at alpha 1; lower it for a gentle reheat (focus).
  sim.alpha(alpha);
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
    } else if (!n.pin) {
      // Anchor a free child to its parent's pin, if the parent has one.
      const pp = parentPinOf(n);
      if (pp) {
        sim.force(`px-${n.id}`, d3.forceX(pp.x).strength(PARENT_PIN_STRENGTH))
           .force(`py-${n.id}`, d3.forceY(pp.y).strength(PARENT_PIN_STRENGTH));
      }
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
