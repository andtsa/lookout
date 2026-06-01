import { fetchGraph, patchNode, patchEdge, postSave, fetchFile } from './api.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_W    = 140;
const NODE_H    = 44;
const NODE_W_SM = 110;
const NODE_H_SM = 32;

// ─── State ────────────────────────────────────────────────────────────────────

let nodes        = {};   // id → node object (augmented with x,y,fx,fy by D3)
let edges        = {};   // id → edge object
let labelNodes   = {};   // edgeId → phantom node for label force-positioning
let sourceToNode = {};   // normalised source path → node
let dirty        = false;
let selectedEdgeId = null;
let simulation   = null;
let parentDisplayMode = 'container'; // 'ghost' | 'container'
let hoveredNodeId = null;
const scrollAccum = {};  // nodeId → accumulated deltaY for LOD scroll threshold

// ─── SVG Setup ────────────────────────────────────────────────────────────────

const svg = d3.select('#canvas');
const defs = svg.append('defs');

defs.append('marker')
  .attr('id', 'arrow')
  .attr('viewBox', '0 -4 8 8')
  .attr('refX', 8).attr('refY', 0)
  .attr('markerWidth', 6).attr('markerHeight', 6)
  .attr('orient', 'auto')
  .append('path')
  .attr('d', 'M0,-4L8,0L0,4')
  .attr('fill', '#4a9eff')
  .attr('opacity', 0.6);

const root      = svg.append('g').attr('id', 'root');
const edgeLayer = root.append('g').attr('id', 'edge-layer');
const nodeLayer = root.append('g').attr('id', 'node-layer');

// ─── Zoom ─────────────────────────────────────────────────────────────────────
// Scroll over nodes is captured by each node's own wheel handler and does NOT
// reach this zoom handler (stopPropagation).  Scroll over empty canvas zooms.
// +/− keys also zoom (see keydown handler below).

const zoom = d3.zoom()
  .scaleExtent([0.05, 20])
  .wheelDelta(event => -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.001))
  .on('zoom', (event) => {
    root.attr('transform', event.transform);
    updateLodIndicator(event.transform.k);
  });

svg.call(zoom);

// ─── Viewport helpers ─────────────────────────────────────────────────────────

function getViewportSize() {
  const svgEl = svg.node();
  const w = svgEl.clientWidth  || svgEl.getBoundingClientRect().width  || window.innerWidth  || 1280;
  const h = svgEl.clientHeight || svgEl.getBoundingClientRect().height || window.innerHeight || 720;
  return { w, h };
}

// ─── Per-node LOD helpers ─────────────────────────────────────────────────────

// A node is visible iff it is a root (no parent) OR its parent is visible AND
// has expandedDepth >= 1 (meaning the parent has expanded to reveal children).
function isNodeVisible(node) {
  if (!node.parent) return true;
  const parent = nodes[node.parent];
  if (!parent) return true;
  return parent.expandedDepth >= 1 && isNodeVisible(parent);
}

function isLeafNode(node) {
  return !node.children || node.children.length === 0;
}

// All currently visible descendants of node (used for container bounding box).
function visibleDescendants(node) {
  const result = [];
  for (const cid of (node.children || [])) {
    const c = nodes[cid];
    if (c && isNodeVisible(c)) {
      result.push(c);
      result.push(...visibleDescendants(c));
    }
  }
  return result;
}

// Walk up the parent chain to find the closest visible ancestor for a nodeId.
// Returns the node itself if it is visible, otherwise the first visible ancestor.
// Returns null if no visible ancestor exists.
function getVisibleProxy(nodeId) {
  let node = nodes[nodeId];
  while (node) {
    if (isNodeVisible(node)) return node;
    node = nodes[node.parent];
  }
  return null;
}

// ─── Expand / Collapse ────────────────────────────────────────────────────────

function expandNode(node) {
  // Place any children that haven't been positioned yet at the parent location
  // (with small jitter so the sim has a sensible starting point to push from).
  for (const cid of (node.children || [])) {
    const c = nodes[cid];
    if (c && c.x == null) {
      c.x = node.x + (Math.random() - 0.5) * 20;
      c.y = node.y + (Math.random() - 0.5) * 20;
    }
  }
  node.expandedDepth++;
  refreshVisibility();
}

