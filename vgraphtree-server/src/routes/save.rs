use crate::config::serialize_intent;
use crate::state::{serialize_state, StateConfig};
use crate::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;

pub async fn post_save(State(state): State<AppState>) -> Result<Json<Value>, StatusCode> {
    let mut graph = state.graph.lock().unwrap();
    let project = state.project.lock().unwrap();
    let dismissed = state.dismissed.lock().unwrap();

    // Intent file — human-owned semantic layer. Only rewritten when a semantic
    // change (label, annotation, structure) is pending; position-only edits leave
    // the hand-authored intent file untouched.
    if graph.intent_dirty {
        let intent_str =
            serialize_intent(&graph, &project).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        atomic_write(state.config_path.as_str(), &intent_str)?;
    }

    // State file — only positions that *deviate* from the committed intent default
    // (a fresh personal state file stays empty until you actually move a node).
    // The value is the effective pin: `Some(pos)` for a moved/personal pin, or
    // `None` (→ `null`) when a node with an intent-default pin was explicitly
    // unpinned — so the unpin survives reload instead of falling back to intent.
    let mut pins = HashMap::new();
    for node in graph.nodes.values() {
        if node.pin != node.intent_pin {
            pins.insert(node.id.clone(), node.pin.clone());
        }
    }
    let state_config = StateConfig {
        pins,
        dismissed: dismissed.clone(),
    };
    let state_str =
        serialize_state(&state_config).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    atomic_write(state.state_path.as_str(), &state_str)?;

    graph.dirty = false;
    graph.intent_dirty = false;
    Ok(Json(json!({ "ok": true })))
}

/// Write to `{path}.tmp` then rename — atomic on the same filesystem.
fn atomic_write(path: &str, contents: &str) -> Result<(), StatusCode> {
    let tmp_path = format!("{}.tmp", path);
    let mut file =
        std::fs::File::create(&tmp_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    file.write_all(contents.as_bytes())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    drop(file);
    std::fs::rename(&tmp_path, path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(())
}
