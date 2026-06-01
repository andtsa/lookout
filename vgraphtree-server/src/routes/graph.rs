use axum::{extract::State, http::StatusCode, Json};
use serde_json::{json, Value};
use crate::AppState;

pub async fn get_graph(State(state): State<AppState>) -> Result<Json<Value>, StatusCode> {
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
