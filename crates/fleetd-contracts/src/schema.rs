//! JSON Schema (draft 2020-12) for the app-facing types, one file per type in `crates/fleetd-contracts/schema/`:
//! `{ "$schema", "$ref": "#/$defs/<Name>", "$defs" }`.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use schemars::generate::SchemaSettings;
use serde_json::{Map, Value};

use crate::app::{AppClientMessage, AppServerMessage};
use crate::blocks::ChatBlock;
use crate::chat::{ChatMessage, ProjectChatState};
use crate::events::{
    HubEvent, HubEventType, MachineGuardData, MachineSleptData, PromptChangedData,
    RecoveryPausedData, RequestEventData, ThreadEventData, ThreadOrphanedData, TrainEventData,
    WorkstreamEventData,
};
use crate::ledger::{Decision, HumanRequest, Lead, Workstream};
use crate::mcp::McpToolName;
use crate::model::{Machine, ProjectOutcome, ProjectSummary, ThreadSummary};
use crate::projects::{CloneProgressData, ProjectAddFailedData, ProjectAddedData};
use crate::status::{
    ChangeStateData, CiMainData, PlanChangedData, PlanVerifiedData, SourceFreshData,
    SourceStaleData,
};
use crate::steer::SteerEventData;
use crate::tasks::{AgentsCapData, FetchFailedData, TaskEventData};
use crate::tasks::{SlotState, Task};
use crate::train::{Change, TrainState};
use crate::usage::UsageEventData;

pub const META_SCHEMA: &str = "https://json-schema.org/draft/2020-12/schema";

/// One schema document with the root type under `$defs/<name>`.
pub fn document<T: JsonSchema>(name: &str) -> Value {
    document_for::<T>(name, Side::Deserialize)
}

/// Which side of serde a schema describes. The committed schemas describe what the hub accepts; the serialize side
/// is only for the test that holds the two together.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Deserialize,
    Serialize,
}

fn document_for<T: JsonSchema>(name: &str, side: Side) -> Value {
    document_with(name, side, |generator| T::json_schema(generator))
}

/// Every tool's input and output, keyed "<tool>.input" / "<tool>.output", for clients of the app call frame.
pub fn mcp_tools_document() -> Value {
    mcp_tools_document_for(Side::Deserialize)
}

fn mcp_tools_document_for(side: Side) -> Value {
    document_with("McpTools", side, |generator| {
        let mut properties = Map::new();
        for tool in McpToolName::ALL {
            let input = tool.input_schema(generator).to_value();
            properties.insert(format!("{}.input", tool.as_str()), input);
            let output = tool.output_schema(generator).to_value();
            properties.insert(format!("{}.output", tool.as_str()), output);
        }
        let required: Vec<Value> = properties.keys().cloned().map(Value::String).collect();
        schemars::json_schema!({ "type": "object", "properties": properties, "required": required })
    })
}

