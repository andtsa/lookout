# vgraphtree — Design Decisions Log

Decisions made during implementation that were not covered (or were ambiguous) in plan.md.

---

## Rust / Backend

### D1: `serde_yaml::from_str` for YAML children map

The YAML schema uses a nested map (`children:` key inside each node). During deserialization I needed an intermediate `YamlNode` type that mirrors the on-disk schema (with `children: HashMap<String, YamlNode>`) distinct from the in-memory `Node` struct (with `children: Vec<String>`). The flatten step runs at load time, populating `parent` and `children` fields on each node. This keeps the runtime graph flat and O(1) to look up, while keeping YAML human-writable.

### D2: `ProjectConfig.lsp` is `Option<HashMap<String, String>>`

Made `lsp` optional in the config struct so a minimal YAML without an `lsp:` block still parses. Defaults to an empty map on serialize.

### D3: Atomic save uses `std::fs::rename` (not `std::fs::copy`)

`rename` is atomic on POSIX systems when source and destination are on the same filesystem (which they always are here — both are in the project directory). This matches the spec. The `.tmp` file is written fully before the rename, so a crash mid-write leaves the old file intact.

### D4: Config path passed as CLI arg, defaulting to `vgraphtree.yaml`

The server accepts an optional first argument for the config path. This makes it easy to run from any working directory and allows multiple configs (e.g. for different repos). Default is `"vgraphtree.yaml"` relative to CWD, which matches the project root convention.

### D5: Delete node uses iterative BFS instead of recursive `remove_subtree`

Rust's borrow checker prevents passing `&mut graph.nodes` and `&mut graph.edges` simultaneously to a recursive function (both are fields of the same struct). Solved by inlining the recursion as an iterative loop that pops a `Vec<String>` of IDs to remove, avoiding the double-mutable-borrow.

### D6: `PATCH /node/:id` accepts `pin: null` to unpin

The pin field is represented as `serde_json::Value` in the patch body so it can be `null` (unpin), absent (no change), or `{x, y}` (pin). A typed `Option<Option<Position>>` would be cleaner but requires a custom deserializer; using raw `Value` is pragmatic for Phase 1.

### D7: Axum route syntax uses `:id` not `{id}` (CORRECTED)

**Original claim was backwards and caused a real bug.** Axum **0.7** uses the
Express-style `:id` colon syntax; the `{id}` brace syntax only became correct in
axum **0.8**. With the pinned `axum = "0.7.9"`, routes written as `/node/{id}`
matched a *literal* `{id}` segment and never matched `/node/frontend`, so every
parameterized request (PATCH/DELETE node, PATCH edge) fell through to the
static-file fallback and returned `405 GET,HEAD`. Node rename, pin, and edge
annotation were therefore silently non-functional. Fixed in D29 by switching the
routes to `/node/:id` and `/edge/:id`.

---

## Frontend

### D8: Child nodes scatter near parent pin position, not random canvas

Free nodes without a pin are placed at `parent.pin ± 100px` (random spread). The original approach of `100 + Math.random() * (window.innerWidth - 200)` failed because `window.innerWidth` is 0 during ES module evaluation (before the browser has finished painting). Placing children near their parent is also better UX — they start where the user expects them.

### D9: Node positions assigned in level order (roots first)

During `init()`, nodes are sorted by `level` ascending before assigning positions. This ensures that when a child's `initialPosition()` looks up `parent.pin`, the parent's position has already been assigned. Without this sort, child nodes could be processed before their parent and fall back to canvas-center placement.

### D10: `currentLOD` initialized from `getLODLevel(1)` before first render

If `currentLOD` starts at 0 but the initial zoom is k=1 (which is LOD 1 with default thresholds), child nodes would render with `opacity: 0` and never become visible until a zoom event fires. Fixed by computing `currentLOD = getLODLevel(initialK)` before calling `renderNodes()`.

### D11: Edge endpoints clipped to node border (not center-to-center)

