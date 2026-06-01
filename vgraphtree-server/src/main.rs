use axum::{
    routing::{delete, get, patch, post},
    Router,
};
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

mod config;
mod graph;
mod routes;

use config::{parse_yaml, ProjectConfig};
use graph::NodeGraph;

#[derive(Clone)]
pub struct AppState {
    pub graph: Arc<Mutex<NodeGraph>>,
    pub project: Arc<Mutex<ProjectConfig>>,
    pub config_path: Arc<String>,
}

#[tokio::main]
async fn main() {
    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "vgraphtree.yaml".to_string());

    let yaml_str = std::fs::read_to_string(&config_path)
        .unwrap_or_else(|e| panic!("Cannot read config file '{}': {}", config_path, e));

    let (graph, project) = parse_yaml(&yaml_str)
        .unwrap_or_else(|e| panic!("Failed to parse YAML: {}", e));

    let state = AppState {
        graph: Arc::new(Mutex::new(graph)),
        project: Arc::new(Mutex::new(project)),
        config_path: Arc::new(config_path),
    };

    let app = Router::new()
        .route("/ping", get(|| async { "ok" }))
        .route("/graph", get(routes::graph::get_graph))
        .route("/node", post(routes::node::create_node))
        .route("/node/{id}", patch(routes::node::patch_node))
        .route("/node/{id}", delete(routes::node::delete_node))
        .route("/edge", post(routes::edge::create_edge))
        .route("/edge/{id}", patch(routes::edge::patch_edge))
        .route("/save", post(routes::save::post_save))
        .route("/file", get(routes::file::get_file))
        .route(
            "/status",
            get(|state: axum::extract::State<AppState>| async move {
                let graph = state.graph.lock().unwrap();
                axum::Json(serde_json::json!({ "dirty": graph.dirty }))
            }),
        )
        .nest_service("/", ServeDir::new("static"))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:7777").await.unwrap();
    println!("vgraphtree running at http://localhost:7777");
    axum::serve(listener, app).await.unwrap();
}