function collapseDeepestIn(node) {
  // Depth-first: find the deepest expanded node in this subtree and decrement it.
  function deepest(n) {
    for (const cid of (n.children || [])) {
      const c = nodes[cid];
      if (c && c.expandedDepth > 0 && isNodeVisible(c)) {
        const d = deepest(c);
        if (d) return d;
      }
    }
    return n.expandedDepth > 0 ? n : null;
  }
  const target = deepest(node);
  if (target) {
    target.expandedDepth--;
    refreshVisibility();
  }
}

function refreshVisibility() {
  // Initialise label-node positions for edges that just became visible.
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

  nodeLayer.selectAll('.node').each(function(d) {
    const vis = isNodeVisible(d);
    d3.select(this)
      .transition().duration(vis ? 350 : 200)
      .ease(vis ? d3.easeCubicOut : d3.easeCubicIn)
      .attr('opacity', vis ? 1 : 0)
      .attr('pointer-events', vis ? 'all' : 'none');
  });

  updateContainers();
  rerenderEdges();
  buildSimulation();
  updateModeIndicator();
  updateLodIndicator(d3.zoomTransform(svg.node()).k);
}

function flashLeaf(nodeId) {
  const el = nodeLayer.select(`#node-${nodeId}`);
  el.classed('node-leaf-flash', true);
  setTimeout(() => el.classed('node-leaf-flash', false), 600);
}

// ─── Label phantom nodes ──────────────────────────────────────────────────────
// Each edge with an annotation gets a lightweight phantom node in the sim that
// is attracted toward the edge midpoint and repelled by real nodes, so labels
// find a visible clear spot rather than overlapping nodes.

function initLabelNodes() {
  labelNodes = {};
  for (const [eid, edge] of Object.entries(edges)) {
    if (!edge.annotation) continue;
    labelNodes[eid] = {
      id: `label_${eid}`, edgeId: eid,
      x: 0, y: 0, vx: 0, vy: 0,
      _placed: false, // set true once given a real initial position
    };
  }
}

// ─── Force simulation ─────────────────────────────────────────────────────────

function buildSimulation() {
  if (simulation) simulation.stop();

  const simNodes = Object.values(nodes).filter(n => isNodeVisible(n));
  const visIds   = new Set(simNodes.map(n => n.id));

  // Semantic edges between visible node pairs + weak parent→child links
  const simLinks = [];
  for (const edge of Object.values(edges)) {
    if (visIds.has(edge.from) && visIds.has(edge.to)) {
      simLinks.push({ source: edge.from, target: edge.to, type: 'edge' });
    }
  }
  for (const n of simNodes) {
    if (n.parent && visIds.has(n.parent)) {
      simLinks.push({ source: n.parent, target: n.id, type: 'parent' });
    }
  }

  // Label phantom nodes for edges whose both endpoints are currently visible
  const visLabelNodes = Object.values(labelNodes).filter(ln => {
    const e = edges[ln.edgeId];
    return e && visIds.has(e.from) && visIds.has(e.to);
  });

  const allSimNodes = [...simNodes, ...visLabelNodes];

  const { w: vw, h: vh } = getViewportSize();

  simulation = d3.forceSimulation(allSimNodes)
    .force('charge',    d3.forceManyBody().strength(d => d.edgeId ? -20   : -350))
    .force('link',      d3.forceLink(simLinks).id(d => d.id)
                          .distance(d => d.type === 'parent' ? 130 : 220)
                          .strength(d => d.type === 'parent' ? 0.5 : 0.25))
    .force('collision', d3.forceCollide().radius(d => d.edgeId ? 0 : 70))
    .force('cx',        d3.forceX(vw / 2).strength(d => d.edgeId ? 0 : 0.015))
    .force('cy',        d3.forceY(vh / 2).strength(d => d.edgeId ? 0 : 0.015))
    // Custom force: pull label nodes toward their edge midpoints
    .force('label-pull', () => {
      for (const ln of visLabelNodes) {
        const e = edges[ln.edgeId];
        const src = nodes[e.from], tgt = nodes[e.to];
        if (!src || !tgt) continue;
        ln.vx += ((src.x + tgt.x) / 2 - ln.x) * 0.4;
        ln.vy += ((src.y + tgt.y) / 2 - ln.y) * 0.4;
      }
    })
    .alphaDecay(0.025)
    .on('tick', () => {
      nodeLayer.selectAll('.node')
        .attr('transform', d => `translate(${d.x},${d.y})`);
      rerenderEdges();
      updateContainers();
    });

  // Apply pin / zone constraints to real nodes only
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
      simulation
        .force(`ax-${n.id}`, d3.forceX(t.x).strength(0.08))
        .force(`ay-${n.id}`, d3.forceY(t.y).strength(0.08));
    }
  }
}

