# vgraphtree — Design Document

> A locally-hosted, zoomable mind map for understanding and navigating codebases.
> This document captures all design decisions, architecture choices, data models, and the step-by-step prototype build plan.

---

## 1. What Is vgraphtree?

vgraphtree is a local web application that lets you build and explore a multi-level visual map of a codebase. The map is made of **nodes** (logical components at different levels of abstraction) connected by **annotated edges** (arrows with human-authored labels).

The core interaction is **zoom**: as you zoom in, nodes reveal their constituent sub-components. Zoom further and you eventually reach real symbols — functions, types, methods — drawn from the codebase via LSP. At the deepest level, clicking a node opens a read-only code panel showing the actual source lines.

The tool is not a code browser. It is a **semantic map** — the primary output is a spatial understanding of a codebase that no automated tool can generate alone, because it requires the developer's own conceptual model.

---

## 2. Core Design Decisions

### 2.1 Zoom model

- **Continuous zoom** via D3's `d3.zoom()`, which gives a real-valued scale `k`.
- **Semantic snap points** at configurable `k` thresholds (e.g. `[0.4, 1.2, 3.0, 8.0]`). Crossing a threshold triggers a level-of-detail (LOD) transition.
- Snap thresholds affect *what is visible*, not the zoom position itself — the viewport does not jump.
- **Children float up** out of their parent as you zoom in: child nodes start inside the parent's bounding box at near-zero opacity/scale, and animate outward as `k` increases past the threshold.
- **Edges morph** across zoom levels. Edges are stored as logical references (`from_id → to_id`), never as pixel paths. SVG paths are re-derived at render time from the current positions and visible LOD. A high-level edge (`ModuleA → ModuleB`) resolves into sub-edges between files, then functions, as zoom increases.

### 2.2 Node creation

- **Top-level nodes are manually authored** — either in the UI or directly in the YAML config file.
- **LSP-derived nodes** (Phase 2) appear as visual "ghost" nodes. They are not written to config until the user explicitly accepts them.
- **The key mid-level creative act**: lasso-select a group of LSP-discovered symbols → name the group → that grouping is written to config as a named mid-level node. Its children remain ephemeral (always re-derived from LSP); the grouping itself is permanently authored.

### 2.3 Position model — three tiers

| Tier | YAML entry | D3 behaviour | Written when |
|------|-----------|--------------|--------------|
| **Pinned** | `pin: {x: 240, y: 180}` | `node.fx = x, node.fy = y` — immovable | Shift+drag → save |
| **Anchored** | `zone: bottom-right` | `forceX/forceY` with low strength (~0.05) — gravity well | Manually authored in YAML |
| **Free** | *(absent)* | Standard charge/link forces — settles by topology | Never |

Dragging a node without Shift is temporary — the node returns to simulation on release. Shift+drag pins it; the coordinates are written to YAML on next save (Ctrl+S).

### 2.4 Persistence — explicit save, YAML source of truth

- The **YAML config file** is the only thing written to disk. It is checked into the repo.
- The **in-memory graph** (owned by the Rust backend) is rebuilt from YAML on startup and mutated by UI actions.
- **Ctrl+S** triggers an atomic write: Rust serialises the in-memory graph to a YAML string, writes to a `.tmp` file, then renames it atomically.
- A **dirty flag** tracks unsaved changes. It is visible in the browser UI (e.g. a dot in the title bar).
- Viewport state (zoom `k`, pan `x/y`, selected node, open panel) is **never persisted**.

### 2.5 Config growth control

Four mechanisms prevent the config file from becoming unmanageable:

1. **`depth_ceiling`**: Only nodes up to a configured depth level are written to config. Deeper nodes (individual functions, lines) are always derived from LSP at runtime. Configurable per project.
2. **LSP nodes are ephemeral until pinned**: Ghost nodes never enter config until the user explicitly accepts them. Accepted suggestions write a minimal entry (id, source binding, optional label override).
3. **Positions only stored when pinned**: Unpinned nodes get their position from the force simulation every session. No coordinates in config = no coordinates to go stale.
4. **Future: `vgraphtree check` CLI command**: Warns about dead `source:` paths after file renames. Keeps config from accumulating stale entries.