Lines drawn center-to-center overlap the node rectangles, hiding arrowheads. `borderOffset(dx, dy, hw, hh)` clips the ray to the nearest edge of the bounding box using the separating-axis `t = min(hw/|dx|, hh/|dy|)` calculation. This keeps arrowheads visible and avoids overlap.

### D12: Two SVG layers for edges: visual + hitarea

Edges have a thin visible stroke and an invisible wide stroke (12px, transparent) for click targeting. Separate `<g>` groups (`edge-visual` and `edge-hitarea-group`) are kept in sync during each `rerenderEdges()` call. This avoids the classic "can't click a 1px line" problem without making visible strokes fat.

### D13: `getMostSpecificVisible` descends to first child only

When resolving edge endpoints at LOD > 0, `getMostSpecificVisible` walks to `children[0]` (the first child in the array). This is a simplification — a more accurate implementation would pick the child closest to the edge's other endpoint. Deferred to Phase 2.

### D14: Edge annotation editing uses a floating HTML `<input>` overlay

Rather than an SVG `<foreignObject>` (which works poorly for edge midpoints that move), edge annotation editing creates a fixed-position `<div>` overlay whose screen coordinates are computed from the current D3 zoom transform (`t.applyX(mx)`). This overlays correctly at any zoom level.

### D15: highlight.js loaded from CDN, autodetect disabled

Only the Rust language pack is loaded to keep it lightweight. `hljs.highlightElement(code)` is called with an explicit `language-rust` class. If the source file is not Rust, syntax highlighting degrades gracefully (no class = no highlighting, no error).

### D16: `POST /save` clears dirty flag on the backend, not just frontend

The backend sets `graph.dirty = false` after a successful atomic write. The frontend also clears its local `dirty` flag on a `200 OK` response. Both sides agree on clean state. The `GET /status` endpoint reflects the backend state, which could be polled to catch out-of-sync edge cases (not done in Phase 1).

### D17: Force simulation added (Phase 1 addendum)

`buildSimulation()` runs `d3.forceSimulation` on nodes at `level <= currentLOD`. Pinned nodes get `fx/fy` set (immovable). Zoned nodes get `forceX/forceY` anchors at low strength (0.08). Free nodes settle by charge/link/collision. A weak center gravity (`strength: 0.015`) prevents unconnected nodes drifting offscreen. Simulation is rebuilt on every LOD change (new nodes enter/leave). Drag interactions heat/cool alpha target appropriately.

### D18: Snap levels derived from fit-to-screen scale

Snap levels (when each LOD unlocks) should not be absolute `k` values — those break on different screen sizes and graph layouts. Instead, they are computed as multipliers over the fit-to-screen scale (`fitScale`) each time `centerGraph` runs:

```
snapLevels[n] = fitScale × LOD_MULTIPLIERS[n]
```

`LOD_MULTIPLIERS = [1.2, 1.8, 3.2, 6.0]`. This means "zoom in 20% from the initial fit view to see level-1 children." The transition feels the same on any screen or graph size, because it's relative to where you start. The `snap_levels` field in `vgraphtree.yaml` is currently unused by the frontend (Q4 still open).

### D19: Graph centering uses `svg.clientWidth` not `window.innerWidth`

`window.innerWidth` is unreliable in iframes (returns 2 in the preview tool). All viewport measurements use `svg.node().clientWidth` / `clientHeight` instead. `scheduleCenterGraph` uses `requestAnimationFrame` to wait for the browser's layout pass before reading dimensions. A debounced `window.resize` listener re-runs `centerGraph` on viewport resize, which also re-derives snap levels.

### D20: `svg.transition().call(zoom.transform)` races with the simulation tick

The D3 pattern `svg.transition().call(zoom.transform, t)` fires a zoom event asynchronously during the transition tween. When the simulation is already ticking (calling `rerenderEdges` on every frame), this races and the root transform attribute doesn't get set. Fixed by calling both `svg.call(zoom.transform, t)` (updates D3's internal state and fires the event) and `root.attr('transform', t)` (sets the DOM attribute immediately as a belt-and-suspenders).

---

## Config architecture (goal-state)

