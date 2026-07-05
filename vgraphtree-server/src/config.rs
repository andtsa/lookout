// The human-intent file (`vgraphtree.yaml`).
//
// On-disk types are deliberately sparse — `level` is derived from nesting depth,
// `kind` is inferred from the binding, provenance comes from file location + key
// presence (no `origin` flag), and positions live in the state file. See
// config-architecture.md for the full model.

use crate::graph::{Edge, Node, NodeGraph, Position, Zone};
use crate::kinds::{EdgeKind, NodeKind};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Resolve `project.root` relative to the config file's own directory, so that
/// `source:` links resolve correctly no matter what the current working
/// directory is. The authored `project.root` (usually `.`) is left untouched for
/// serialization — this is only for filesystem lookups.
pub fn resolved_root(config_path: &str, project: &ProjectConfig) -> PathBuf {
    Path::new(config_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .join(&project.root)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectConfig {
    pub root: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lsp: Option<HashMap<String, String>>,
    /// How deep LSP auto-derives *below* an authored node. Not a limit on
    /// authoring depth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth_ceiling: Option<u32>,
}

/// A node as written to disk (nested). Every field is optional except identity,
/// which is the map key. See `flatten_node` for how it resolves to a `Node`.
#[derive(Debug, Serialize, Deserialize)]
pub struct IntentNode {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<NodeKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zone: Option<Zone>,
    /// Committed exact-position default. Hand-authored; the app never rewrites it
    /// (drag/pin writes go to the state file). Overridden by a state-file pin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<Position>,
    /// Mount point: delegate this node's subtree to the referenced inner
    /// `vgraphtree.yaml` (path relative to this config's directory).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub derive_children: bool,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub children: HashMap<String, IntentNode>,
}

/// An edge as written to disk (flat list). `id` is omitted when derivable and
/// `kind` is omitted when `Semantic` (the hand-drawn default).
#[derive(Debug, Serialize, Deserialize)]
pub struct IntentEdge {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<EdgeKind>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IntentConfig {
    pub project: ProjectConfig,
    #[serde(default)]
    pub nodes: HashMap<String, IntentNode>,
    #[serde(default)]
    pub edges: Vec<IntentEdge>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

// ─── Parse ──────────────────────────────────────────────────────────────────

pub fn parse_intent(yaml_str: &str) -> Result<(NodeGraph, ProjectConfig), serde_yaml::Error> {
    let config: IntentConfig = serde_yaml::from_str(yaml_str)?;

    let mut graph = NodeGraph::new();

    for (id, node) in &config.nodes {
        flatten_node(id, node, None, 0, &mut graph);
    }

    mark_missing_sources(&mut graph, &config.project.root);

    for intent_edge in &config.edges {
        let id_derived = intent_edge.id.is_none();
        let id = intent_edge
            .id
            .clone()
            .unwrap_or_else(|| derived_edge_id(&intent_edge.from, &intent_edge.to, &graph));

        let edge = Edge {
            id: id.clone(),
            from: intent_edge.from.clone(),
            to: intent_edge.to.clone(),
            annotation: intent_edge.annotation.clone(),
            kind: intent_edge.kind.clone().unwrap_or_default(),
            id_derived,
        };
        graph.edges.insert(id, edge);
    }

    Ok((graph, config.project))
}

fn flatten_node(
    id: &str,
    intent: &IntentNode,
    parent: Option<String>,
    level: u32,
    graph: &mut NodeGraph,
) {
    let child_ids: Vec<String> = intent.children.keys().cloned().collect();
    let label_overridden = intent.label.is_some();

    let node = Node {
        id: id.to_string(),
        label: intent.label.clone().unwrap_or_else(|| id.to_string()),
        level,
        kind: intent
            .kind
            .clone()
            .unwrap_or_else(|| NodeKind::infer(intent.source.as_deref())),
        parent: parent.clone(),
        source: intent.source.clone(),
        zone: intent.zone.clone(),
        // Effective pin starts at the intent default; a state-file pin overrides
        // it after parse (see main.rs).
        pin: intent.pin.clone(),
        intent_pin: intent.pin.clone(),
        pin_from_state: false, // set true in main.rs/reload.rs when state applies a pin
        children: child_ids,
        derive_children: intent.derive_children,
        derived: false,
        nested: false,
        include: intent.include.clone(),
        source_missing: false, // filled in by mark_missing_sources after flatten
        label_overridden,
        dirty: false,
    };

    graph.nodes.insert(id.to_string(), node);

    for (child_id, child) in &intent.children {
        flatten_node(child_id, child, Some(id.to_string()), level + 1, graph);
    }
}

/// Flag nodes whose `source` binding points at a path that doesn't exist on
/// disk (a symbol binding `file::sym` is checked by its file part). Resolved
/// relative to the project root so the UI can surface stale bindings.
fn mark_missing_sources(graph: &mut NodeGraph, root: &std::path::Path) {
    for node in graph.nodes.values_mut() {
        if let Some(src) = &node.source {
            let file_part = src.split("::").next().unwrap_or(src);
            node.source_missing = !root.join(file_part).exists();
        }
    }
}

// ─── Compose (nested includes) ────────────────────────────────────────────────

/// Load a config and recursively splice every `include:` mount into one composed
/// graph. Inner ids are namespaced under the mount, inner roots become the mount's
/// children, inner sources are rewritten to resolve against the outer root, and
/// inner content is flagged `nested` (read-only). Returns non-fatal warnings (e.g.
/// `include` + `children`); Err on read / parse / cycle failure.
pub fn compose(config_path: &str) -> Result<(NodeGraph, ProjectConfig, Vec<String>), String> {
    compose_inner(config_path, &mut Vec::new())
}

fn compose_inner(
    config_path: &str,
    chain: &mut Vec<PathBuf>,
) -> Result<(NodeGraph, ProjectConfig, Vec<String>), String> {
    let canon = std::fs::canonicalize(config_path).unwrap_or_else(|_| PathBuf::from(config_path));
    if chain.contains(&canon) {
        return Err(format!("include cycle detected at '{config_path}'"));
    }
    chain.push(canon);

    let yaml = std::fs::read_to_string(config_path)
        .map_err(|e| format!("cannot read '{config_path}': {e}"))?;
    let (mut graph, project) =
        parse_intent(&yaml).map_err(|e| format!("failed to parse '{config_path}': {e}"))?;

    let outer_root = resolved_root(config_path, &project);
    let config_dir = Path::new(config_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let mut warnings = Vec::new();

    // Snapshot mounts up front so the recursive splice doesn't borrow `graph`.
    let mounts: Vec<(String, String, bool)> = graph
        .nodes
        .values()
        .filter_map(|n| {
            n.include
                .as_ref()
                .map(|inc| (n.id.clone(), inc.clone(), !n.children.is_empty()))
        })
        .collect();

    for (mount_id, include_rel, had_children) in mounts {
        if had_children {
            warnings.push(format!(
                "node '{mount_id}': `include` and `children` both set — children ignored"
            ));
            let inline = graph
                .nodes
                .get(&mount_id)
                .map(|n| n.children.clone())
                .unwrap_or_default();
            remove_subtree(&mut graph, inline);
        }

        let inner_path = config_dir.join(&include_rel);
        let inner_path_str = inner_path.to_string_lossy().to_string();
        let (inner_graph, inner_project, inner_warnings) = compose_inner(&inner_path_str, chain)?;
        warnings.extend(inner_warnings);

        let inner_root = resolved_root(&inner_path_str, &inner_project);
        splice(&mut graph, &mount_id, inner_graph, &inner_root, &outer_root);
    }

    chain.pop();
    Ok((graph, project, warnings))
}

/// Splice an inner graph under `mount_id`: namespace ids, reparent inner roots to
/// the mount, offset levels, rewrite sources, and flag nodes `nested`.
fn splice(
    graph: &mut NodeGraph,
    mount_id: &str,
    mut inner: NodeGraph,
    inner_root: &Path,
    outer_root: &Path,
) {
    let prefix = format!("{mount_id}/");
    let ns = |id: &str| format!("{prefix}{id}");
    let mount_level = graph.nodes.get(mount_id).map(|n| n.level).unwrap_or(0);

    let mut inner_roots = Vec::new();
    for (_, mut node) in inner.nodes.drain() {
        let new_id = ns(&node.id);
        node.id = new_id.clone();
        node.level += mount_level + 1;
        node.nested = true;
        node.children = node.children.iter().map(|c| ns(c)).collect();
        node.parent = match node.parent {
            Some(p) => Some(ns(&p)),
            None => {
                inner_roots.push(new_id.clone());
                Some(mount_id.to_string())
            }
        };
        if let Some(src) = &node.source {
            node.source = Some(rewrite_source(src, inner_root, outer_root));
        }
        graph.nodes.insert(new_id, node);
    }

    for (_, mut edge) in inner.edges.drain() {
        edge.id = ns(&edge.id);
        edge.from = ns(&edge.from);
        edge.to = ns(&edge.to);
        graph.edges.insert(edge.id.clone(), edge);
    }

    if let Some(mount) = graph.nodes.get_mut(mount_id) {
        mount.children = inner_roots;
    }
}

/// Rewrite an inner `source` (relative to the inner root) so it resolves against
/// the outer root — relative when the inner tree is under the outer root, else an
/// absolute path (which `root.join` uses verbatim). Preserves any `::symbol` tail.
fn rewrite_source(src: &str, inner_root: &Path, outer_root: &Path) -> String {
    let (file_part, sym) = match src.split_once("::") {
        Some((f, s)) => (f, Some(s)),
        None => (src, None),
    };
    let inner_canon = inner_root
        .canonicalize()
        .unwrap_or_else(|_| inner_root.to_path_buf());
    let outer_canon = outer_root
        .canonicalize()
        .unwrap_or_else(|_| outer_root.to_path_buf());
    let abs = inner_canon.join(file_part);
    let rewritten = abs
        .strip_prefix(&outer_canon)
        .map(|p| p.to_path_buf())
        .unwrap_or(abs);
    let mut out = rewritten.to_string_lossy().replace('\\', "/");
    if let Some(sym) = sym {
        out.push_str("::");
        out.push_str(sym);
    }
    out
}

/// Remove a set of node subtrees (and any edges touching them) from the graph.
fn remove_subtree(graph: &mut NodeGraph, roots: Vec<String>) {
    let mut stack = roots;
    while let Some(id) = stack.pop() {
        if let Some(node) = graph.nodes.remove(&id) {
            stack.extend(node.children);
        }
        graph.edges.retain(|_, e| e.from != id && e.to != id);
    }
}

/// Deterministic id for an edge whose intent entry omitted one: `{from}__{to}`,
/// with `#N` suffixes for parallel edges between the same pair.
pub fn derived_edge_id(from: &str, to: &str, graph: &NodeGraph) -> String {
    let base = format!("{from}__{to}");
    if !graph.edges.contains_key(&base) {
        return base;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}#{n}");
        if !graph.edges.contains_key(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

// ─── Serialize ──────────────────────────────────────────────────────────────

/// Serialize the graph back to the intent file, omitting everything derived:
/// no `level`, no positions, sparse labels, inferred kinds, derived edge ids.
/// Machine-derived nodes/edges (Phase B) are skipped entirely.
pub fn serialize_intent(
    graph: &NodeGraph,
    project: &ProjectConfig,
) -> Result<String, serde_yaml::Error> {
    let mut nodes: HashMap<String, IntentNode> = HashMap::new();
    for node in graph.nodes.values() {
        if node.parent.is_none() && !node.derived && !node.nested {
            nodes.insert(node.id.clone(), build_intent_node(node, graph));
        }
    }

    let mut edges: Vec<IntentEdge> = graph
        .edges
        .values()
        .filter(|e| !is_derived_edge(e, graph) && !is_nested_edge(e, graph))
        .map(|e| IntentEdge {
            id: if e.id_derived {
                None
            } else {
                Some(e.id.clone())
            },
            from: e.from.clone(),
            to: e.to.clone(),
            annotation: e.annotation.clone(),
            kind: if e.kind == EdgeKind::Semantic {
                None
            } else {
                Some(e.kind.clone())
            },
        })
        .collect();

    // Stable order for readable diffs.
    edges.sort_by(|a, b| (&a.from, &a.to).cmp(&(&b.from, &b.to)));

    let config = IntentConfig {
        project: ProjectConfig {
            root: project.root.clone(),
            lsp: project.lsp.clone(),
            depth_ceiling: project.depth_ceiling,
        },
        nodes,
        edges,
    };

    serde_yaml::to_string(&config)
}

fn build_intent_node(node: &Node, graph: &NodeGraph) -> IntentNode {
    // A mount node emits `include:` and never inlines its (nested) subtree.
    let mut children: HashMap<String, IntentNode> = HashMap::new();
    if node.include.is_none() {
        for child_id in &node.children {
            if let Some(child) = graph.nodes.get(child_id) {
                if !child.derived && !child.nested {
                    children.insert(child_id.clone(), build_intent_node(child, graph));
                }
            }
        }
    }

    let inferred_kind = NodeKind::infer(node.source.as_deref());

    IntentNode {
        label: if node.label_overridden {
            Some(node.label.clone())
        } else {
            None
        },
        source: node.source.clone(),
        kind: if node.kind == inferred_kind {
            None
        } else {
            Some(node.kind.clone())
        },
        zone: node.zone.clone(),
        // Re-emit the committed default unchanged — personal overrides live in
        // the state file, never here.
        pin: node.intent_pin.clone(),
        include: node.include.clone(),
        derive_children: node.derive_children,
        children,
    }
}

/// An edge is derived if either endpoint is a machine-derived node — such edges
/// live in the cache, not the intent file.
fn is_derived_edge(edge: &Edge, graph: &NodeGraph) -> bool {
    let derived = |id: &str| graph.nodes.get(id).map(|n| n.derived).unwrap_or(false);
    derived(&edge.from) || derived(&edge.to)
}

/// An edge is nested if either endpoint came from an included config — it lives
/// in that inner file, not the outer one.
fn is_nested_edge(edge: &Edge, graph: &NodeGraph) -> bool {
    let nested = |id: &str| graph.nodes.get(id).map(|n| n.nested).unwrap_or(false);
    nested(&edge.from) || nested(&edge.to)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
project:
  root: .
  depth_ceiling: 2
nodes:
  a:
    label: A
    source: src/
    children:
      b: { label: B, source: src/b.rs }
      c: { source: "src/c.rs::sym" }   # no label → sparse anchor
edges:
  - { from: a, to: b, annotation: hi }
  - { id: custom, from: b, to: c, kind: import }
"#;

    fn parse(yaml: &str) -> NodeGraph {
        parse_intent(yaml).expect("parse").0
    }

    #[test]
    fn level_derived_from_depth() {
        let g = parse(SAMPLE);
        assert_eq!(g.nodes["a"].level, 0);
        assert_eq!(g.nodes["b"].level, 1);
        assert_eq!(g.nodes["c"].level, 1);
    }

    #[test]
    fn kind_inferred_from_binding_shape() {
        let g = parse(SAMPLE);
        assert_eq!(g.nodes["a"].kind, NodeKind::Dir);
        assert_eq!(g.nodes["b"].kind, NodeKind::File);
        assert_eq!(g.nodes["c"].kind, NodeKind::Symbol);
    }

    #[test]
    fn sparse_anchor_has_no_authored_label() {
        let g = parse(SAMPLE);
        // c had no label → falls back to id, and is not treated as overridden.
        assert_eq!(g.nodes["c"].label, "c");
        assert!(!g.nodes["c"].label_overridden);
        assert!(g.nodes["a"].label_overridden);
    }

    #[test]
    fn edge_id_derived_when_omitted() {
        let g = parse(SAMPLE);
        assert!(g.edges.contains_key("a__b"), "derived id present");
        assert!(g.edges["a__b"].id_derived);
        assert!(g.edges.contains_key("custom"), "explicit id preserved");
        assert!(!g.edges["custom"].id_derived);
        assert_eq!(g.edges["custom"].kind, EdgeKind::Import);
        assert_eq!(g.edges["a__b"].kind, EdgeKind::Semantic);
    }

    /// The load-bearing test: parse → serialize → parse must preserve the graph.
    #[test]
    fn roundtrip_preserves_graph() {
        let (g1, p1) = parse_intent(SAMPLE).unwrap();
        let yaml = serialize_intent(&g1, &p1).unwrap();
        let (g2, _) = parse_intent(&yaml).unwrap();

        assert_eq!(g1.nodes.len(), g2.nodes.len());
        assert_eq!(g1.edges.len(), g2.edges.len());
        for (id, n1) in &g1.nodes {
            let n2 = &g2.nodes[id];
            assert_eq!(n1.label, n2.label, "label {id}");
            assert_eq!(n1.level, n2.level, "level {id}");
            assert_eq!(n1.kind, n2.kind, "kind {id}");
            assert_eq!(n1.source, n2.source, "source {id}");
            assert_eq!(n1.parent, n2.parent, "parent {id}");
            assert_eq!(n1.label_overridden, n2.label_overridden, "override {id}");
        }
        for (id, e1) in &g1.edges {
            let e2 = &g2.edges[id];
            assert_eq!(e1.from, e2.from, "from {id}");
            assert_eq!(e1.to, e2.to, "to {id}");
            assert_eq!(e1.annotation, e2.annotation, "annotation {id}");
            assert_eq!(e1.kind, e2.kind, "kind {id}");
        }
    }

    /// Serialized intent must never leak derived fields.
    #[test]
    fn serialize_omits_derived_fields() {
        let (g, p) = parse_intent(SAMPLE).unwrap();
        let yaml = serialize_intent(&g, &p).unwrap();
        for field in ["level:", "origin:", "pin:", "levels:"] {
            assert!(!yaml.contains(field), "leaked `{field}` into intent output");
        }
        // sparse anchor c must not gain a label on save
        let reparsed: IntentConfig = serde_yaml::from_str(&yaml).unwrap();
        let c = &reparsed.nodes["a"].children["c"];
        assert!(c.label.is_none(), "sparse anchor gained a label");
    }

    #[test]
    fn derive_children_roundtrips() {
        let yaml = r#"
project: { root: . }
nodes:
  d:
    label: D
    source: src/
    derive_children: true
"#;
        let (g, p) = parse_intent(yaml).unwrap();
        assert!(g.nodes["d"].derive_children);
        let out = serialize_intent(&g, &p).unwrap();
        assert!(
            out.contains("derive_children: true"),
            "derive_children lost on save"
        );
    }

    // ─── Composition (nested includes) ────────────────────────────────────────

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vgt_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn compose_splices_nested_map() {
        use std::fs;
        let base = tmp("compose");
        let auth = base.join("services/auth");
        fs::create_dir_all(auth.join("src")).unwrap();
        fs::write(auth.join("src/lib.rs"), "// x").unwrap();
        fs::write(
            auth.join("vgraphtree.yaml"),
            r#"
project: { root: . }
nodes:
  frontend:
    label: Auth FE
    pin: { x: 100.0, y: 0.0 }
    children:
      login: { label: Login, source: src/lib.rs }
  backend: { label: Auth BE, pin: { x: 300.0, y: 0.0 } }
edges:
  - { from: frontend, to: backend, annotation: calls }
"#,
        )
        .unwrap();
        fs::write(
            base.join("vgraphtree.yaml"),
            r#"
project: { root: . }
nodes:
  auth:
    label: Auth service
    pin: { x: 500.0, y: 500.0 }
    include: services/auth/vgraphtree.yaml
  billing: { label: Billing }
edges:
  - { from: auth, to: billing, annotation: events }
"#,
        )
        .unwrap();

        let outer = base.join("vgraphtree.yaml");
        let (graph, project, warnings) = compose(outer.to_str().unwrap()).unwrap();
        assert!(warnings.is_empty());

        // namespaced ids, reparented, level-offset, nested flag
        assert_eq!(graph.nodes["auth/frontend"].parent.as_deref(), Some("auth"));
        assert_eq!(graph.nodes["auth/frontend"].level, 1);
        assert_eq!(graph.nodes["auth/login"].level, 2);
        assert!(graph.nodes["auth/frontend"].nested);
        assert!(!graph.nodes["auth"].nested);
        assert!(graph.edges.contains_key("auth/frontend__backend"));
        assert_eq!(graph.edges["auth/frontend__backend"].from, "auth/frontend");
        assert_eq!(graph.edges["auth/frontend__backend"].to, "auth/backend");
        let kids = &graph.nodes["auth"].children;
        assert!(kids.contains(&"auth/frontend".to_string()));

        // source rewritten to resolve from the outer root
        let src = graph.nodes["auth/login"].source.as_deref().unwrap();
        assert!(resolved_root(outer.to_str().unwrap(), &project)
            .join(src)
            .exists());

        // serialize keeps `include:` and never inlines nested content
        let out = serialize_intent(&graph, &project).unwrap();
        assert!(out.contains("include:"), "mount emits include");
        assert!(!out.contains("auth/frontend"), "nested ids not serialized");
        assert!(!out.contains("Auth FE"), "nested labels not serialized");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn compose_detects_cycle() {
        use std::fs;
        let base = tmp("cycle");
        fs::write(
            base.join("a.yaml"),
            "project: { root: . }\nnodes:\n  m: { include: b.yaml }\n",
        )
        .unwrap();
        fs::write(
            base.join("b.yaml"),
            "project: { root: . }\nnodes:\n  m: { include: a.yaml }\n",
        )
        .unwrap();
        let r = compose(base.join("a.yaml").to_str().unwrap());
        assert!(r.is_err() && r.unwrap_err().contains("cycle"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn compose_warns_include_and_children() {
        use std::fs;
        let base = tmp("incchild");
        fs::create_dir_all(base.join("inner")).unwrap();
        fs::write(
            base.join("inner/vgraphtree.yaml"),
            "project: { root: . }\nnodes:\n  x: { label: X }\n",
        )
        .unwrap();
        fs::write(
            base.join("vgraphtree.yaml"),
            r#"
project: { root: . }
nodes:
  m:
    label: M
    include: inner/vgraphtree.yaml
    children:
      ghost: { label: Ghost }
"#,
        )
        .unwrap();
        let (graph, _p, warnings) =
            compose(base.join("vgraphtree.yaml").to_str().unwrap()).unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("children ignored"));
        assert!(!graph.nodes.contains_key("ghost"), "inline child dropped");
        assert!(graph.nodes.contains_key("m/x"), "inner spliced");
        let _ = fs::remove_dir_all(&base);
    }
}
