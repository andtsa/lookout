use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::graph::{Node, Origin, Position, Zone};
use crate::AppState;

#[derive(Deserialize)]
pub struct PatchNode {
    pub label: Option<String>,
    pub pin: Option<serde_json::Value>, // null = unpin, {x,y} = pin
    pub zone: Option<Zone>,
}

#[derive(Deserialize)]
pub struct CreateNode {
    pub id: String,
    pub label: String,
    pub level: u32,
    pub parent: Option<String>,
    pub source: Option<String>,
}

pub async fn patch_node(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchNode>,
) -> Result<Json<Value>, StatusCode> {
    let mut graph = state.graph.lock().unwrap();

    let node = graph.nodes.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;

    if let Some(label) = body.label {
        node.label = label;
    }

    if let Some(pin_val) = body.pin {
        if pin_val.is_null() {
            node.pin = None;
        } else {
            let pos: Position = serde_json::from_value(pin_val).map_err(|_| StatusCode::BAD_REQUEST)?;
            node.pin = Some(pos);
        }
    }

    if let Some(zone) = body.zone {
        node.zone = Some(zone);
    }

    node.dirty = true;
    graph.dirty = true;

    Ok(Json(json!({ "ok": true })))
}

pub async fn create_node(
    State(state): State<AppState>,
    Json(body): Json<CreateNode>,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let mut graph = state.graph.lock().unwrap();

    if graph.nodes.contains_key(&body.id) {
        return Err(StatusCode::CONFLICT);
    }

    // Validate parent exists if provided
    if let Some(ref parent_id) = body.parent {
        if !graph.nodes.contains_key(parent_id) {
            return Err(StatusCode::BAD_REQUEST);
        }
    }

    let node = Node {
        id: body.id.clone(),
        label: body.label,
        level: body.level,
        parent: body.parent.clone(),
        source: body.source,
        origin: Origin::Manual,
        pin: None,
        zone: None,
        children: Vec::new(),
        dirty: false,
    };

    // Register as child of parent
    if let Some(ref parent_id) = body.parent {
        if let Some(parent) = graph.nodes.get_mut(parent_id) {
            parent.children.push(body.id.clone());
        }
    }

    graph.nodes.insert(body.id.clone(), node);
    graph.dirty = true;

    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))))
}

pub async fn delete_node(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let mut graph = state.graph.lock().unwrap();

    let node = graph.nodes.get(&id).ok_or(StatusCode::NOT_FOUND)?.clone();

    // Remove from parent's children list
    if let Some(parent_id) = &node.parent {
        if let Some(parent) = graph.nodes.get_mut(parent_id) {
            parent.children.retain(|c| c != &id);
        }
    }

    // Remove edges involving this node
    graph.edges.retain(|_, e| e.from != id && e.to != id);

    // Recursively remove children
    let children = node.children.clone();
    graph.nodes.remove(&id);
    // Split borrow: collect children to remove, then do it
    let mut to_remove = children;
    while let Some(child_id) = to_remove.pop() {
        graph.edges.retain(|_, e| e.from != child_id && e.to != child_id);
        if let Some(child_node) = graph.nodes.remove(&child_id) {
            to_remove.extend(child_node.children);
        }
    }

    graph.dirty = true;
    Ok(Json(json!({ "ok": true })))
}

