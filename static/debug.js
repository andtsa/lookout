// ─── Force debug overlay ──────────────────────────────────────────────────────
// d3-force has no built-in visualiser (forces mutate node velocities in place),
// so this draws what the sim is doing, to make tuning tractable:
//   • velocity vectors  — orange arrows; length ∝ how fast a node is moving.
//     Persistent wiggling arrows = jitter/instability; no arrows = settled.
//   • collision radii   — faint circles of COLLISION_RADIUS around each node.
//   • target lines      — dashed line from each node to its positional anchor
//     (pin / zone / parent-pin), with a dot at the target.
//   • α + vmax readout  — the sim "temperature" and peak node speed (HUD).
// Toggle with the `D` key. Drawn every tick while on.

import { nodes, debugLayer, simulation } from './state.js';
import { COLLISION_RADIUS } from './constants.js';
import { zoneToCoords, containerCenter, containerRadius } from './geometry.js';
import { isNodeVisible } from './lod.js';

const VEL_SCALE = 8; // px drawn per unit of per-tick velocity

// The dominant positional target a node is pulled toward, if any.
function targetOf(n) {
  if (n.pin)  return { x: n.pin.x, y: n.pin.y, kind: 'pin' };
  if (n.zone) { const t = zoneToCoords(n.zone); return { x: t.x, y: t.y, kind: 'zone' }; }
  const p = n.parent && nodes[n.parent];
  if (p && p.pin) return { x: p.pin.x, y: p.pin.y, kind: 'parent' };
  return null; // only weak center gravity — not worth drawing
}

export function renderDebug() {
  const vis = Object.values(nodes).filter(isNodeVisible);

  // Collision circles — the grouped-collision size of each element (node radius,
  // or the container's box circle at its box centre).
  const isC = d => d.expandedDepth > 0 && d.containerBounds;
  const cx = d => isC(d) ? containerCenter(d.containerBounds).x : d.x;
  const cy = d => isC(d) ? containerCenter(d.containerBounds).y : d.y;
  const cr = d => isC(d) ? containerRadius(d.containerBounds) : COLLISION_RADIUS;
  const coll = debugLayer.selectAll('circle.dbg-collide').data(vis, d => d.id);
  coll.enter().append('circle').attr('class', 'dbg-collide')
    .merge(coll)
    .attr('cx', cx).attr('cy', cy).attr('r', cr);
  coll.exit().remove();

  // Target lines + dots (pin / zone / parent-pin).
  const targeted = vis.map(d => ({ d, t: targetOf(d) })).filter(o => o.t);
  const tline = debugLayer.selectAll('line.dbg-target').data(targeted, o => o.d.id);
  tline.enter().append('line').attr('class', 'dbg-target')
    .merge(tline)
    .attr('x1', o => o.d.x).attr('y1', o => o.d.y)
    .attr('x2', o => o.t.x).attr('y2', o => o.t.y)
    .attr('data-kind', o => o.t.kind);
  tline.exit().remove();

  const tdot = debugLayer.selectAll('circle.dbg-target-dot').data(targeted, o => o.d.id);
  tdot.enter().append('circle').attr('class', 'dbg-target-dot')
    .merge(tdot)
    .attr('cx', o => o.t.x).attr('cy', o => o.t.y).attr('r', 4)
    .attr('data-kind', o => o.t.kind);
  tdot.exit().remove();

  // Velocity vectors (drawn last so they sit on top).
  const vel = debugLayer.selectAll('line.dbg-vel').data(vis, d => d.id);
  vel.enter().append('line').attr('class', 'dbg-vel').attr('marker-end', 'url(#dbg-arrow)')
    .merge(vel)
    .attr('x1', d => d.x).attr('y1', d => d.y)
    .attr('x2', d => d.x + (d.vx || 0) * VEL_SCALE)
    .attr('y2', d => d.y + (d.vy || 0) * VEL_SCALE);
  vel.exit().remove();

  updateDebugHud(vis);
}

function updateDebugHud(vis) {
  const el = document.getElementById('debug-indicator');
  if (!el) return;
  const alpha = simulation ? simulation.alpha() : 0;
  let vmax = 0;
  for (const n of vis) vmax = Math.max(vmax, Math.hypot(n.vx || 0, n.vy || 0));
  el.textContent = `α ${alpha.toFixed(3)} · vmax ${vmax.toFixed(2)}`;
}

// Clear the overlay when debug is turned off mid-settle.
export function clearDebug() {
  debugLayer.selectAll('*').remove();
}
