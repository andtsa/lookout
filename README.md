
# lookout!

initially called "visual graph-tree" (still accepting name suggestions)

## what is this

this is a tool and a format for creating interactive visualisations of (large) codebases.

*nodes* can be created to represent *components, modules, files, functions*, and other 
*symbols*; but can also represent *concepts, structures* and anything else you'd include in 
a project schematic (e.g. a C4 diagram).

```yaml
nodes:
  frontend:
    label: Web frontend
    source: static/
    description: Vanilla JS + D3 single-page app — renders the graph, drives interaction, and hosts the config panel.
    zone: top-right

  yaml_store:
    label: Intent map
    source: vgraphtree.yaml
    description: The file that contains the actual graph, with all the nodes, labels, descriptions, and edges between them.
    zone: bottom

  backend:
    label: Rust backend
    source: vgraphtree-server/
    description: An axum web server. it parses the intent map, serves the composed graph and file contents, and persists edits.
    zone: top-left
```

these nodes can have *semantic edges* between them, used to express the conceptual 
connection between the two nodes.

```yaml
edges:
  - from: frontend, 
    to: backend,    
    annotation: HTTP fetch API,
    description: "The frontend fetches /graph, /file, /config, /save and /reload over HTTP; the backend is the single source of truth for the composed graph." 
    
  - from: backend,  
    to: yaml_store, 
    annotation: parse + serialize 
```

the resulting graph is rendered on an interactive canvas in the browser, and can be panned,
zoomed, and dragged around.


### nesting

a module probably has submodules, and as such you can nest a whole graph within a node, 
and a graph in each sub-node, and so on:
```yaml
  backend:
    label: Rust backend
    source: vgraphtree-server/
    description: An axum web server. it parses the intent map, serves the composed graph and file contents, and persists edits.
    zone: top-left
    children:
      config_parser:   { label: Config parser,   source: vgraphtree-server/src/config.rs,          description: "Parses / serializes the intent YAML and composes nested includes." }
      graph_types:     { label: Graph types,     source: vgraphtree-server/src/graph.rs,           description: "Runtime Node / Edge / NodeGraph types (symbol, description, pins, kinds)." }
      kinds:           { label: Kinds,           source: vgraphtree-server/src/kinds.rs,           description: "NodeKind, EdgeKind, and SymbolKind enums." }
      state_file:      { label: State file,      source: vgraphtree-server/src/state.rs,           description: "Loads / saves personal pins and dismissed items (nullable-pin tombstones)." }
      personal_config: { label: Personal config, source: vgraphtree-server/src/personal_config.rs, description: "Reads / writes the per-project .vgraphtree.config.yaml dotfile." }
      check_cli:       { label: Check CLI,       source: vgraphtree-server/src/check.rs,           description: "The `vgraphtree check` subcommand — validates a map without serving." }
      server_entry:    { label: Server entry,    source: vgraphtree-server/src/main.rs,            description: "CLI, routing, state-file application, and static asset serving." }
      route_handlers:
        label: Route handlers
        source: vgraphtree-server/src/routes/
        description: HTTP endpoints over the in-memory graph.
        children:
          save:         { label: Save,   source: vgraphtree-server/src/routes/save.rs,   description: "Writes the intent + state files (only deviations go to state)." }
          graph:        { label: Graph,  source: vgraphtree-server/src/routes/graph.rs,  description: "Serves the composed NodeGraph as JSON." }
          edge:         { label: Edge,   source: vgraphtree-server/src/routes/edge.rs,   description: "Create / patch edges." }
          node:         { label: Node,   source: vgraphtree-server/src/routes/node.rs,   description: "Create / patch / delete nodes (double-option pin patch)." }
          file:         { label: File,   source: vgraphtree-server/src/routes/file.rs,   description: "Reads file contents (line range) and directory listings." }
          reload:       { label: Reload, source: vgraphtree-server/src/routes/reload.rs, description: "Re-parses the intent + state files from disk." }
          config_route: { label: Config, source: vgraphtree-server/src/routes/config.rs, description: "GET / PUT the personal config dotfile." }
```

## using this

to use this, you need 2 things:

1. the `vgraphtree` binary, found under `target/debug/vgraphtree` after `cargo build`
2. a `vgraphtree.yaml` file, which you should make yourself! you can see the one for [this codebase](vgraphtree.yaml) for inspiration.

from the directory containing the codebase (and likely the `vgraphtree.yaml`), run
```sh
vgraphtree serve
```

and open [localhost](http://localhost:7777) as instructed

in the browser, press `?` to open the documentation panel


## and now?

contributions are more than welcome:)


