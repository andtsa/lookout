use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use crate::graph::{Edge, Node, NodeGraph, Origin, Position, Zone};

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectConfig {
    pub root: PathBuf,
    pub lsp: Option<HashMap<String, String>>,
    pub snap_levels: Vec<f64>,
    pub depth_ceiling: u32,
}

// YAML-serializable node (nested, as written to disk)
#[derive(Debug, Serialize, Deserialize)]
pub struct YamlNode {
    pub label: String,
    pub level: u32,
    pub source: Option<String>,
    pub origin: Origin,
    pub pin: Option<Position>,
    pub zone: Option<Zone>,
    #[serde(default)]
    pub children: HashMap<String, YamlNode>,
}

// YAML-serializable edge (flat list)
#[derive(Debug, Serialize, Deserialize)]
pub struct YamlEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub annotation: Option<String>,
    #[serde(default)]
    pub levels: Vec<u32>,
    pub origin: Origin,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct YamlConfig {
    pub project: ProjectConfig,
    #[serde(default)]
    pub nodes: HashMap<String, YamlNode>,
    #[serde(default)]
    pub edges: Vec<YamlEdge>,
}

pub fn parse_yaml(yaml_str: &str) -> Result<(NodeGraph, ProjectConfig), serde_yaml::Error> {
    let config: YamlConfig = serde_yaml::from_str(yaml_str)?;

    let mut graph = NodeGraph::new();

    // Flatten nested YAML nodes into the graph
    for (id, yaml_node) in &config.nodes {
        flatten_node(id, yaml_node, None, &mut graph);
    }

    for yaml_edge in &config.edges {
        let edge = Edge {
            id: yaml_edge.id.clone(),
            from: yaml_edge.from.clone(),
            to: yaml_edge.to.clone(),
            annotation: yaml_edge.annotation.clone(),
            levels: yaml_edge.levels.clone(),
            origin: yaml_edge.origin.clone(),
        };
        graph.edges.insert(edge.id.clone(), edge);
    }

    let project = config.project;
    Ok((graph, project))
}

fn flatten_node(
    id: &str,
    yaml_node: &YamlNode,
    parent: Option<String>,
    graph: &mut NodeGraph,
) {
    let child_ids: Vec<String> = yaml_node.children.keys().cloned().collect();

    let node = Node {
        id: id.to_string(),
        label: yaml_node.label.clone(),
        level: yaml_node.level,
        parent: parent.clone(),
        source: yaml_node.source.clone(),
        origin: yaml_node.origin.clone(),
        pin: yaml_node.pin.as_ref().map(|p| Position { x: p.x, y: p.y }),
        zone: yaml_node.zone.clone(),
        children: child_ids,
        dirty: false,
    };

    graph.nodes.insert(id.to_string(), node);

    for (child_id, child_yaml) in &yaml_node.children {
        flatten_node(child_id, child_yaml, Some(id.to_string()), graph);
    }
}

/// Serialize NodeGraph back to YAML, reconstructing the nested structure.
pub fn serialize_yaml(graph: &NodeGraph, project: &ProjectConfig) -> Result<String, serde_yaml::Error> {
    let mut yaml_nodes: HashMap<String, YamlNode> = HashMap::new();
    let mut yaml_edges: Vec<YamlEdge> = Vec::new();

    // Only serialize nodes with no parent at the top level; children are nested.
    // Build a map of parent -> children for nesting.
    let root_ids: Vec<String> = graph
        .nodes
        .values()
        .filter(|n| n.parent.is_none())
        .map(|n| n.id.clone())
        .collect();

    for root_id in &root_ids {
        if let Some(node) = graph.nodes.get(root_id) {
            yaml_nodes.insert(root_id.clone(), build_yaml_node(node, graph));
        }
    }

    for edge in graph.edges.values() {
        yaml_edges.push(YamlEdge {
            id: edge.id.clone(),
            from: edge.from.clone(),
            to: edge.to.clone(),
            annotation: edge.annotation.clone(),
            levels: edge.levels.clone(),
            origin: edge.origin.clone(),
        });
    }

    // Sort edges for stable output
    yaml_edges.sort_by(|a, b| a.id.cmp(&b.id));

    // Rebuild a lsp map for the project config, keeping existing settings
    let lsp_map = project.lsp.clone().unwrap_or_default();

    let yaml_config = YamlConfig {
        project: ProjectConfig {
            root: project.root.clone(),
            lsp: Some(lsp_map),
            snap_levels: project.snap_levels.clone(),
            depth_ceiling: project.depth_ceiling,
        },
        nodes: yaml_nodes,
        edges: yaml_edges,
    };

    serde_yaml::to_string(&yaml_config)
}

fn build_yaml_node(node: &Node, graph: &NodeGraph) -> YamlNode {
    let mut children_map: HashMap<String, YamlNode> = HashMap::new();
    for child_id in &node.children {
        if let Some(child_node) = graph.nodes.get(child_id) {
            children_map.insert(child_id.clone(), build_yaml_node(child_node, graph));
        }
    }

    YamlNode {
        label: node.label.clone(),
        level: node.level,
        source: node.source.clone(),
        origin: node.origin.clone(),
        pin: node.pin.as_ref().map(|p| Position { x: p.x, y: p.y }),
        zone: node.zone.clone(),
        children: children_map,
    }
}
