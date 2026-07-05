use crate::kinds::{EdgeKind, NodeKind};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Zone {
    Top,
    Bottom,
    Left,
    Right,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    Center,
}

/// Resolved runtime node. Distinct from the on-disk `IntentNode` (config.rs):
/// `level` is computed from tree depth, `label`/`kind` are resolved from intent
/// or derived, and `pin` is applied from the state file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub label: String,
    pub level: u32,
    pub kind: NodeKind,
    pub parent: Option<String>,
    pub source: Option<String>,
    pub zone: Option<Zone>,
    /// Effective pin: the state-file override if present, else the intent default.
    pub pin: Option<Position>,
    /// The committed default pin authored in the intent file. Kept so save can
    /// write only *deviations* to the state file and re-emit the default intact.
    #[serde(skip)]
    pub intent_pin: Option<Position>,
    /// True when `pin` came from the state file (an explicit/personal position),
    /// not the intent default. The frontend uses this to avoid re-auto-placing a
    /// nested node the user has manually moved.
    #[serde(default)]
    pub pin_from_state: bool,
    pub children: Vec<String>,
    /// Opt-in flag to populate children from LSP. Inert until the LSP layer
    /// exists; carried here so it round-trips through save.
    #[serde(default)]
    pub derive_children: bool,
    /// false = authored (intent file), true = machine-derived (cache/LSP).
    #[serde(default)]
    pub derived: bool,
    /// Spliced in from another config via a mount `include`. Read-only in the
    /// composed view. Serialized so the frontend can gate editing / show a cue.
    #[serde(default)]
    pub nested: bool,
    /// Mount point: this node delegates its subtree to the referenced inner
    /// config. Kept so `save` re-emits `include:` instead of the nested subtree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<String>,
    /// True when `source` is set but the path doesn't exist on disk — surfaced
    /// in the UI so broken bindings are visible without opening the file.
    #[serde(default)]
    pub source_missing: bool,
    /// True when the intent file carried an explicit `label:` key. Absence means
    /// "follow the code" — used to decide whether to emit a label on save.
    #[serde(skip)]
    pub label_overridden: bool,
    #[serde(skip)]
    pub dirty: bool,
}

/// Resolved runtime edge. `id` is always present (derived `{from}__{to}` when
/// the intent file omitted it); `id_derived` records that so save can omit it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub annotation: Option<String>,
    pub kind: EdgeKind,
    #[serde(skip)]
    pub id_derived: bool,
}

#[derive(Debug)]
pub struct NodeGraph {
    pub nodes: HashMap<String, Node>,
    pub edges: HashMap<String, Edge>,
    /// Any unsaved change (drives the UI dirty indicator).
    pub dirty: bool,
    /// A *semantic* change (label, annotation, structure) is pending — the intent
    /// file needs rewriting on save. Position changes set `dirty` but NOT this, so
    /// dragging a node saves only to the state file and never touches intent.
    pub intent_dirty: bool,
}

impl NodeGraph {
    pub fn new() -> Self {
        NodeGraph {
            nodes: HashMap::new(),
            edges: HashMap::new(),
            dirty: false,
            intent_dirty: false,
        }
    }
}