### 2.6 YAML over TOML

YAML was chosen over TOML for the config format because:
- Nested node hierarchies read naturally as indented blocks in YAML; TOML requires verbose `[node.parent.child.grandchild]` table paths for the same structure.
- Multiline annotation strings are cleaner with YAML block scalars (`|`).
- YAML anchors (`&anchor` / `*alias`) allow shared property references without duplication.
- The Rust ecosystem supports YAML well via `serde_yaml`.

**Note**: Quote any values that could be ambiguous (e.g. two-letter country codes like `NO`) to avoid YAML's boolean coercion edge cases.

---

## 3. Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Backend | Rust (Axum + Tokio) | Lightweight, fast startup, safe file I/O, good LSP crate ecosystem |
| Frontend | Vanilla JS + D3.js | D3's zoom transform is the right primitive; no framework overhead needed |
| Config format | YAML (`serde_yaml`) | Hierarchical structure, human-readable, repo-friendly |
| LSP (Phase 2) | `lsp-types` crate | JSON-RPC serialisation for rust-analyzer / pyright / marksman |
| No database | — | In-memory only; YAML is the store |

The app runs as a local HTTP server (default port `7777`). The browser opens `index.html` served from the `static/` directory.

---

## 4. What Belongs in Config vs What Doesn't

### Belongs in YAML config

- Manually named high-level and mid-level nodes (id, label, level, parent)
- Source path bindings (`source: src/auth/`)
- Manual edges with annotations
- Pinned node positions (`pin: {x, y}`)
- Anchored node zones (`zone: bottom-right`)
- `origin` flag distinguishing manual nodes from LSP-accepted ones (`origin: manual | lsp`)
- Project-level settings: root path, LSP commands, snap thresholds, depth ceiling
- LSP-accepted suggestions (minimal entry only — after user confirmation)

### Does NOT belong in config

- Auto-layout positions for free/unpinned nodes (recomputed by force simulation each session)
- LSP-derived nodes and edges (until user-confirmed)
- Symbol-level detail below the depth ceiling (functions, types — always read from LSP/code)
- Viewport state (zoom, pan, selected node)
- File content (never stored; always read from disk on demand)
- Render cache (edge SVG paths, D3 node positions — derived at runtime)

---

## 5. YAML Config Schema

```yaml
# vgraphtree.yaml — only manually authored / confirmed content

project:
  root: "."
  lsp:
    rust: "rust-analyzer"
    python: "pyright"
    markdown: "marksman"
  snap_levels: [0.4, 1.2, 3.0, 8.0]   # zoom k thresholds for LOD transitions
  depth_ceiling: 2                      # max node level written to config (0-indexed)

nodes:
  auth_service:
    label: "Auth service"
    level: 0                            # 0 = top-level
    source: "src/auth/"
    origin: manual
    pin: { x: 240, y: 180 }            # explicit pin — written on Shift+drag + save
    children:
      token_validator:
        label: "Token validator"
        level: 1
        source: "src/auth/token.rs"
        origin: manual
        # no pin — force-directed within parent bounds

      session_store:
        label: "Session store"
        level: 1
        source: "src/auth/session.rs"
        origin: manual

  database:
    label: "Database layer"
    level: 0
    source: "src/db/"
    origin: manual
    zone: "bottom"                     # soft anchor — gravity well, not fixed point

  api_gateway:
    label: "API gateway"
    level: 0
    source: "src/api/"
    origin: manual
    pin: { x: 340, y: 80 }

edges:
  - id: auth_to_db
    from: auth_service
    to: database
    annotation: "reads user records on login"
    levels: [0, 1]                     # visible at these LOD levels
    origin: manual

  - id: gateway_to_auth
    from: api_gateway
    to: auth_service
    annotation: "validates bearer token"
    levels: [0]
    origin: manual
```

