//! Drift check between `protocol` and the hub's JSON Schemas in `packages/contracts/schema/`.
//!
//! For each type, sample documents are generated from the schema: a full one (every property) and a
//! minimal one (required properties only), once per variant index so every enum value and every union
//! branch is used at least once. Each sample must parse into the Rust type (which denies unknown fields
//! under test) and serialize back to the same JSON. That fails when the hub adds, renames or retypes a
//! field, adds an enum value or a union branch, or makes an optional field required, without this
//! crate following.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::protocol::*;

const SCHEMA_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/contracts/schema/");

struct Doc {
    root: Value,
}

impl Doc {
    fn load(file: &str) -> Self {
        let text = std::fs::read_to_string(format!("{SCHEMA_DIR}{file}")).unwrap_or_else(|e| panic!("{file}: {e}"));
        Doc { root: serde_json::from_str(&text).unwrap() }
    }

    fn resolve<'a>(&'a self, mut node: &'a Value) -> &'a Value {
        while let Some(r) = node.get("$ref").and_then(Value::as_str) {
            let name = r.strip_prefix("#/$defs/").unwrap_or_else(|| panic!("unsupported $ref {r}"));
            node = &self.root["$defs"][name];
        }
        node
    }

    /// The schema of property `name` of the root object (`McpTools.json` keys tools this way).
    fn property(&self, name: &str) -> &Value {
        let root = self.resolve(&self.root);
        root.get("properties").and_then(|p| p.get(name)).unwrap_or_else(|| panic!("no property {name}"))
    }

    /// The largest enum or union in the schema: that many variant indices cover every value and branch.
    fn width(&self) -> usize {
        fn walk(v: &Value, max: &mut usize) {
            match v {
                Value::Object(m) => {
                    for key in ["enum", "anyOf", "oneOf"] {
                        if let Some(Value::Array(a)) = m.get(key) {
                            *max = (*max).max(a.len());
                        }
                    }
                    m.values().for_each(|v| walk(v, max));
                }
                Value::Array(a) => a.iter().for_each(|v| walk(v, max)),
                _ => {}
            }
        }
        let mut max = 1;
        walk(&self.root, &mut max);
        max
    }

