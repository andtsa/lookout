use crate::graph::{Node, Position, Zone};
use crate::kinds::NodeKind;
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct PatchNode {
    pub label: Option<String>,
    /// absent = no change · `null` = unpin · `{x,y}` = pin. `double_option`
    /// distinguishes an explicit null from an absent field — a plain
    /// `Option<Option<_>>` collapses both to `None`.
    #[serde(default, deserialize_with = "double_option")]
    pub pin: Option<Option<Position>>,
    pub zone: Option<Zone>,
}

fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Ok(Some(Option::deserialize(de)?))
}

#[derive(Deserialize)]
pub struct CreateNode {
    pub id: String,
    pub label: String,
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
    // Nested (included) nodes are content-read-only, but their POSITION is
    // outer-owned (persisted to the state file) — so pins are allowed, not labels/zones.
    if node.nested && (body.label.is_some() || body.zone.is_some()) {
        return Err(StatusCode::FORBIDDEN);
    }

    // Position changes go to the state file only; label/zone are intent content.
    let mut intent_changed = false;

    if let Some(label) = body.label {
        node.label = label;
        node.label_overridden = true; // an explicit label is a human override
        intent_changed = true;
    }

    if let Some(new_pin) = body.pin {
        node.pin = new_pin; // Some(pos) = pin here, None = unpin
    }

    if let Some(zone) = body.zone {
        node.zone = Some(zone);
        intent_changed = true;
    }

    node.dirty = true;
    graph.dirty = true;
    graph.intent_dirty |= intent_changed;

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

    // Validate parent exists if provided; derive level from parent depth.
    let level = if let Some(ref parent_id) = body.parent {
        match graph.nodes.get(parent_id) {
            Some(parent) => parent.level + 1,
            None => return Err(StatusCode::BAD_REQUEST),
        }
    } else {
        0
    };

    let node = Node {
        id: body.id.clone(),
        label: body.label,
        description: None,
        level,
        kind: NodeKind::infer(body.source.as_deref()),
        parent: body.parent.clone(),
        source: body.source,
        symbol: None,
        line: None,
        col: None,
        symbol_kind: None,
        zone: None,
        pin: None,
        intent_pin: None,
        pin_from_state: false,
        children: Vec::new(),
        derive_children: false,
        derived: false,
        nested: false,
        include: None,
        source_missing: false,
        label_overridden: true, // created with an explicit label
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
    graph.intent_dirty = true; // structural change → rewrite intent

    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))))
}

pub async fn delete_node(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let mut graph = state.graph.lock().unwrap();

    let node = graph.nodes.get(&id).ok_or(StatusCode::NOT_FOUND)?.clone();
    if node.nested {
        return Err(StatusCode::FORBIDDEN); // nested (included) content is read-only
    }

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
        graph
            .edges
            .retain(|_, e| e.from != child_id && e.to != child_id);
        if let Some(child_node) = graph.nodes.remove(&child_id) {
            to_remove.extend(child_node.children);
        }
    }

    graph.dirty = true;
    graph.intent_dirty = true; // structural change → rewrite intent
    Ok(Json(json!({ "ok": true })))
}