fn hub_event_data_document_for(side: Side) -> Value {
    use HubEventType as E;
    document_with("HubEventData", side, |generator| {
        let mut properties = Map::new();
        let mut add = |types: &[HubEventType], schema: schemars::Schema| {
            for t in types {
                properties.insert(t.as_str().to_owned(), schema.clone().to_value());
            }
        };
        macro_rules! data {
            ($ty:ty: $($event:ident),+ $(,)?) => { add(&[$(E::$event),+], generator.subschema_for::<$ty>()) };
        }
        data!(ThreadEventData: ThreadStarted, ThreadCompleted, ThreadFailed, ThreadInterrupted, ThreadWaiting);
        data!(UsageEventData: ThreadUsageLimited, UsageBreaker, UsageResumed);
        data!(MachineSleptData: MachineSlept);
        data!(MachineGuardData: MachineGuard);
        data!(RecoveryPausedData: MachineRecoveryPaused);
        data!(ThreadOrphanedData: ThreadOrphaned);
        data!(ProjectAddedData: ProjectAdded);
        data!(CloneProgressData: ProjectCloneProgress);
        data!(ProjectAddFailedData: ProjectAddFailed);
        data!(WorkstreamEventData: WorkstreamCreated, WorkstreamRunning, WorkstreamState, WorkstreamDone);
        data!(RequestEventData: RequestOpened, RequestUpdated);
        data!(TaskEventData: TaskQueued, TaskStarted, TaskCompleted, TaskFailed, TaskCancelled);
        data!(AgentsCapData: AgentsCap);
        data!(FetchFailedData: ProjectFetchFailed);
        data!(TrainEventData: ChangeQueued, ChangeReady, ChangeNeedsRebase, ChangeCiFailed, ChangeRefused, PrMerged,
            PrMergedOutside);
        data!(ChangeStateData: ChangeState);
        data!(CiMainData: CiMain);
        data!(SourceStaleData: SourceStale);
        data!(SourceFreshData: SourceFresh);
        data!(PlanChangedData: PlanChanged);
        data!(PlanVerifiedData: PlanVerified);
        data!(PromptChangedData: PromptChanged);
        data!(crate::chat::ChatMessageEventData: ChatMessage);
        data!(crate::chat::ProjectChatState: ChatWaiting);
        data!(crate::metrics::AppPresenceData: AppPresence);
        data!(crate::metrics::RepoAdvancedData: RepoAdvanced);
        data!(crate::work::WorkEventData: WorkClaimed, WorkEnded);
        data!(crate::work::WorkLandedData: WorkLanded);
        data!(SteerEventData: SteerQueued, SteerDelivered, SteerAcknowledged, SteerUnacknowledged, SteerWithdrawn,
            SteerFailed);
        let required: Vec<Value> = properties.keys().cloned().map(Value::String).collect();
        schemars::json_schema!({ "type": "object", "properties": properties, "required": required })
    })
}

/// A self-contained schema for a tool's input, every subschema inlined: an MCP `inputSchema`. The type's own doc
/// comment is left out; the tool's description says what it does.
pub fn inline_schema<T: JsonSchema>() -> Value {
    let mut generator = SchemaSettings::draft2020_12()
        .with(|s| s.inline_subschemas = true)
        .into_generator();
    let Value::Object(mut root) = T::json_schema(&mut generator).to_value() else {
        unreachable!("a root schema is an object")
    };
    strip_optional_nulls(&mut root);
    root.remove("$schema");
    root.remove("title");
    root.remove("description");
    Value::Object(root)
}

fn document_with(
    name: &str,
    side: Side,
    root: impl FnOnce(&mut schemars::SchemaGenerator) -> schemars::Schema,
) -> Value {
    let settings = match side {
        Side::Deserialize => SchemaSettings::draft2020_12(),
        Side::Serialize => SchemaSettings::draft2020_12().for_serialize(),
    };
    let mut generator = settings.into_generator();
    let Value::Object(mut root) = root(&mut generator).to_value() else {
        unreachable!("a root schema is an object")
    };
    let mut defs: Map<String, Value> = generator.take_definitions(true).into_iter().collect();
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
    json_schemas_for(Side::Deserialize)
}

fn json_schemas_for(side: Side) -> BTreeMap<&'static str, Value> {
    let mut out = BTreeMap::new();
    macro_rules! add {
        ($($name:ident),* $(,)?) => { $(out.insert(stringify!($name), document_for::<$name>(stringify!($name), side));)* };
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
        HumanRequest,
        Decision,
        Task,
        SlotState,
        Change,
        TrainState,
        ChatMessage,
        ChatBlock,
        ProjectChatState,
    );
    out.insert("McpTools", mcp_tools_document_for(side));
    out.insert("HubEventData", hub_event_data_document_for(side));
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

/// The generated TypeScript: file name -> contents, for `ts::TS_DIR`.
pub fn render_ts() -> BTreeMap<String, String> {
    BTreeMap::from([(
        crate::ts::TS_FILE.to_owned(),
        crate::ts::render(&json_schemas()),
    )])
}

