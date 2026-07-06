// Node and edge kinds.
//
// NodeKind drives visual style only (reveal timing comes from tree depth).
// It is usually inferred from the binding shape and only stored when overridden.
//
// EdgeKind uses a custom string (de)serializer so the YAML stays clean and
// hand-editable (`kind: import`, `kind: reads-config`) instead of serde's
// default enum encoding (`kind: !Custom reads-config`).

use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Concept,
    Dir,
    File,
    Symbol,
}

impl NodeKind {
    /// Infer a node's kind from the shape of its source binding.
    ///   none            → concept
    ///   "file.rs::sym"  → symbol
    ///   "path/"         → dir
    ///   "path/file.rs"  → file
    pub fn infer(source: Option<&str>) -> NodeKind {
        match source {
            None => NodeKind::Concept,
            Some(s) if s.contains("::") => NodeKind::Symbol,
            Some(s) if s.ends_with('/') => NodeKind::Dir,
            Some(_) => NodeKind::File,
        }
    }
}

/// Refines a `NodeKind::Symbol` — what *kind* of symbol it is. Drives an icon /
/// colour on the frontend only; layout is unaffected. Uses a custom string
/// (de)serializer (like EdgeKind) so the YAML stays clean (`symbol_kind: function`)
/// and any unrecognised value round-trips as `Custom`.
#[derive(Debug, Clone, PartialEq)]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Struct,
    Interface,
    Trait,
    Enum,
    Constant,
    Variable,
    Field,
    Module,
    Type,
    Macro,
    Custom(String),
}

impl SymbolKind {
    fn as_str(&self) -> &str {
        match self {
            SymbolKind::Function => "function",
            SymbolKind::Method => "method",
            SymbolKind::Class => "class",
            SymbolKind::Struct => "struct",
            SymbolKind::Interface => "interface",
            SymbolKind::Trait => "trait",
            SymbolKind::Enum => "enum",
            SymbolKind::Constant => "constant",
            SymbolKind::Variable => "variable",
            SymbolKind::Field => "field",
            SymbolKind::Module => "module",
            SymbolKind::Type => "type",
            SymbolKind::Macro => "macro",
            SymbolKind::Custom(s) => s.as_str(),
        }
    }
}

impl Serialize for SymbolKind {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SymbolKind {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(match s.as_str() {
            "function" => SymbolKind::Function,
            "method" => SymbolKind::Method,
            "class" => SymbolKind::Class,
            "struct" => SymbolKind::Struct,
            "interface" => SymbolKind::Interface,
            "trait" => SymbolKind::Trait,
            "enum" => SymbolKind::Enum,
            "constant" => SymbolKind::Constant,
            "variable" => SymbolKind::Variable,
            "field" => SymbolKind::Field,
            "module" => SymbolKind::Module,
            "type" => SymbolKind::Type,
            "macro" => SymbolKind::Macro,
            _ => SymbolKind::Custom(s),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum EdgeKind {
    Import,
    Call,
    Reference,
    Semantic,
    Custom(String),
}

impl Default for EdgeKind {
    fn default() -> Self {
        EdgeKind::Semantic
    }
}

impl EdgeKind {
    fn as_str(&self) -> &str {
        match self {
            EdgeKind::Import => "import",
            EdgeKind::Call => "call",
            EdgeKind::Reference => "reference",
            EdgeKind::Semantic => "semantic",
            EdgeKind::Custom(s) => s.as_str(),
        }
    }
}

impl Serialize for EdgeKind {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for EdgeKind {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(match s.as_str() {
            "import" => EdgeKind::Import,
            "call" => EdgeKind::Call,
            "reference" => EdgeKind::Reference,
            "semantic" => EdgeKind::Semantic,
            _ => EdgeKind::Custom(s),
        })
    }
}