// ─── Graph centering ──────────────────────────────────────────────────────────

function centerGraph() {
  const { w: viewW, h: viewH } = getViewportSize();
  if (viewW < 50) return;

  const level0 = Object.values(nodes).filter(n => n.level === 0);
  if (level0.length === 0) return;

  const pad  = 120;
  const xs   = level0.map(n => n.x);
  const ys   = level0.map(n => n.y);
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;

  const graphW    = maxX - minX;
  const graphH    = maxY - minY;
  const fitScale  = Math.min(viewW / graphW, viewH / graphH) * 0.60;

  const tx = viewW / 2 - (minX + graphW / 2) * fitScale;
  const ty = viewH / 2 - (minY + graphH / 2) * fitScale;

  const t = d3.zoomIdentity.translate(tx, ty).scale(fitScale);
  svg.call(zoom.transform, t);
  root.attr('transform', t);
  updateLodIndicator(fitScale);
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

function zoneToCoords(zone) {
  const m = 80;
  const { w, h } = getViewportSize();
  const map = {
    'top':          { x: w/2,   y: m       },
    'bottom':       { x: w/2,   y: h - m   },
    'left':         { x: m,     y: h/2     },
    'right':        { x: w - m, y: h/2     },
    'top-left':     { x: m,     y: m       },
    'top-right':    { x: w - m, y: m       },
    'bottom-left':  { x: m,     y: h - m   },
    'bottom-right': { x: w - m, y: h - m   },
    'center':       { x: w/2,   y: h/2     },
  };
  return map[zone] || { x: w/2, y: h/2 };
}

function initialPosition(node, allNodes) {
  if (node.pin)  return { x: node.pin.x, y: node.pin.y };
  if (node.zone) return zoneToCoords(node.zone);
  if (node.parent && allNodes) {
    const parent = allNodes[node.parent];
    if (parent && parent.x != null) {
      return {
        x: parent.x + (Math.random() - 0.5) * 200,
        y: parent.y + (Math.random() - 0.5) * 200,
      };
    }
  }
  const { w, h } = getViewportSize();
  return {
    x: 100 + Math.random() * (Math.max(w, 400) - 200),
    y: 100 + Math.random() * (Math.max(h, 400) - 200),
  };
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderNodes() {
  const nodeList = Object.values(nodes);

  const sel = nodeLayer.selectAll('.node')
    .data(nodeList, d => d.id);

  const enter = sel.enter().append('g')
    .attr('id',        d => `node-${d.id}`)
    .attr('class',     d => `node level-${d.level}${d.pin ? ' pinned' : ''}`)
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

  enter.append('text')
    .attr('text-anchor',       'middle')
    .attr('dominant-baseline', 'middle')
    .text(d => d.label);

  // ── Hover: visual LOD-target cue ──────────────────────────────────────────
  enter
    .on('mouseenter.lod', function(event, d) {
      hoveredNodeId = d.id;
      d3.select(this).classed('node-lod-target', true);
      if (isLeafNode(d)) d3.select(this).classed('node-leaf-hover', true);
    })
    .on('mouseleave.lod', function(event, d) {
      hoveredNodeId = null;
      scrollAccum[d.id] = 0;
      d3.select(this)
        .classed('node-lod-target', false)
        .classed('node-leaf-hover',  false);
    });

  // ── Scroll: expand / collapse this node's subtree ─────────────────────────
  // stopPropagation prevents the canvas zoom from also firing.
  enter.on('wheel.lod', function(event, d) {
    event.stopPropagation();
    scrollAccum[d.id] = (scrollAccum[d.id] || 0) + event.deltaY;
    const THRESHOLD = 150;
    if (scrollAccum[d.id] > THRESHOLD) {
      scrollAccum[d.id] = 0;
      if (isLeafNode(d)) { flashLeaf(d.id); return; }
      collapseDeepestIn(d);
    } else if (scrollAccum[d.id] < -THRESHOLD) {
      scrollAccum[d.id] = 0;
      if (isLeafNode(d)) { flashLeaf(d.id); return; }
      expandNode(d);
    }
  });

  // ── Other interactions ────────────────────────────────────────────────────
  enter.call(d3.drag()
    .on('start', dragStarted)
    .on('drag',  dragged)
    .on('end',   dragEnded));

  enter.on('dblclick', (event, d) => {
    event.stopPropagation();
    startLabelEdit(d);
  });

  enter.on('click', (event, d) => {
    event.stopPropagation();
    if (d.source) openCodePanel(d);
  });

  enter.on('contextmenu', (event, d) => {
    event.preventDefault();
    showContextMenu(event, d);
  });

  // Merge for class updates (pin state may change)
  enter.merge(sel)
    .attr('class', d => `node level-${d.level}${d.pin ? ' pinned' : ''}`);

  sel.exit().remove();
}

function renderEdges() {
  const edgeList = Object.values(edges);

  // Invisible wide hit areas
  const hitSel = edgeLayer.selectAll('.edge-hitarea-group')
    .data(edgeList, d => d.id);

  hitSel.enter().append('g')
    .attr('class', 'edge-hitarea-group')
    .append('line')
    .attr('class', 'edge-hitarea')
    .on('click', (event, d) => {
      event.stopPropagation();
      selectEdge(d.id, event);
    });

  hitSel.exit().remove();

  // Visible edge lines + annotation text
  const edgeSel = edgeLayer.selectAll('.edge-visual')
    .data(edgeList, d => d.id);

  const edgeEnter = edgeSel.enter().append('g').attr('class', 'edge-visual');
  edgeEnter.append('line').attr('class', 'edge').attr('marker-end', 'url(#arrow)');
  edgeEnter.append('text').attr('class', 'edge-annotation');

  edgeSel.exit().remove();

  rerenderEdges();
}

function rerenderEdges() {
  edgeLayer.selectAll('.edge-visual').each(function(d) {
    const fromProxy = getVisibleProxy(d.from);
    const toProxy   = getVisibleProxy(d.to);
    const vis = !!(fromProxy && toProxy && fromProxy.id !== toProxy.id);
    const pts = vis ? getEdgeEndpoints(d) : null;
    const el  = d3.select(this);

    el.style('opacity', vis ? '1' : '0')
      .attr('pointer-events', vis ? 'all' : 'none');

    if (!pts) return;

    el.select('line.edge')
      .attr('x1', pts.x1).attr('y1', pts.y1)
      .attr('x2', pts.x2).attr('y2', pts.y2);

    // Position annotation label: use phantom label node when placed, else midpoint
    const ln = labelNodes[d.id];
    const tx = (ln && ln._placed) ? ln.x : (pts.x1 + pts.x2) / 2;
    const ty = (ln && ln._placed) ? ln.y : (pts.y1 + pts.y2) / 2 - 6;

    el.select('text.edge-annotation')
      .attr('x', tx).attr('y', ty)
      .attr('text-anchor', 'middle')
      .text(d.annotation || '');
  });

  edgeLayer.selectAll('.edge-hitarea-group').each(function(d) {
    const fromProxy = getVisibleProxy(d.from);
    const toProxy   = getVisibleProxy(d.to);
    const vis = !!(fromProxy && toProxy && fromProxy.id !== toProxy.id);
    const pts = vis ? getEdgeEndpoints(d) : null;
    const el  = d3.select(this);

    el.attr('pointer-events', vis ? 'all' : 'none');

    if (!pts) return;
    el.select('line.edge-hitarea')
      .attr('x1', pts.x1).attr('y1', pts.y1)
      .attr('x2', pts.x2).attr('y2', pts.y2);
  });
}

// ─── Container / ghost mode ───────────────────────────────────────────────────
// A node becomes a container/ghost whenever it has expanded children
// (expandedDepth >= 1).  The bounding box encompasses ALL visible descendants
// (not just direct children) so nested expansions are properly enclosed.

function updateContainers() {
  nodeLayer.selectAll('.node').each(function(d) {
    if (!isNodeVisible(d)) return;
    const el = d3.select(this);

    if (d.expandedDepth === 0) {
      // Collapsed / normal node
      el.classed('node-ghost', false).classed('node-container', false);
      el.select('.node-rect').attr('display', null);
      el.select('.container-rect').attr('display', 'none');
      el.select('text')
        .attr('x', 0).attr('y', 0)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle');
      d.containerBounds = null;
      return;
    }

    const desc = visibleDescendants(d);

    if (desc.length === 0 || parentDisplayMode === 'ghost') {
      // Ghost: dim dashed outline at the node's position
      el.classed('node-ghost', true).classed('node-container', false);
      el.select('.container-rect').attr('display', 'none');
      el.select('.node-rect').attr('display', null);
      el.select('text')
        .attr('x', 0).attr('y', 0)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle');
      d.containerBounds = null;
      return;
    }

    // Container: dashed bounding box around all visible descendants
    el.classed('node-ghost', false).classed('node-container', true);
    el.select('.node-rect').attr('display', 'none');

    const pad    = 36;
    const cw     = NODE_W_SM / 2;
    const ch     = NODE_H_SM / 2;
    const labelH = 22;

    const relXs = desc.map(c => c.x - d.x);
    const relYs = desc.map(c => c.y - d.y);

    const minX = Math.min(...relXs) - cw - pad;
    const maxX = Math.max(...relXs) + cw + pad;
    const minY = Math.min(...relYs) - ch - pad - labelH;
    const maxY = Math.max(...relYs) + ch + pad;

    el.select('.container-rect')
      .attr('display', 'inline')
      .attr('x', minX).attr('y', minY)
      .attr('width',  maxX - minX)
      .attr('height', maxY - minY)
      .attr('rx', 10);

    el.select('text')
      .attr('x', minX + 10).attr('y', minY + labelH - 8)
      .attr('text-anchor', 'start').attr('dominant-baseline', 'middle');

    // Store SVG-space bounds for edge border clipping
    d.containerBounds = {
      x: d.x + minX, y: d.y + minY,
      w: maxX - minX, h: maxY - minY,
    };
  });
}

// ─── HUD ──────────────────────────────────────────────────────────────────────

function updateLodIndicator(k) {
  const n = Object.values(nodes).filter(n => n.expandedDepth > 0).length;
  document.getElementById('lod-indicator').textContent =
    `k=${k.toFixed(2)}` + (n > 0 ? ` · ${n} expanded` : '');
}

function updateModeIndicator() {
  const anyExpanded = Object.values(nodes).some(n => n.expandedDepth > 0);
  document.getElementById('mode-indicator').textContent =
    anyExpanded ? `${parentDisplayMode} (G)` : '';
}

// ─── Edge geometry ────────────────────────────────────────────────────────────

// Returns border centre + half-extents for a node in SVG space.
// When the node is in container mode, uses the container rect bounds instead
// of the fixed node rect so edges clip to the container border.
function nodeBorderInfo(node) {
  if (node.containerBounds) {
    const b = node.containerBounds;
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, hw: b.w / 2, hh: b.h / 2 };
  }
  const hw = (node.level >= 1 ? NODE_W_SM : NODE_W) / 2;
  const hh = (node.level >= 1 ? NODE_H_SM : NODE_H) / 2;
  return { cx: node.x, cy: node.y, hw, hh };
}

function getEdgeEndpoints(edge) {
  const fromNode = getVisibleProxy(edge.from);
  const toNode   = getVisibleProxy(edge.to);
  if (!fromNode || !toNode || fromNode.id === toNode.id) return null;

  const fb = nodeBorderInfo(fromNode);
  const tb = nodeBorderInfo(toNode);

  const dx   = tb.cx - fb.cx;
  const dy   = tb.cy - fb.cy;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;

  const fromOff = borderOffset( dx / dist,  dy / dist, fb.hw, fb.hh);
  const toOff   = borderOffset(-dx / dist, -dy / dist, tb.hw, tb.hh);

  return {
    x1: fb.cx + fromOff.x, y1: fb.cy + fromOff.y,
    x2: tb.cx + toOff.x,   y2: tb.cy + toOff.y,
  };
}

function borderOffset(nx, ny, hw, hh) {
  const tX = nx !== 0 ? hw / Math.abs(nx) : Infinity;
  const tY = ny !== 0 ? hh / Math.abs(ny) : Infinity;
  const t  = Math.min(tX, tY);
  return { x: nx * t, y: ny * t };
}

// ─── Drag ─────────────────────────────────────────────────────────────────────

let dragShift = false;

function dragStarted(event, d) {
  dragShift = event.sourceEvent && event.sourceEvent.shiftKey;
  if (!event.active && simulation) simulation.alphaTarget(0.3).restart();
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function dragEnded(event, d) {
  if (!event.active && simulation) simulation.alphaTarget(0);
  if (dragShift) {
    d.pin = { x: d.fx, y: d.fy };
    d3.select(this).classed('pinned', true);
    patchNode(d.id, { pin: { x: d.fx, y: d.fy } }).then(() => setDirty(true));
  } else {
    if (!d.pin) { d.fx = null; d.fy = null; }
  }
}

// ─── Label editing ────────────────────────────────────────────────────────────

function startLabelEdit(d) {
  const nodeEl = nodeLayer.selectAll('.node').filter(n => n.id === d.id);
  const nw = d.level >= 1 ? NODE_W_SM : NODE_W;
  const nh = d.level >= 1 ? NODE_H_SM : NODE_H;

  nodeEl.select('text').attr('opacity', 0);

  const fo = nodeEl.append('foreignObject')
    .attr('x', -nw/2 + 2).attr('y', -nh/2 + 2)
    .attr('width', nw - 4).attr('height', nh - 4);

  const input = fo.append('xhtml:input')
    .attr('class', 'node-edit-input')
    .attr('value', d.label)
    .style('width', '100%').style('height', '100%');

  const inputEl = input.node();
  inputEl.focus();
  inputEl.select();

  function commit() {
    const newLabel = inputEl.value.trim() || d.label;
    fo.remove();
    d.label = newLabel;
    nodeEl.select('text').attr('opacity', 1).text(newLabel);
    patchNode(d.id, { label: newLabel }).then(() => setDirty(true));
  }

  inputEl.addEventListener('blur', commit, { once: true });
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); inputEl.blur(); }
    if (e.key === 'Escape') { fo.remove(); nodeEl.select('text').attr('opacity', 1); }
  });
}

