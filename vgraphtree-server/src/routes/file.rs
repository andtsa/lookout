use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use crate::AppState;

#[derive(Deserialize)]
pub struct FileQuery {
    pub path: String,
    pub start: Option<usize>,
    pub end: Option<usize>,
}

pub async fn get_file(
    State(state): State<AppState>,
    Query(params): Query<FileQuery>,
) -> Result<Json<Value>, StatusCode> {
    // Reject obvious path-traversal attempts
    if params.path.contains("..") {
        return Err(StatusCode::FORBIDDEN);
    }

    let project = state.project.lock().unwrap();
    let root = project.root.clone();
    drop(project);

    let full_path = root.join(&params.path);

    if full_path.is_dir() {
        return list_directory(&full_path, &params.path, &root);
    }

    read_file(&full_path, params.start, params.end)
}

fn read_file(
    full_path: &Path,
    start: Option<usize>,
    end: Option<usize>,
) -> Result<Json<Value>, StatusCode> {
    let content = std::fs::read_to_string(full_path).map_err(|_| StatusCode::NOT_FOUND)?;
    let all_lines: Vec<&str> = content.lines().collect();
    let total = all_lines.len();
    let start = start.unwrap_or(1).saturating_sub(1);
    let end = end.unwrap_or(total).min(total);
    let lines: Vec<&str> = all_lines[start..end].to_vec();
    Ok(Json(json!({ "type": "file", "lines": lines, "total": total })))
}

fn list_directory(
    full_path: &Path,
    rel_path: &str,
    root: &Path,
) -> Result<Json<Value>, StatusCode> {
    let read_dir = std::fs::read_dir(full_path).map_err(|_| StatusCode::NOT_FOUND)?;

    let mut entries: Vec<Value> = read_dir
        .flatten()
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            // Path relative to project root, forward-slash normalised
            let entry_rel = entry
                .path()
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| name.clone());
            json!({ "name": name, "is_dir": is_dir, "path": entry_rel })
        })
        .collect();

    // Directories first, then alphabetical within each group
    entries.sort_by(|a, b| {
        let ad = a["is_dir"].as_bool().unwrap_or(false);
        let bd = b["is_dir"].as_bool().unwrap_or(false);
        match bd.cmp(&ad) {
            std::cmp::Ordering::Equal => a["name"]
                .as_str()
                .unwrap_or("")
                .cmp(b["name"].as_str().unwrap_or("")),
            other => other,
        }
    });

    // Parent directory (empty string → root, None → already at root)
    let clean = rel_path.trim_end_matches('/');
    let parent = Path::new(clean)
        .parent()
        .and_then(|p| p.to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('\\', "/"));

    Ok(Json(json!({
        "type": "directory",
        "path": rel_path,
        "parent": parent,
        "entries": entries,
    })))
}
