use crate::config::compose;
use crate::state::load_state;
use crate::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde_json::{json, Value};

/// Re-parse the config (and state) files from disk and swap them in. With
/// `only_if_clean`, the swap is skipped when the in-memory graph has unsaved
/// edits, so a background refresh never clobbers work in progress. Returns
/// `Ok(None)` when skipped, else the new (node, edge) counts.
pub fn load_from_disk(
    state: &AppState,
    only_if_clean: bool,
) -> Result<Option<(usize, usize)>, String> {
    if only_if_clean && state.graph.lock().unwrap().dirty {
        return Ok(None);
    }

    let (mut graph, project, _warnings) = compose(state.config_path.as_str())?;

    // Re-apply app-owned state (pins) onto the fresh graph.
    let st = load_state(state.state_path.as_str());
    for (id, pos) in &st.pins {
        if let Some(node) = graph.nodes.get_mut(id) {
            node.pin = pos.clone(); // Some = pinned there, None = explicit unpin
            node.pin_from_state = true;
        }
    }

    let counts = (graph.nodes.len(), graph.edges.len());

    let mut current = state.graph.lock().unwrap();
    // An edit may have landed while composing — re-check under the lock.
    if only_if_clean && current.dirty {
        return Ok(None);
    }
    *current = graph;
    *state.project.lock().unwrap() = project;
    *state.dismissed.lock().unwrap() = st.dismissed;

    Ok(Some(counts))
}

/// Re-parse the config (and state) files from disk without restarting the
/// server. Discards any unsaved in-memory edits — this is a "reload from disk".
pub async fn post_reload(State(state): State<AppState>) -> Result<Json<Value>, StatusCode> {
    let (node_count, edge_count) = load_from_disk(&state, false)
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .expect("unconditional reload always swaps");

    Ok(Json(
        json!({ "ok": true, "nodes": node_count, "edges": edge_count }),
    ))
}
