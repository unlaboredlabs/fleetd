//! The Rust types describe the same JSON as the TS contracts: each schema `fleetd-schema` writes is compared with its
//! namesake in `packages/contracts/schema/` by structure (property names, required keys, enum values, array and union
//! shape), ignoring `$id`, descriptions, constraints, definition names and ordering.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde_json::{Map, Value};

/// Known representational differences, by path suffix, each with why it is unavoidable.
const ALLOWED: &[(&str, &str)] = &[
    // TS: `Union([Literal("nothing"), text(200)])`; "nothing" is itself a valid text(200), so Rust keeps one string
    // type with the same accepted values.
    (".blocks", "AskBlocks is a plain string in Rust"),
];

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Shape {
    Any,
    Null,
    Bool,
    Number,
    String,
    Enum(BTreeSet<String>),
    Array(Box<Shape>),
    Object {
        properties: BTreeMap<String, Shape>,
        required: BTreeSet<String>,
    },
    Union(Vec<Shape>),
}

struct Doc {
    defs: Map<String, Value>,
}

impl Doc {
    fn load(text: &str) -> (Doc, Value) {
        let mut root: Value = serde_json::from_str(text).unwrap();
        let defs = match root.as_object_mut().and_then(|o| o.remove("$defs")) {
            Some(Value::Object(defs)) => defs,
            _ => Map::new(),
        };
        (Doc { defs }, root)
    }

    fn shape(&self, schema: &Value) -> Shape {
        let Some(object) = schema.as_object() else {
            return Shape::Any;
        };
        if let Some(Value::String(reference)) = object.get("$ref") {
            let name = reference.rsplit('/').next().unwrap();
            let target = self.shape(&self.defs[name]);
            // schemars puts an internally tagged newtype variant's tag beside the `$ref`.
            let mut rest = object.clone();
            rest.remove("$ref");
            return match (target, self.shape_of_keys(&rest)) {
                (target, None) => target,
                (
                    Shape::Object {
                        mut properties,
                        mut required,
                    },
                    Some(Shape::Object {
                        properties: more,
                        required: more_required,
                    }),
                ) => {
                    properties.extend(more);
                    required.extend(more_required);
                    Shape::Object {
                        properties,
                        required,
                    }
                }
                (target, Some(_)) => target,
            };
        }
        self.shape_of_keys(object).unwrap_or(Shape::Any)
    }