**Key schema rules:**
- Nodes are a nested map keyed by ID. Children are nested under their parent's `children:` key.
- `level` is redundant with nesting depth but explicit — makes runtime queries simpler.
- `origin: manual | lsp` lets LSP re-discovery avoid clobbering manually placed nodes.
- `levels: [0, 1]` on edges controls at which LOD levels the edge is drawn.
- No pixel coordinates for edge routing — paths are always derived at render time.
- `depth_ceiling` in project config sets the maximum level that will ever be written here; everything deeper is always runtime-only.

---

## 6. Rust Data Structures

```rust
// Core graph types (in-memory, rebuilt from YAML on startup)

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub label: String,
    pub level: u32,
    pub parent: Option<String>,
    pub source: Option<String>,          // path to file or directory
    pub origin: Origin,
    pub pin: Option<Position>,           // Some = pinned, None = force-directed
    pub zone: Option<Zone>,              // soft anchor zone
    pub children: Vec<String>,           // child IDs (populated at load time)
    pub bounds: Option<Rect>,            // bounding box (computed, not stored)
    pub dirty: bool,                     // has unsaved changes
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub annotation: Option<String>,
    pub levels: Vec<u32>,
    pub origin: Origin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Origin {
    Manual,
    Lsp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Zone {
    Top, Bottom, Left, Right,
    TopLeft, TopRight, BottomLeft, BottomRight,
    Center,
}

pub struct NodeGraph {
    pub nodes: HashMap<String, Node>,
    pub edges: HashMap<String, Edge>,
    pub dirty: bool,                     // any unsaved changes in the graph
}

// Project-level config (top of YAML)
#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectConfig {
    pub root: PathBuf,
    pub lsp: HashMap<String, String>,    // language → LSP command
    pub snap_levels: Vec<f64>,
    pub depth_ceiling: u32,
}
```

---

## 7. HTTP API Surface

All endpoints served by the Axum backend. The frontend is a single `index.html` + JS bundle served from `static/`.

| Method | Path | Body / Params | Response | Notes |
|--------|------|---------------|----------|-------|
| `GET` | `/ping` | — | `"ok"` | Health check |
| `GET` | `/graph` | — | Full graph JSON | Nodes + edges, used on startup |
| `PATCH` | `/node/:id` | `{label?, pin?, zone?}` | `200 OK` | Mutates in-memory node; sets dirty flag |
| `PATCH` | `/edge/:id` | `{annotation?, levels?}` | `200 OK` | Mutates in-memory edge; sets dirty flag |
| `POST` | `/node` | `{id, label, level, parent?, source?}` | `201 Created` | Creates new node |
| `POST` | `/edge` | `{id, from, to, annotation?, levels?}` | `201 Created` | Creates new edge |
| `DELETE` | `/node/:id` | — | `200 OK` | Removes node and its edges |
| `POST` | `/save` | — | `200 OK` | Atomically writes in-memory graph to YAML |
| `GET` | `/file` | `?path=...&start=N&end=M` | `{lines: [...]}` | Returns source lines for code panel |
| `GET` | `/status` | — | `{dirty: bool}` | Dirty flag state |

**WebSocket** (Phase 2): `/ws` — used for LSP event push (new symbol suggestions, reference changes).

**Key API rules:**
- `PATCH` endpoints accept partial updates (only fields present in the body are changed).
- `/save` does an atomic write: serialize to string → write to `vgraphtree.yaml.tmp` → `rename()` to `vgraphtree.yaml`.
- `/file` is read-only and stateless. File content is never cached server-side.
- The backend never pushes unsolicited updates to the frontend in Phase 1 (no WebSocket needed until LSP).

---

## 8. Frontend Architecture

### Canvas setup

