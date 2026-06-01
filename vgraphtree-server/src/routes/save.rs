use axum::{extract::State, http::StatusCode, Json};
use serde_json::{json, Value};
use crate::config::serialize_yaml;
use crate::AppState;
use std::io::Write;

pub async fn post_save(State(state): State<AppState>) -> Result<Json<Value>, StatusCode> {
    let mut graph = state.graph.lock().unwrap();
    let project = state.project.lock().unwrap();

    let yaml_str = serialize_yaml(&graph, &project).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let config_path = state.config_path.as_str();
    let tmp_path = format!("{}.tmp", config_path);

    let mut file = std::fs::File::create(&tmp_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    file.write_all(yaml_str.as_bytes()).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    drop(file);

    std::fs::rename(&tmp_path, config_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    graph.dirty = false;

    Ok(Json(json!({ "ok": true })))
}
