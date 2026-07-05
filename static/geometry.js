// ─── Coordinate geometry ──────────────────────────────────────────────────────
// Pure coordinate helpers.  No render side-effects; imports only constants/state.

import { NODE_W, NODE_H, NODE_W_SM, NODE_H_SM, CONTAINER_MARGIN } from './constants.js';
import { svg } from './state.js';

// ─── Container collision geometry ──────────────────────────────────────────────

// Centre of a container's box (which follows its children, not the parent node).
export function containerCenter(b) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

// Collision radius for a container — the circle that circumscribes its box, plus
// the perimeter margin. Analogous to COLLISION_RADIUS for a node, but sized to
// the box so it grows/shrinks with the container.
export function containerRadius(b) {
  return 0.5 * Math.hypot(b.w, b.h) + CONTAINER_MARGIN;
}

// ─── Viewport ─────────────────────────────────────────────────────────────────

export function getViewportSize() {
  const el = svg.node();
  const w = el.clientWidth  || el.getBoundingClientRect().width  || window.innerWidth  || 1280;
  const h = el.clientHeight || el.getBoundingClientRect().height || window.innerHeight || 720;
  return { w, h };
}

// ─── Zone / initial position ──────────────────────────────────────────────────

export function zoneToCoords(zone) {
  const m = 80;
  const { w, h } = getViewportSize();
  const map = {
    'top':          { x: w / 2,   y: m       },
    'bottom':       { x: w / 2,   y: h - m   },
    'left':         { x: m,       y: h / 2   },
    'right':        { x: w - m,   y: h / 2   },
    'top-left':     { x: m,       y: m       },
    'top-right':    { x: w - m,   y: m       },
    'bottom-left':  { x: m,       y: h - m   },
    'bottom-right': { x: w - m,   y: h - m   },
    'center':       { x: w / 2,   y: h / 2   },
  };
  return map[zone] || { x: w / 2, y: h / 2 };
}

export function initialPosition(node, allNodes) {
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

// ─── Node border geometry ──────────────────────────────────────────────────────

// Returns the border centre + half-extents for a node in SVG space.
// Container nodes use their computed bounding rect instead of the fixed box.
export function nodeBorderInfo(node) {
  if (node.containerBounds) {
    const b = node.containerBounds;
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, hw: b.w / 2, hh: b.h / 2 };
  }
  const hw = (node.level >= 1 ? NODE_W_SM : NODE_W) / 2;
  const hh = (node.level >= 1 ? NODE_H_SM : NODE_H) / 2;
  return { cx: node.x, cy: node.y, hw, hh };
}

function borderOffset(nx, ny, hw, hh) {
  const tX = nx !== 0 ? hw / Math.abs(nx) : Infinity;
  const tY = ny !== 0 ? hh / Math.abs(ny) : Infinity;
  const t  = Math.min(tX, tY);
  return { x: nx * t, y: ny * t };
}

// Returns the two border-intersection points for an edge, or null if not renderable.
// getVisibleProxyFn must be passed in to avoid an import cycle with lod.js.
export function getEdgeEndpoints(edge, getVisibleProxyFn) {
  const fromNode = getVisibleProxyFn(edge.from);
  const toNode   = getVisibleProxyFn(edge.to);
  if (!fromNode || !toNode || fromNode.id === toNode.id) return null;

  const fb   = nodeBorderInfo(fromNode);
  const tb   = nodeBorderInfo(toNode);
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
