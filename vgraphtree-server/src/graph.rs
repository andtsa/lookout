use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Manual,
    Lsp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub label: String,
    pub level: u32,
    pub parent: Option<String>,
    pub source: Option<String>,
    pub origin: Origin,
    pub pin: Option<Position>,
    pub zone: Option<Zone>,
    pub children: Vec<String>,
    pub dirty: bool,
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

pub struct NodeGraph {
    pub nodes: HashMap<String, Node>,
    pub edges: HashMap<String, Edge>,
    pub dirty: bool,
}

impl NodeGraph {
    pub fn new() -> Self {
        NodeGraph {
            nodes: HashMap::new(),
            edges: HashMap::new(),
            dirty: false,
        }
    }
}
