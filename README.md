

major issues to resolve first
- [x] pins arent rendered correctly; there's a root cause that i can't infer from the behaviour, so i list the symptoms:
    - [x] dragging a pinned node doesnt do anything, until i refresh the page
        - ROOT CAUSE FOUND + FIXED: the drag-threshold change moved sim-reheating
          into the `dragged` handler but kept a `!event.active` guard — and inside
          a drag the gesture is already active, so that guard was always false and
          the simulation never reheated. A non-expanded node (e.g. a pinned
          top-level node) only re-renders via the sim tick, so it appeared frozen
          until a refresh. Removed the guard. (verify in a real browser)
    - [x] refreshing the page with unsaved changes saves them for some reason?
        - EXPLAINED (not a bug): the backend holds edits in memory across a page
          reload; only Ctrl+S writes to disk. The reload re-fetches the in-memory
          graph, so it looks "saved". Use /reload to actually re-read from disk.
    - [x] when a pinned node is expanded, the container isnt pinned anywhere (should be pinned where the parent was, and it can scale with its content but not move)
        - FIXED: a pinned container's box is now grown symmetrically around the
          parent pin (box x = -w/2, y = -h/2 relative to the parent), so its centre
          stays on the pin and it only scales with its contents — it can't drift as
          children shuffle. (verified: rect is centred on the parent; confirm the
          feel in a real browser)
    - NOTE: drag/pin visual behaviour can't be verified in the headless preview
      (it freezes d3 transitions and reports the canvas as 0×0). Please confirm the
      drag fix in a real browser.
- [~] containers should never be allowed to overlap (unless two containers can contain the same node, but im not sure if that's even possible)
- [~] containers should probably not be allowed to overlap with external nodes either
    - REWORKED (see the runaway-growth fix below): the earlier collide-radius
      approach caused unbounded container growth, so it was reverted. Separation now
      comes from (a) each container's *children* being real sim nodes with their own
      collide radius (external nodes can't enter), and (b) a static, descendant-count
      based container charge that pushes containers apart. This is softer than hard
      rect-vs-rect collision — corners can still touch — but it doesn't run away.
      Tune CHARGE_CONTAINER_PER_DESC if separation needs to be stronger. Needs live
      confirmation. (Overlapping membership isn't possible — the tree is strict.)
- [x] scroll to zoom the d3 canvas works only when the mouse is in the middle (ish) of the screen, at least when using a trackpad
    - [x] somehow scroll to zoom doesnt work when first loading the page, until some nodes are expanded (i think, not sure how to reproduce)
    - ROOT CAUSE (same bug as the container growth below): the wheel handler on
      every node called `stopPropagation()` unconditionally, so zoom was dead over
      any visible node. The non-rectangular "dead zone" was the union of node/
      container rects — and a runaway-huge container (see below) made it cover most
      of the screen and shift unpredictably. FIXED: plain scroll now bubbles to the
      d3 zoom (works everywhere, incl. over nodes — verified); per-node expand moved
      to Alt+scroll so the two gestures don't collide (E/C still do global LOD).
    - FOLLOW-UP (empty-canvas dead spots) — REAL ROOT CAUSE per the d3-zoom docs:
      d3-zoom binds its wheel/drag listeners to <svg>, but "an SVG only receives
      pointer events where something is painted." Empty canvas paints nothing, so
      scroll there reached no listener. `display: block` alone didn't fix it. FIX
      (the documented one): a full-viewport transparent `<rect>` (fill:none,
      pointer-events:all) under the content — it paints the whole viewport so
      empty-area events reach the zoom, while nodes on top still get their own.
      Confirm zoom-over-empty in a real browser.
- [x] focusing a node currently shuffles all the content a *lot*, even if no edges are revealed
    - fixed: focus now reheats the simulation gently (alpha 0.2 via FOCUS_REHEAT_ALPHA)
      instead of the full alpha=1 relayout used for expand/collapse. Verify the
      reduced motion in a real browser.
- [x] no error/warning for broken file links unless i explicitly try to open the file: surfacing these would help agents a lot
    - fixed: backend flags `source_missing` per node (checks the path on disk at
      load/reload); UI draws those nodes with an orange dashed border + orange label.
- [x] E/C for expanding/collapsing doesnt saturate at the minimum/maximum available LoD
    - fixed: expandedDepth is now treated as boolean; E advances the outer frontier
      and C retracts the inner frontier, so both saturate cleanly (verified: E stops
      once fully expanded, C once fully collapsed, E…C…C returns to start).

minor issues to resolve soon:
- [x] edge annotation hitboxes are too small
    - fixed: widened the edge click target (12→20px) and made the annotation label
      itself clickable (it can float off the line via its phantom node).


known issues remaining:
- [~] edge labels (phantom nodes) can still overlap container rects — label repulsion
      only models real nodes, not container boundaries; label nodes should also be
      pushed away from container-rect fills
    - PARTIALLY MITIGATED by the container collide-radius fix above (labels now
      collide with the container's bounding circle), but not a full rect-boundary
      solution. Needs live confirmation.


to-do now:
- [x] re-parse config file without restarting the backend (SIGHUP or /reload endpoint)
    - done: `POST /reload` re-parses the intent + state files and swaps the in-memory
      graph (verified). Discards unsaved in-memory edits by design.
- [x] dragging should be registered as shift-drag based on whether shift is held when drag is released, not started
    - done: pin-vs-release is now decided from the Shift state at drag end.


needs further thinking or planning:
- [ ] restyle HUD / top bar
- [ ] change theme
- [ ] undo history (ctrl/cmd+Z / ctrl/cmd+Y)
- [ ] diff-like config changes saved to a side-file before overwriting original,
      so changes can be reverted after saving or restarting the backend


done:
- [x] E/C saturation, broken-source surfacing, /reload endpoint, shift-drag at
      release, edge-annotation hitbox, focus-shuffle mitigation
- [x] container "infinitely growing" bug — ROOT CAUSE: container charge/collide
      were derived from the *live rendered bounds*, so size fed back into the force
      that set the size (bigger box → stronger push → bigger box → …). Fixed by
      deriving the container charge from a child COUNT and removing the
      bounds-derived collide radius. (verified: backend container width is stable
      across repeated refreshes instead of compounding)
- [x] nested container over-inflated (e.g. "rust backend" much bigger than flat
      "web frontend" despite fewer nodes) — the charge counted *recursive
      descendants*, so a sub-container's children were repelled by every ancestor's
      charge and compounded. Fixed by counting DIRECT visible children only, and
      lowering the floor. (verified: backend container 794×1215 → 432×415, now
      proportional to frontend 350×325)
- [x] scroll-zoom dead over nodes — same root theme: wheel events were swallowed
      by an unconditional stopPropagation. Plain scroll now zooms anywhere;
      per-node expand is Alt+scroll. (verified: zoom fires over a node)
- [x] pin-drag regression (sim never reheated inside the drag handler)
- [~] container-overlap collide radius + label/container mitigation (best-effort,
      needs live confirmation)
- [x] dev-server no-cache headers (browser was serving stale JS/CSS on reload,
      which masked edits — `Cache-Control: no-cache` on all responses)

remaining (need your real browser — the headless preview freezes d3 transitions
and reports a 0×0 canvas, so animated/pointer/zoom behaviour can't be verified):
- pinned-container anchoring on expand
- scroll-zoom mid-screen / first-load
- rect-vs-rect (not circle-approx) container separation + label boundaries
Everything above is code-complete; these need a reproduce-and-confirm loop in a
real browser.
