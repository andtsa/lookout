//! Personal-config endpoints. GET returns the merged config map (+ the writable
//! path for display); PUT overwrites the per-project dotfile. The backend does
//! no schema validation — the panel validates before it ever PUTs.

use crate::personal_config::{load, save, writable_path};
use crate::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde_json::{json, Value};

pub async fn get_config(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "config": load(state.config_path.as_str()),
        "path": writable_path(state.config_path.as_str()),
    }))
}

pub async fn put_config(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    // Accept either the raw map or a `{ "config": {...} }` envelope.
    let cfg = match body.get("config") {
        Some(c) => c.clone(),
        None => body,
    };
    if !cfg.is_object() {
        return Err(StatusCode::BAD_REQUEST);
    }
    save(state.config_path.as_str(), &cfg).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({ "ok": true })))
}
