// ─── Node box dimensions ───────────────────────────────────────────────────────

export const NODE_W    = 140;  // level-0 node width  (px, SVG space)
export const NODE_H    = 44;   // level-0 node height
export const NODE_W_SM = 110;  // level-1+ node width
export const NODE_H_SM = 32;   // level-1+ node height

// ─── Force simulation ──────────────────────────────────────────────────────────
// Charge (repulsion) — forceManyBody strength values are negative.
//
// NOTE: parameters marked "(live)" are `export let` so the config panel
// (config.js → setTunable) can override them at runtime; importers reading them
// inside functions pick up the new value on the next layout. Add a `case` to
// setTunable() at the bottom when exposing another parameter.

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
export let   CHARGE_CONTAINER_PER_CHILD = -200; // repulsion per direct child (live)
export let   CHARGE_CONTAINER_MIN       = -1500; // floor — keeps tiny containers from being too weak (live)

// Leaf / regular nodes. Kept modest — spacing is mostly done by COLLISION now,
// not long-range charge, to reduce shaking (see CHARGE_DISTANCE_MAX).
// A connected node's repulsion scales with its degree (number of incident visible
// semantic edges, in + out): -degree × CHARGE_PER_EDGE. So hubs clear more space
// around themselves while leaf nodes stay light. A degree-1 node repels at exactly
// CHARGE_PER_EDGE.
export let   CHARGE_PER_EDGE         = -500; // repulsion added per incident visible edge (live)
export let   CHARGE_ISOLATED         = -80;  // node with no visible edges (gentler; it has nowhere to go) (live)

// Cap the range of charge (px). forceManyBody is inverse-square and by default
// touches every node, so a move anywhere ripples everywhere → global jitter.
// Limiting the range makes charge a *local* separator; collision does the rest.
export let   CHARGE_DISTANCE_MAX     = 920; // (live)

// Link force — spring between connected nodes.
export let   LINK_DIST_PARENT        = 360;  // rest length for parent → child links (px) (live)
export let   LINK_DIST_EDGE          = 580;  // rest length for semantic edges (px) (live)
export let   LINK_STRENGTH_PARENT    = 0.0001;  // spring stiffness for parent → child (0 = loose, 1 = rigid) (live)
export let   LINK_STRENGTH_EDGE      = 0.0001; // spring stiffness for exposed semantic edges (live)
// Unexposed edges (focus active, neither endpoint focused) still pull, but only
// weakly — enough to keep the graph loosely coherent while the focused subgraph
// dominates the layout. This is the point of focus mode.
export let   LINK_STRENGTH_UNEXPOSED = 0.01; // (live)

// Collision — the primary spacing force now. More iterations = firmer, less
// squishy separation (nodes settle apart instead of oscillating through).
export let   COLLISION_RADIUS        = 105;   // exclusion radius for regular nodes (px) (live)
export let   COLLISION_ITERATIONS    = 3; // (live)

// Friction: fraction of velocity *kept* each tick is (1 − velocityDecay). Higher
// decay = more damping = less ringing/shaking. D3 default 0.4; we run heavier.
export let   VELOCITY_DECAY          = 0.7; // (live)

// Grouped collision. Elements collide only within their sibling group (same
// parent = same LoD): a leaf/collapsed node is a circle of COLLISION_RADIUS, an
// expanded container is a circle (containerRadius) around its box that represents
// its whole subtree to the parent group. This is what d3.forceCollide can't do
// (it's global). Strength = fraction of the overlap resolved per tick (soft, like
// forceCollide); higher = firmer, riskier to jitter.
export let   COLLIDE_STRENGTH        = 0.4; // (live)
// Extra clearance folded into a container's collision radius, so its neighbours
// are kept off the perimeter, not just out of the box.
export let   CONTAINER_MARGIN        = 24; // (live)

// ─── Cola (WebCola) constraint-layout engine ─────────────────────────────────
// Alternative layout engine (toggle with the engine keybinding). Constraint /
// stress based rather than force based: it minimises a stress function subject
// to non-overlap + (optional) directed-layering constraints, which yields far
// fewer edge crossings than the force sim. See layout-cola.js.
export let   COLA_NODE_PAD           = 60;  // px added around each box for non-overlap spacing (live)
export let   COLA_LINK_LENGTH        = 360;  // ideal link length fed to jaccardLinkLengths (live)
export let   COLA_LINK_LENGTH_JACCARD = 0.7; // jaccard neighbourhood-overlap weighting (0..1) (live)
export let   COLA_FLOW_GAP           = 60;  // min vertical separation for directed edges (flowLayout) (live)
// Iteration budget for the synchronous solve: [unconstrained, user-constraint,
// all-constraint]. More = tidier but slower. The spike hit ~72 crossings at 30/30/60.
export const COLA_ITERS              = [30, 30, 60];
// Animation duration (ms) for tweening nodes from old positions to the solved
// layout after a (re)solve. A full relayout uses the longer end.
export let   COLA_ANIM_MS_FULL       = 550; // (live)
export let   COLA_ANIM_MS_GENTLE     = 320; // (live)

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
export let   COLA_LABEL_MID_BAND     = 0.34; // central fraction of the edge a label may sit in (live)
export let   COLA_LABEL_OFFSET       = 30;    // perpendicular offset off the line (px) (live)

