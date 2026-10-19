//! TypeScript for the desktop app, rendered from the same JSON Schemas as `schema/`: one alias per `$defs` entry,
//! `ToolMap` (each tool's input and output) and `HubEventDataMap` (each event type's `data`), plus the wire
//! constants. Handles exactly the keywords schemars emits for these types and panics on any other, so a new
//! construct gets a deliberate mapping instead of a silent `unknown`.

use std::collections::BTreeMap;
use std::fmt::Write;

use serde_json::{Map, Value};

/// Set by `#[schemars(extend("x-open" = true))]` on an enum a newer hub may add values to: the app gets
/// `Known<Name>` (this build's values) and `<Name>`, which also admits any other string, so it handles the new value
/// as a generic one instead of trusting a closed union.
pub const OPEN: &str = "x-open";

/// Where the app keeps the generated file, from the repo root.
pub const TS_DIR: &str = "app/desktop/src/shared/contracts/generated";
pub const TS_FILE: &str = "contracts.ts";

/// Keywords that only validate; TypeScript has no use for them.
const VALIDATION: &[&str] = &[
    "description",
    "title",
    "format",
    "pattern",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "uniqueItems",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
];

/// The constants a client needs to match the hub's bounds.
fn constants() -> Vec<(&'static str, &'static str, Value)> {
    use crate::live;
    vec![
        (
            "PROTOCOL_VERSION",
            "The /app protocol this build speaks.",
            crate::hello::PROTOCOL_VERSION.into(),
        ),
        (
            "SPARK_BUCKET_SECS",
            "Seconds per sparkline bucket.",
            live::SPARK_BUCKET_SECS.into(),
        ),
        (
            "SPARK_BUCKETS",
            "Buckets in a sparkline: the last minute.",
            live::SPARK_BUCKETS.into(),
        ),
        (
            "LIVE_MAX_LANES",
            "Lanes in one live frame.",
            live::LIVE_MAX_LANES.into(),
        ),
        (
            "LIVE_MAX_TEXTS",
            "Streamed texts in one live frame.",
            live::LIVE_MAX_TEXTS.into(),
        ),
        (
            "LIVE_MAX_MACHINES",
            "Machines in one live frame.",
            live::LIVE_MAX_MACHINES.into(),
        ),
        (
            "SECRET_MAX_BYTES",
            "Largest secret a secret ask takes.",
            crate::secrets::SECRET_MAX_BYTES.into(),
        ),
        (
            "ATTACHMENT_MAX_BYTES",
            "Largest attachment attachment_put takes.",
            crate::mcp::ATTACHMENT_MAX_BYTES.into(),
        ),
        (
            "SLEPT_SHOWN_MS",
            "How long a machine's sleep stays shown.",
            crate::model::SLEPT_SHOWN_MS.into(),
        ),
    ]
}

/// The generated file's text, from the schema documents `schema::json_schemas` returns.
pub fn render(docs: &BTreeMap<&'static str, Value>) -> String {
    let mut defs: BTreeMap<String, Value> = BTreeMap::new();
    for (doc_name, doc) in docs {
        for (name, schema) in doc["$defs"].as_object().expect("a document has $defs") {
            // The map documents' roots become ToolMap and HubEventDataMap below, not aliases.
            if name == "McpTools" || name == "HubEventData" {
                continue;
            }
            match defs.get(name) {
                Some(seen) if seen != schema => panic!(
                    "two different types are both named {name} (one in {doc_name}.json): rename one in fleetd-contracts"
                ),
                _ => {
                    defs.insert(name.clone(), schema.clone());
                }
            }
        }
    }
    let mut out = String::from(
        "// Generated from crates/fleetd-contracts by `cargo run -p fleetd-contracts --bin fleetd-schema`.\n\
         // Do not edit: CI regenerates it and fails on any difference.\n\
         /* eslint-disable -- generated; the schemas are what they are (a machine id or \"browser\" is just a string). */\n\n",
    );
    for (name, doc, value) in constants() {
        writeln!(out, "/** {doc} */\nexport const {name} = {value};\n").unwrap();
    }
    for (name, schema) in &defs {
        doc_comment(&mut out, schema, 0);
        if schema.get(OPEN) == Some(&Value::Bool(true)) {
            writeln!(
                out,
                "export type Known{name} ={};",
                assigned(expr(schema, 0))
            )
            .unwrap();
            writeln!(out, "/** Known{name}, or a value from a newer hub. */").unwrap();
            writeln!(out, "export type {name} = Known{name} | (string & {{}});\n").unwrap();
        } else {
            writeln!(out, "export type {name} ={};\n", assigned(expr(schema, 0))).unwrap();
        }
    }
    let tools = root_properties(&docs["McpTools"], "McpTools");
    let mut by_tool: BTreeMap<&str, [String; 2]> = BTreeMap::new();
    for (key, schema) in tools {
        let (tool, side) = key
            .rsplit_once('.')
            .expect("McpTools keys are <tool>.input / <tool>.output");
        let slot = by_tool.entry(tool).or_default();
        slot[usize::from(side == "output")] = expr(schema, 2);
    }
    out.push_str("/** Every tool the app can `call`: its input and its output. */\nexport interface ToolMap {\n");
    for (tool, [input, output]) in by_tool {
        writeln!(
            out,
            "  {}: {{ input: {input}; output: {output} }};",
            prop_name(tool)
        )
        .unwrap();
    }
    out.push_str("}\n\n");
    out.push_str(
        "/** `HubEvent.data` by event type, for the types whose data has a declared shape. */\nexport interface HubEventDataMap {\n",
    );
    for (event, schema) in root_properties(&docs["HubEventData"], "HubEventData") {
        writeln!(out, "  {}: {};", prop_name(event), expr(schema, 1)).unwrap();
    }
    out.push_str("}\n");
    out
}