// ─── Edge annotation editing ──────────────────────────────────────────────────

function selectEdge(edgeId, event) {
  selectedEdgeId = edgeId;
  const edge = edges[edgeId];
  if (!edge) return;

  const pts = getEdgeEndpoints(edge);
  if (!pts) return;

  const t  = d3.zoomTransform(svg.node());
  const sx = t.applyX((pts.x1 + pts.x2) / 2);
  const sy = t.applyY((pts.y1 + pts.y2) / 2);

  const existing = document.getElementById('edge-edit-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'edge-edit-overlay';
  overlay.style.cssText = `position:fixed;left:${sx-80}px;top:${sy-16}px;z-index:150`;

  const inp = document.createElement('input');
  inp.className   = 'edge-annotation-input';
  inp.style.width = '160px';
  inp.value       = edge.annotation || '';
  inp.placeholder = 'annotation…';
  overlay.appendChild(inp);
  document.body.appendChild(overlay);

  inp.focus();
  inp.select();

  function commit() {
    const val = inp.value.trim();
    edge.annotation = val || null;
    overlay.remove();
    // Update label node placement flag if annotation changed
    if (labelNodes[edgeId]) {
      if (!val) {
        delete labelNodes[edgeId];
      }
    } else if (val) {
      labelNodes[edgeId] = {
        id: `label_${edgeId}`, edgeId,
        x: (pts.x1 + pts.x2) / 2, y: (pts.y1 + pts.y2) / 2,
        vx: 0, vy: 0, _placed: true,
      };
    }
    rerenderEdges();
    patchEdge(edgeId, { annotation: val || null }).then(() => setDirty(true));
    selectedEdgeId = null;
  }

  inp.addEventListener('blur', commit, { once: true });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { overlay.remove(); selectedEdgeId = null; }
  });
}

