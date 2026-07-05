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

// Expanded container nodes: repulsion scales with √(w × h) so the force
// reaches to the container's border regardless of how large it grows.
export const CHARGE_CONTAINER_SCALE  = 22;   // multiplied by √(w × h)
export const CHARGE_CONTAINER_MIN    = 3000; // floor — prevents very small containers from being too weak
export const CHARGE_CONTAINER_FALLBACK = 150; // assumed footprint (px) when containerBounds is not yet available

// Leaf / regular nodes.
export const CHARGE_CONNECTED        = -700; // node with at least one visible edge
export const CHARGE_ISOLATED         = -70;  // node with no visible edges (gentler; it has nowhere to go)

// Link force — spring between connected nodes.
export const LINK_DIST_PARENT        = 160;  // rest length for parent → child links (px)
export const LINK_DIST_EDGE          = 280;  // rest length for semantic edges (px)
export const LINK_STRENGTH_PARENT    = 0.5;  // spring stiffness for parent → child (0 = loose, 1 = rigid)
export const LINK_STRENGTH_EDGE      = 0.25; // spring stiffness for semantic edges

// Collision — keeps nodes from overlapping.
export const COLLISION_RADIUS        = 90;   // exclusion radius for regular nodes (px)

// Centering — weak gravity toward the viewport centre to prevent the graph
// from drifting off-screen during long sessions.
export const CENTER_STRENGTH         = 0.015;

// Label pull — custom force that moves each phantom label node toward the
// midpoint of its edge's border endpoints on every simulation tick.
// 0 = no pull, 1 = teleport instantly to midpoint.
export const LABEL_PULL_STRENGTH     = 0.9;

// Alpha decay — controls how quickly the simulation cools and stops.
// D3's default is ~0.0228.  A slightly higher value makes the layout settle
// faster at the cost of a less thorough search of the energy landscape.
export const ALPHA_DECAY             = 0.125;

// Zone forces — per-node attraction toward a named screen zone (top, left, …).
// Applied on top of the global centering force when a node has zone: set.
export const ZONE_STRENGTH           = 0.08;

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
export const SPARSE_EDGE_RATIO       = 1.0;