/// The right side of `=`: a one-per-line union starts on the next line.
fn assigned(e: String) -> String {
    if e.starts_with('\n') {
        e
    } else {
        format!(" {e}")
    }
}

fn root_properties<'a>(doc: &'a Value, name: &str) -> &'a Map<String, Value> {
    doc["$defs"][name]["properties"]
        .as_object()
        .expect("a map document's root has properties")
}

fn doc_comment(out: &mut String, schema: &Value, indent: usize) {
    let Some(text) = schema.get("description").and_then(Value::as_str) else {
        return;
    };
    let pad = "  ".repeat(indent);
    let text = text.replace("*/", "*\\/");
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() == 1 {
        writeln!(out, "{pad}/** {} */", lines[0]).unwrap();
        return;
    }
    writeln!(out, "{pad}/**").unwrap();
    for line in lines {
        writeln!(out, "{pad} * {line}").unwrap();
    }
    writeln!(out, "{pad} */").unwrap();
}

fn prop_name(name: &str) -> String {
    let mut chars = name.chars();
    let ident = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    if ident {
        name.to_owned()
    } else {
        Value::String(name.to_owned()).to_string()
    }
}

/// The byte offsets of `|` / `&` operators outside brackets and string literals.
fn top_level_operators(e: &str) -> Vec<(usize, u8)> {
    let (mut depth, mut quoted, mut escaped) = (0i32, false, false);
    let bytes = e.as_bytes();
    let mut found = Vec::new();
    for (i, &b) in bytes.iter().enumerate() {
        if quoted {
            match (escaped, b) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => quoted = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => quoted = true,
            b'(' | b'{' | b'[' | b'<' => depth += 1,
            b')' | b'}' | b']' | b'>' => depth -= 1,
            b'|' | b'&' if depth == 0 && i > 0 && bytes[i - 1] == b' ' => found.push((i, b)),
            _ => {}
        }
    }
    found
}

/// Wraps a union or intersection in parentheses; object literals and names stay as they are.
fn paren(e: String) -> String {
    if top_level_operators(&e).is_empty() {
        e
    } else {
        format!("({e})")
    }
}

/// A flat union: nested unions are spliced in, duplicates dropped; a long list of literals at the top level goes one
/// per line.
fn union(parts: Vec<String>, indent: usize) -> String {
    let mut seen: Vec<String> = Vec::new();
    for part in parts {
        let part = part.trim_start_matches(['\n', ' ', '|']).to_owned();
        let ops = top_level_operators(&part);
        let members: Vec<String> = if !ops.is_empty() && ops.iter().all(|(_, op)| *op == b'|') {
            let mut members = Vec::new();
            let mut from = 0;
            for (at, _) in ops {
                members.push(part[from..at].trim().to_owned());
                from = at + 1;
            }
            members.push(part[from..].trim().to_owned());
            members
        } else {
            vec![part]
        };
        for m in members {
            if !seen.contains(&m) {
                seen.push(m);
            }
        }
    }
    let one_line = seen.join(" | ");
    match seen.len() {
        0 => "never".into(),
        n if indent == 0 && n > 1 && one_line.len() > 100 && !one_line.contains('\n') => {
            seen.iter().map(|p| format!("\n  | {p}")).collect()
        }
        _ => one_line,
    }
}

