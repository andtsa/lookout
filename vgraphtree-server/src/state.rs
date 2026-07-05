// The app-owned state file (`vgraphtree.state.yaml`).
//
// Holds data the app writes but that is not human intent: exact pin positions
// (the intent file carries the semantic `zone` instead) and dismissed ghost
// suggestions. Keyed by node id, so reattaching at load is a simple lookup.

use crate::graph::Position;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct StateConfig {
    /// Per-node position override. `Some(pos)` = pinned there; `None` (`null` in
    /// YAML) = *explicitly unpinned*, which overrides an intent-file pin default
    /// so the node goes force-directed. Absent from the map = no override.
    #[serde(default)]
    pub pins: HashMap<String, Option<Position>>,
    #[serde(default)]
    pub dismissed: Vec<String>,
}

/// Load the state file. A missing or unparseable file yields defaults —
/// state is app-owned and non-critical, so we never fail startup over it.
pub fn load_state(path: &str) -> StateConfig {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_yaml::from_str(&s).unwrap_or_default(),
        Err(_) => StateConfig::default(),
    }
}

/// Serialize the state file with a machine-owned banner. The banner is
/// re-emitted every write (serde_yaml drops comments on round-trip).
pub fn serialize_state(state: &StateConfig) -> Result<String, serde_yaml::Error> {
    let banner = "# app-owned — pins and dismissed suggestions. The app writes this file.\n";
    let body = serde_yaml::to_string(state)?;
    Ok(format!("{banner}{body}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Position;

    #[test]
    fn state_roundtrips_with_banner() {
        let mut pins = HashMap::new();
        pins.insert("frontend".to_string(), Some(Position { x: 10.0, y: 20.0 }));
        pins.insert("unpinned".to_string(), None); // explicit unpin tombstone
        let st = StateConfig {
            pins,
            dismissed: vec!["ghost::x".to_string()],
        };

        let yaml = serialize_state(&st).unwrap();
        assert!(yaml.starts_with("# app-owned"), "banner re-emitted");

        let back: StateConfig = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(back.pins["frontend"], Some(Position { x: 10.0, y: 20.0 }));
        assert_eq!(back.pins["unpinned"], None, "null unpin round-trips");
        assert_eq!(back.dismissed, vec!["ghost::x".to_string()]);
    }

    #[test]
    fn missing_state_file_yields_defaults() {
        let st = load_state("/nonexistent/path/does-not-exist.state.yaml");
        assert!(st.pins.is_empty());
        assert!(st.dismissed.is_empty());
    }
}
