// ─── Config schema ────────────────────────────────────────────────────────────
// Single source of truth for the personal config: it drives BOTH the config
// panel UI and the validation (the "LSP-style" hints). Exposing a new setting is
// one entry here — plus a `setTunable` case in constants.js for `target:'const'`.
//
// Numeric `target:'const'` defaults are pulled straight from constants.js (via the
// `C` import) so the panel can never drift from the code defaults. enum/colour
// defaults are literals (colours must match the :root CSS variables).
//
// Field shape:
//   key      dotfile key (also the constant name for target:'const')
//   label    panel label
//   type     'enum' | 'number' | 'color'
//   default  default value (dotfile overrides it)
//   target   where a valid value is applied:
//              'engine' → setLayoutEngine, 'colaMode' → setColaMode,
//              'const'  → setTunable (live layout/physics param),
//              'color'  → sets the CSS variable `cssVar`
//   help     tooltip / description
//   type-specific: enum[], min/max/step (number), cssVar (color)

import * as C from './constants.js';

// Shorthand for a live-tunable numeric field (default sourced from constants.js).
const num = (key, label, min, max, step, help) =>
  ({ key, label, type: 'number', min, max, step, default: C[key], target: 'const', help });

export const CONFIG_SCHEMA = [
  {
    title: 'Engine',
    fields: [
      { key: 'engine',   label: 'Default engine', type: 'enum', enum: ['force', 'cola'], default: 'force', target: 'engine',   help: 'Layout engine used on load.' },
      { key: 'colaMode', label: 'Cola mode',      type: 'enum', enum: ['layered', 'radial', 'stress'], default: 'layered', target: 'colaMode', help: 'Cola layout mode (layered / radial / stress).' },
    ],
  },
  {
    title: 'Layout · Cola',
    fields: [
      num('COLA_LINK_LENGTH',         'Link length',       10, 2000, 10,  'Ideal edge length — overall graph scale.'),
      num('COLA_NODE_PAD',            'Node padding',      0,  400,  4,   'Minimum clearance kept around every node.'),
      num('COLA_FLOW_GAP',            'Layer gap',         0,  600,  10,  'Vertical separation between layers (layered/radial).'),
      num('COLA_LINK_LENGTH_JACCARD', 'Jaccard weight',    0,  1,    0.05, 'Neighbourhood-overlap weighting for link lengths.'),
      num('COLA_LABEL_OFFSET',        'Label offset',      0,  200,  2,   'Perpendicular offset of an edge label off its line.'),
      num('COLA_LABEL_MID_BAND',      'Label band',        0,  1,    0.02, 'Central fraction of an edge a label may sit in.'),
      num('COLA_RADIAL_SPAN',         'Radial span',       0,  1,    0.02, 'Fraction of a full turn the radial fan spans.'),
      num('COLA_ANIM_MS_FULL',        'Anim ms (full)',    0,  3000, 50,  'Tween duration for a full relayout.'),
      num('COLA_ANIM_MS_GENTLE',      'Anim ms (gentle)',  0,  3000, 50,  'Tween duration for a gentle re-solve.'),
    ],
  },
  {
    title: 'Physics · force',
    fields: [
      num('CHARGE_PER_EDGE',           'Charge / edge',     -10000, 0,   50,   'Repulsion added per incident edge (negative).'),
      num('CHARGE_ISOLATED',           'Charge (isolated)', -5000,  0,   10,   'Repulsion for a node with no visible edges.'),
      num('CHARGE_CONTAINER_PER_CHILD','Charge / child',    -5000,  0,   50,   'Container repulsion per direct child (negative).'),
      num('CHARGE_CONTAINER_MIN',      'Charge (container)',-20000, 0,   100,  'Minimum container repulsion (floor, negative).'),
      num('CHARGE_DISTANCE_MAX',       'Charge range',      0,      10000, 50, 'Max distance charge acts over (local separator).'),
      num('LINK_DIST_PARENT',          'Parent rest len',   0,      5000, 20,  'Spring rest length for parent → child links.'),
      num('LINK_DIST_EDGE',            'Edge rest len',     0,      5000, 20,  'Spring rest length for semantic edges.'),
      num('LINK_STRENGTH_PARENT',      'Parent stiffness',  0,      1,    0.001, 'Parent → child spring stiffness.'),
      num('LINK_STRENGTH_EDGE',        'Edge stiffness',    0,      1,    0.001, 'Exposed semantic edge spring stiffness.'),
      num('LINK_STRENGTH_UNEXPOSED',   'Faded stiffness',   0,      1,    0.001, 'Unexposed (faded) edge spring stiffness.'),
      num('NODE_COLLISION_MARGIN',     'Node collision margin', 0,  1000, 5,   'Clearance added around a node’s own (text-fit) box for collision.'),
      num('COLLISION_ITERATIONS',      'Collision iters',   1,      10,   1,   'Collision solver passes per tick.'),
      num('COLLIDE_STRENGTH',          'Collide strength',  0,      1,    0.05, 'Grouped-collision overlap resolved per tick.'),
      num('VELOCITY_DECAY',            'Velocity decay',    0,      1,    0.05, 'Friction (0 = none, 1 = frozen).'),
      num('CENTER_STRENGTH',           'Center gravity',    0,      1,    0.001, 'Pull toward viewport centre.'),
      num('ZONE_STRENGTH',             'Zone strength',     0,      1,    0.01, 'Pull toward a node’s named zone.'),
      num('PARENT_PIN_STRENGTH',       'Parent-pin pull',   0,      1,    0.01, 'Pull of children toward a pinned parent.'),
      num('ALPHA_DECAY',               'Alpha decay',       0,      1,    0.005, 'How fast the sim cools/settles.'),
      num('LABEL_PULL_STRENGTH',       'Label pull',        0,      1,    0.05, 'Pull of a label toward its edge midpoint.'),
      num('LABEL_DECLUTTER_STRENGTH',  'Label declutter',   0,      1,    0.05, 'Push of a label out of foreign containers.'),
    ],
  },
  {
    title: 'Rendering',
    fields: [
      num('CONTAINER_PAD',       'Container padding', 0, 200, 4,   'Padding inside a container box.'),
      num('CONTAINER_LABEL_H',   'Container label h', 0, 80,  2,   'Height reserved for a container’s label.'),
      num('CONTAINER_MARGIN',    'Container margin',  0, 200, 4,   'Extra clearance folded into a container’s radius.'),
      num('EXPAND_JITTER',       'Expand jitter',     0, 200, 5,   'Scatter applied to newly revealed children.'),
      num('LABEL_RADIUS_MIN',    'Label radius min',  0, 200, 5,   'Minimum phantom-label collision radius.'),
      num('LABEL_RADIUS_PER_CHAR','Label radius/char',0, 20,  0.5, 'Added label radius per annotation character.'),
      num('CENTER_PAD',          'Fit padding',       0, 600, 20,  'Padding around the graph when fitting to screen.'),
      num('CENTER_FIT_MARGIN',   'Fit margin',        0, 1,   0.05, 'Scale factor after fitting (keeps a margin).'),
      num('EDGE_PARALLEL_GAP',   'Parallel edge gap', 0, 100, 2,   'Spacing between edges connecting the same node pair (0 = overlap).'),
      { key: 'declutter_labels', label: 'Declutter labels', type: 'bool', default: true, target: 'declutter', help: 'Nudge edge labels off nodes they would overlap (off = keep labels pinned to their edge).' },
      num('NODE_TEXT_PAD',       'Node text padding', 0, 100, 2,   'Padding added each side of a node’s label when sizing its box.'),
      num('NODE_MAX_W',          'Node max width',    50, 2000, 10, 'Cap on a node’s box width, however long its label is.'),
    ],
  },
  {
    title: 'Focus',
    fields: [
      num('SPARSE_EDGE_RATIO',  'Sparse ratio',   0, 5, 0.1,  'Edges ≤ this × nodes → graph shows all edges (focus off).'),
      num('FOCUS_REHEAT_ALPHA', 'Focus reheat',   0, 1, 0.05, 'Relayout energy when toggling / clearing focus.'),
      num('DIM_EDGE_OPACITY',   'Faded edge opacity', 0, 1, 0.05, 'Opacity of dim / unfocused edges (0 = invisible, 1 = same as exposed).'),
    ],
  },
  {
    title: 'Nodes',
    fields: [
      { key: 'node_desc_mode', label: 'Descriptions', type: 'enum', enum: ['inline', 'hover'], default: 'hover', target: 'nodeDescMode', help: 'Show node descriptions inline (caption under the node) or only in a popup on hover.' },
      { key: 'hover_delay',    label: 'Hover delay (ms)', type: 'number', min: 0, max: 3000, step: 50, default: 500, target: 'hoverDelay', help: 'How long the mouse must be still over a node/edge before its description popup appears.' },
    ],
  },
  {
    // These target the theme CSS variables (see :root in style.css), so setting
    // one live-recolours everything that references it. Defaults MUST match :root.
    title: 'Colours',
    fields: [
      { key: 'color_bg',         label: 'Background',    type: 'color', cssVar: '--bg-base',    default: '#1d2021', target: 'color', help: 'Canvas background.' },
      { key: 'color_accent',     label: 'Nodes / edges', type: 'color', cssVar: '--accent',     default: '#fe8019', target: 'color', help: 'Primary colour — level-0 nodes, edges, arrows.' },
      { key: 'color_sub',        label: 'Sub-nodes',     type: 'color', cssVar: '--teal',       default: '#83a598', target: 'color', help: 'Level-1+ nodes.' },
      { key: 'color_pin',        label: 'Pinned',        type: 'color', cssVar: '--gold',       default: '#fabd2f', target: 'color', help: 'Pinned / LOD-target highlight.' },
      { key: 'color_focus',      label: 'Focus ring',    type: 'color', cssVar: '--focus',      default: '#d3869b', target: 'color', help: 'Focused-node ring.' },
      { key: 'color_edge_dim',   label: 'Faded edge',    type: 'color', cssVar: '--edge-dim',   default: '#fe8019', target: 'color', help: 'Colour of dim / unfocused edges.' },
      { key: 'color_edge_label', label: 'Edge label',    type: 'color', cssVar: '--edge-label', default: '#a89984', target: 'color', help: 'Edge annotation text colour.' },
    ],
  },
];

export function allFields()      { return CONFIG_SCHEMA.flatMap(s => s.fields); }
export function fieldByKey(key)  { return allFields().find(f => f.key === key); }

// Coerce a raw input to the field's value type.
export function coerce(f, raw) {
  if (f.type === 'number') return raw === '' ? NaN : Number(raw);
  if (f.type === 'bool')   return raw === true || raw === 'true';
  return raw;
}

// Validate a value against a field. Returns null if OK, else an error message
// (used verbatim as the LSP-style hint under the field).
export function validateField(f, value) {
  switch (f.type) {
    case 'enum':
      return f.enum.includes(value) ? null : `expected one of: ${f.enum.join(', ')}`;
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (value === '' || value == null || Number.isNaN(n)) return 'expected a number';
      if (f.min != null && n < f.min) return `must be ≥ ${f.min}`;
      if (f.max != null && n > f.max) return `must be ≤ ${f.max}`;
      return null;
    }
    case 'color':
      return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value)) ? null : 'expected a hex colour, e.g. #d79921';
    case 'bool':
      return typeof value === 'boolean' ? null : 'expected true or false';
    default:
      return null;
  }
}
