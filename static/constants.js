// ─── Node box dimensions ───────────────────────────────────────────────────────

export const NODE_W    = 140;  // level-0 node width  (px, SVG space)
export const NODE_H    = 44;   // level-0 node height
export const NODE_W_SM = 110;  // level-1+ node width
export const NODE_H_SM = 32;   // level-1+ node height

// ─── Force simulation ──────────────────────────────────────────────────────────
// Charge (repulsion) — forceManyBody strength values are negative.

// Label phantom nodes: charge scales with the collision radius so they push
// away from real nodes just enough to find a clear gap.
export const CHARGE_LABEL_FACTOR     = 2;

// Expanded container nodes: repulsion scales with the number of DIRECT visible
// children (what the container actually needs to space out), not its rendered
// size and not its recursive descendant count. Two reasons:
//   • rendered size fed back into the force → unbounded growth.
//   • recursive count double-counts nesting — a sub-container's children are
//     repelled by every ancestor's charge, compounding and over-inflating deep
//     containers (e.g. "rust backend" ballooning while flat "web frontend" is fine).
// Direct-child count is a stable, non-compounding proxy.
export const CHARGE_CONTAINER_PER_CHILD = -200; // repulsion per direct child
export const CHARGE_CONTAINER_MIN       = -1500; // floor — keeps tiny containers from being too weak

// Leaf / regular nodes. Kept modest — spacing is mostly done by COLLISION now,
// not long-range charge, to reduce shaking (see CHARGE_DISTANCE_MAX).
// A connected node's repulsion scales with its degree (number of incident visible
// semantic edges, in + out): -degree × CHARGE_PER_EDGE. So hubs clear more space
// around themselves while leaf nodes stay light. A degree-1 node repels at exactly
// CHARGE_PER_EDGE.
export const CHARGE_PER_EDGE         = -2000; // repulsion added per incident visible edge
export const CHARGE_ISOLATED         = -80;  // node with no visible edges (gentler; it has nowhere to go)

// Cap the range of charge (px). forceManyBody is inverse-square and by default
// touches every node, so a move anywhere ripples everywhere → global jitter.
// Limiting the range makes charge a *local* separator; collision does the rest.
export const CHARGE_DISTANCE_MAX     = 3920;

// Link force — spring between connected nodes.
export const LINK_DIST_PARENT        = 1360;  // rest length for parent → child links (px)
export const LINK_DIST_EDGE          = 1580;  // rest length for semantic edges (px)
export const LINK_STRENGTH_PARENT    = 0.001;  // spring stiffness for parent → child (0 = loose, 1 = rigid)
export const LINK_STRENGTH_EDGE      = 0.00; // spring stiffness for exposed semantic edges
// Unexposed edges (focus active, neither endpoint focused) still pull, but only
// weakly — enough to keep the graph loosely coherent while the focused subgraph
// dominates the layout. This is the point of focus mode.
export const LINK_STRENGTH_UNEXPOSED = 0.01;

// Collision — the primary spacing force now. More iterations = firmer, less
// squishy separation (nodes settle apart instead of oscillating through).
export const COLLISION_RADIUS        = 135;   // exclusion radius for regular nodes (px)
export const COLLISION_ITERATIONS    = 3;

// Friction: fraction of velocity *kept* each tick is (1 − velocityDecay). Higher
// decay = more damping = less ringing/shaking. D3 default 0.4; we run heavier.
export const VELOCITY_DECAY          = 0.7;

// Grouped collision. Elements collide only within their sibling group (same
// parent = same LoD): a leaf/collapsed node is a circle of COLLISION_RADIUS, an
// expanded container is a circle (containerRadius) around its box that represents
// its whole subtree to the parent group. This is what d3.forceCollide can't do
// (it's global). Strength = fraction of the overlap resolved per tick (soft, like
// forceCollide); higher = firmer, riskier to jitter.
export const COLLIDE_STRENGTH        = 0.7;
// Extra clearance folded into a container's collision radius, so its neighbours
// are kept off the perimeter, not just out of the box.
export const CONTAINER_MARGIN        = 24;

// ─── Cola (WebCola) constraint-layout engine ─────────────────────────────────
// Alternative layout engine (toggle with the engine keybinding). Constraint /
// stress based rather than force based: it minimises a stress function subject
// to non-overlap + (optional) directed-layering constraints, which yields far
// fewer edge crossings than the force sim. See layout-cola.js.
export const COLA_NODE_PAD           = 24;  // px added around each box for non-overlap spacing
export const COLA_LINK_LENGTH        = 90;  // ideal link length fed to jaccardLinkLengths
export const COLA_LINK_LENGTH_JACCARD = 0.7; // jaccard neighbourhood-overlap weighting (0..1)
export const COLA_FLOW_GAP           = 60;  // min vertical separation for directed edges (flowLayout)
// Iteration budget for the synchronous solve: [unconstrained, user-constraint,
// all-constraint]. More = tidier but slower. The spike hit ~72 crossings at 30/30/60.
export const COLA_ITERS              = [30, 30, 60];
// Animation duration (ms) for tweening nodes from old positions to the solved
// layout after a (re)solve. A full relayout uses the longer end.
export const COLA_ANIM_MS_FULL       = 550;
export const COLA_ANIM_MS_GENTLE     = 320;