```javascript
// Root SVG with D3 zoom
const svg = d3.select('#canvas');
const root = svg.append('g').attr('id', 'root'); // all content under this g

const zoom = d3.zoom()
  .scaleExtent([0.05, 20])
  .on('zoom', (event) => {
    root.attr('transform', event.transform);
    handleLOD(event.transform.k);
  });

svg.call(zoom);
```

### LOD (Level of Detail) system

```javascript
const SNAP_LEVELS = [0.4, 1.2, 3.0, 8.0]; // from project config

function getLODLevel(k) {
  // Returns 0 (system), 1 (module), 2 (file), 3 (symbol)
  return SNAP_LEVELS.filter(threshold => k >= threshold).length;
}

function handleLOD(k) {
  const level = getLODLevel(k);
  if (level === currentLOD) return;
  currentLOD = level;
  transitionToLOD(level);
}

function transitionToLOD(targetLevel) {
  // Reveal nodes at targetLevel: animate opacity 0→1, scale 0.5→1
  // Hide nodes above targetLevel: animate opacity 1→0
  // Re-derive edge paths for currently visible nodes
}
```

### Node rendering

- Nodes are `<g>` elements containing a `<rect>` and `<text>`.
- Each node has a `data-level` attribute used for LOD filtering.
- Child nodes start positioned inside their parent's bounding box, then float to their own positions as zoom reveals them.
- D3's force simulation only applies to **free** (unpinned, unanchored) nodes.

### Edge rendering

Edges are never stored as pixel paths. On each LOD transition and on each frame when nodes are in motion:

```javascript
function deriveEdgePath(edge, nodes) {
  // Find the most specific visible endpoints for this edge
  // at the current LOD level
  const fromNode = getMostSpecificVisible(edge.from, currentLOD, nodes);
  const toNode   = getMostSpecificVisible(edge.to,   currentLOD, nodes);

  if (!fromNode || !toNode) return null; // edge not visible at this level

  // Return SVG path string (straight line for Phase 1, curved for later)
  return `M ${fromNode.cx} ${fromNode.cy} L ${toNode.cx} ${toNode.cy}`;
}
```

### State managed in the frontend (never sent to backend)

- Current zoom `k` and pan `x/y`
- Current LOD level
- Selected node ID
- Whether the code panel is open, and which node it shows
- Render cache: derived edge paths, computed node positions from D3 simulation
- Unsaved position changes for unpinned (temporary drag) nodes

### State managed by backend (sent to frontend on request)

- All nodes with their labels, levels, parents, sources
- All edges with their annotations and level visibility
- Dirty flag (polled via `GET /status`, or tracked client-side)

---

## 9. Information Flows

### Startup
1. Browser loads `index.html`
2. JS calls `GET /graph`
3. Rust reads `vgraphtree.yaml` → parses into `NodeGraph` → serialises to JSON
4. D3 renders nodes at their pinned positions (or random positions for free nodes)
5. Force simulation starts; free nodes settle

### Pan / zoom
- Entirely frontend. No backend calls.
- D3 updates `transform.k` → LOD check → reveal/hide child nodes → re-derive edge paths.

### Edit node label or edge annotation
1. User double-clicks node or clicks edge → inline edit input appears
2. On confirm: `PATCH /node/:id` or `PATCH /edge/:id` with delta JSON
3. Rust mutates in-memory graph, sets `dirty = true`
4. `200 OK` → frontend updates label, shows dirty indicator

### Shift+drag to pin
1. User Shift+drags node to position
2. Frontend sends `PATCH /node/:id { pin: {x, y} }`
3. Rust sets `node.pin = Some(Position { x, y })`, sets dirty flag
4. D3 sets `node.fx = x, node.fy = y` — simulation stops moving it

### Save (Ctrl+S)
1. Browser sends `POST /save`
2. Rust serialises `NodeGraph` → YAML string
3. Writes to `vgraphtree.yaml.tmp`
4. `rename("vgraphtree.yaml.tmp", "vgraphtree.yaml")` (atomic)
5. `dirty = false`, `200 OK` → frontend clears dirty indicator

