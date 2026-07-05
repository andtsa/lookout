use crate::config::compose;
use crate::state::load_state;
use crate::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde_json::{json, Value};

/// Re-parse the config (and state) files from disk without restarting the
/// server. Discards any unsaved in-memory edits — this is a "reload from disk".
pub async fn post_reload(State(state): State<AppState>) -> Result<Json<Value>, StatusCode> {
    let (mut graph, project, _warnings) =
        compose(state.config_path.as_str()).map_err(|_| StatusCode::BAD_REQUEST)?;

    // Re-apply app-owned state (pins) onto the fresh graph.
    let st = load_state(state.state_path.as_str());
    for (id, pos) in &st.pins {
        if let Some(node) = graph.nodes.get_mut(id) {
            node.pin = pos.clone(); // Some = pinned there, None = explicit unpin
            node.pin_from_state = true;
        }
    }

    let node_count = graph.nodes.len();
    let edge_count = graph.edges.len();

    *state.graph.lock().unwrap() = graph;
    *state.project.lock().unwrap() = project;
    *state.dismissed.lock().unwrap() = st.dismissed;

    Ok(Json(
        json!({ "ok": true, "nodes": node_count, "edges": edge_count }),
    ))
}
