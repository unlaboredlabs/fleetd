//! JSON Schema (draft 2020-12) for the app-facing types, in the same file layout as `packages/contracts/schema/`:
//! `{ "$schema", "$ref": "#/$defs/<Name>", "$defs" }`.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use schemars::generate::SchemaSettings;
use serde_json::{Map, Value};

use crate::app::{AppClientMessage, AppServerMessage};
use crate::events::HubEvent;
use crate::ledger::{Ask, Batch, Decision, Lead, Workstream};
use crate::model::{Machine, ProjectOutcome, ProjectSummary, ThreadSummary};
use crate::tasks::{SlotState, Task};
use crate::train::{Change, TrainState};
use crate::verification::{Claim, Incident};

pub const META_SCHEMA: &str = "https://json-schema.org/draft/2020-12/schema";

/// One schema document with the root type under `$defs/<name>`.
pub fn document<T: JsonSchema>(name: &str) -> Value {
    let root = SchemaSettings::draft2020_12()
        .into_generator()
        .into_root_schema_for::<T>();
    let Value::Object(mut root) = root.to_value() else {
        unreachable!("a root schema is an object")
    };
    let mut defs = match root.remove("$defs") {
        Some(Value::Object(defs)) => defs,
        _ => Map::new(),
    };
    strip_optional_nulls(&mut root);
    for def in defs.values_mut() {
        if let Value::Object(def) = def {
            strip_optional_nulls(def);
        }
    }
    root.remove("$schema");
    root.remove("title");
    defs.insert(name.to_owned(), Value::Object(root));
    serde_json::json!({ "$schema": META_SCHEMA, "$ref": format!("#/$defs/{name}"), "$defs": defs })
}

/// schemars makes every `Option<T>` nullable, but an optional key is absent, never null, on the wire (Effect's
/// `optionalKey`). Drop `null` from properties that are not required; required nullable ones (`NullOr`) keep it.
fn strip_optional_nulls(schema: &mut Map<String, Value>) {
    let required: Vec<String> = match schema.get("required") {
        Some(Value::Array(names)) => names
            .iter()
            .filter_map(|n| n.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    };
    if let Some(Value::Object(properties)) = schema.get_mut("properties") {
        for (name, property) in properties.iter_mut() {
            if let Value::Object(property) = property
                && !required.contains(name)
            {
                drop_null(property);
            }
        }
    }
    for value in schema.values_mut() {
        match value {
            Value::Object(child) => strip_optional_nulls(child),
            Value::Array(items) => {
                for item in items {
                    if let Value::Object(child) = item {
                        strip_optional_nulls(child);
                    }
                }
            }
            _ => {}
        }
    }
}

fn drop_null(property: &mut Map<String, Value>) {
    if let Some(Value::Array(types)) = property.get_mut("type") {
        types.retain(|t| t != "null");
        if types.len() == 1 {
            let only = types.remove(0);
            property.insert("type".into(), only);
        }
    }
    for key in ["anyOf", "oneOf"] {
        let Some(Value::Array(alternatives)) = property.get_mut(key) else {
            continue;
        };
        alternatives.retain(|alt| alt.get("type") != Some(&Value::String("null".into())));
        if alternatives.len() == 1 {
            let Value::Object(only) = alternatives.remove(0) else {
                continue;
            };
            property.remove(key);
            for (k, v) in only {
                property.entry(k).or_insert(v);
            }
        }
    }
    if let Some(Value::Array(values)) = property.get_mut("enum") {
        values.retain(|v| !v.is_null());
    }
}

/// Name -> schema document, for every app-facing type.
pub fn json_schemas() -> BTreeMap<&'static str, Value> {
    let mut out = BTreeMap::new();
    macro_rules! add {
        ($($name:ident),* $(,)?) => { $(out.insert(stringify!($name), document::<$name>(stringify!($name)));)* };
    }
    add!(
        HubEvent,
        Machine,
        ProjectSummary,
        ThreadSummary,
        ProjectOutcome,
        AppClientMessage,
        AppServerMessage,
        Lead,
        Workstream,
        Ask,
        Batch,
        Decision,
        Task,
        SlotState,
        Claim,
        Incident,
        Change,
        TrainState,
    );
    out
}

/// File name -> file contents.
pub fn render_json_schemas() -> BTreeMap<String, String> {
    json_schemas()
        .into_iter()
        .map(|(name, doc)| {
            (
                format!("{name}.json"),
                format!("{}\n", serde_json::to_string_pretty(&doc).unwrap()),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn checked_in_schemas_are_current() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("schema");
        for (file, text) in super::render_json_schemas() {
            let on_disk = std::fs::read_to_string(dir.join(&file)).unwrap_or_default();
            assert!(
                on_disk == text,
                "{file} is out of date: run `cargo run -p fleetd-contracts --bin fleetd-schema`"
            );
        }
    }
}
