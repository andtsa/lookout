# vgraphtree — Open Questions & Decision Points

> Consolidated tracker of everything still undecided or deferred, gathered from
> `design-decisions.md` (Q1–Q5), `config-architecture.md` §12, `plan.md` §13,
> and the config-architecture design discussion. Grouped by how soon it needs an
> answer. Resolved items are recorded in `design-decisions.md` (D1–D27), not here.

Status legend: 🔵 decidable now (no LSP dependency) · 🟡 needs Phase B context · ⚪ known issue / polish

---

## A. Config & schema — ✅ all resolved

- **A1 — Position model.** ✅ Resolved (D28). 4-tier resolution: state pin
  (gitignored, personal) ▸ intent pin (committed, exact default) ▸ intent zone
  (committed, soft) ▸ force-directed. App writes pins only to state; save records
  deviations only. State file gitignored. *Sub-flag deferred to Phase B:* whether
  `dismissed` should be committed (team) rather than personal.

- **A2 — `depth_ceiling` default.** ✅ Resolved. `None` → conservative built-in
  cap of **2**. Baked in for Phase B; inert now.

- **A3 — `snap_levels` override multipliers.** ✅ Resolved. Stays gone —
  frontend tuning lives in `constants.js`; revisit only if the zoom-threshold LOD
  model becomes active *and* a project needs custom banding.

- **A4 — Symbol-binding syntax.** ✅ Resolved. `::` separator, uniform for the
  whole symbol path (`file.rs::Outer::Inner::method`); file→symbol boundary is the
  first `::`. Overload/ambiguity disambiguation deferred to Phase B (surface as an
  ambiguity case, don't invent index syntax now).

---

## B. Rendering & UX — known issues ⚪

- **B1 — Edge endpoint resolution at LOD > 0 (was Q1).** `getMostSpecificVisible`
  descends to `children[0]`; it should pick the child closest to the edge's other
  endpoint (or most semantically relevant). Affects how morphed edges look when
  zoomed in. (design-decisions.md Q1, D13)

- **B2 — YAML key-order churn (was Q2).** `serde_yaml` reorders keys on save.
  Largely mitigated by the split (the intent file is now rarely written), but a
  stable/ordered serializer would make the occasional intent diff clean. *Lean:
  add a deterministic key order when it starts to matter.* (Q2)

- **B3 — `centerGraph` resets zoom on resize (was Q5).** Re-centres on every
  window resize, discarding pan/zoom. Jarring once you've navigated deep. *Lean:
  skip re-centre if the user has interacted / zoomed past LOD 0.* (Q5)

- **B4 — Edge bundling & coarse/fine decluttering.** When many descendant edges
  collapse onto the same visible proxy-pair, render one bundled/counted edge and
  fan out on zoom; optionally hide a coarse hand-drawn edge once finer edges
  supersede it. Runtime rendering feature, not a config field. (config-architecture.md §7, §12)

---

## C. LOD semantics with derived nodes 🟡

- **C1 — How derived depth counts toward LOD tiers.** Settled: reveal = tree
  depth, style = kind (D24). Still to pin down once LSP children exist: when a
  branch mixes authored levels and machine-derived levels, does global expand (E)
  treat them uniformly, and how does `depth_ceiling` gate the derived tail during
  a global expand vs a per-node dive? (config-architecture.md §7, §11)

- **C2 — Kind-based frontend styling.** Frontend currently styles by `level`
  (level-0 big, level-1+ small). D24 wants style by `kind` (concept/dir/file/
  symbol). Deferred until derived nodes exist to differentiate — but it's a
  frontend-only change that could land earlier if desired. (D24)

---

## D. Phase B scope (LSP integration) 🟡

Each is additive on the Phase A shape; listed so scope doesn't creep.

- **D1 — Cache file + `source_hash` invalidation.** `.vgraphtree/lsp-cache.yaml`
  writer/reader, staleness stamp, warm-start load path.
- **D2 — `derive_children` wired to an LSP scan.** Currently parsed but inert.
- **D3 — Server-side staleness / rebind loop.** Resolve every `source` against
  real code; surface dangling bindings for re-bind; `vgraphtree check` as a CLI
  entrypoint over the same logic.
- **D4 — Ghost nodes + `dismissed` enforcement.** Suggestion surface; the
  `dismissed` list exists in the schema but nothing populates or honours it yet.
- **D5 — Derived-id stability across renames.** Accepted as fragile; mitigated by
  gitignoring the cache and the rebind loop, not by fingerprinting. Revisit if
  rename churn proves painful.
- **D6 — LSP client, lasso grouping, WebSocket push.** Larger Phase 2 items from
  `plan.md` §13.

---

## E. Migration tail / housekeeping ⚪

- **E1 — Formal unit tests.** ✅ Done — 9 tests (parse/serialize round-trip,
  sparse anchor, level/kind derivation, edge-id derivation, derive_children
  round-trip, state round-trip). Kept here as the record.

- **E5 — Routing bug fixed (D29).** ✅ Found while verifying A1: axum-0.7 param
  routes must use `:id` not `{id}`, and static files must be a `fallback_service`
  not `nest_service("/")`. Before the fix, node rename/pin and edge annotation
  returned 405 and never persisted. Now working; corrected D7 in design-decisions.

- **E2 — UI node/edge creation paths.** `create_node`/`create_edge` still exist
  and work but the frontend doesn't use them (nodes added via YAML). When UI
  creation lands, ensure it sets `kind`/`derive_children`/`label_overridden`
  correctly and routes new pins to the state file.

- **E3 — README accuracy.** README may still reference the old single-file schema
  / field set; update once the config model settles publicly.

- **E4 — `plan.md` divergence.** `plan.md` documents the prototype and now carries
  "superseded" banners pointing at `config-architecture.md`. Decide whether to
  eventually fold the goal-state back into `plan.md` or keep the split.

---

## F. Composition (nested configs) — deferred beyond v1 🟡

v1 shipped (eager load, read-only nested, mount-level cross edges — D30–D33,
`config-architecture.md` §11). Deferred:

- **F1 — Lazy include loading.** The real scale win: mounts load their inner map
  on expand instead of eagerly at startup, so a big org map never materializes
  thousands of nodes at once. Needs an on-demand fetch/merge path.
- **F2 — Per-file edit/save routing.** Make nested content editable in the composed
  view, routing each change to its owning config file (generalizes `intent_dirty`
  to per-file). Currently nested is read-only.
- **F3 — Fine-grained cross-project edges.** Outer edges that reference namespaced
  inner ids (`auth/X → billing/Y`); v1 connects only at the mount boundary.
- **F4 — Auto-discovery.** Optionally mount any `source:` dir that contains a
  `vgraphtree.yaml`, without an explicit `include`.
- **F5 — Unpinned-mount drift.** A rigid nested cluster under a force-directed mount
  drifts from it; fine when mounts are anchored (the common case). Revisit if it
  bites — likely a "move the cluster with the mount" tick force.
