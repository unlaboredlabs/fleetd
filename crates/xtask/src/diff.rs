//! Structural diff of fleetd's Rust wire types (schemars) against T3's contracts (effect's JSON Schema export).
//!
//! The Rust side drives: only fields fleetd sends or reads are compared, and every T3 field fleetd does not type
//! is ignored. A problem is reported when
//! - a field fleetd sends or reads is missing upstream (renamed or removed), or T3 now requires one fleetd does
//!   not send;
//! - a type changed (kind, a literal fleetd uses dropped from an enum, null or omission now possible for a field
//!   fleetd requires, integer -> number);
//! - a tagged-union variant fleetd uses (`kind`, `type`, `_tag`, `operation`) no longer exists.
//!
//! Both sides are normalized lazily into alternatives (`Alt`), resolving `$ref`, `allOf`, `anyOf`/`oneOf`, `enum`,
//! `const` and type arrays, so the two generators' different spellings compare equal.
use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dir {
    /// fleetd sends it, T3 decodes it.
    Send,
    /// T3 sends it, fleetd decodes it.
    Read,
}

/// A schema document: its root plus the definitions `$ref`s point into.
pub struct Doc<'a> {
    root: &'a Value,
    defs: &'a Map<String, Value>,
}

impl<'a> Doc<'a> {
    pub fn new(root: &'a Value) -> Self {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        let defs = root
            .get("$defs")
            .and_then(Value::as_object)
            .unwrap_or_else(|| EMPTY.get_or_init(Map::new));
        Doc { root, defs }
    }

    fn resolve(&self, reference: &str) -> Value {
        let name = reference.rsplit('/').next().unwrap_or(reference);
        self.defs.get(name).cloned().unwrap_or(Value::Bool(true))
    }
}

#[derive(Clone, Debug)]
enum Alt {
    Any,
    Null,
    Bool,
    Int,
    Num,
    /// `None`: any string; `Some`: one of these literals.
    Str(Option<BTreeSet<String>>),
    Arr(Value),
    Obj(Obj),
}

#[derive(Clone, Debug, Default)]
struct Obj {
    props: BTreeMap<String, Value>,
    required: BTreeSet<String>,
    /// A map's value schema (`additionalProperties: {…}`); `true`/absent is not recorded.
    values: Option<Value>,
}

impl Alt {
    fn kind(&self) -> &'static str {
        match self {
            Alt::Any => "any",
            Alt::Null => "null",
            Alt::Bool => "boolean",
            Alt::Int => "integer",
            Alt::Num => "number",
            Alt::Str(_) => "string",
            Alt::Arr(_) => "array",
            Alt::Obj(_) => "object",
        }
    }
}