// ─── Context menu ─────────────────────────────────────────────────────────────

const ctxMenu = document.getElementById('context-menu');
let ctxNode = null;

function showContextMenu(event, d) {
  ctxNode = d;
  ctxMenu.style.left = `${event.clientX}px`;
  ctxMenu.style.top  = `${event.clientY}px`;
  ctxMenu.classList.add('visible');
  document.getElementById('ctx-unpin').style.display = d.pin ? 'block' : 'none';
}

function hideContextMenu() {
  ctxMenu.classList.remove('visible');
  ctxNode = null;
}

document.getElementById('ctx-unpin').addEventListener('click', () => {
  if (!ctxNode) return;
  const d = ctxNode;
  hideContextMenu();
  d.pin = null; d.fx = null; d.fy = null;
  nodeLayer.selectAll('.node').filter(n => n.id === d.id).classed('pinned', false);
  if (simulation) simulation.alphaTarget(0.2).restart();
  patchNode(d.id, { pin: null }).then(() => setDirty(true));
});

document.getElementById('ctx-open-source').addEventListener('click', () => {
  if (!ctxNode) return;
  const d = ctxNode;
  hideContextMenu();
  if (d.source) openCodePanel(d);
});

svg.on('click', hideContextMenu);

// ─── Code panel ───────────────────────────────────────────────────────────────