### Open code panel (click leaf node)
1. User clicks a node at maximum visible LOD
2. Frontend reads `source` path + line range from node data
3. `GET /file?path=src/auth/token.rs&start=42&end=87`
4. Rust reads the file, returns lines as JSON array
5. Code panel renders with syntax highlighting (client-side, e.g. highlight.js)
6. File content is not cached — discarded when panel closes

---

## 10. What Is Never Persisted

The following are frontend-only and are never sent to the backend or written to YAML:

- Pan position and zoom level
- Render cache (D3 node positions, derived edge SVG paths)
- Selected node ID
- Code panel open/closed state and content
- Temporary drag positions (drag without Shift)
- LSP ghost nodes (until user confirms them)

---

## 11. The Hybrid Force Layout

The force simulation uses D3's `d3-force` with three different treatments per node type:

```javascript
const simulation = d3.forceSimulation(nodes)
  .force('charge', d3.forceManyBody().strength(-300))
  .force('link', d3.forceLink(edges).id(d => d.id).distance(120))
  .force('collision', d3.forceCollide(50));

// Pinned nodes: D3 respects fx/fy and does not move them
nodes.forEach(n => {
  if (n.pin) { n.fx = n.pin.x; n.fy = n.pin.y; }
});

// Anchored nodes: soft gravity well toward zone centre
nodes.forEach(n => {
  if (n.zone) {
    const target = zoneToCoords(n.zone, canvasWidth, canvasHeight);
    simulation
      .force(`anchor-${n.id}`,
        d3.forceX(target.x).strength(0.05)
      );
    // also forceY
  }
});

// Free nodes: no additional force — settle by charge/link/collision
```

**Interaction rules:**
- Plain drag: `node.fx = event.x; node.fy = event.y` during drag, then `node.fx = null; node.fy = null` on drag end (returns to simulation).
- Shift+drag: same during drag, but on drag end sends `PATCH /node/:id { pin: {x, y} }` and keeps `fx/fy` set.
- Right-click pinned node → "Unpin": sends `PATCH /node/:id { pin: null }`, clears `fx/fy`.

---

## 12. Prototype Build Plan (Phase 1)

The goal of Phase 1 is the simplest possible thing that validates the core interaction: **zoom in → nodes reveal → edges morph → can edit and save**.

No LSP, no force simulation initially, no ghost nodes, no lasso grouping.

---

### Step 1 — Rust project scaffold

**Goal:** HTTP server running, browser can open the app.

```
cargo new vgraphtree-server
cd vgraphtree-server
# Add to Cargo.toml:
# axum = "0.7"
# tokio = { version = "1", features = ["full"] }
# tower-http = { version = "0.5", features = ["fs", "cors"] }
# serde = { version = "1", features = ["derive"] }
# serde_yaml = "0.9"
# serde_json = "1"
```

Tasks:
- Single binary with `main.rs`
- Route `GET /ping` returns `"ok"`
- `tower_http::services::ServeDir` serves `static/` directory
- `static/index.html` is a minimal HTML page with a `<canvas>` or `<svg>` element
- Hardcoded port `7777`

Deliverable: `curl localhost:7777/ping` returns `ok`. Browser opens `localhost:7777` and shows a blank page.

**Defer:** YAML parsing, any graph logic, CORS headers (add when needed).

---

### Step 2 — YAML model + graph API

**Goal:** Backend can parse a hand-written `vgraphtree.yaml` and serve it as JSON.

Tasks:
- Define `Node`, `Edge`, `ProjectConfig`, `NodeGraph` structs (see Section 6)
- `serde_yaml` deserialization from `vgraphtree.yaml` at startup
- Flatten the nested YAML node tree into a `HashMap<String, Node>` with explicit `parent` and `children` fields populated during load
- `GET /graph` returns `{ nodes: {...}, edges: [...] }` as JSON
- Hand-write a `vgraphtree.yaml` with 3–5 nodes and 2–3 edges to test with

