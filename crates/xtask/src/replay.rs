//! Replays the recorded T3 streams (apps/hub/test/fixtures, wire JSON from a lab T3) through t3-wire's decoders.
use std::path::Path;

use anyhow::Context;
use serde::de::DeserializeOwned;
use serde_json::Value;
use t3_wire::types::{ShellStreamItem, ThreadEvent, ThreadStreamItem, TurnItem, TurnItemKind};

pub struct Replayed {
    pub items: usize,
    pub problems: Vec<String>,
}

const SHELL: &[&str] = &[
    "shell-live.json",
    "shell-resume-replay.json",
    "shell-resume-snapshot.json",
];
const THREAD: &[&str] = &["thread-a-stream.json", "thread-a-tail.json"];

fn load(dir: &Path, name: &str) -> anyhow::Result<Value> {
    let text = std::fs::read_to_string(dir.join(name))
        .with_context(|| format!("reading fixture {name}"))?;
    Ok(serde_json::from_str(&text)?)
}

fn decode_all<T: DeserializeOwned>(
    file: &str,
    key: &str,
    fixture: &Value,
    out: &mut Vec<T>,
    problems: &mut Vec<String>,
) {
    for (i, raw) in fixture[key].as_array().into_iter().flatten().enumerate() {
        match serde_json::from_value::<T>(raw.clone()) {
            Ok(v) => out.push(v),
            Err(e) => problems.push(format!("fixture {file} {key}[{i}] does not decode: {e}")),
        }
    }
}

/// A turn item T3 sent with a `type` fleetd models must not fall through to `Other`.
fn check_item(file: &str, raw_type: Option<&str>, item: &TurnItem, problems: &mut Vec<String>) {
    let modeled = [
        "command_execution",
        "file_change",
        "dynamic_tool",
        "file_search",
        "web_search",
        "subagent",
        "error",
        "user_input_request",
        "approval_request",
    ];
    if matches!(item.kind, TurnItemKind::Other) && raw_type.is_some_and(|t| modeled.contains(&t)) {
        problems.push(format!(
            "fixture {file}: item {} of type {raw_type:?} decoded as Other",
            item.id
        ));
    }
}

pub fn replay(dir: &Path) -> anyhow::Result<Replayed> {
    let mut problems = Vec::new();
    let mut items = 0;
    for file in SHELL {
        let fixture = load(dir, file)?;
        let mut decoded: Vec<ShellStreamItem> = Vec::new();
        decode_all(file, "items", &fixture, &mut decoded, &mut problems);
        let snapshots = decoded
            .iter()
            .filter(|i| matches!(i, ShellStreamItem::Snapshot(_)))
            .count();
        let unknown = decoded
            .iter()
            .filter(|i| matches!(i, ShellStreamItem::Other))
            .count();
        if unknown > 0 {
            problems.push(format!(
                "fixture {file}: {unknown} shell item(s) of a kind fleetd does not know"
            ));
        }
        if *file != "shell-resume-replay.json" && snapshots == 0 {
            problems.push(format!("fixture {file}: no snapshot decoded"));
        }
        items += decoded.len();
    }
    for file in THREAD {
        let fixture = load(dir, file)?;
        let mut decoded: Vec<ThreadStreamItem> = Vec::new();
        decode_all(file, "items", &fixture, &mut decoded, &mut problems);
        let raw = fixture["items"].as_array().cloned().unwrap_or_default();
        for (item, raw) in decoded.iter().zip(&raw) {
            match item {
                ThreadStreamItem::Snapshot(s) => {
                    for (t, r) in s.projection.turn_items.iter().zip(
                        raw["projection"]["turnItems"]
                            .as_array()
                            .into_iter()
                            .flatten(),
                    ) {
                        check_item(file, r["type"].as_str(), t, &mut problems);
                    }
                }
                ThreadStreamItem::Event(e) => {
                    if let ThreadEvent::TurnItemUpdated(p) = &e.event {
                        check_item(
                            file,
                            raw["event"]["payload"]["type"].as_str(),
                            &p.payload,
                            &mut problems,
                        );
                    }
                }
                ThreadStreamItem::Other => problems.push(format!(
                    "fixture {file}: a thread item of a kind fleetd does not know"
                )),
                ThreadStreamItem::Synchronized => {}
            }
        }
        if !decoded
            .iter()
            .any(|i| matches!(i, ThreadStreamItem::Snapshot(_)))
        {
            problems.push(format!("fixture {file}: no snapshot decoded"));
        }
        items += decoded.len();
        if fixture.get("commandItems").is_some() {
            let mut commands: Vec<Option<TurnItem>> = Vec::new();
            decode_all(file, "commandItems", &fixture, &mut commands, &mut problems);
            for (item, raw) in commands
                .iter()
                .zip(fixture["commandItems"].as_array().into_iter().flatten())
            {
                if let Some(item) = item {
                    check_item(file, raw["type"].as_str(), item, &mut problems);
                }
            }
            items += commands.len();
        }
    }
    Ok(Replayed { items, problems })
}

#[cfg(test)]
mod tests {
    #[test]
    fn recorded_streams_decode() {
        let dir = crate::repo_root().join("apps/hub/test/fixtures");
        let replayed = super::replay(&dir).unwrap();
        assert!(replayed.problems.is_empty(), "{:#?}", replayed.problems);
        assert!(replayed.items > 0);
    }
}