const codePanel        = document.getElementById('code-panel');
const codePanelPath    = document.getElementById('code-panel-path');
const codePanelContent = document.getElementById('code-panel-content');
const codePanelBack    = document.getElementById('code-panel-back');

let codePanelFileParent = null;

codePanelBack.addEventListener('click', () => {
  if (codePanelFileParent !== null) openCodePanel(codePanelFileParent);
});

// ─── Panel resize ─────────────────────────────────────────────────────────────

const codePanelResize = document.getElementById('code-panel-resize');
let resizing = false;

codePanelResize.addEventListener('mousedown', e => {
  e.preventDefault();
  resizing = true;
  codePanelResize.classList.add('dragging');
});
document.addEventListener('mousemove', e => {
  if (!resizing) return;
  const newWidth = window.innerWidth - e.clientX;
  const min = parseInt(getComputedStyle(codePanel).minWidth);
  const max = parseInt(getComputedStyle(codePanel).maxWidth);
  codePanel.style.width = Math.min(max, Math.max(min, newWidth)) + 'px';
});
document.addEventListener('mouseup', () => {
  if (!resizing) return;
  resizing = false;
  codePanelResize.classList.remove('dragging');
});

async function openCodePanel(nodeOrPath) {
  const source = typeof nodeOrPath === 'string' ? nodeOrPath : nodeOrPath.source;
  if (!source && source !== '') return;

  codePanelPath.textContent    = source;
  codePanelContent.innerHTML   = '<pre style="color:#666;padding:8px 12px">Loading…</pre>';
  codePanel.classList.add('open');

  try {
    const data = await fetchFile(source);
    if (data.type === 'directory') renderDirectoryInPanel(data);
    else                           renderFileInPanel(data, source);
  } catch (e) {
    codePanelContent.innerHTML = `<pre style="color:#f66;padding:8px 12px">Error: ${e.message}</pre>`;
  }
}

