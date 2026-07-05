# vgraphtree — Config Architecture (goal-state)

> The target design for the configuration format. Supersedes the schema described
> in `plan.md` sections 4–6 (which document the Phase-1 prototype). This document
> describes where we are heading, not everything that is built yet — see
> **§8 Prototype vs goal** for what is inert today.

---

## 1. Core stance: the config is a human overlay on a shifting code substrate

There are two graphs, and the config only owns one of them.

1. **The code-derived graph** — files, symbols, imports, call/reference edges.
   Mechanical, regenerable by LSP, *never hand-authored*.
2. **The semantic graph** — "auth talks to the DB," the groupings and
   abstractions that exist only in a developer's head.

The config's job is **not to store a graph**. It records human intent and *binds*
it to code artifacts. Anything a machine can re-derive should be re-derived;
the config holds only what a machine cannot invent — names, groupings,
annotations, and the bindings between concepts and code.

A direct consequence: the config is a **lossy overlay** on code that moves
underneath it. We do not try to perfectly track renames. We bind by
best-available identity, **detect dangling bindings, and make "re-bind" a
first-class action** (see §6 Staleness). This is the tool documenting an
*existing* codebase — it never enforces an architecture, it annotates one.

---

## 2. Three files, three lifetimes

The single prototype file conflates three kinds of data with different owners,
change rates, and git dispositions. They split into three files:

| File | Contains | Written by | Change rate | Git |
|------|----------|------------|-------------|-----|
| `vgraphtree.yaml` | **human intent**: concepts, groupings, labels, annotations, bindings, zones | person (+ app on explicit commit) | rarely | committed |
| `vgraphtree.state.yaml` | **app state**: pins, dismissed suggestions | app | often | committed (shared layout) |
| `.vgraphtree/lsp-cache.yaml` | **derived snapshot**: code nodes/edges for warm start | machine only | every scan | **gitignored** |

Why this split:

- The intent file becomes genuinely hand-authorable and diff-clean — the app
  touches it only when the human commits a *semantic* change.
- LSP maintenance writes to a different file and therefore **cannot corrupt
  human intent**.
- Positions key by node id, and node ids are human-owned and stable, so
  reattaching the state layer at load is a dictionary lookup — no identity
  problem. (The hard identity case, LSP leaves, is never persisted in either
  committed file.)

---

## 3. The intent file — `vgraphtree.yaml`

### 3.1 Shape

```yaml
project:
  root: .
  lsp:
    rust: rust-analyzer
    javascript: typescript-language-server
  depth_ceiling: 2          # how deep LSP auto-derives *below* an authored node

nodes:
  frontend:
    label: Web frontend
    source: static/
    zone: top-right
    children:
      mod_app:    { label: App entry, source: static/app.js }
      mod_state:  { label: State,     source: static/state.js }
      mod_render: { label: Render,    source: static/render.js }
      # …
      api_client: { label: API client, source: static/api.js }

  backend:
    label: Rust backend
    source: vgraphtree-server/
    zone: top-left
    children:
      route_handlers:
        label: Route handlers
        source: vgraphtree-server/src/routes/
        derive_children: true        # opt-in; inert until LSP exists (§8)
      config_parser:
        label: Config parser
        source: vgraphtree-server/src/config.rs
        children:
          parse_fn:
            source: vgraphtree-server/src/config.rs::parse_yaml
            # no label → follows the LSP symbol name "parse_yaml"
      graph_types:  { label: Graph types,  source: vgraphtree-server/src/graph.rs }
      server_entry: { label: Server entry, source: vgraphtree-server/src/main.rs }

  yaml_store:
    label: YAML store
    source: vgraphtree.yaml
    zone: bottom

edges:
  - { from: frontend, to: backend,    annotation: HTTP fetch API }
  - { from: backend,  to: yaml_store, annotation: atomic read/write }
  - { from: config_parser, to: graph_types, annotation: produces NodeGraph }
  - { from: mod_app,  to: api_client, annotation: fetchGraph / postSave }
  # …
```

### 3.2 Node fields

A node is keyed by its **id** (human-owned, stable) and has:

