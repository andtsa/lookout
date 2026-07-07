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

// Reveal this node's direct children (scroll-based expand). Placing children
// that have no position yet near the parent. Idempotent: expandedDepth is
// boolean, so re-expanding an already-open node is a no-op.
export function expandNode(node) {
  for (const cid of (node.children || [])) {
    const c = nodes[cid];
    if (c && c.x == null) {
      c.x = node.x + (Math.random() - 0.5) * EXPAND_JITTER;
      c.y = node.y + (Math.random() - 0.5) * EXPAND_JITTER;
    }
  }
  node.expandedDepth = 1;
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
  if (target) target.expandedDepth = 0;
  return !!target;
}

// ─── Global expand / collapse ─────────────────────────────────────────────────
// expandedDepth is effectively boolean per node: 0 = children hidden, 1 = shown
// (isNodeVisible only checks `parent.expandedDepth >= 1`). Because a node is
// visible only when its parent is expanded, the set of *visible, collapsed,
// non-leaf* nodes is exactly the current outer frontier, and the *innermost
// expanded* nodes are the inner frontier. Working from those sets makes E/C
// naturally saturate — E stops when nothing collapsed remains to open, C stops
// when nothing is expanded — with no depth counter to run away.

export function globalExpand() {
  // Outer frontier: visible non-leaf nodes whose children are still hidden.
  const frontier = Object.values(nodes).filter(
    n => isNodeVisible(n) && !isLeafNode(n) && n.expandedDepth === 0);
  if (frontier.length === 0) { flashLodNothing(); return false; }
  for (const n of frontier) {
    for (const cid of (n.children || [])) {
      const c = nodes[cid];
      if (c && c.x == null) {
        c.x = n.x + (Math.random() - 0.5) * EXPAND_JITTER;
        c.y = n.y + (Math.random() - 0.5) * EXPAND_JITTER;
      }
    }
    n.expandedDepth = 1;
  }
  return true;
}

export function globalCollapse() {
  const expanded = Object.values(nodes).filter(n => isNodeVisible(n) && n.expandedDepth > 0);
  if (expanded.length === 0) { flashLodNothing(); return false; }
  // Inner frontier: expanded nodes with no expanded (visible) child — the
  // deepest revealed layer. Collapsing these undoes exactly one E.
  const hasExpandedChild = n => (n.children || []).some(cid => {
    const c = nodes[cid];
    return c && isNodeVisible(c) && c.expandedDepth > 0;
  });
  for (const n of expanded.filter(n => !hasExpandedChild(n))) {
    n.expandedDepth = 0;
  }
  return true;
}

// ─── Focus / edge exposure ────────────────────────────────────────────────────
// "Focus mode is always on": on a dense graph edges are faded by default and you
// focus node(s) to reveal their connections. An edge is "exposed" (full opacity,
// physics-active) when:
//   • one or more nodes ARE focused — only edges touching a focused node are
//     exposed, full stop. This overrides the sparse bypass below: focusing is a
//     deliberate "show me just this" action, so it should never be diluted by
//     "well the graph's sparse, here's everything anyway."
//   • otherwise (nothing focused): the graph is sparse (few edges) — focusing
//     would be pointless, so show all; else every edge is faded — the intended
//     resting state (declutters a dense graph).
// Esc clears focus and returns to that resting state.

export function isEdgeExposed(edge) {
  if (focusedNodeIds.size > 0) {
    // Compare against each endpoint's VISIBLE PROXY, not just its raw id.
    // Rendering draws a hidden node's edges as touching its nearest visible
    // ancestor (getVisibleProxy) — e.g. a collapsed container stands in for
    // all its hidden children. Without this, focusing that container would
    // never expose an edge owned by one of its (hidden) children, even though
    // the drawn line visibly touches the focused container.
    const fromId = getVisibleProxy(edge.from)?.id ?? edge.from;
    const toId   = getVisibleProxy(edge.to)?.id ?? edge.to;
    return focusedNodeIds.has(edge.from) || focusedNodeIds.has(edge.to)
        || focusedNodeIds.has(fromId)    || focusedNodeIds.has(toId);
  }
  return graphIsSparse;
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