function renderFileInPanel(data, path) {
  codePanelPath.textContent = path;
  const parts = path.replace(/\/+$/, '').split('/');
  parts.pop();
  codePanelFileParent = parts.join('/');
  codePanelBack.hidden = false;

  const pre  = document.createElement('pre');
  const code = document.createElement('code');
  code.className  = langClass(path);
  code.textContent = data.lines.join('\n');
  pre.appendChild(code);
  codePanelContent.innerHTML = '';
  codePanelContent.appendChild(pre);
  if (window.hljs) hljs.highlightElement(code);
}

function renderDirectoryInPanel(data) {
  codePanelBack.hidden    = true;
  codePanelFileParent     = null;
  codePanelPath.textContent = data.path;

  const container = document.createElement('div');
  container.className = 'dir-listing';

  // Breadcrumb nav
  const nav   = document.createElement('div');
  nav.className = 'dir-nav';
  const parts = data.path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 0) {
    const span = document.createElement('span');
    span.textContent = '/';
    nav.appendChild(span);
  } else {
    const rootBtn = document.createElement('button');
    rootBtn.className   = 'dir-nav-part';
    rootBtn.textContent = '~';
    rootBtn.addEventListener('click', () => openCodePanel(''));
    nav.appendChild(rootBtn);
    parts.forEach((part, i) => {
      const sep = document.createElement('span');
      sep.className   = 'dir-nav-sep';
      sep.textContent = '/';
      nav.appendChild(sep);
      const btn = document.createElement('button');
      btn.className   = 'dir-nav-part';
      btn.textContent = part;
      if (i < parts.length - 1) {
        const target = parts.slice(0, i + 1).join('/');
        btn.addEventListener('click', () => openCodePanel(target));
      }
      nav.appendChild(btn);
    });
  }
  container.appendChild(nav);

  const list = document.createElement('div');
  list.className = 'dir-entries';

  for (const entry of data.entries) {
    const row  = document.createElement('div');
    row.className = `dir-entry ${entry.is_dir ? 'dir-entry-dir' : 'dir-entry-file'}`;

    const icon = document.createElement('span');
    icon.className   = 'dir-entry-icon';
    icon.textContent = entry.is_dir ? '▸' : '·';
    row.appendChild(icon);

    const nameEl = document.createElement('span');
    nameEl.className   = 'dir-entry-name';
    nameEl.textContent = entry.name + (entry.is_dir ? '/' : '');
    row.appendChild(nameEl);

    const matchedNode = findNodeBySource(entry.path);
    if (matchedNode) {
      const badge = document.createElement('span');
      badge.className   = 'dir-node-badge';
      badge.textContent = matchedNode.label;
      badge.title       = 'Jump to node in graph';
      badge.addEventListener('click', e => { e.stopPropagation(); zoomToNode(matchedNode); });
      row.appendChild(badge);
    }

    row.addEventListener('click', () => openCodePanel(entry.path));
    list.appendChild(row);
  }
  container.appendChild(list);

  const dirs  = data.entries.filter(e => e.is_dir).length;
  const files = data.entries.length - dirs;
  const footer = document.createElement('div');
  footer.className   = 'dir-footer';
  footer.textContent = [
    dirs  && `${dirs}  dir${dirs  !== 1 ? 's' : ''}`,
    files && `${files} file${files !== 1 ? 's' : ''}`,
  ].filter(Boolean).join(', ');
  container.appendChild(footer);

  codePanelContent.innerHTML = '';
  codePanelContent.appendChild(container);
}

