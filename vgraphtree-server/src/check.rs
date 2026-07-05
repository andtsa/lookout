// The `check` subcommand: validate that the config parses and that every source
// link resolves on disk.
//
// Broken links are *warnings* — every one is reported and the command still
// exits 0. Genuine faults (unreadable config, parse failure) are *errors* and
// exit non-zero. Future checks (dead edge endpoints, duplicate ids, …) slot in
// as additional passes before the summary.

use crate::config::{compose, resolved_root};
use crate::graph::NodeGraph;
use std::path::Path;
use std::process::ExitCode;

pub fn run_check(config_path: &str) -> ExitCode {
    // compose validates parse + include resolution + cycles recursively.
    let (graph, project, warnings) = match compose(config_path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    // Compose warnings (e.g. `include` + `children`) are ERRORS in check.
    for w in &warnings {
        eprintln!("error: {w}");
    }

    let root = resolved_root(config_path, &project);

    let checked = graph.nodes.values().filter(|n| n.source.is_some()).count();
    let broken = collect_broken_links(&graph, &root);
    for (id, source) in &broken {
        println!("warning: node '{id}' → source '{source}' not found");
    }

    println!(
        "checked {checked} source link(s): {} warning(s), {} error(s)",
        broken.len(),
        warnings.len()
    );
    if warnings.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// Return `(node_id, source)` for every node whose `source` file is missing on
/// disk. Symbol bindings (`file.rs::symbol`) are validated by their file part
/// only — symbol resolution is deferred to the LSP layer (Phase B). Pure over
/// the filesystem via `root`, so it's easy to test.
pub fn collect_broken_links(graph: &NodeGraph, root: &Path) -> Vec<(String, String)> {
    let mut broken: Vec<(String, String)> = graph
        .nodes
        .values()
        .filter_map(|node| {
            let source = node.source.as_ref()?;
            let file_part = source.split("::").next().unwrap_or(source);
            (!root.join(file_part).exists()).then(|| (node.id.clone(), source.clone()))
        })
        .collect();
    broken.sort();
    broken
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_intent;

    #[test]
    fn flags_missing_source_links() {
        // cargo runs tests with CWD = the crate dir, so `src/config.rs` exists
        // and `src/bogus.rs` does not.
        let yaml = r#"
project: { root: . }
nodes:
  good:    { label: Good,    source: src/config.rs }
  bad:     { label: Bad,     source: src/bogus.rs }
  sym:     { label: Sym,     source: "src/bogus.rs::thing" }
  concept: { label: Concept }
"#;
        let (graph, _) = parse_intent(yaml).unwrap();
        let broken = collect_broken_links(&graph, Path::new("."));
        let ids: Vec<&str> = broken.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&"bad"), "missing file should be flagged");
        assert!(
            ids.contains(&"sym"),
            "symbol binding with missing file should be flagged"
        );
        assert!(!ids.contains(&"good"), "existing file must not be flagged");
        assert!(
            !ids.contains(&"concept"),
            "node without a source must not be flagged"
        );
    }
}
