use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::graph::{Edge, Origin};
use crate::AppState;

#[derive(Deserialize)]
pub struct PatchEdge {
    pub annotation: Option<String>,
    pub levels: Option<Vec<u32>>,
}

#[derive(Deserialize)]
pub struct CreateEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub annotation: Option<String>,
    pub levels: Option<Vec<u32>>,
}

pub async fn patch_edge(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchEdge>,
) -> Result<Json<Value>, StatusCode> {
    let mut graph = state.graph.lock().unwrap();

    let edge = graph.edges.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;

    if let Some(annotation) = body.annotation {
        edge.annotation = Some(annotation);
    }

    if let Some(levels) = body.levels {
        edge.levels = levels;
    }

    graph.dirty = true;
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
        levels: body.levels.unwrap_or_else(|| vec![0]),
        origin: Origin::Manual,
    };

    graph.edges.insert(body.id, edge);
    graph.dirty = true;

    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))))
}