    /// `None` when the keys say nothing about the shape.
    fn shape_of_keys(&self, object: &Map<String, Value>) -> Option<Shape> {
        if let Some(value) = object.get("const") {
            return Some(Shape::Enum([literal(value)].into()));
        }
        if let Some(Value::Array(values)) = object.get("enum") {
            return Some(Shape::Enum(values.iter().map(literal).collect()));
        }
        for key in ["anyOf", "oneOf"] {
            if let Some(Value::Array(alternatives)) = object.get(key) {
                let mut base = object.clone();
                base.remove(key);
                let base = self.shape_of_keys(&base);
                let alternatives = alternatives
                    .iter()
                    .map(|alt| merge(base.clone(), self.shape(alt)))
                    .collect();
                return Some(union(alternatives));
            }
        }
        if let Some(Value::Array(parts)) = object.get("allOf") {
            return parts
                .iter()
                .map(|part| Some(self.shape(part)))
                .reduce(|a, b| Some(merge(a, b.unwrap())))?;
        }
        // Effect writes an empty `Struct({})` as "anything but null".
        if object.get("not") == Some(&serde_json::json!({ "type": "null" })) && object.len() == 1 {
            return Some(Shape::Object {
                properties: BTreeMap::new(),
                required: BTreeSet::new(),
            });
        }
        let kinds: Vec<&str> = match object.get("type") {
            Some(Value::String(kind)) => vec![kind.as_str()],
            Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).collect(),
            _ if object.contains_key("properties") => vec!["object"],
            _ => return None,
        };
        let shapes = kinds
            .into_iter()
            .map(|kind| match kind {
                "null" => Shape::Null,
                "boolean" => Shape::Bool,
                "integer" | "number" => Shape::Number,
                "string" => Shape::String,
                "array" => Shape::Array(Box::new(
                    object
                        .get("items")
                        .map_or(Shape::Any, |items| self.shape(items)),
                )),
                "object" => Shape::Object {
                    properties: object
                        .get("properties")
                        .and_then(Value::as_object)
                        .map(|properties| {
                            properties
                                .iter()
                                .map(|(k, v)| (k.clone(), self.shape(v)))
                                .collect()
                        })
                        .unwrap_or_default(),
                    required: object
                        .get("required")
                        .and_then(Value::as_array)
                        .map(|names| {
                            names
                                .iter()
                                .filter_map(|n| n.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default(),
                },
                other => panic!("unexpected type {other}"),
            })
            .collect();
        Some(union(shapes))
    }
}

fn literal(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn merge(base: Option<Shape>, shape: Shape) -> Shape {
    match (base, shape) {
        (
            Some(Shape::Object {
                properties: mut base_properties,
                required: mut base_required,
            }),
            Shape::Object {
                properties,
                required,
            },
        ) => {
            base_properties.extend(properties);
            base_required.extend(required);
            Shape::Object {
                properties: base_properties,
                required: base_required,
            }
        }
        (_, shape) => shape,
    }
}

/// Flattens nested unions, folds enums together (schemars splits documented enum variants into `oneOf` consts) and
/// sorts the alternatives.
fn union(shapes: Vec<Shape>) -> Shape {
    let mut flat = Vec::new();
    for shape in shapes {
        match shape {
            Shape::Union(inner) => flat.extend(inner),
            other => flat.push(other),
        }
    }
    let mut values = BTreeSet::new();
    let mut rest: Vec<Shape> = Vec::new();
    for shape in flat {
        match shape {
            Shape::Enum(more) => values.extend(more),
            other if !rest.contains(&other) => rest.push(other),
            _ => {}
        }
    }
    if !values.is_empty() {
        rest.push(Shape::Enum(values));
    }
    rest.sort();
    if rest.len() == 1 {
        rest.pop().unwrap()
    } else {
        Shape::Union(rest)
    }
}

fn diff(ts: &Shape, rust: &Shape, path: &str, out: &mut Vec<String>) {
    if ts == rust {
        return;
    }
    match (ts, rust) {
        (
            Shape::Object {
                properties: a,
                required: ar,
            },
            Shape::Object {
                properties: b,
                required: br,
            },
        ) => {
            let only_ts: Vec<_> = a.keys().filter(|k| !b.contains_key(*k)).collect();
            let only_rust: Vec<_> = b.keys().filter(|k| !a.contains_key(*k)).collect();
            if !only_ts.is_empty() || !only_rust.is_empty() {
                out.push(format!(
                    "{path}: properties only in TS {only_ts:?}, only in Rust {only_rust:?}"
                ));
            }
            if ar != br {
                out.push(format!("{path}: required TS {ar:?}, Rust {br:?}"));
            }
            for (key, shape) in a {
                if let Some(other) = b.get(key) {
                    diff(shape, other, &format!("{path}.{key}"), out);
                }
            }
        }
        (Shape::Array(a), Shape::Array(b)) => diff(a, b, &format!("{path}[]"), out),
        (Shape::Union(a), Shape::Union(b)) if a.len() == b.len() => {
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                diff(x, y, &format!("{path}|{index}"), out);
            }
        }
        _ => out.push(format!("{path}: TS {ts:?}\n    Rust {rust:?}")),
    }
}

#[test]
fn rust_schemas_match_the_ts_contracts() {
    let ts_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/contracts/schema");
    let rust = fleetd_contracts::schema::json_schemas();
    let ts_files: BTreeSet<String> = std::fs::read_dir(&ts_dir)
        .unwrap()
        .map(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .trim_end_matches(".json")
                .to_owned()
        })
        .collect();
    let rust_names: BTreeSet<String> = rust.keys().map(|name| name.to_string()).collect();
    assert_eq!(ts_files, rust_names, "the same schema files");

    let mut problems = Vec::new();
    for (name, rust_doc) in &rust {
        let ts_value: Value = serde_json::from_str(
            &std::fs::read_to_string(ts_dir.join(format!("{name}.json"))).unwrap(),
        )
        .unwrap();
        let (ts, ts_root) = Doc::load(&ts_value.to_string());
        let (rs, rs_root) = Doc::load(&rust_doc.to_string());
        let mut out = Vec::new();
        diff(&ts.shape(&ts_root), &rs.shape(&rs_root), name, &mut out);
        out.retain(|line| {
            let path = line.split(':').next().unwrap();
            !ALLOWED.iter().any(|(suffix, _)| path.ends_with(suffix))
        });
        problems.extend(out);
    }
    assert!(
        problems.is_empty(),
        "schema differences:\n{}",
        problems.join("\n")
    );
}