| Field | Required | Meaning |
|-------|----------|---------|
| `label` | no | Display name. **Absent → follow the binding's derived name** (see §5 provenance). A pure concept with no binding falls back to the id. |
| `source` | no | Binding to code: a directory (`src/auth/`), file (`token.rs`), or symbol (`token.rs::validate`). Absent → a pure concept. Symbol bindings resolve to a line range at runtime; ranges are **never stored**. |
| `kind` | no | Visual style only: `concept \| dir \| file \| symbol`. Absent → inferred from the binding shape. |
| `zone` | no | Semantic layout anchor (`top-left`, `bottom`, …) — a soft gravity well. The hand-authorable expression of "put it roughly here." |
| `pin` | no | Committed **exact** position default (`{x, y}`). Hand-authored; the app never rewrites it (drag/pin writes go to the state file). Overridden by a state-file pin. Use when `zone` isn't enough and you want the shared layout to land precisely. |
| `derive_children` | no | Opt-in: populate children from LSP below this node. Default `false`. **Inert in the prototype** (§8). |
| `children` | no | Nested map of child nodes, same shape recursively. |

Removed from the prototype schema: **`level`** (derived from nesting depth, see
§7) and **`origin`** (replaced by file-location provenance, see §5). Note `pin`
is *not* removed — it stays as an optional committed default (see §4 for the
position-resolution model), distinct from the churny personal pin in state.

### 3.3 Edge fields

An edge has:

| Field | Required | Meaning |
|-------|----------|---------|
| `from` / `to` | yes | Node ids. The edge is a pure semantic assertion; rendering resolves each endpoint to its nearest visible ancestor (morphing). |
| `annotation` | no | Human label on the arrow. |
| `kind` | no | Edge type for styling/filtering (§3.4). Hand-drawn default: `semantic`. |
| `id` | no | Stable identifier. **Absent → derived `{from}__{to}`.** Assign an explicit id for parallel edges between the same pair you want to reference reliably (derived `#2`/`#3` suffixes are order-dependent and not stable across reordering). |

Removed: **`levels`** (edges are pure morphing; visibility is derived, not
authored — see §7).

### 3.4 Edge kinds

```rust
enum EdgeKind { Import, Call, Reference, Semantic, Custom(String) }
```

- Machine-derived edges get concrete variants (`import`, `call`, `reference`).
- Hand-drawn edges default to `Semantic`.
- `Custom(String)` covers freeform user tags.

**Serialization note:** the default serde enum encoding produces ugly YAML for
the custom case (`kind: !Custom reads config`). `EdgeKind` needs a custom string
(de)serializer so YAML stays clean and hand-editable: known kebab-strings map to
unit variants, anything else becomes `Custom`. Target output: `kind: import`,
`kind: reads-config`.

### 3.5 Project block

| Field | Required | Meaning |
|-------|----------|---------|
| `root` | yes | Project root the bindings are relative to. |
| `lsp` | no | Map of language → LSP command. |
| `depth_ceiling` | no | Cap on how deep the machine auto-derives **below** an authored node (bounds cost/clutter). Not a limit on authoring depth. |

Removed: **`snap_levels`** — superseded by fit-scale-derived thresholds
(`design-decisions.md` D18). May return later as optional override multipliers.

---

## 4. The state file — `vgraphtree.state.yaml`

App-owned and **gitignored** (personal layout, per machine). Small.

```yaml
# app-owned — pins and dismissed suggestions. The app writes this.
pins:
  frontend: { x: 640, y: 300 }     # a node this user moved off its shared default

dismissed:                         # ghosts the user said "stop suggesting"
  - vgraphtree-server/src/main.rs::main
```

### Position resolution (4 tiers)

A node's position resolves in priority order:

1. **State `pin`** (gitignored, personal, exact) — wins if present.
2. **Intent `pin`** (committed, exact, hand-authored default).
3. **Intent `zone`** (committed, soft gravity well).
4. **Force-directed** — nothing specified.

