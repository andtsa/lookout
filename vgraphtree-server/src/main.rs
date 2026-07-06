use axum::{
    http::{header, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Router,
};
use clap::{Parser, Subcommand};
use rust_embed::RustEmbed;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;

mod check;
mod config;
mod graph;
mod kinds;
mod personal_config;
mod routes;
mod state;

use config::{compose, resolved_root, ProjectConfig};
use graph::NodeGraph;
use state::load_state;

#[derive(Clone)]
pub struct AppState {
    pub graph: Arc<Mutex<NodeGraph>>,
    pub project: Arc<Mutex<ProjectConfig>>,
    pub config_path: Arc<String>,
    pub state_path: Arc<String>,
    /// `project.root` resolved against the config file's directory — used for all
    /// filesystem lookups so `--path` works from any cwd. The authored root is
    /// kept in `project` for serialization.
    pub resolved_root: Arc<PathBuf>,
    pub dismissed: Arc<Mutex<Vec<String>>>,
}

// ─── CLI ────────────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "vgraphtree",
    version,
    about = "A zoomable semantic map of a codebase."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the interactive map on a local web server.
    Serve {
        /// Path to the intent config YAML.
        #[arg(long, default_value = "vgraphtree.yaml")]
        path: String,
        /// Port to bind the server to.
        #[arg(long, default_value_t = 7777)]
        port: u16,
    },
    /// Validate the config: that it parses and every source link resolves.
    Check {
        /// Path to the intent config YAML.
        #[arg(long, default_value = "vgraphtree.yaml")]
        path: String,
    },
}

// ─── Static frontend ────────────────────────────────────────────────────────
// The `static/` frontend is located three ways, in priority order:
//   1. $VGRAPHTREE_STATIC_DIR — explicit filesystem override (any build).
//   2. debug build — rust-embed reads from disk at $CARGO_MANIFEST_DIR/../static,
//      so `serve` works from any cwd and live edits show up on refresh.
//   3. release build — files are embedded in the binary (no static/ dir needed).

#[derive(RustEmbed)]
#[folder = "../static"]
struct StaticAssets;

async fn static_handler(uri: Uri) -> Response {
    let mut path = uri.path().trim_start_matches('/');
    if path.is_empty() {
        path = "index.html";
    }

    // 1. Explicit override — serve from a filesystem directory. An unset OR
    //    empty value falls through to the embedded/disk assets below.
    if let Some(dir) = std::env::var("VGRAPHTREE_STATIC_DIR")
        .ok()
        .filter(|d| !d.is_empty())
    {
        return match tokio::fs::read(std::path::Path::new(&dir).join(path)).await {
            Ok(bytes) => ([(header::CONTENT_TYPE, content_type_for(path))], bytes).into_response(),
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        };
    }

    // 2/3. rust-embed: disk in debug, embedded bytes in release.
    match StaticAssets::get(path) {
        Some(file) => (
            [(header::CONTENT_TYPE, content_type_for(path))],
            file.data.into_owned(),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn content_type_for(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    }
}

/// The state file sits next to the intent file: `foo.yaml` → `foo.state.yaml`.
fn state_path_for(config_path: &str) -> String {
    match config_path.strip_suffix(".yaml") {
        Some(stem) => format!("{stem}.state.yaml"),
        None => format!("{config_path}.state.yaml"),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Serve { path, port } => serve(path, port).await,
        Command::Check { path } => check::run_check(&path),
    }
}

// ─── serve ──────────────────────────────────────────────────────────────────

async fn serve(config_path: String, port: u16) -> ExitCode {
    let state_path = state_path_for(&config_path);

    let (mut graph, project, warnings) = match compose(&config_path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    for w in &warnings {
        eprintln!("warning: {w}");
    }

    let root = resolved_root(&config_path, &project);

    // Apply app-owned state (pins) onto the resolved graph by node id.
    let st = load_state(&state_path);
    for (id, pos) in &st.pins {
        if let Some(node) = graph.nodes.get_mut(id) {
            node.pin = pos.clone(); // Some = pinned there, None = explicit unpin
            node.pin_from_state = true;
        }
    }

    let state = AppState {
        graph: Arc::new(Mutex::new(graph)),
        project: Arc::new(Mutex::new(project)),
        config_path: Arc::new(config_path),
        state_path: Arc::new(state_path),
        resolved_root: Arc::new(root),
        dismissed: Arc::new(Mutex::new(st.dismissed)),
    };

    let app = Router::new()
        .route("/ping", get(|| async { "ok" }))
        .route("/graph", get(routes::graph::get_graph))
        .route("/node", post(routes::node::create_node))
        .route(
            "/node/:id",
            patch(routes::node::patch_node).delete(routes::node::delete_node),
        )
        .route("/edge", post(routes::edge::create_edge))
        .route("/edge/:id", patch(routes::edge::patch_edge))
        .route("/save", post(routes::save::post_save))
        .route("/reload", post(routes::reload::post_reload))
        .route(
            "/config",
            get(routes::config::get_config).put(routes::config::put_config),
        )
        .route("/file", get(routes::file::get_file))
        .route(
            "/status",
            get(|state: axum::extract::State<AppState>| async move {
                let graph = state.graph.lock().unwrap();
                axum::Json(serde_json::json!({ "dirty": graph.dirty }))
            }),
        )
        .fallback(static_handler)
        // Dev tool: never let the browser serve stale JS/CSS from cache — always
        // revalidate so edits and config reloads show up on refresh.
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("error: cannot bind {addr}: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("vgraphtree running at http://localhost:{port}");
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("error: server failed: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