// Edge labels as first-class Cola nodes: each annotated edge gets a dummy node
// sized to its text and routed source→label→target, so avoidOverlaps keeps
// labels clear of nodes and of each other. Size = text metrics (approx).
export const COLA_LABEL_CHAR_W       = 6.2; // px per annotation character (monospace ~11px)
export const COLA_LABEL_H            = 16;  // label box height (px)
export const COLA_LABEL_PAD          = 10;  // extra clearance around a label box
// After solving, each label is snapped onto its edge segment so it reads as
// belonging to that edge. It's kept within this fraction of the edge centred on
// the midpoint (0.3 → allowed between 35% and 65% along the edge), at the point
// nearest where the solver placed it (which spreads crossing labels apart), then
// nudged this many px perpendicular to the line so the edge doesn't strike
// through the text.
export const COLA_LABEL_MID_BAND     = 0.34; // central fraction of the edge a label may sit in
export const COLA_LABEL_OFFSET       = 30;    // perpendicular offset off the line (px)

// Radial ("center → outward") mode. The layered solve is polar-remapped: layer
// depth → radius, in-layer position → angle. The fan spans this fraction of a
// full turn (leaving a gap so the two ends don't collide).
export const COLA_RADIAL_SPAN        = 0.92; // × 2π

// Centering — weak gravity toward the viewport centre to prevent the graph
// from drifting off-screen during long sessions.
export const CENTER_STRENGTH         = 0.0015;

// Label pull — custom force that moves each phantom label node toward the
// midpoint of its edge's border endpoints on every simulation tick.
// 0 = no pull, 1 = teleport instantly to midpoint. Kept gentle — a strong pull
// adds a big velocity kick every tick and makes labels (and their edges) jitter.
export const LABEL_PULL_STRENGTH     = 0.35;

// Alpha decay — controls how quickly the simulation cools and stops.
// D3's default is ~0.0228.  A slightly higher value makes the layout settle
// faster at the cost of a less thorough search of the energy landscape.
export const ALPHA_DECAY             = 0.025;

// Zone forces — per-node attraction toward a named screen zone (top, left, …).
// Applied on top of the global centering force when a node has zone: set.
export const ZONE_STRENGTH           = 0.01;

// Children of a pinned parent are pulled toward the parent's pin (in place of the
// viewport-center gravity), so an expanded container's contents stay clustered on
// the pin instead of drifting toward centre. The parent-child link handles the
// rest; this just keeps them anchored to the right spot.
export const PARENT_PIN_STRENGTH     = 0.10;

// Fit-to-screen padding when centering the graph after load.
export const CENTER_PAD              = 120;  // px around the bounding box of root nodes
// Scale factor applied after fitting — keeps a margin around the graph.
export const CENTER_FIT_MARGIN       = 0.60;

// ─── LOD / expand-collapse ────────────────────────────────────────────────────

// Jitter applied to newly revealed child nodes so they don't stack exactly
// on top of their parent before the simulation spreads them apart.
export const EXPAND_JITTER           = 20;   // ± half this value (px)

// Phantom label node collision radius — grows with annotation text length so
// longer labels claim more space.
export const LABEL_RADIUS_MIN        = 20;   // minimum radius (px)
export const LABEL_RADIUS_PER_CHAR   = 3.5;  // added radius per annotation character

// ─── Container / ghost rendering ──────────────────────────────────────────────

// Padding inside a container box around the bounding rect of its descendants.
export const CONTAINER_PAD           = 36;   // px on all sides except top (where the label lives)
export const CONTAINER_LABEL_H       = 22;   // px reserved at the top for the container label text

// ─── Zoom ──────────────────────────────────────────────────────────────────────

// Fraction of wheel deltaY (pixels) converted to a zoom step each scroll tick.
// Higher = faster zoom.  0.001 is the D3 default for pixel-mode scroll events
// (the typical trackpad mode).  Line-mode and page-mode events are scaled by
// separate fixed factors (0.05 and 1.0) that don't need tuning.
export const ZOOM_SENSITIVITY        = 0.005;
export const ZOOM_MIN                = 0.05; // minimum zoom scale (most zoomed out)
export const ZOOM_MAX                = 20;   // maximum zoom scale (most zoomed in)

// ─── Interaction ──────────────────────────────────────────────────────────────

// Accumulated scroll (wheel deltaY, px) required to trigger one expand or
// collapse step on a node.  Higher = less sensitive scroll wheel.
export const SCROLL_THRESHOLD        = 150;

// Minimum pointer travel (px, in SVG space) before a mousedown-move-mouseup
// sequence is treated as a drag rather than a click.  Below this threshold the
// node does not move and the simulation is not heated, so the click handler
// fires cleanly.
export const DRAG_THRESHOLD          = 4;

// Delay (ms) between a mousedown and the decision that it was a single click
// rather than the first half of a double-click.
export const CLICK_DEBOUNCE_MS       = 220;

// ─── Focus / edge exposure ─────────────────────────────────────────────────────

// Edges are faded and force-inactive by default (focus mode always on).
// Exception: if the number of visible semantic edges is at most this multiple
// of the visible node count, the graph is considered "sparse" and all edges
// are exposed automatically — no clicking needed.
// Set to 1.0 to match the original "edges ≤ nodes" threshold, or 0 to disable.
export const SPARSE_EDGE_RATIO       = 0.5;

// Reheat energy when toggling/clearing focus. Focus is triggered by a deliberate
// Alt+click and changes which edges pull, so a gentle relayout is wanted (and
// accidental plain clicks no longer trigger it). Lower = calmer settle.
export const FOCUS_REHEAT_ALPHA      = 0.3;

// ─── Nested (included) maps ─────────────────────────────────────────────────

// Nested nodes keep their inner map's layout, recentred on the mount node and
// scaled down by this factor so a large subproject map becomes a compact cluster
// inside the mount container. 1 = original size.
export const NESTED_SCALE            = 0.35;

// ─── Focus / edge exposure (continued) ──────────────────────────────────────