Deliverable: `fetch("http://localhost:7777/graph")` in the browser console returns your nodes and edges. No frontend rendering yet.

**Defer:** PATCH/POST/DELETE endpoints, save, any mutation logic.

---

### Step 3 — D3 canvas, nodes, static edges

**Goal:** A pannable map of the YAML nodes and edges. No LOD yet — everything visible.

Tasks:
- Fetch `/graph` on page load
- Render each node as a `<rect>` + `<text>` label, positioned at `pin` coordinates (or random if no pin)
- Draw edges as straight `<line>` elements between node centres
- Apply `d3.zoom()` to a root `<g>` element for pan and zoom
- Style: minimal but readable — gray fills, black labels, thin strokes

Deliverable: A pannable map with all your YAML nodes and edges visible. Zoom works (everything scales together). No LOD, no interaction.

**Defer:** Force simulation, LOD reveals, editing, annotations on edges.

---

### Step 4 — Zoom levels and LOD reveals

**Goal:** Zoom in → child nodes float up out of their parent. Edges re-derive.

Tasks:
- Read `snap_levels` from config (or hardcode `[0.4, 1.2, 3.0, 8.0]` initially)
- Implement `getLODLevel(k)` and `handleLOD(k)` (see Section 8)
- On LOD increase: reveal child nodes of nodes at the new level
  - Initialise child nodes inside parent bounding box at `opacity: 0, scale: 0.5`
  - Animate to `opacity: 1, scale: 1` over ~300ms
  - D3 transition: `.transition().duration(300).attr('opacity', 1)`
- On LOD decrease: reverse — fade children out, parent becomes fully opaque again
- Edge re-derivation: after each LOD transition, recompute all edge paths using `getMostSpecificVisible()`
- Add a visible LOD level indicator in the corner (e.g. "Level 1 — Module")

Deliverable: Zoom in past threshold → child nodes emerge from parent. Zoom out → they retract. Edges visibly adjust endpoints.

**Tuning note:** Spend time on the easing curve here. `d3.easeCubicOut` for reveals, `d3.easeCubicIn` for hides typically feels right.

**Defer:** Snap-to-threshold behaviour (continuous zoom is fine), force simulation for children.

---

### Step 5 — Node editing and edge annotations

**Goal:** Full edit loop — label nodes, annotate edges, pin positions.

Tasks:
- **Label editing:** Double-click a node → replace label `<text>` with a positioned `<foreignObject>` containing an `<input>`. On blur/Enter: send `PATCH /node/:id { label }`, update display.
- **Edge annotation:** Click an edge → show a small floating input near the midpoint. On confirm: `PATCH /edge/:id { annotation }`. Annotation renders as small text along the edge.
- **Pin on Shift+drag:** Implement drag handler. Without Shift: temporary position (returns on release). With Shift: send `PATCH /node/:id { pin: {x, y} }`, lock `fx/fy`.
- **Implement remaining PATCH endpoints** in Rust: `/node/:id` and `/edge/:id`.
- **Dirty flag:** After any PATCH response, set `dirty = true` client-side. Show indicator in page title: `● vgraphtree` vs `vgraphtree`.
- **Keyboard shortcut:** Ctrl+S calls `POST /save`, clears dirty flag on success.

Deliverable: The full edit loop works end-to-end. You can rename nodes, annotate edges, pin positions. The dirty indicator shows/clears correctly.

**Defer:** Node creation from UI (add manually to YAML for now), node deletion, undo/redo.

---

### Step 6 — Save and load round-trip

**Goal:** Ctrl+S persists everything; reload restores exact state.

Tasks:
- Implement `POST /save` in Rust:
  1. Serialise `NodeGraph` back to YAML (respecting the original schema shape — nested nodes, not flat)
  2. Write to `vgraphtree.yaml.tmp`
  3. `std::fs::rename("vgraphtree.yaml.tmp", "vgraphtree.yaml")`
  4. Set `dirty = false`, return `200 OK`