/// The TypeScript type of one schema; `indent` is the nesting level of any object literal it opens.
fn expr(schema: &Value, indent: usize) -> String {
    let schema = match schema {
        Value::Bool(true) => return "unknown".into(),
        Value::Bool(false) => return "never".into(),
        Value::Object(map) => map,
        other => panic!("not a schema: {other}"),
    };
    for key in schema.keys() {
        let known = VALIDATION.contains(&key.as_str())
            || matches!(
                key.as_str(),
                "$ref"
                    | "type"
                    | "enum"
                    | "const"
                    | "oneOf"
                    | "anyOf"
                    | "allOf"
                    | "properties"
                    | "required"
                    | "additionalProperties"
                    | "items"
                    | "prefixItems"
                    | OPEN
            );
        assert!(
            known,
            "the TypeScript generator has no mapping for the keyword {key:?}"
        );
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(r) = schema.get("$ref").and_then(Value::as_str) {
        let name = r
            .strip_prefix("#/$defs/")
            .unwrap_or_else(|| panic!("an outside $ref: {r}"));
        parts.push(name.to_owned());
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(Value::Array(alts)) = schema.get(key) {
            parts.push(union(
                alts.iter().map(|a| expr(a, indent)).collect(),
                indent,
            ));
        }
    }
    if let Some(Value::Array(all)) = schema.get("allOf") {
        parts.extend(all.iter().map(|a| expr(a, indent)));
    }
    if let Some(literals) = schema.get("enum").and_then(Value::as_array) {
        parts.push(union(
            literals.iter().map(Value::to_string).collect(),
            indent,
        ));
    } else if let Some(literal) = schema.get("const") {
        parts.push(literal.to_string());
    } else if let Some(t) = schema.get("type") {
        let types: Vec<&str> = match t {
            Value::String(t) => vec![t.as_str()],
            Value::Array(ts) => ts.iter().filter_map(Value::as_str).collect(),
            other => panic!("a bad type: {other}"),
        };
        let typed: Vec<String> = types.iter().map(|t| typed(t, schema, indent)).collect();
        // `{ "$ref": X, "type": "object", "properties": {} }`: the properties add to X; a bare object adds nothing.
        let adds = !(parts.len() == 1 && typed == ["{ [key: string]: unknown }"]);
        if adds {
            parts.push(union(typed, indent));
        }
    }
    match parts.len() {
        0 => "unknown".into(),
        1 => parts.remove(0),
        _ => parts.into_iter().map(paren).collect::<Vec<_>>().join(" & "),
    }
}

fn typed(t: &str, schema: &Map<String, Value>, indent: usize) -> String {
    match t {
        "string" => "string".into(),
        "integer" | "number" => "number".into(),
        "boolean" => "boolean".into(),
        "null" => "null".into(),
        "array" => match (schema.get("prefixItems"), schema.get("items")) {
            (Some(Value::Array(items)), _) => {
                format!(
                    "[{}]",
                    items
                        .iter()
                        .map(|i| expr(i, indent))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
            (_, Some(items)) => format!("{}[]", paren(expr(items, indent))),
            _ => "unknown[]".into(),
        },
        "object" => object(schema, indent),
        other => panic!("an unknown JSON type: {other}"),
    }
}

fn object(schema: &Map<String, Value>, indent: usize) -> String {
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let properties = schema.get("properties").and_then(Value::as_object);
    let extra = match schema.get("additionalProperties") {
        None | Some(Value::Bool(false)) => None,
        Some(Value::Bool(true)) => Some("unknown".to_owned()),
        Some(other) => Some(expr(other, indent + 1)),
    };
    let Some(properties) = properties.filter(|p| !p.is_empty()) else {
        return match (extra, schema.get("additionalProperties")) {
            (Some(value), _) => format!("{{ [key: string]: {value} }}"),
            (None, Some(Value::Bool(false))) => "Record<string, never>".into(),
            (None, _) => "{ [key: string]: unknown }".into(),
        };
    };
    let pad = "  ".repeat(indent + 1);
    let mut out = String::from("{\n");
    for (name, property) in properties {
        doc_comment(&mut out, property, indent + 1);
        let optional = if required.contains(&name.as_str()) {
            ""
        } else {
            "?"
        };
        writeln!(
            out,
            "{pad}{}{optional}: {};",
            prop_name(name),
            expr(property, indent + 1)
        )
        .unwrap();
    }
    if let Some(value) = extra {
        writeln!(out, "{pad}[key: string]: {value};").unwrap();
    }
    out.push_str(&"  ".repeat(indent));
    out.push('}');
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::expr;

    #[test]
    fn maps_the_shapes_schemars_emits() {
        // A tagged variant that flattens a struct: the struct and its tag, together.
        let tagged = json!({ "$ref": "#/$defs/HubEvent", "type": "object", "properties": { "t": { "const": "event", "type": "string" } }, "required": ["t"] });
        assert_eq!(expr(&tagged, 0), "HubEvent & {\n  t: \"event\";\n}");
        let union = json!({ "oneOf": [{ "$ref": "#/$defs/A" }, { "type": ["number", "null"] }] });
        assert_eq!(expr(&union, 0), "A | number | null");
        let list = json!({ "type": "array", "items": { "anyOf": [{ "$ref": "#/$defs/Star" }, { "type": "string" }] } });
        assert_eq!(expr(&list, 0), "(Star | string)[]");
        let keyed = json!({ "type": "object", "properties": { "a.input": { "type": "boolean", "description": "Why */ not" } } });
        assert_eq!(
            expr(&keyed, 0),
            "{\n  /** Why *\\/ not */\n  \"a.input\"?: boolean;\n}"
        );
        assert_eq!(
            expr(
                &json!({ "type": "object", "additionalProperties": { "type": "integer" } }),
                0
            ),
            "{ [key: string]: number }"
        );
        assert_eq!(expr(&json!(true), 0), "unknown");
    }

    #[test]
    #[should_panic(expected = "no mapping for the keyword \"if\"")]
    fn refuses_a_keyword_it_does_not_map() {
        expr(&json!({ "if": {} }), 0);
    }
}