Design forks settled while planning the goal-state config. Full model in
[`config-architecture.md`](config-architecture.md); these entries record *why*
each fork went the way it did.

### D21: Config split into three files (intent / state / cache)

The single prototype file conflates human intent, app-written layout state, and
machine-derived data — which is exactly why it churns and can't be hand-authored
cleanly. Split into `vgraphtree.yaml` (human intent, committed, rarely written),
`vgraphtree.state.yaml` (pins + dismissed, app-owned, committed), and
`.vgraphtree/lsp-cache.yaml` (derived snapshot, gitignored, warm-start only).
The usual "need identity to reattach layers" objection dissolves because state
keys by human-owned node id; the hard identity case (LSP leaves) is never
persisted in a committed file.

### D22: Provenance = file location + key presence (no `origin` flag)

Once layered, a node's provenance is *which file it lives in* (intent = blessed,
cache = derived), and field-level provenance is *key presence* (an explicit
`label:` = human override, absence = follow the code). This is strictly more
capable than the binary `origin` flag, which would need an extra `overrides` set
to match it. `origin` is dropped from the schema. "Accept a suggestion" = promote
a sparse entry from cache into the intent file.

### D23: Edges are pure morphing — `levels` dropped

Section 2.1's morphing model (endpoints resolve to nearest visible ancestor)
already makes per-edge `levels` meaningless, and the prototype never consumed the
field. An edge is drawn when both endpoints resolve to distinct visible proxies.
Coarse/fine coexistence (bundling, decluttering) is a runtime rendering concern,
not a config field.

### D24: Reveal by tree depth, style by kind

Zoom reveal timing = authored tree depth (always well-defined, robust to
irregular human groupings and derived children). Visual style = `kind`
(concept/dir/file/symbol) for altitude wayfinding. Reveal-by-abstraction-altitude
was rejected: the tool documents existing code and human groupings don't respect
a system→module→file→symbol ladder. `level` is therefore derived, never authored.

### D25: `derive_children` opt-in and inert until LSP

`derive_children` defaults to `false` and is parsed-but-ignored in the prototype.
The prototype is meant to be used to understand a real codebase by hand first;
the authored/derived seam moves up only once LSP derivation exists and has been
felt out in practice.

### D26: `EdgeKind::Custom(String)` with a string (de)serializer

Edge kinds are a small fixed enum (`Import | Call | Reference | Semantic`) plus
`Custom(String)`; hand-drawn edges default to `Semantic`. Serde's default enum
encoding emits ugly YAML for the custom case (`kind: !Custom …`), so `EdgeKind`
gets a custom string (de)serializer: known kebab-strings → unit variants, else
`Custom`. Keeps YAML clean and hand-editable (`kind: reads-config`).

### D28: Position resolution — intent pin default + gitignored state override (A1)

Positions resolve in four tiers: **state `pin`** (gitignored, personal, exact) ▸
**intent `pin`** (committed, exact, hand-authored default) ▸ **intent `zone`**
(committed soft anchor) ▸ force-directed. `zone` alone doesn't stop the force sim
from nudging shared layouts, so exact committed defaults are allowed in intent —
but the app **never writes pins into intent** (drag/pin always writes to the
state file), so intent stays hand-authored and churn-free. Save writes only pins
that *deviate* from the intent default; the state file is gitignored so personal
layout never enters the repo. State pins are nullable (`id → Option<Position>`):
`id: null` is an **explicit unpin** that overrides an intent-`pin` default and
survives reload — resolving the earlier null-tombstone gap. The `PATCH /node`
body uses a double-option so `pin: null` (unpin) is distinguishable from an absent
field (no change); a plain `Option<Value>` collapsed both to `None`, so unpin
silently did nothing.

### D29: Static files via `fallback_service`, param routes via `:id`

Two coupled routing fixes surfaced while verifying D28. (1) `nest_service("/",
ServeDir)` shadowed API routes; replaced with `fallback_service(ServeDir::new(
"static"))` so static files serve only unmatched paths. (2) Param routes switched
from `{id}` to `:id` for axum 0.7 (see corrected D7). Also merged the duplicate
`/node/{id}` registrations into one `patch(..).delete(..)` method router. Result:
node rename/pin and edge annotation persist correctly for the first time.

