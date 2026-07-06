//! Personal ("dotfile") configuration — user preferences like default layout
//! engine, layout/physics parameters, and colours. Distinct from the project
//! *intent* (`vgraphtree.yaml`) and *state* (`vgraphtree.state.yaml`) files.
//!
//! The backend stays deliberately dumb: it reads and writes an arbitrary
//! key/value map and does NOT know the schema. Validation lives in the frontend
//! (the config panel), so adding a new setting never requires a backend change.
//!
//! SCOPE: currently per-project — the dotfile sits next to the intent file as
//! `.vgraphtree.config.yaml`. This is intentionally the *last* source in
//! `config_sources()`; a future global `~/.config/vgraphtree/config.yaml` will be
//! prepended as the base layer with this per-project file layered on top as an
//! override. Callers should go through `config_sources()` / `load()` so that
//! change stays contained here.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The personal config file for a project: `<intent dir>/.vgraphtree.config.yaml`.
pub fn personal_config_path(config_path: &str) -> PathBuf {
    Path::new(config_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(".vgraphtree.config.yaml")
}

/// Ordered list of config sources, base-first. Later sources override earlier
/// ones (see module note). For now this is just the per-project file; keep the
/// list shape so a global base can be prepended without touching callers.
pub fn config_sources(config_path: &str) -> Vec<PathBuf> {
    vec![personal_config_path(config_path)]
}

/// Load and shallow-merge all config sources into one map (later wins). Missing
/// or unparseable files contribute nothing. Always returns a JSON object.
pub fn load(config_path: &str) -> Value {
    let mut merged = serde_json::Map::new();
    for src in config_sources(config_path) {
        if let Ok(txt) = std::fs::read_to_string(&src) {
            if let Ok(Value::Object(map)) = serde_yaml::from_str::<Value>(&txt) {
                for (k, v) in map {
                    merged.insert(k, v);
                }
            }
        }
    }
    Value::Object(merged)
}

/// Write the config map to the per-project dotfile (the writable override layer).
pub fn save(config_path: &str, value: &Value) -> std::io::Result<()> {
    let path = personal_config_path(config_path);
    let yaml = serde_yaml::to_string(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, yaml)
}

/// Path shown to the client (the writable file), for display in the panel.
pub fn writable_path(config_path: &str) -> Value {
    json!(personal_config_path(config_path).to_string_lossy())
}