// Radial ("center → outward") mode. The layered solve is polar-remapped: layer
// depth → radius, in-layer position → angle. The fan spans this fraction of a
// full turn (leaving a gap so the two ends don't collide).
export let   COLA_RADIAL_SPAN        = 0.92; // × 2π (live)

// Centering — weak gravity toward the viewport centre to prevent the graph
// from drifting off-screen during long sessions.
export let   CENTER_STRENGTH         = 0.0015; // (live)

// Label pull — custom force that moves each phantom label node toward the
// midpoint of its edge's border endpoints on every simulation tick.
// 0 = no pull, 1 = teleport instantly to midpoint. Kept gentle — a strong pull
// adds a big velocity kick every tick and makes labels (and their edges) jitter.
export let   LABEL_PULL_STRENGTH     = 0.35; // (live)

// How firmly an edge label is pushed out of a container box it doesn't belong to
// (its edge is fully outside that container). Labels don't affect container size,
// so this can't feed the growth loop. Gentle, to avoid jitter fighting label-pull.
export let   LABEL_DECLUTTER_STRENGTH = 0.3; // (live)

// Alpha decay — controls how quickly the simulation cools and stops.
// D3's default is ~0.0228.  A slightly higher value makes the layout settle
// faster at the cost of a less thorough search of the energy landscape.
export let   ALPHA_DECAY             = 0.025; // (live)

// Zone forces — per-node attraction toward a named screen zone (top, left, …).
// Applied on top of the global centering force when a node has zone: set.
export let   ZONE_STRENGTH           = 0.01; // (live)

// Children of a pinned parent are pulled toward the parent's pin (in place of the
// viewport-center gravity), so an expanded container's contents stay clustered on
// the pin instead of drifting toward centre. The parent-child link handles the
// rest; this just keeps them anchored to the right spot.
export let   PARENT_PIN_STRENGTH     = 0.10; // (live)

// Fit-to-screen padding when centering the graph after load.
export let   CENTER_PAD              = 120;  // px around the bounding box of root nodes (live)
// Scale factor applied after fitting — keeps a margin around the graph.
export let   CENTER_FIT_MARGIN       = 0.60; // (live)

// ─── LOD / expand-collapse ────────────────────────────────────────────────────

// Jitter applied to newly revealed child nodes so they don't stack exactly
// on top of their parent before the simulation spreads them apart.
export let   EXPAND_JITTER           = 20;   // ± half this value (px) (live)

// Phantom label node collision radius — grows with annotation text length so
// longer labels claim more space.
export let   LABEL_RADIUS_MIN        = 20;   // minimum radius (px) (live)
export let   LABEL_RADIUS_PER_CHAR   = 3.5;  // added radius per annotation character (live)

// ─── Container / ghost rendering ──────────────────────────────────────────────

// Padding inside a container box around the bounding rect of its descendants.
export let   CONTAINER_PAD           = 36;   // px on all sides except top (where the label lives) (live)
export let   CONTAINER_LABEL_H       = 22;   // px reserved at the top for the container label text (live)

// ─── Parallel edges ────────────────────────────────────────────────────────────
// Perpendicular spacing between adjacent edges that connect the same pair of
// nodes. Multi-edges fan into curves offset by this step so they don't overlap.
// 0 disables the fan (all parallels collapse back onto one straight line).
export let   EDGE_PARALLEL_GAP       = 22; // px between adjacent parallel edges (live)

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
export let   SPARSE_EDGE_RATIO       = 0.5; // (live)

// Reheat energy when toggling/clearing focus. Focus is triggered by a deliberate
// Alt+click and changes which edges pull, so a gentle relayout is wanted (and
// accidental plain clicks no longer trigger it). Lower = calmer settle.
export let   FOCUS_REHEAT_ALPHA      = 0.3; // (live)

// Opacity of a dim/unfocused edge (focus active, this edge's endpoints aren't
// focused, and the graph isn't sparse). 0 = invisible, 1 = same as an exposed
// edge (defeats the point of focus mode). Set on the edge-visual group in
// rerenderEdges (render.js).
export let   DIM_EDGE_OPACITY        = 0.1; // (live)

// ─── Nested (included) maps ─────────────────────────────────────────────────

// Nested nodes keep their inner map's layout, recentred on the mount node and
// scaled down by this factor so a large subproject map becomes a compact cluster
// inside the mount container. 1 = original size.
export const NESTED_SCALE            = 0.35;