    fn sample(&self, node: &Value, variant: usize, minimal: bool) -> Value {
        let node = self.resolve(node);
        if let Some(Value::Array(values)) = node.get("enum") {
            return values[variant % values.len()].clone();
        }
        if let Some(c) = node.get("const") {
            return c.clone();
        }
        for key in ["anyOf", "oneOf"] {
            if let Some(Value::Array(branches)) = node.get(key) {
                return self.sample(&branches[variant % branches.len()], variant, minimal);
            }
        }
        let kind = match node.get("type") {
            Some(Value::String(t)) => t.as_str(),
            Some(Value::Array(ts)) => ts[variant % ts.len()].as_str().unwrap(),
            // `Schema.Unknown`: any JSON.
            None if node.get("properties").is_none() => return json!({ "any": [1, "x"] }),
            None => "object",
            Some(other) => panic!("unsupported type {other}"),
        };
        match kind {
            "null" => Value::Null,
            "boolean" => Value::Bool(variant % 2 == 0),
            "integer" => {
                let min = node.get("minimum").and_then(Value::as_i64).unwrap_or(0).max(0);
                json!(min.max(1))
            }
            "number" => json!(1.5),
            "string" => match node.get("format").and_then(Value::as_str) {
                Some("date-time") => json!("2026-10-17T10:00:00.000Z"),
                _ => json!("x"),
            },
            "array" => {
                let min = node.get("minItems").and_then(Value::as_u64).unwrap_or(0);
                if minimal && min == 0 { json!([]) } else { json!([self.sample(&node["items"], variant, minimal)]) }
            }
            "object" => {
                let required: Vec<&str> =
                    node.get("required").and_then(Value::as_array).map(|r| r.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                let mut out = Map::new();
                if let Some(Value::Object(props)) = node.get("properties") {
                    for (name, prop) in props {
                        if !minimal || required.contains(&name.as_str()) {
                            out.insert(name.clone(), self.sample(prop, variant, minimal));
                        }
                    }
                }
                Value::Object(out)
            }
            other => panic!("unsupported type {other}"),
        }
    }
}

/// Every sample of `schema` parses into `T` and serializes back unchanged.
fn check<T: DeserializeOwned + Serialize>(doc: &Doc, schema: &Value, what: &str) {
    for variant in 0..doc.width() {
        for minimal in [false, true] {
            let sample = doc.sample(schema, variant, minimal);
            let parsed: T = serde_json::from_value(sample.clone())
                .unwrap_or_else(|e| panic!("{what}: the Rust type rejects the hub's shape ({e}):\n{sample:#}"));
            let back = serde_json::to_value(&parsed).unwrap();
            assert_eq!(back, sample, "{what}: the Rust type changes the hub's shape on a round trip");
        }
    }
}

fn check_file<T: DeserializeOwned + Serialize>(file: &str) {
    let doc = Doc::load(file);
    check::<T>(&doc, &doc.root.clone(), file);
}

#[test]
fn frames_match_the_contracts() {
    check_file::<ClientMessage>("AppClientMessage.json");
    check_file::<ServerMessage>("AppServerMessage.json");
}

#[test]
fn model_types_match_the_contracts() {
    check_file::<HubEvent>("HubEvent.json");
    check_file::<Machine>("Machine.json");
    check_file::<ProjectSummary>("ProjectSummary.json");
    check_file::<ThreadSummary>("ThreadSummary.json");
    check_file::<ProjectOutcome>("ProjectOutcome.json");
    check_file::<Lead>("Lead.json");
    check_file::<Workstream>("Workstream.json");
    check_file::<Ask>("Ask.json");
    check_file::<Batch>("Batch.json");
}

#[test]
fn tool_inputs_and_outputs_match_the_contracts() {
    let doc = Doc::load("McpTools.json");
    macro_rules! tool_io {
        ($name:literal, $input:ty, $output:ty) => {
            check::<$input>(&doc, &doc.property(concat!($name, ".input")).clone(), concat!($name, ".input"));
            check::<$output>(&doc, &doc.property(concat!($name, ".output")).clone(), concat!($name, ".output"));
        };
    }
    tool_io!("project_get", ProjectGetInput, ProjectOutcome);
    tool_io!("thread_tail", ThreadTailInput, ThreadTailOutput);
    tool_io!("asks_list", AsksListInput, AsksListOutput);
    tool_io!("inbox_reply", InboxReplyInput, InboxReplyOutput);
    tool_io!("doctor_list", DoctorListInput, DoctorListOutput);
    tool_io!("doctor_fix", DoctorFixInput, DoctorFixOutput);
}

#[test]
fn the_check_catches_drift() {
    // A field the Rust type lacks, and a field the Rust type requires that the hub may omit.
    let doc = Doc { root: json!({ "type": "object", "properties": { "protocol": { "type": "integer" }, "extra": { "type": "string" } }, "required": ["protocol"] }) };
    let full = std::panic::catch_unwind(|| check::<Ready>(&doc, &doc.root.clone(), "extra field"));
    assert!(full.is_err());
    let doc = Doc { root: json!({ "type": "object", "properties": { "protocol": { "type": "integer" } } }) };
    let minimal = std::panic::catch_unwind(|| check::<Ready>(&doc, &doc.root.clone(), "optional field"));
    assert!(minimal.is_err());
    // An enum value the Rust enum doesn't know falls into Other and so fails the round trip.
    let doc = Doc { root: json!({ "type": "string", "enum": ["online", "offline", "degraded", "asleep"] }) };
    assert!(std::panic::catch_unwind(|| check::<MachineStatus>(&doc, &doc.root.clone(), "new enum value")).is_err());
}