fn without(v: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    v.iter()
        .filter(|(k, _)| !keys.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn literal(v: &Value) -> Alt {
    match v {
        Value::Null => Alt::Null,
        Value::Bool(_) => Alt::Bool,
        Value::Number(n) if n.is_i64() || n.is_u64() => Alt::Int,
        Value::Number(_) => Alt::Num,
        Value::String(s) => Alt::Str(Some(BTreeSet::from([s.clone()]))),
        Value::Array(_) => Alt::Arr(Value::Bool(true)),
        Value::Object(_) => Alt::Obj(Obj::default()),
    }
}

/// Merges two alternatives that must both hold (`allOf`, `$ref` with siblings, base properties with `oneOf`).
fn meet(a: Alt, b: Alt) -> Alt {
    match (a, b) {
        (Alt::Any, x) | (x, Alt::Any) => x,
        (Alt::Obj(mut a), Alt::Obj(b)) => {
            for (k, v) in b.props {
                match a.props.remove(&k) {
                    Some(prev) => a.props.insert(k, json!({ "allOf": [prev, v] })),
                    None => a.props.insert(k, v),
                };
            }
            a.required.extend(b.required);
            a.values = a.values.or(b.values);
            Alt::Obj(a)
        }
        (Alt::Str(Some(a)), Alt::Str(Some(b))) => {
            Alt::Str(Some(a.intersection(&b).cloned().collect()))
        }
        (Alt::Str(None), s @ Alt::Str(_)) => s,
        (a, _) => a,
    }
}

fn product(left: Vec<Alt>, right: Vec<Alt>) -> Vec<Alt> {
    let mut out = Vec::new();
    for a in &left {
        for b in &right {
            out.push(meet(a.clone(), b.clone()));
        }
    }
    out
}

/// The alternatives a schema allows.
fn norm(doc: &Doc, v: &Value) -> Vec<Alt> {
    let obj = match v {
        Value::Bool(true) => return vec![Alt::Any],
        Value::Bool(false) => return vec![],
        Value::Object(o) => o,
        _ => return vec![Alt::Any],
    };
    if let Some(Value::String(r)) = obj.get("$ref") {
        let target = doc.resolve(r);
        let rest = without(obj, &["$ref"]);
        return product(norm(doc, &target), norm(doc, &Value::Object(rest)));
    }
    if let Some(Value::Array(all)) = obj.get("allOf") {
        let mut acc = norm(doc, &Value::Object(without(obj, &["allOf"])));
        for member in all {
            acc = product(acc, norm(doc, member));
        }
        return acc;
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(Value::Array(alts)) = obj.get(key) {
            let base = norm(doc, &Value::Object(without(obj, &[key])));
            return product(base, alts.iter().flat_map(|a| norm(doc, a)).collect());
        }
    }
    if let Some(Value::Array(values)) = obj.get("enum") {
        let mut strs = BTreeSet::new();
        let mut out = Vec::new();
        for value in values {
            match value {
                Value::String(s) => drop(strs.insert(s.clone())),
                other => out.push(literal(other)),
            }
        }
        if !strs.is_empty() {
            out.push(Alt::Str(Some(strs)));
        }
        return out;
    }
    if let Some(c) = obj.get("const") {
        return vec![literal(c)];
    }
    let types: Vec<&str> = match obj.get("type") {
        Some(Value::String(t)) => vec![t.as_str()],
        Some(Value::Array(ts)) => ts.iter().filter_map(Value::as_str).collect(),
        _ if obj.contains_key("properties") || obj.contains_key("additionalProperties") => {
            vec!["object"]
        }
        _ if obj.contains_key("items") => vec!["array"],
        // No type constraint: effect writes `{}` for `Schema.Unknown`, schemars `true` for `serde_json::Value`.
        _ => return vec![Alt::Any],
    };
    types
        .into_iter()
        .map(|t| match t {
            "null" => Alt::Null,
            "boolean" => Alt::Bool,
            "integer" => Alt::Int,
            "number" => Alt::Num,
            "string" => Alt::Str(None),
            "array" => Alt::Arr(obj.get("items").cloned().unwrap_or(Value::Bool(true))),
            "object" => Alt::Obj(Obj {
                props: obj
                    .get("properties")
                    .and_then(Value::as_object)
                    .map(|p| p.clone().into_iter().collect())
                    .unwrap_or_default(),
                required: obj
                    .get("required")
                    .and_then(Value::as_array)
                    .map(|r| {
                        r.iter()
                            .filter_map(Value::as_str)
                            .map(String::from)
                            .collect()
                    })
                    .unwrap_or_default(),
                values: obj
                    .get("additionalProperties")
                    .filter(|v| v.is_object())
                    .cloned(),
            }),
            _ => Alt::Any,
        })
        .collect()
}

const TAG_KEYS: &[&str] = &["kind", "type", "_tag", "operation"];

/// The `(key, literal)` a Rust union variant is told apart by.
fn discriminator(doc: &Doc, obj: &Obj) -> Option<(String, String)> {
    let single = |key: &str| {
        let schema = obj.props.get(key)?;
        match norm(doc, schema).as_slice() {
            [Alt::Str(Some(set))] if set.len() == 1 => set.iter().next().cloned(),
            _ => None,
        }
    };
    TAG_KEYS
        .iter()
        .find_map(|k| single(k).map(|v| (k.to_string(), v)))
}

/// Merges several upstream objects into one: a property is the union of its schemas, required only if every
/// object requires it.
fn join_objects(objs: Vec<Obj>) -> Obj {
    let mut out = Obj::default();
    let mut seen: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for o in &objs {
        for (k, v) in &o.props {
            let list = seen.entry(k.clone()).or_default();
            if !list.contains(v) {
                list.push(v.clone());
            }
        }
    }
    out.required = objs
        .iter()
        .map(|o| o.required.clone())
        .reduce(|a, b| a.intersection(&b).cloned().collect())
        .unwrap_or_default();
    // A property some object lacks may be absent.
    out.required
        .retain(|k| objs.iter().all(|o| o.props.contains_key(k)));
    out.props = seen
        .into_iter()
        .map(|(k, mut vs)| {
            (
                k,
                if vs.len() == 1 {
                    vs.remove(0)
                } else {
                    json!({ "anyOf": vs })
                },
            )
        })
        .collect();
    out.values = objs.into_iter().find_map(|o| o.values);
    out
}

pub struct Differ<'a> {
    rust: Doc<'a>,
    up: Doc<'a>,
    dir: Dir,
    pub problems: Vec<String>,
}

impl<'a> Differ<'a> {
    pub fn new(rust: &'a Value, up: &'a Value, dir: Dir) -> Self {
        Differ {
            rust: Doc::new(rust),
            up: Doc::new(up),
            dir,
            problems: Vec::new(),
        }
    }

    pub fn run(mut self, path: &str) -> Vec<String> {
        let (r, u) = (self.rust.root.clone(), self.up.root.clone());
        self.check(&r, &u, path);
        self.problems
    }

    fn problem(&mut self, path: &str, text: String) {
        self.problems.push(format!("{path}: {text}"));
    }

    fn check(&mut self, r: &Value, u: &Value, path: &str) {
        let ra = norm(&self.rust, r);
        if ra.iter().any(|a| matches!(a, Alt::Any)) {
            return;
        }
        let ua = norm(&self.up, u);
        if ua.iter().any(|a| matches!(a, Alt::Any)) {
            return;
        }
        let r_null = ra.iter().any(|a| matches!(a, Alt::Null));
        let u_null = ua.iter().any(|a| matches!(a, Alt::Null));
        if self.dir == Dir::Read && u_null && !r_null {
            self.problem(
                path,
                "T3 can send null here; fleetd's type does not take it".into(),
            );
        }
        let ra: Vec<Alt> = ra.into_iter().filter(|a| !matches!(a, Alt::Null)).collect();
        let ua: Vec<Alt> = ua.into_iter().filter(|a| !matches!(a, Alt::Null)).collect();
        if ra.is_empty() {
            return;
        }
        if ua.is_empty() {
            if self.dir == Dir::Send {
                self.problem(path, "T3 takes only null here".into());
            }
            return;
        }
        let rust_union = ra.len() > 1;
        for alt in &ra {
            let tagged = match alt {
                Alt::Obj(o) => discriminator(&self.rust, o),
                _ => None,
            };
            let (label, cands) = match &tagged {
                Some((key, value)) => (
                    format!("{path}[{key}={value}]"),
                    self.by_tag(&ua, key, value),
                ),
                None if rust_union => (
                    path.to_string(),
                    ua.iter().filter(|u| same_kind(alt, u)).cloned().collect(),
                ),
                None => (path.to_string(), ua.clone()),
            };
            if cands.is_empty() {
                let what = match &tagged {
                    Some((k, v)) => format!("T3 no longer has the {k}={v:?} variant fleetd uses"),
                    None => format!("T3 no longer takes a {} here", alt.kind()),
                };
                self.problem(path, what);
                continue;
            }
            self.against(alt, cands, &label);
        }
    }

    /// Upstream alternatives whose `key` is the literal `value`. A generic `string` fallback upstream does not
    /// count: fleetd relies on the variant itself.
    fn by_tag(&self, ua: &[Alt], key: &str, value: &str) -> Vec<Alt> {
        ua.iter()
            .filter(|u| {
                let Alt::Obj(o) = u else { return false };
                o.props.get(key).is_some_and(|schema| {
                    norm(&self.up, schema)
                        .iter()
                        .any(|a| matches!(a, Alt::Str(Some(set)) if set.contains(value)))
                })
            })
            .cloned()
            .collect()
    }

    /// Compares one Rust alternative with the upstream alternatives it can meet. Sending, one of them must take it;
    /// reading, it must take all of them.
    fn against(&mut self, alt: &Alt, cands: Vec<Alt>, path: &str) {
        let mut objs = Vec::new();
        let mut others = Vec::new();
        for c in cands {
            match c {
                Alt::Obj(o) => objs.push(o),
                other => others.push(other),
            }
        }
        let mut groups: Vec<Alt> = others;
        if !objs.is_empty() {
            groups.push(Alt::Obj(join_objects(objs)));
        }
        match self.dir {
            Dir::Read => {
                for g in &groups {
                    self.leaf(alt, g, path);
                }
            }
            Dir::Send => {
                let before = self.problems.len();
                let mut best: Option<Vec<String>> = None;
                for g in &groups {
                    let mut trial = Differ {
                        rust: Doc::new(self.rust.root),
                        up: Doc::new(self.up.root),
                        dir: self.dir,
                        problems: vec![],
                    };
                    trial.leaf(alt, g, path);
                    if trial.problems.is_empty() {
                        return;
                    }
                    if best.as_ref().is_none_or(|b| trial.problems.len() < b.len()) {
                        best = Some(trial.problems);
                    }
                }
                self.problems.truncate(before);
                self.problems.extend(best.unwrap_or_default());
            }
        }
    }

    fn leaf(&mut self, r: &Alt, u: &Alt, path: &str) {
        match (r, u) {
            (Alt::Bool, Alt::Bool) | (Alt::Int, Alt::Int) | (Alt::Num, Alt::Num) => {}
            (Alt::Int, Alt::Num) if self.dir == Dir::Send => {}
            (Alt::Num, Alt::Int) if self.dir == Dir::Read => {}
            (Alt::Str(rs), Alt::Str(us)) => match (rs, us) {
                (Some(r), Some(u)) => {
                    let gone: Vec<_> = r.difference(u).cloned().collect();
                    if !gone.is_empty() {
                        self.problem(path, format!("T3 dropped {gone:?} (now one of {u:?})"));
                    }
                }
                (None, Some(u)) if self.dir == Dir::Send => {
                    self.problem(
                        path,
                        format!("fleetd sends any string; T3 takes only {u:?}"),
                    );
                }
                _ => {}
            },
            (Alt::Arr(ri), Alt::Arr(ui)) => self.check(ri, ui, &format!("{path}[]")),
            (Alt::Obj(ro), Alt::Obj(uo)) => self.object(ro, uo, path),
            _ => self.problem(
                path,
                format!("type changed: fleetd has {}, T3 has {}", r.kind(), u.kind()),
            ),
        }
    }

    fn object(&mut self, r: &Obj, u: &Obj, path: &str) {
        for (name, rs) in &r.props {
            let at = format!("{path}.{name}");
            match u.props.get(name) {
                Some(us) => {
                    if self.dir == Dir::Read
                        && r.required.contains(name)
                        && !u.required.contains(name)
                    {
                        self.problem(&at, "T3 may omit it; fleetd requires it".into());
                    }
                    self.check(rs, us, &at);
                }
                None => match &u.values {
                    Some(vs) => self.check(rs, vs, &at),
                    None => self.problem(&at, "missing in T3 (renamed or removed)".into()),
                },
            }
        }
        if self.dir == Dir::Send {
            for name in &u.required {
                if !r.required.contains(name) {
                    let why = if r.props.contains_key(name) {
                        "fleetd does not always send it"
                    } else {
                        "fleetd does not send it"
                    };
                    self.problem(&format!("{path}.{name}"), format!("T3 requires it; {why}"));
                }
            }
        }
        if let (Some(rv), Some(uv)) = (&r.values, &u.values) {
            self.check(rv, uv, &format!("{path}{{*}}"));
        }
    }
}

fn same_kind(a: &Alt, b: &Alt) -> bool {
    matches!((a, b), (Alt::Int | Alt::Num, Alt::Int | Alt::Num)) || a.kind() == b.kind()
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{Differ, Dir};

    fn diff(rust: Value, up: Value, dir: Dir) -> Vec<String> {
        Differ::new(&rust, &up, dir).run("m")
    }

    /// effect's spelling: `anyOf` with null, single-value `enum` tags, `$defs` refs.
    fn upstream_item() -> Value {
        json!({
            "anyOf": [
                { "type": "object", "properties": { "kind": { "type": "string", "enum": ["snapshot"] }, "seq": { "type": "integer" } }, "required": ["kind", "seq"] },
                { "$ref": "#/$defs/Updated" }
            ],
            "$defs": { "Updated": { "type": "object", "properties": {
                "kind": { "type": "string", "enum": ["thread.updated"] },
                "runId": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                "mode": { "type": "string", "enum": ["auto", "plan"] }
            }, "required": ["kind", "runId", "mode"] } }
        })
    }

    /// schemars' spelling: `oneOf` with `const` tags, `$ref` beside sibling properties, type arrays for null.
    fn rust_item(run_id_key: &str, kind: &str) -> Value {
        json!({
            "oneOf": [
                { "type": "object", "properties": { "kind": { "type": "string", "const": "snapshot" } }, "$ref": "#/$defs/Snap", "required": ["kind"] },
                { "type": "object", "properties": { "kind": { "type": "string", "const": kind } }, "$ref": "#/$defs/Upd", "required": ["kind"] }
            ],
            "$defs": {
                "Snap": { "type": "object", "properties": { "seq": { "type": "integer", "format": "uint64" } }, "required": ["seq"] },
                "Upd": { "type": "object", "properties": { run_id_key: { "type": ["string", "null"] } } }
            }
        })
    }

    #[test]
    fn equal_shapes_in_either_spelling_pass() {
        assert_eq!(
            diff(
                rust_item("runId", "thread.updated"),
                upstream_item(),
                Dir::Read
            ),
            Vec::<String>::new()
        );
    }

    #[test]
    fn renamed_read_field_and_removed_variant_fail() {
        assert_eq!(
            diff(
                rust_item("runID", "thread.updated"),
                upstream_item(),
                Dir::Read
            ),
            ["m[kind=thread.updated].runID: missing in T3 (renamed or removed)"]
        );
        assert_eq!(
            diff(
                rust_item("runId", "thread.changed"),
                upstream_item(),
                Dir::Read
            ),
            ["m: T3 no longer has the kind=\"thread.changed\" variant fleetd uses"]
        );
    }

    #[test]
    fn read_field_that_became_nullable_or_optional_fails() {
        let up = json!({ "type": "object", "properties": { "a": { "anyOf": [{ "type": "string" }, { "type": "null" }] } } });
        let rust = json!({ "type": "object", "properties": { "a": { "type": "string" } }, "required": ["a"] });
        assert_eq!(
            diff(rust, up, Dir::Read),
            [
                "m.a: T3 may omit it; fleetd requires it",
                "m.a: T3 can send null here; fleetd's type does not take it"
            ]
        );
    }

    #[test]
    fn sends_t3_would_reject_fail() {
        let up = json!({ "type": "object", "properties": {
            "mode": { "type": "string", "enum": ["auto", "plan"] }, "id": { "type": "string" }, "n": { "type": "integer" }
        }, "required": ["mode", "id"] });
        let rust = json!({ "type": "object", "properties": {
            "mode": { "type": "string", "enum": ["auto", "yolo"] }, "n": { "type": "number" }, "extra": { "type": "string" }
        }, "required": ["mode"] });
        assert_eq!(
            diff(rust, up, Dir::Send),
            [
                "m.extra: missing in T3 (renamed or removed)",
                "m.mode: T3 dropped [\"yolo\"] (now one of {\"auto\", \"plan\"})",
                "m.n: type changed: fleetd has number, T3 has integer",
                "m.id: T3 requires it; fleetd does not send it",
            ]
        );
    }
}
