use crate::graph::Edge;
use crate::kinds::EdgeKind;
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct PatchEdge {
    pub annotation: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub annotation: Option<String>,
}

pub async fn patch_edge(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchEdge>,
) -> Result<Json<Value>, StatusCode> {
    let mut graph = state.graph.lock().unwrap();

    // A nested edge (either endpoint from an included config) is read-only.
    let (from, to) = {
        let edge = graph.edges.get(&id).ok_or(StatusCode::NOT_FOUND)?;
        (edge.from.clone(), edge.to.clone())
    };
    let nested = |nid: &str| graph.nodes.get(nid).map(|n| n.nested).unwrap_or(false);
    if nested(&from) || nested(&to) {
        return Err(StatusCode::FORBIDDEN);
    }

    let edge = graph.edges.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;

    if let Some(annotation) = body.annotation {
        edge.annotation = Some(annotation);
    }

    graph.dirty = true;
    graph.intent_dirty = true; // annotation is intent content
    Ok(Json(json!({ "ok": true })))
}

pub async fn create_edge(
    State(state): State<AppState>,
    Json(body): Json<CreateEdge>,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let mut graph = state.graph.lock().unwrap();

    if graph.edges.contains_key(&body.id) {
        return Err(StatusCode::CONFLICT);
    }

    if !graph.nodes.contains_key(&body.from) || !graph.nodes.contains_key(&body.to) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let edge = Edge {
        id: body.id.clone(),
        from: body.from,
        to: body.to,
        annotation: body.annotation,
        kind: EdgeKind::Semantic,
        id_derived: false, // an explicit id was supplied
    };

    graph.edges.insert(body.id, edge);
    graph.dirty = true;
    graph.intent_dirty = true; // structural change → rewrite intent

    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))))
}