// Pan the canvas to centre on a node; no LOD side-effects.
function zoomToNode(node) {
  const { w: viewW, h: viewH } = getViewportSize();
  const k  = d3.zoomTransform(svg.node()).k;
  const tx = viewW / 2 - node.x * k;
  const ty = viewH / 2 - node.y * k;
  svg.transition().duration(600).call(zoom.transform,
    d3.zoomIdentity.translate(tx, ty).scale(k));

  codePanel.classList.remove('open');
  codePanelContent.innerHTML = '';

  const sel = nodeLayer.selectAll('.node').filter(d => d.id === node.id);
  sel.classed('node-flash', true);
  setTimeout(() => sel.classed('node-flash', false), 1200);
}

// Source path helpers
function normaliseSource(s) {
  return (s || '').replace(/\/+$/, '').replace(/\\/g, '/');
}
function findNodeBySource(path) {
  return sourceToNode[normaliseSource(path)] || null;
}
function langClass(path) {
  const ext = path.split('.').pop().toLowerCase();
  const map = {
    rs: 'rust', js: 'javascript', ts: 'typescript',
    yaml: 'yaml', yml: 'yaml', html: 'html',
    css: 'css', toml: 'toml', md: 'markdown', json: 'json',
  };
  return map[ext] ? `language-${map[ext]}` : '';
}

document.getElementById('code-panel-close').addEventListener('click', () => {
  codePanel.classList.remove('open');
  codePanelContent.innerHTML = '';
  svg.node().focus();
});

// ─── Dirty flag / save ────────────────────────────────────────────────────────

function setDirty(val) {
  dirty = val;
  document.getElementById('dirty-indicator').textContent = val ? '● unsaved' : '';
  document.title = val ? '● vgraphtree' : 'vgraphtree';
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', async e => {
  const inInput = document.activeElement.tagName === 'INPUT';

  // Ctrl/Cmd+S: save
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (!dirty) return;
    await postSave();
    setDirty(false);
    return;
  }

  if (inInput) return;

  // G: toggle ghost / container mode
  if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    parentDisplayMode = parentDisplayMode === 'ghost' ? 'container' : 'ghost';
    updateContainers();
    updateModeIndicator();
  }

  // +/= : zoom in   −: zoom out
  if ((e.key === '+' || e.key === '=') && !e.ctrlKey && !e.metaKey) {
    svg.transition().duration(250).call(zoom.scaleBy, 1.3);
  }
  if (e.key === '-' && !e.ctrlKey && !e.metaKey) {
    svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.3);
  }
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  const data = await fetchGraph();

  nodes = data.nodes;
  edges = {};
  for (const e of (data.edges || [])) {
    edges[e.id] = e;
  }

  // Attach per-node LOD state and build source index
  sourceToNode = {};
  for (const node of Object.values(nodes)) {
    node.expandedDepth  = 0;
    node.containerBounds = null;
    if (node.source) sourceToNode[normaliseSource(node.source)] = node;
  }

  // Assign positions — roots first so children can reference parent positions
  const sorted = Object.values(nodes).sort((a, b) => a.level - b.level);
  for (const node of sorted) {
    const pos = initialPosition(node, nodes);
    node.x = pos.x;
    node.y = pos.y;
  }

  // Build label phantom nodes for edges that have annotations
  initLabelNodes();

  renderNodes();
  renderEdges();
  updateLodIndicator(0);

  buildSimulation();
  scheduleCenterGraph();
  // Ensure the canvas has keyboard focus so shortcuts work without requiring
  // the user to click first.
  svg.node().focus();
}

function scheduleCenterGraph() {
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

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (Object.keys(nodes).length > 0) centerGraph();
  }, 150);
});

init();
