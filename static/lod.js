// ─── Level-of-detail (expand / collapse) logic ───────────────────────────────
// Pure state mutations — no render calls.  Callers are responsible for
// calling refreshVisibility() (in app.js) after any mutation.

import { nodes, edges, labelNodes, focusedNodeIds, graphIsSparse } from './state.js';
import { EXPAND_JITTER, LABEL_RADIUS_MIN, LABEL_RADIUS_PER_CHAR } from './constants.js';

// ─── Visibility predicates ────────────────────────────────────────────────────

export function isNodeVisible(node) {
  if (!node.parent) return true;
  const parent = nodes[node.parent];
  if (!parent) return true;
  return parent.expandedDepth >= 1 && isNodeVisible(parent);
}

export function isLeafNode(node) {
  return !node.children || node.children.length === 0;
}

// All currently visible descendants (used for container bounds & cluster drag).
export function visibleDescendants(node) {
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

// Walk up the parent chain to find the nearest visible ancestor (or self).
export function getVisibleProxy(nodeId) {
  let node = nodes[nodeId];
  while (node) {
    if (isNodeVisible(node)) return node;
    node = nodes[node.parent];
  }
  return null;
}

// ─── Per-node expand / collapse ───────────────────────────────────────────────

// Expand one level in this node's subtree (direct scroll-based expand).
// Children that have no position yet are placed near the parent.
// Returns true always (the caller still refreshes).
export function expandNode(node) {
  for (const cid of (node.children || [])) {
    const c = nodes[cid];
    if (c && c.x == null) {
      c.x = node.x + (Math.random() - 0.5) * EXPAND_JITTER;
      c.y = node.y + (Math.random() - 0.5) * EXPAND_JITTER;
    }
  }
  node.expandedDepth++;
  return true;
}

// Collapse the deepest expanded node in this node's subtree.
// Returns true if something was actually collapsed.
export function collapseDeepestIn(node) {
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
  if (target) target.expandedDepth--;
  return !!target;
}

// ─── Global expand / collapse ─────────────────────────────────────────────────
// E — advance the shallowest frontier (nodes at minimum expandedDepth).
// C — retract the deepest frontier, honouring tree-level ordering so that
//     pressing C once undoes exactly one E, even when multiple tree levels
//     share the same expandedDepth value.

export function globalExpand() {
  const targets = Object.values(nodes).filter(n => isNodeVisible(n) && !isLeafNode(n));
  if (targets.length === 0) { flashLodNothing(); return false; }
  const minDepth = Math.min(...targets.map(n => n.expandedDepth));
  for (const n of targets.filter(t => t.expandedDepth === minDepth)) {
    for (const cid of (n.children || [])) {
      const c = nodes[cid];
      if (c && c.x == null) {
        c.x = n.x + (Math.random() - 0.5) * 20;
        c.y = n.y + (Math.random() - 0.5) * 20;
      }
    }
    n.expandedDepth++;
  }
  return true;
}

export function globalCollapse() {
  const targets = Object.values(nodes).filter(n => isNodeVisible(n) && !isLeafNode(n));
  if (targets.length === 0) { flashLodNothing(); return false; }
  const maxDepth = Math.max(...targets.map(n => n.expandedDepth));
  if (maxDepth === 0) { flashLodNothing(); return false; }

  // Bug fix: after two E presses, both level-0 roots (depth=1) and their
  // level-1 children (depth=1) share the same expandedDepth.  Without the
  // level tiebreaker, one C press would collapse BOTH levels simultaneously,
  // jumping straight back to the initial state.
  // Fix: among nodes at maxDepth, only collapse those at the deepest tree
  // level — the outermost shell of the expansion.
  const atMax    = targets.filter(t => t.expandedDepth === maxDepth);
  const maxLevel = Math.max(...atMax.map(n => n.level));
  for (const n of atMax.filter(n => n.level === maxLevel)) {
    n.expandedDepth--;
  }
  return true;
}

// ─── Focus / edge exposure ────────────────────────────────────────────────────
// An edge is "exposed" (full opacity, physics-active) when:
//   • no node is focused (default state — whole graph is live), OR
//   • at least one of its endpoints is currently focused.
// This lets the user focus one or more nodes to see only their connections
// while the rest of the graph fades to a low-opacity guide.

export function isEdgeExposed(edge) {
  // Sparse graphs expose everything regardless of focus state.
  if (graphIsSparse) return true;
  // Otherwise an edge is only exposed when at least one endpoint is focused.
  return focusedNodeIds.has(edge.from) || focusedNodeIds.has(edge.to);
}

// ─── Label phantom-node radius ────────────────────────────────────────────────

export function labelRadius(ln) {
  const annotation = edges[ln.edgeId]?.annotation || '';
  return Math.max(LABEL_RADIUS_MIN, annotation.length * LABEL_RADIUS_PER_CHAR);
}

// ─── Visual feedback helpers ──────────────────────────────────────────────────

export function flashLeaf(nodeId) {
  // getElementById handles IDs with dots correctly (no CSS selector parsing).
  const el = document.getElementById(`node-${nodeId}`);
  if (!el) return;
  el.classList.add('node-leaf-flash');
  setTimeout(() => el.classList.remove('node-leaf-flash'), 600);
}

export function flashLodNothing() {
  const el = document.getElementById('lod-indicator');
  el.style.transition  = 'color 0.08s, border-color 0.08s';
  el.style.color       = 'var(--gold)';
  el.style.borderColor = 'var(--gold)';
  setTimeout(() => {
    el.style.color       = '';
    el.style.borderColor = '';
    setTimeout(() => { el.style.transition = ''; }, 200);
  }, 280);
}
