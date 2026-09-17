// The `check` subcommand: validate that the config parses and that every source
// link resolves on disk.
//
// Broken links are *warnings* — every one is reported and the command still
// exits 0. Genuine faults (unreadable config, parse failure, duplicate ids,
// parent cycles) are *errors* and exit non-zero. Future checks (dead edge
// endpoints, …) slot in as additional passes before the summary.

use crate::config::{compose, resolved_root};
use crate::graph::NodeGraph;
use std::collections::BTreeSet;
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

    // Compose warnings (`include` + `children`, duplicate ids) are ERRORS in check.
    for w in &warnings {
        eprintln!("error: {w}");
    }

    // Structural pass: a `parent` cycle makes the graph untraversable and hangs
    // every ancestor walk in the frontend. `parse_intent` now refuses the
    // duplicate ids that used to create these, but a cycle reaching the composed
    // graph by any other route must still fail loudly rather than ship.
    let cycles = collect_parent_cycles(&graph);
    for c in &cycles {
        eprintln!("error: parent cycle: {c}");
    }

    let root = resolved_root(config_path, &project);

    let checked = graph.nodes.values().filter(|n| n.source.is_some()).count();
    let broken = collect_broken_links(&graph, &root);
    for (id, source) in &broken {
        println!("warning: node '{id}' → source '{source}' not found");
    }

    let errors = warnings.len() + cycles.len();
    println!(
        "checked {checked} source link(s): {} warning(s), {errors} error(s)",
        broken.len(),
    );
    if errors == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// Return one `a -> b -> a` description per distinct `parent` cycle in the graph.
/// Walks up from every node; a chain that revisits an id has closed a loop, and
/// the loop's members are reported once regardless of how many nodes hang off it.
pub fn collect_parent_cycles(graph: &NodeGraph) -> Vec<String> {
    let mut reported: BTreeSet<String> = BTreeSet::new();

    for start in graph.nodes.keys() {
        let mut seen: Vec<&str> = Vec::new();
        let mut cur: &str = start;
        loop {
            if let Some(at) = seen.iter().position(|s| *s == cur) {
                // Normalise the rotation so the same loop reached from different
                // entry points collapses to one report.
                let mut members: Vec<&str> = seen[at..].to_vec();
                members.sort_unstable();
                reported.insert(format!("{} -> {}", members.join(" -> "), members[0]));
                break;
            }
            seen.push(cur);
            match graph.nodes.get(cur).and_then(|n| n.parent.as_deref()) {
                // A dangling parent ref is not a cycle; it terminates the walk.
                Some(parent) if graph.nodes.contains_key(parent) => cur = parent,
                _ => break,
            }
        }
    }

    reported.into_iter().collect()
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

    /// A `parent` cycle reaching the composed graph must fail the check rather
    /// than ship a map that hangs the browser.
    #[test]
    fn flags_parent_cycles() {
        let yaml = r#"
project: { root: . }
nodes:
  a: { label: A, children: { b: { label: B } } }
"#;
        let (mut graph, _, _) = parse_intent(yaml).unwrap();
        assert!(
            collect_parent_cycles(&graph).is_empty(),
            "a well-formed tree has no cycles"
        );

        // Force the shape `parse_intent` now refuses, to prove the pass catches
        // a cycle arriving by any other route.
        graph.nodes.get_mut("a").unwrap().parent = Some("b".to_string());
        let cycles = collect_parent_cycles(&graph);
        assert_eq!(cycles.len(), 1, "one loop, reported once: {cycles:?}");
        assert!(
            cycles[0].contains('a') && cycles[0].contains('b'),
            "{}",
            cycles[0]
        );

        // Self-parent is the degenerate case — exactly the fesa `codegen` shape.
        let (mut g2, _, _) = parse_intent(yaml).unwrap();
        g2.nodes.get_mut("a").unwrap().parent = Some("a".to_string());
        assert_eq!(collect_parent_cycles(&g2).len(), 1);
    }

    /// A parent id that names no node is broken, but it terminates the walk —
    /// it must not be mistaken for a cycle.
    #[test]
    fn dangling_parent_is_not_a_cycle() {
        let yaml = r#"
project: { root: . }
nodes:
  a: { label: A }
"#;
        let (mut graph, _, _) = parse_intent(yaml).unwrap();
        graph.nodes.get_mut("a").unwrap().parent = Some("ghost".to_string());
        assert!(collect_parent_cycles(&graph).is_empty());
    }

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
        let (graph, _, _) = parse_intent(yaml).unwrap();
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