- Implement `GET /file?path=...&start=N&end=M` in Rust:
  - Read the file, slice the requested lines, return as `{ lines: ["...", "..."] }`
  - Clamp line range to actual file length
- Add code panel to frontend:
  - Click a leaf node (deepest visible level) → fetch `/file` with its `source` path
  - Render lines in a side drawer with a monospace font
  - Basic syntax highlighting via highlight.js (CDN import)
- Test the full round-trip: edit labels and positions → Ctrl+S → hard reload → verify everything restored

Deliverable: **The prototype is a usable tool.** You can map a real codebase, save your work, reload and continue. Everything after this is an enhancement.

---

## 13. What Comes After Phase 1 (Phase 2+)

Not part of the prototype. Listed here to avoid scope creep bleeding into Phase 1.

- **D3 force simulation for free nodes** — add after save/load works; don't add during LOD implementation
- **LSP client in Rust** — spawn `rust-analyzer`, `pyright`, `marksman` as child processes via stdio; use `lsp-types` crate for JSON-RPC; query `textDocument/documentSymbol` and `textDocument/references`
- **Ghost nodes** — LSP-derived nodes shown with dashed borders and reduced opacity until accepted
- **Lasso grouping** — select multiple ghost nodes → name the group → write as a mid-level node to config
- **WebSocket push** — backend pushes LSP suggestion events to frontend in real time
- **Node creation in UI** — right-click canvas → "Add node"; currently nodes are added directly in YAML
- **Edge routing** — curved/orthogonal paths that avoid other nodes; for Phase 1, straight lines are fine
- **Undo/redo** — command history in frontend state
- **`vgraphtree check` CLI** — validate that all `source:` paths in YAML still exist
- **Markdown support** — parse `pulldown-cmark` AST to generate heading-hierarchy nodes

---

## 14. File / Directory Structure

```
vgraphtree/
├── vgraphtree-server/           # Rust backend
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs           # Axum server setup, route registration
│       ├── graph.rs          # NodeGraph, Node, Edge structs + in-memory state
│       ├── config.rs         # ProjectConfig, YAML parsing
│       ├── routes/
│       │   ├── graph.rs      # GET /graph
│       │   ├── node.rs       # PATCH /node, POST /node, DELETE /node
│       │   ├── edge.rs       # PATCH /edge, POST /edge
│       │   ├── save.rs       # POST /save
│       │   └── file.rs       # GET /file
│       └── lsp/              # Phase 2 only
│           └── client.rs
│
├── static/                   # Served as-is by tower-http
│   ├── index.html
│   ├── app.js                # D3 canvas, LOD logic, edit interactions
│   ├── api.js                # fetch() wrappers for all backend routes
│   └── style.css
│
└── vgraphtree.yaml              # The map config — checked into repo
```

---

## 15. Key Constraints and Rules to Respect

1. **Config is human-readable and hand-editable.** The YAML schema must stay clean enough that a developer can open `vgraphtree.yaml` and make changes without running the app.

2. **Backend is stateless between requests** (in Phase 1). The only state is the in-memory graph (rebuilt from YAML on startup) and the dirty flag. No sessions, no per-request state.

3. **Edge paths are never stored.** SVG paths for edges are always computed from current node positions and current LOD. This is what makes edge morphing work without special-casing.

4. **LSP data (Phase 2) never enters the YAML** until the user explicitly accepts it. Ghost nodes and ghost edges are ephemeral.

5. **Positions in YAML only when pinned.** Free nodes have no position in config. This keeps the file short and prevents stale coordinates after layout changes.

6. **Atomic file writes only.** Never write directly to `vgraphtree.yaml` in place. Always write to `.tmp` and rename. Prevents partial writes corrupting the file.

7. **No bundler required.** The frontend is plain JS with D3 loaded from CDN (or a local copy). Opening `localhost:7777` should just work — no `npm install`, no build step for the frontend.