/// The repo root, from this crate's manifest directory.
pub fn repo_root() -> std::path::PathBuf {
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    crate_dir
        .ancestors()
        .nth(2)
        .unwrap_or(crate_dir)
        .to_path_buf()
}

/// Every generated file that differs from what is checked in, or that is checked in and no longer generated.
pub fn drift() -> Vec<String> {
    let mut stale = Vec::new();
    let sets = [
        (
            repo_root().join("crates/fleetd-contracts/schema"),
            render_json_schemas(),
            "json",
        ),
        (repo_root().join(crate::ts::TS_DIR), render_ts(), "ts"),
    ];
    for (dir, files, ext) in sets {
        for (file, text) in &files {
            if std::fs::read_to_string(dir.join(file)).ok().as_deref() != Some(text.as_str()) {
                stale.push(dir.join(file).display().to_string());
            }
        }
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(ext) && !files.contains_key(&name) {
                stale.push(format!("{} (no longer generated)", entry.path().display()));
            }
        }
    }
    stale
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::Value;

    use super::{Side, json_schemas_for};

    /// Every object schema under `value`, by JSON pointer: its required keys and the properties that admit null.
    fn objects(
        value: &Value,
        path: String,
        out: &mut BTreeMap<String, (Vec<String>, Vec<String>)>,
    ) {
        match value {
            Value::Object(map) => {
                if let Some(Value::Object(properties)) = map.get("properties") {
                    let required = map
                        .get("required")
                        .and_then(Value::as_array)
                        .map(|r| {
                            r.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default();
                    let nullable = properties
                        .iter()
                        .filter(|(_, p)| admits_null(p))
                        .map(|(k, _)| k.clone())
                        .collect();
                    out.insert(path.clone(), (required, nullable));
                }
                for (k, v) in map {
                    objects(v, format!("{path}/{k}"), out);
                }
            }
            Value::Array(items) => {
                for (i, v) in items.iter().enumerate() {
                    objects(v, format!("{path}/{i}"), out);
                }
            }
            _ => {}
        }
    }

    fn admits_null(p: &Value) -> bool {
        let null = Value::String("null".into());
        match p.get("type") {
            Some(Value::Array(types)) if types.contains(&null) => return true,
            Some(t) if *t == null => return true,
            _ => {}
        }
        ["anyOf", "oneOf"].iter().any(|k| {
            p.get(*k)
                .and_then(Value::as_array)
                .is_some_and(|alts| alts.iter().any(admits_null))
        })
    }

    /// The schemas (and the app's types) say an optional key is absent, never null. An `Option` the hub serializes
    /// without `skip_serializing_none` sends `null` instead: the serialize side then requires a nullable key the
    /// deserialize side calls optional. Catch every such field.
    #[test]
    fn optional_keys_are_never_sent_as_null() {
        let de = json_schemas_for(Side::Deserialize);
        let ser = json_schemas_for(Side::Serialize);
        let mut sent_null = Vec::new();
        for (doc, de_doc) in &de {
            let (mut de_objects, mut ser_objects) = (BTreeMap::new(), BTreeMap::new());
            objects(de_doc, String::new(), &mut de_objects);
            objects(&ser[doc], String::new(), &mut ser_objects);
            for (path, (ser_required, ser_nullable)) in &ser_objects {
                let Some((de_required, _)) = de_objects.get(path) else {
                    continue;
                };
                for key in ser_required {
                    if !de_required.contains(key) && ser_nullable.contains(key) {
                        sent_null.push(format!("{doc}.json{path}: {key}"));
                    }
                }
            }
        }
        sent_null.sort();
        sent_null.dedup();
        assert!(
            sent_null.is_empty(),
            "serialized as null but schema'd as optional (add #[skip_serializing_none]): {sent_null:#?}"
        );
    }

    #[test]
    fn generated_contracts_are_current() {
        let drift = super::drift();
        assert!(
            drift.is_empty(),
            "out of date: {drift:?}: run `cargo run -p fleetd-contracts --bin fleetd-schema`"
        );
    }
}