// ─── Live-tunable overrides (config panel) ───────────────────────────────────
// The values above are DEFAULTS. Parameters marked "(live)" are `export let` so
// the config panel (config.js) can override them at runtime — importers reading
// them inside functions pick up the new value on the next layout, no other code
// changes needed. Only the declaring module may reassign its own `let`s, so the
// setter lives here. Add a `case` when exposing another parameter in the panel.
export function setTunable(key, value) {
  switch (key) {
    // charge / force
    case 'CHARGE_PER_EDGE':          CHARGE_PER_EDGE          = value; break;
    case 'CHARGE_ISOLATED':          CHARGE_ISOLATED          = value; break;
    case 'CHARGE_CONTAINER_PER_CHILD': CHARGE_CONTAINER_PER_CHILD = value; break;
    case 'CHARGE_CONTAINER_MIN':     CHARGE_CONTAINER_MIN     = value; break;
    case 'CHARGE_DISTANCE_MAX':      CHARGE_DISTANCE_MAX      = value; break;
    // links
    case 'LINK_DIST_PARENT':         LINK_DIST_PARENT         = value; break;
    case 'LINK_DIST_EDGE':           LINK_DIST_EDGE           = value; break;
    case 'LINK_STRENGTH_PARENT':     LINK_STRENGTH_PARENT     = value; break;
    case 'LINK_STRENGTH_EDGE':       LINK_STRENGTH_EDGE       = value; break;
    case 'LINK_STRENGTH_UNEXPOSED':  LINK_STRENGTH_UNEXPOSED  = value; break;
    // collision / spacing
    case 'COLLISION_RADIUS':         COLLISION_RADIUS         = value; break;
    case 'COLLISION_ITERATIONS':     COLLISION_ITERATIONS     = value; break;
    case 'COLLIDE_STRENGTH':         COLLIDE_STRENGTH         = value; break;
    case 'CONTAINER_MARGIN':         CONTAINER_MARGIN         = value; break;
    case 'VELOCITY_DECAY':           VELOCITY_DECAY           = value; break;
    // gravity / anchors
    case 'CENTER_STRENGTH':          CENTER_STRENGTH          = value; break;
    case 'ZONE_STRENGTH':            ZONE_STRENGTH            = value; break;
    case 'PARENT_PIN_STRENGTH':      PARENT_PIN_STRENGTH      = value; break;
    case 'ALPHA_DECAY':              ALPHA_DECAY              = value; break;
    // labels
    case 'LABEL_PULL_STRENGTH':      LABEL_PULL_STRENGTH      = value; break;
    case 'LABEL_DECLUTTER_STRENGTH': LABEL_DECLUTTER_STRENGTH = value; break;
    case 'LABEL_RADIUS_MIN':         LABEL_RADIUS_MIN         = value; break;
    case 'LABEL_RADIUS_PER_CHAR':    LABEL_RADIUS_PER_CHAR    = value; break;
    // cola
    case 'COLA_NODE_PAD':            COLA_NODE_PAD            = value; break;
    case 'COLA_LINK_LENGTH':         COLA_LINK_LENGTH         = value; break;
    case 'COLA_LINK_LENGTH_JACCARD': COLA_LINK_LENGTH_JACCARD = value; break;
    case 'COLA_FLOW_GAP':            COLA_FLOW_GAP            = value; break;
    case 'COLA_LABEL_OFFSET':        COLA_LABEL_OFFSET        = value; break;
    case 'COLA_LABEL_MID_BAND':      COLA_LABEL_MID_BAND      = value; break;
    case 'COLA_RADIAL_SPAN':         COLA_RADIAL_SPAN         = value; break;
    case 'COLA_ANIM_MS_FULL':        COLA_ANIM_MS_FULL        = value; break;
    case 'COLA_ANIM_MS_GENTLE':      COLA_ANIM_MS_GENTLE      = value; break;
    // container / fit
    case 'CONTAINER_PAD':            CONTAINER_PAD            = value; break;
    case 'CONTAINER_LABEL_H':        CONTAINER_LABEL_H        = value; break;
    case 'CENTER_PAD':               CENTER_PAD               = value; break;
    case 'CENTER_FIT_MARGIN':        CENTER_FIT_MARGIN        = value; break;
    case 'EXPAND_JITTER':            EXPAND_JITTER            = value; break;
    // focus
    case 'SPARSE_EDGE_RATIO':        SPARSE_EDGE_RATIO        = value; break;
    case 'FOCUS_REHEAT_ALPHA':       FOCUS_REHEAT_ALPHA       = value; break;
    case 'DIM_EDGE_OPACITY':         DIM_EDGE_OPACITY         = value; break;
    case 'EDGE_PARALLEL_GAP':        EDGE_PARALLEL_GAP        = value; break;
    default: return false; // not a live-tunable key
  }
  return true;
}
