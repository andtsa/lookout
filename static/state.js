// ─── Mutable graph state ──────────────────────────────────────────────────────
// All modules share these via ES module live bindings.  Use the setX() helpers
// whenever a variable needs to be wholly replaced (not just mutated in-place).

import { ZOOM_SENSITIVITY, ZOOM_MIN, ZOOM_MAX } from './constants.js';

export let nodes           = {};   // id → node (augmented with x,y,fx,fy by D3)
export let edges           = {};   // id → edge
export let labelNodes      = {};   // edgeId → phantom label node for force sim
export let sourceToNode    = {};   // normalised source path → node
export let selectedEdgeId  = null;
export let parentDisplayMode = 'container'; // 'ghost' | 'container'
export let hoveredNodeId   = null;
export let simulation      = null; // current layout controller (D3 force sim, or a Cola shim)
export const scrollAccum   = {};   // nodeId → accumulated wheel deltaY

// Active layout engine: 'force' (d3-force) or 'cola' (WebCola constraint layout).
// Toggled at runtime; refreshVisibility dispatches the (re)layout accordingly.
export let layoutEngine    = 'force';
export function setLayoutEngine(v) { layoutEngine = v; }
// Cola layout mode: 'layered' (top-down flow), 'radial' (center → outward), or
// 'stress' (no directional flow). Cycled by the layering keybinding.
export let colaMode        = 'layered';
export function setColaMode(v)     { colaMode = v; }
export const COLA_MODES    = ['layered', 'radial', 'stress'];

// Focused node IDs — mutated in-place so all importers share the same Set.
// Edges are always dim unless at least one endpoint is focused, EXCEPT when
// graphIsSparse is true (see lod.js / simulation.js).
export const focusedNodeIds = new Set();

// Set to true by buildSimulation when visible semantic edges ≤ SPARSE_EDGE_RATIO
// × visible nodes.  When sparse, all edges are exposed without needing focus.
export let graphIsSparse = false;
export function setGraphIsSparse(v) { graphIsSparse = v; }
export function toggleFocusedNode(id) {
  if (focusedNodeIds.has(id)) focusedNodeIds.delete(id);
  else focusedNodeIds.add(id);
}
export function clearFocus() {
  if (focusedNodeIds.size === 0) return false;
  focusedNodeIds.clear();
  return true;
}

export function setNodes(v)             { nodes = v; }
export function setEdges(v)             { edges = v; }
export function setSourceToNode(v)      { sourceToNode = v; }
export function setSelectedEdgeId(v)    { selectedEdgeId = v; }
export function setParentDisplayMode(v) { parentDisplayMode = v; }
export function setHoveredNodeId(v)     { hoveredNodeId = v; }
export function setSimulation(v)        { simulation = v; }

// labelNodes is always mutated in-place (no setLabelNodes needed).
// nodes/edges are occasionally replaced wholesale — use setNodes / setEdges.

// ─── Dirty / unsaved state ────────────────────────────────────────────────────

let _dirty = false;
export function getDirty() { return _dirty; }
export function setDirty(val) {
  _dirty = val;
  document.getElementById('dirty-indicator').textContent = val ? '● unsaved' : '';
  document.title = val ? '● vgraphtree' : 'vgraphtree';
  // Discard is only offered when there are unsaved edits to discard.
  const db = document.getElementById('discard-btn');
  if (db) db.hidden = !val;
}

// ─── SVG canvas setup ─────────────────────────────────────────────────────────
// Runs once at module load time (ES modules are deferred, so the DOM is ready).

export const svg = d3.select('#canvas');
const defs = svg.append('defs');

defs.append('marker')
  .attr('id',          'arrow')
  .attr('viewBox',     '0 -4 8 8')
  .attr('refX',        8).attr('refY', 0)
  .attr('markerWidth', 6).attr('markerHeight', 6)
  .attr('orient',      'auto')
  .append('path')
  .attr('d',    'M0,-4L8,0L0,4')
  .attr('opacity', 0.6);
  // Fill is themed via CSS (`#arrow path { fill: var(--accent) }`) so the
  // arrowhead colour follows the active palette.

// Full-viewport transparent "catcher". d3-zoom binds its wheel/drag listeners to
// <svg>, but an SVG only receives pointer events where something is *painted* —
// so scrolling over empty canvas did nothing. This rect paints the whole viewport
// (fill:none + pointer-events:all keeps it invisible but hit-testable) and sits
// UNDER the content, so empty-area events reach the zoom while nodes still get
// their own. 100% width/height tracks the viewport with no resize handling.
svg.append('rect')
  .attr('class', 'zoom-catcher')
  .attr('width', '100%')
  .attr('height', '100%')
  .attr('fill', 'none')
  .attr('pointer-events', 'all');

// Debug overlay arrowhead (velocity vectors).
defs.append('marker')
  .attr('id', 'dbg-arrow')
  .attr('viewBox', '0 -3 6 6')
  .attr('refX', 6).attr('refY', 0)
  .attr('markerWidth', 5).attr('markerHeight', 5)
  .attr('orient', 'auto')
  .append('path').attr('d', 'M0,-3L6,0L0,3').attr('fill', '#e0602c');

export const root      = svg.append('g').attr('id', 'root');
export const edgeLayer = root.append('g').attr('id', 'edge-layer');
export const nodeLayer = root.append('g').attr('id', 'node-layer');
// Force-debug overlay — drawn above nodes, hidden unless debug mode is on.
export const debugLayer = root.append('g').attr('id', 'debug-layer').attr('display', 'none');

export let debugMode = false;
export function setDebugMode(v) {
  debugMode = v;
  debugLayer.attr('display', v ? 'inline' : 'none');
  const el = document.getElementById('debug-indicator');
  if (el) el.hidden = !v;
}

export const zoom = d3.zoom()
  .scaleExtent([ZOOM_MIN, ZOOM_MAX])
  .wheelDelta(event =>
    -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : ZOOM_SENSITIVITY))
  .on('zoom', event => {
    root.attr('transform', event.transform);
    // Additional listeners (e.g. LOD indicator) are registered with zoom.on('zoom.xxx')
    // by other modules after import, so there is no import-time dependency here.
  });

svg.call(zoom);

// Explicitly prevent default on wheel events with {passive: false}.
// Browsers may register wheel listeners as passive on SVG elements, which
// prevents D3 zoom from calling preventDefault() in time and lets the browser
// swallow the scroll event before the zoom transform is applied.
svg.node().addEventListener('wheel', e => e.preventDefault(), { passive: false });