The point of the split: the committed intent carries the *shared* layout (exact
`pin` or soft `zone`) so a fresh clone reproduces the author's arrangement; the
gitignored state carries *personal* overrides so individuals rearrange (for their
screen/font size) without repo churn or merge conflicts. The app **only ever
writes pins to state**, never to intent — so intent stays hand-authored, and save
records only pins that *deviate* from the intent default (a fresh state file is
empty).

- **`dismissed`** — suppression tombstones: the one class of "human decision
  about machine data." Keyed by best-effort binding identity. *Open (A1 flag):*
  since state is now gitignored, dismissals are personal; a dismissed suggestion
  may be more of a *team* decision, so `dismissed` may want to move into the
  committed intent file in Phase B.

**Explicit unpin:** state pins are `id → Option<Position>`, so `id: null` records
an *explicit unpin* — it overrides an intent-`pin` default and sends the node
force-directed, and survives reload. (The PATCH also uses a double-option so
`pin: null` = unpin is distinguishable from an absent field = no change.)

---

## 5. Provenance — location + key presence (no `origin` flag)

Provenance falls out of the file split at two levels, so no explicit flag is
needed:

- **Node-level provenance = which file.** A node in `vgraphtree.yaml` is
  human-blessed, full stop. A node in the cache is machine-derived. Location
  *is* the flag.
- **Field-level provenance = key presence.** An accepted node can be a *sparse
  anchor*: `{ source: config.rs::parse_yaml }` with no `label` asserts "this
  exists, is blessed, bound here" while deferring the name to LSP. The moment
  the user renames it, an explicit `label:` appears — and the *existence* of
  that key is the signal "human override; do not touch." Absence of a key =
  follow the code.

"Accept a suggestion" therefore means **promote a sparse entry from the cache
into the intent file.** Edges follow the identical rule.

---

## 6. Staleness — a core server loop

Binding resolution and dangle-detection live in the **server** (it owns the
in-memory graph and is the only thing that touches the filesystem). On load and
on rescan:

1. Resolve every intent `source` against real code.
2. Any binding that does not resolve is flagged **dangling** — surfaced for
   re-bind, **never dropped silently**.
3. New code artifacts below an authored seam surface as **ghost** suggestions
   (minus anything in `dismissed`, minus anything already promoted to intent).

`vgraphtree check` is just a CLI entrypoint over this same server logic.

---

## 7. Level of detail — reveal by tree depth, style by kind

The zoom experience should feel like **stepping through a codebase**, but through
the human's semantic groupings rather than raw dir/file structure. Two concerns,
deliberately decoupled:

- **Reveal timing = tree depth.** Zooming in reveals one more level of the
  authored tree. Always well-defined for any hierarchy, robust to irregular
  human groupings and to derived children (which simply extend the tree deeper).
- **Visual style = `kind`.** A file still *looks* like a file and a symbol like
  a symbol, giving altitude wayfinding without forcing every hierarchy onto a
  rigid system→module→file→symbol ladder.

We explicitly rejected reveal-by-abstraction-altitude: human groupings do not
respect the ladder (a top-level concept may parent a symbol directly), and the
tool documents existing code rather than enforcing a structure.

**The seam is invisible.** The tree is human-authored at the top and
machine-derived at the bottom; the transition is per-branch and implicit
(wherever a branch runs out of authored children). Zooming down crosses from
human abstraction into real code without a bump — to the zoom machinery it is
all just deeper levels of one tree. `depth_ceiling` caps how far the machine
continues past the seam.

Ragged depth across branches is a non-issue because the dominant interaction is
**dive into one node**, not "expand everything to level N." Over-full nodes get
*soft nudges* (suggested groupings) — never enforcement.

Edges follow from this automatically: an edge is drawn when both endpoints
resolve to distinct visible proxies, and hidden when they collapse to the same
node (i.e. it is internal at this zoom). Coarse/fine coexistence (bundling
parallel edges, decluttering superseded coarse edges) is a **runtime rendering**
concern, not a config field.

---

## 8. Merge / resolution order at load

1. **Intent** → blessed nodes/edges.
2. **State** → apply pins to matching ids; load the `dismissed` set.
3. **Cache** (refresh if `source_hash` is stale) → derived nodes/edges below each
   authored seam, capped by `depth_ceiling`, gated by `derive_children`, minus
   `dismissed` and minus anything already promoted into intent.
