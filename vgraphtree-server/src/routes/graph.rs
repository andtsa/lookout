use crate::routes::reload::load_from_disk;
use crate::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde_json::{json, Value};

pub async fn get_graph(State(state): State<AppState>) -> Result<Json<Value>, StatusCode> {
    // Pick up on-disk changes (new included maps, hand edits) on every page load,
    // unless there are unsaved in-memory edits. A broken file keeps the last
    // good graph rather than failing the request.
    if let Err(e) = load_from_disk(&state, true) {
        eprintln!("warning: not reloading from disk: {e}");
    }

    let graph = state.graph.lock().unwrap();
    let nodes: serde_json::Map<String, Value> = graph
        .nodes
        .iter()
        .map(|(id, node)| (id.clone(), serde_json::to_value(node).unwrap()))
        .collect();

    let edges: Vec<Value> = graph
        .edges
        .values()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();

    Ok(Json(json!({ "nodes": nodes, "edges": edges })))
}