### D27: `depth_ceiling` reinterpreted as auto-derivation cap

The authored/derived seam is per-branch and implicit (wherever authored children
run out). `depth_ceiling` is no longer "max authored level" but "how deep the
machine keeps deriving *below* the seam" — a clutter/cost bound, not a limit on
hand-authoring.

---

## Nested configs (composition, v1)

Full model in [`config-architecture.md`](config-architecture.md) §11; these record
why each fork went the way it did.

### D30: `include:` mounts — composition is a backend load-time transform

A node's `include: <inner vgraphtree.yaml>` delegates its subtree to that
subproject's independently-maintained map ("submodules for maps"). `compose`
recursively splices includes into one graph so the frontend renders a single
composed graph (mounts are just containers) — the whole feature is one loader
transform, not a rendering change. Chosen over textual `!include` (shared id space,
one owner) because clean per-subproject ownership is the point for large codebases.

### D31: Namespace inner ids under the mount; rewrite sources to the outer root

Inner ids are prefixed `"<mount>/"` (`auth/frontend`) so two subprojects can both
have a `frontend`; inner edges are rewritten to match. Inner `source:` is rewritten
once at compose time to resolve against the *outer* `resolved_root` (relative when
under it, absolute fallback) — this keeps the single existing `resolved_root`/`GET
/file` path working, with no per-node roots at runtime. Inner roots reparent to the
mount and levels offset by `mount.level + 1` so the seam is invisible.

### D32: Nested content is read-only; serialize stops at mounts

v1 avoids per-file save routing entirely: nested nodes/edges are read-only
(`PATCH`/`DELETE` → 403), a `nested: true` flag ships to the frontend (hides
rename/pin, dashed cue), and `serialize_intent` emits `include:` at a mount and
never inlines the nested subtree (nor edges with a nested endpoint). So saves only
ever touch outer-owned content and the `intent_dirty` model (D28-era) is unchanged.
`include` + inline `children` → warning on `serve`, error in `check`.

### D33: Preserve inner layout — recenter on the mount, scale down

Rather than force-relaxing nested nodes, the frontend keeps the subproject's
designed pin layout: recenter the inner map's pinned bbox on the mount and scale by
`NESTED_SCALE` (~0.35), making the shifted position a rigid pin. Preserves the
team's arrangement as a compact cluster. Caveat: a nested cluster under an unpinned
mount can drift — acceptable for v1. Deferred: lazy include loading (the scale win),
per-file editing, fine-grained cross-project edges, auto-discovery.

---

## Open questions / known issues

- **Q1**: `getMostSpecificVisible` always picks `children[0]`. For edges to look correct at LOD 1+, it should pick the child that is closest to the edge's other endpoint, or that has the most relevant semantic connection. Deferred.

- **Q2**: The save round-trip serializes YAML via `serde_yaml`, which does not guarantee key order. The YAML output may reorder keys on each save. A stable serializer (writing keys in a defined order) would be friendlier for git diffs. Deferred. *Partly mitigated by D21: the intent file is rarely written (only on explicit semantic commits), so diff churn matters much less there; the app-owned state/cache files are where frequent writes land.*

- **Q3**: ~~No force simulation.~~ Resolved: D17.

- **Q4**: The `snap_levels` from `vgraphtree.yaml` are not returned by `GET /graph`. The frontend ignores the YAML value and derives snap levels from the fit scale (D18). The API should return project config, or snap levels should be exposed via a `GET /config` endpoint, so the YAML multipliers can override the defaults. *Goal-state (config-architecture.md §3.5, §12): `snap_levels` is dropped from the schema; may return as optional override multipliers over the fit-scale-derived thresholds.*

- **Q5**: `centerGraph` re-runs on every window resize, resetting the zoom. This is fine for now but will be jarring if the user has panned deep into the graph. A future improvement: only re-center if the user hasn't zoomed past LOD 0, or track "has user interacted" and skip re-centering in that case.