4. **Field resolution** — `label` = intent value if the key is present, else the
   derived name; `kind` = intent value if present, else inferred from the
   binding shape; `level` = computed from tree depth.
5. **Staleness** — flag dangling bindings for rebind (§6).

---

## 9. The cache file — `.vgraphtree/lsp-cache.yaml`

Machine-generated, gitignored, warm-start only. Flat for fast load.

```yaml
# ⚠ MACHINE-GENERATED — do not edit; overwritten on next scan.
meta:
  generated:   2026-07-03T14:22:10Z
  source_hash: b3f1c9…             # invalidation stamp over scanned files
nodes:                             # flat; keyed by derived id; parent = authored anchor
  "routes/save.rs":
    kind: file
    parent: route_handlers
    source: vgraphtree-server/src/routes/save.rs
  "routes/save.rs::save_handler":
    kind: symbol
    parent: "routes/save.rs"
    source: vgraphtree-server/src/routes/save.rs::save_handler
edges:
  - { from: "routes/save.rs::save_handler", to: "graph.rs::NodeGraph", kind: reference }
```

- **`meta.source_hash`** invalidates the cache when scanned sources change. The
  cache is a warm-start optimization and is **never authoritative** — code is
  truth.
- The banner and `meta` are re-emitted by the writer every time (`serde_yaml`
  drops comments on round-trip, so the "machine-generated" notice is code, not a
  preserved file comment).
- Derived ids are path-relative (`routes/save.rs::save_handler`). Stable enough
  across scans for `pins`/`dismissed` to reference, inherently fragile to
  renames — which is *why* the file is gitignored and cheap to rebuild.

---

## 10. Rust data model (goal-state sketch)

On-disk (deserialized) types, distinct from the resolved runtime node:

```rust
// ── intent file ───────────────────────────────────────────────
struct IntentConfig {
    project: ProjectConfig,
    nodes:   HashMap<String, IntentNode>,   // nested
    edges:   Vec<IntentEdge>,
}
struct IntentNode {
    label:           Option<String>,
    source:          Option<String>,
    kind:            Option<NodeKind>,
    zone:            Option<Zone>,
    pin:             Option<Position>,      // committed exact default; app never rewrites
    derive_children: bool,                  // default false, inert until LSP
    children:        HashMap<String, IntentNode>,
}
struct IntentEdge {
    id:         Option<String>,             // derived {from}__{to} if None
    from:       String,
    to:         String,
    annotation: Option<String>,
    kind:       Option<EdgeKind>,           // default Semantic
}
struct ProjectConfig {
    root:          PathBuf,
    lsp:           Option<HashMap<String, String>>,
    depth_ceiling: Option<u32>,
}

// ── state file ────────────────────────────────────────────────
struct StateConfig {
    pins:      HashMap<String, Position>,
    dismissed: Vec<String>,
}

// ── resolved runtime node (in-memory, not serialized as-is) ────
struct Node {
    id:       String,
    label:    String,             // resolved (intent or derived)
    level:    u32,                // computed from tree depth
    kind:     NodeKind,           // resolved (intent or inferred)
    parent:   Option<String>,
    source:   Option<String>,
    zone:     Option<Zone>,
    pin:      Option<Position>,   // effective: state override if present, else intent default
    intent_pin: Option<Position>, // committed default, for deviation-only state writes
    children: Vec<String>,
    derived:  bool,               // false = from intent, true = from cache/LSP
    label_overridden: bool,       // intent had explicit label key
    dirty:    bool,
}

enum NodeKind { Concept, Dir, File, Symbol }
enum EdgeKind { Import, Call, Reference, Semantic, Custom(String) }
```

---

## 11. Nested configs (composition)

