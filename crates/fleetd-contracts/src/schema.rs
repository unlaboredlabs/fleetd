//! JSON Schema (draft 2020-12) for the app-facing types, one file per type in `crates/fleetd-contracts/schema/`:
//! `{ "$schema", "$ref": "#/$defs/<Name>", "$defs" }`.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use schemars::generate::SchemaSettings;
use serde_json::{Map, Value};

use crate::app::{AppClientMessage, AppServerMessage};
use crate::events::{
    AskEventData, ClaimEventData, HubEvent, HubEventType, MachineSleptData, PromptChangedData,
    ThreadEventData, TrainEventData, WorkstreamEventData, WorkstreamNoteData,
};
use crate::ledger::{Ask, Batch, Decision, Lead, Workstream};
use crate::mcp::McpToolName;
use crate::model::{Machine, ProjectOutcome, ProjectSummary, ThreadSummary};
use crate::projects::{CloneProgressData, ProjectAddFailedData, ProjectAddedData};
use crate::status::{
    ChangeStateData, CiMainData, GithubDriftData, PlanChangedData, PlanVerifiedData,
    SourceFreshData, SourceStaleData,
};
use crate::steer::SteerEventData;
use crate::tasks::TaskEventData;
use crate::tasks::{SlotState, Task};
use crate::train::{Change, TrainState};
use crate::usage::UsageEventData;
use crate::verification::{Claim, Incident};

pub const META_SCHEMA: &str = "https://json-schema.org/draft/2020-12/schema";

/// One schema document with the root type under `$defs/<name>`.
pub fn document<T: JsonSchema>(name: &str) -> Value {
    document_with(name, |generator| T::json_schema(generator))
}

/// Every tool's input and output, keyed "<tool>.input" / "<tool>.output", for clients of the app call frame.
pub fn mcp_tools_document() -> Value {
    document_with("McpTools", |generator| {
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

/// `HubEvent.data` by event type, keyed by the wire name, for the event types whose data has a declared shape.
pub fn hub_event_data_document() -> Value {
    use HubEventType as E;
    document_with("HubEventData", |generator| {
        let mut properties = Map::new();
        let mut add = |types: &[HubEventType], schema: schemars::Schema| {
            for t in types {
                properties.insert(t.as_str().to_owned(), schema.clone().to_value());
            }
        };
        macro_rules! data {
            ($ty:ty: $($event:ident),+ $(,)?) => { add(&[$(E::$event),+], generator.subschema_for::<$ty>()) };
        }
        data!(ThreadEventData: ThreadStarted, ThreadCompleted, ThreadFailed, ThreadInterrupted, ThreadWaiting, ThreadStalled);
        data!(UsageEventData: ThreadUsageLimited, UsageBreaker, UsageResumed);
        data!(MachineSleptData: MachineSlept);
        data!(ProjectAddedData: ProjectAdded);
        data!(CloneProgressData: ProjectCloneProgress);
        data!(ProjectAddFailedData: ProjectAddFailed);
        data!(WorkstreamEventData: WorkstreamCreated, WorkstreamRunning, WorkstreamState, WorkstreamDone);
        data!(WorkstreamNoteData: WorkstreamNote);
        data!(AskEventData: AskCreated, AskAuto, AskAnswered, AskUndone, AskDelivered);
        data!(TaskEventData: TaskQueued, TaskStarted, TaskCompleted, TaskFailed, TaskCancelled, TaskOutOfArea);
        data!(ClaimEventData: ClaimPassed, ClaimFailed);
        data!(TrainEventData: ChangeQueued, ChangeReady, ChangeNeedsRebase, ChangeCiFailed, ChangeRefused, PrMerged,
            TrainFrozen, TrainResumed, TrainBlocked);
        data!(ChangeStateData: ChangeState);
        data!(CiMainData: CiMain);
        data!(GithubDriftData: GithubDrift);
        data!(SourceStaleData: SourceStale);
        data!(SourceFreshData: SourceFresh);
        data!(PlanChangedData: PlanChanged);
        data!(PlanVerifiedData: PlanVerified);
        data!(PromptChangedData: PromptChanged);
        data!(SteerEventData: SteerQueued, SteerDelivered, SteerAcknowledged, SteerUnacknowledged, SteerWithdrawn,
            SteerFailed);
        let required: Vec<Value> = properties.keys().cloned().map(Value::String).collect();
        schemars::json_schema!({ "type": "object", "properties": properties, "required": required })
    })
}

fn document_with(
    name: &str,
    root: impl FnOnce(&mut schemars::SchemaGenerator) -> schemars::Schema,
) -> Value {
    let mut generator = SchemaSettings::draft2020_12().into_generator();
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
    out.insert("McpTools", mcp_tools_document());
    out.insert("HubEventData", hub_event_data_document());
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
    #[test]
    fn generated_contracts_are_current() {
        let drift = super::drift();
        assert!(
            drift.is_empty(),
            "out of date: {drift:?}: run `cargo run -p fleetd-contracts --bin fleetd-schema`"
        );
    }
}