Large codebases can't live in one hand-maintained map. A node in an outer config
carries **`include: <path/to/vgraphtree.yaml>`** and delegates its whole subtree
to that subproject's own, independently-maintained map — "submodules for maps."
Zooming into the mount node reveals the subproject's map, continuing the seamless
descent. Ownership is clean: the outer owns mount nodes + cross-subproject edges;
each inner config owns everything below its mount. This extends the §7 idea (a
node's subtree can come from inline / LSP / **another intent file**).

```yaml
# outer vgraphtree.yaml
nodes:
  auth:
    label: Auth service
    include: services/auth/vgraphtree.yaml   # delegate subtree to this map
  billing: { label: Billing }
edges:
  - { from: auth, to: billing, annotation: events }   # cross-subproject edge
```

### The compose transform (backend, load-time)

Composition is a one-time transform in the loader (`compose`); the frontend gets a
single composed graph and renders mounts as containers. For each `include`:

1. **Recurse** into the inner file (cycle-guarded by the include chain — a repeat
   is a hard error; an unreadable/unparseable include is too).
2. **Namespace** every inner id with `"<mount_id>/"` (`frontend` → `auth/frontend`),
   rewriting inner edge endpoints to match.
3. **Reparent** inner roots to the mount; **offset** inner `level` by
   `mount.level + 1` so the seam is invisible.
4. **Rewrite** inner `source:` to resolve against the *outer* root (relative when
   the subproject is under it, absolute fallback otherwise). One rewrite at compose
   time keeps the single `resolved_root` working for `GET /file` — no per-node roots.
5. **Flag** inner nodes `nested = true`; the mount's children become the inner roots;
   the mount keeps `include` for serialization.

`include` + inline `children` → a **warning** (children ignored, `include` wins) on
`serve`, an **error** in `check`. `check` runs `compose`, so it validates include
resolution + cycles recursively.

### Read-only + save

Nested content is **read-only** in the composed view: `PATCH`/`DELETE` on a nested
node, and `PATCH` on an edge with a nested endpoint, return `403`. A `nested: true`
flag ships in the graph JSON so the frontend hides rename/pin and shows a dashed
cue. `serialize_intent` **stops at mounts** — it emits `include:` and never inlines
the nested subtree, and skips edges with a nested endpoint — so the outer file only
ever records outer-owned content. This keeps the §4 / `intent_dirty` save model
intact (nested edits never happen, so per-file save routing isn't needed yet).

### Nested layout

Inner maps arrive with their own absolute pins. The frontend recenters each inner
map's pinned bounding box on its mount and scales it by `NESTED_SCALE` (~0.35), so
the subproject's designed layout is preserved as a compact cluster inside the mount
container. The shifted value becomes the node's pin (rigid). *Caveat:* an
unpinned/force-directed mount lets the rigid cluster drift — fine for v1.

### v1 scope / deferred

v1 is **eager** load, **read-only** nested, mount-level cross edges. Deferred: lazy
on-demand loading of includes (the real scale win — don't materialize thousands of
nodes at once), per-file edit/save routing (edit nested content in the composed
view), fine-grained cross-project edges (`auth/X → billing/Y`), and auto-discovery
(mount any `source:` dir that contains a `vgraphtree.yaml`).

---

## 12. Prototype vs goal (what is inert today)

The prototype can adopt most of this schema immediately, with two parts parked
until LSP lands:

- **`derive_children` is a no-op.** Parsed and ignored by the loader. Hand-authored
  children (e.g. the level-2 route handlers) stay authored; the seam moves up
  only once derivation is real and tested.
- **The cache file and staleness loop** do not exist yet. Only the intent and
  state files are live in the prototype.

Adopting the schema now means: the prototype's file becomes today's map minus
`level`, `origin`, `pin`, and edge `levels`, with pins relocated to
`vgraphtree.state.yaml`. Everything else (derive/cache/staleness) is additive
and arrives with the LSP integration.

---

## 13. Deferred / open

- **`snap_levels` as override multipliers** — currently dropped; may return as
  optional overrides on the fit-scale-derived thresholds (D18 / Q4).
- **Edge bundling & coarse/fine decluttering** — runtime rendering feature, not
  a config field. Deferred.
- **Derived-id stability across renames** — accepted as fragile; mitigated by
  gitignoring the cache and by the rebind loop, not by fingerprinting.
- **State file git disposition** — committed by default (shared layout); teams
  that treat layout as personal may gitignore it.
