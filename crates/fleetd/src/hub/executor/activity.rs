//! What one followed thread is doing now, for the app's live lanes: the open tool call or the model's state, the
//! streamed text of the current message, token usage, and a one-minute sparkline of real work. Fed every thread
//! frame the hub receives (including the deltas the transcript view drops), stamped with the hub's clock. Pure.
//!
//! The sparkline counts tool calls started, text streamed, and the output tokens claude reports that were not
//! streamed as text: a file written, a command composed, thinking. Without those an agent that mostly writes
//! files reads as idle while it works hardest.
use std::collections::HashMap;

use fleetd_contracts::live::{
    Activity, ActivityNow, SPARK_BUCKET_SECS, SPARK_BUCKETS, Spark, Tokens,
};
use fleetd_contracts::prim::{List, Text};
use fleetd_contracts::sessions::{
    ItemKind, ItemStatus, MessageRole, RunInfo, RunUsage, ThreadEvent, ThreadItem, ThreadMessage,
};

use super::shell_mapper::js_take;
use crate::hub::store::iso_ms;
use crate::hub::usage::time::parse_ms;

/// Streamed text counts as "writing" this long after the last delta.
pub const WRITING_FOR_MS: i64 = 3000;
/// The newest streamed text kept per thread.
pub const TEXT_TAIL_CHARS: usize = 2000;
const BUCKET_MS: i64 = SPARK_BUCKET_SECS as i64 * 1000;
/// Roughly, for English and code: how many streamed characters one output token is.
const CHARS_PER_TOKEN: u64 = 4;
/// The active run's complete text messages kept per thread. The chat folds each in within a tick, so a few will do.
const DONE_KEPT: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Open {
    activity: Activity,
    started_ms: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Bucket {
    index: i64,
    items: u32,
    chars: u32,
    /// Output tokens that did not stream as text.
    tokens: u32,
}

/// The current message's streamed text: its newest `TEXT_TAIL_CHARS` characters and how many were ever appended,
/// so each reader sends only what it has not sent yet.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamText {
    pub message_id: String,
    pub tail: String,
    pub total: u64,
}

impl StreamText {
    /// What was appended after the reader's `sent` characters, at most the kept tail.
    pub fn since(&self, sent: u64) -> &str {
        let missing = self.total.saturating_sub(sent);
        let kept = self.tail.chars().count() as u64;
        if missing >= kept {
            return &self.tail;
        }
        let skip = (kept - missing) as usize;
        let start = self
            .tail
            .char_indices()
            .nth(skip)
            .map_or(self.tail.len(), |(i, _)| i);
        &self.tail[start..]
    }
}

/// A text message of the active run as the node stored it, complete. Deltas aren't: the node drops one still pending
/// when its complete message lands, so a reader that only follows deltas can miss a message's last words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DoneText {
    pub message_id: String,
    pub text: String,
}

#[derive(Clone, Debug, Default)]
pub struct ActivityTracker {
    /// The session's worktree or workspace root: paths under it are shown repo-relative.
    root: Option<String>,
    open: HashMap<String, Open>,
    active_run: Option<String>,
    /// When the model last had nothing open: a run started, a tool call ended or the text stopped.
    quiet_since_ms: i64,
    writing_since_ms: Option<i64>,
    last_delta_ms: Option<i64>,
    retry: Option<(Activity, i64)>,
    text: Option<StreamText>,
    /// The active run's complete assistant messages, oldest first, at most `DONE_KEPT`.
    done: Vec<DoneText>,
    /// Final usage per run, from `run` events (and the snapshot's runs).
    run_usage: HashMap<String, RunUsage>,
    /// The active run's usage so far.
    live_usage: Option<(String, RunUsage)>,
    /// Text streamed since the last usage report, so that report's output tokens count only what text did not.
    chars_since_usage: u64,
    buckets: [Bucket; SPARK_BUCKETS],
}

impl ActivityTracker {
    pub fn set_root(&mut self, root: Option<String>) {
        self.root = root.map(|r| r.trim_end_matches('/').to_owned());
    }

    pub fn apply(&mut self, event: &ThreadEvent, now_ms: i64) {
        match event {
            ThreadEvent::Snapshot(snap) => {
                let root = self.root.take();
                *self = Self {
                    root,
                    quiet_since_ms: now_ms,
                    buckets: self.buckets,
                    ..Self::default()
                };
                for run in &snap.runs {
                    self.run(run, now_ms);
                }
                // A follow (again) mid-run: what the run already said complete.
                if let Some(active) = self.active_run.clone() {
                    for m in snap
                        .messages
                        .iter()
                        .filter(|m| m.run_id.as_ref().is_some_and(|r| r.as_str() == active))
                    {
                        self.message(m);
                    }
                }
                for item in snap
                    .items
                    .iter()
                    .filter(|i| i.status == ItemStatus::Running)
                {
                    let started = parse_ms(item.started_at.as_str())
                        .unwrap_or(now_ms)
                        .min(now_ms);
                    self.open_item(item, started);
                }
            }
            ThreadEvent::Message(m) => {
                if self.active_run.is_some() {
                    self.message(m);
                }
            }
            ThreadEvent::Item(item) => {
                self.retry = None;
                if item.status == ItemStatus::Running {
                    if !self.open.contains_key(item.id.as_str()) {
                        self.bump(now_ms, 1, 0, 0);
                    }
                    self.open_item(item, now_ms);
                } else {
                    if self.open.remove(item.id.as_str()).is_some() {
                        self.quiet_since_ms = now_ms;
                    } else {
                        // A call that started and ended between two frames is still work done.
                        self.bump(now_ms, 1, 0, 0);
                    }
                    if let Some(retry) = retry_of(item) {
                        self.retry = Some((retry, now_ms));
                    }
                }
            }
            ThreadEvent::Run(run) => self.run(run, now_ms),
            ThreadEvent::Delta {
                message_id, append, ..
            } => {
                self.retry = None;
                let chars = append.chars().count();
                self.bump(now_ms, 0, chars as u32, 0);
                self.chars_since_usage += chars as u64;
                if self
                    .last_delta_ms
                    .is_none_or(|at| now_ms - at > WRITING_FOR_MS)
                {
                    self.writing_since_ms = Some(now_ms);
                }
                self.last_delta_ms = Some(now_ms);
                let text = match &mut self.text {
                    Some(t) if t.message_id == message_id.as_str() => t,
                    _ => self.text.insert(StreamText {
                        message_id: message_id.to_string(),
                        ..StreamText::default()
                    }),
                };
                text.total += chars as u64;
                text.tail.push_str(append);
                let len = text.tail.chars().count();
                if len > TEXT_TAIL_CHARS {
                    let cut = text
                        .tail
                        .char_indices()
                        .nth(len - TEXT_TAIL_CHARS)
                        .map_or(0, |(i, _)| i);
                    text.tail.drain(..cut);
                }
            }
            ThreadEvent::Usage { run_id, usage } => {
                // Usage is cumulative per run. The first report of a run (or one seen after following mid-run)
                // only sets the baseline, so a whole run's tokens never land in one bucket.
                if let Some((run, before)) = &self.live_usage
                    && run == run_id.as_str()
                {
                    let out = usage.output_tokens.saturating_sub(before.output_tokens);
                    let as_text = self.chars_since_usage / CHARS_PER_TOKEN;
                    let unstreamed = out.saturating_sub(as_text);
                    self.bump(now_ms, 0, 0, unstreamed.min(u32::MAX as u64) as u32);
                }
                self.chars_since_usage = 0;
                self.live_usage = Some((run_id.to_string(), usage.clone()));
            }
        }
    }

    fn run(&mut self, run: &RunInfo, now_ms: i64) {
        let id = run.id.as_str();
        if run.status.is_active() {
            if self.active_run.as_deref() != Some(id) {
                self.active_run = Some(id.to_owned());
                self.quiet_since_ms = now_ms;
                self.done.clear();
            }
            return;
        }
        if let Some(usage) = &run.usage {
            self.run_usage.insert(id.to_owned(), usage.clone());
        }
        if self.live_usage.as_ref().is_some_and(|(r, _)| r == id) {
            self.live_usage = None;
        }
        if self.active_run.as_deref() == Some(id) {
            self.active_run = None;
            self.open.clear();
            self.retry = None;
            self.last_delta_ms = None;
            self.writing_since_ms = None;
            self.done.clear();
        }
    }

    fn message(&mut self, m: &ThreadMessage) {
        if m.role != MessageRole::Assistant || m.text.trim().is_empty() {
            return;
        }
        self.done.retain(|d| d.message_id != m.id.as_str());
        self.done.push(DoneText {
            message_id: m.id.to_string(),
            text: m.text.clone(),
        });
        if self.done.len() > DONE_KEPT {
            self.done.remove(0);
        }
    }

    fn open_item(&mut self, item: &ThreadItem, started_ms: i64) {
        let Some(activity) = activity_of(item, self.root.as_deref()) else {
            return;
        };
        let started_ms = self
            .open
            .get(item.id.as_str())
            .map_or(started_ms, |o| o.started_ms);
        self.open.insert(
            item.id.to_string(),
            Open {
                activity,
                started_ms,
            },
        );
    }

    fn bump(&mut self, now_ms: i64, items: u32, chars: u32, tokens: u32) {
        let index = now_ms.div_euclid(BUCKET_MS);
        let slot = &mut self.buckets[index.rem_euclid(SPARK_BUCKETS as i64) as usize];
        if slot.index != index {
            *slot = Bucket {
                index,
                ..Bucket::default()
            };
        }
        slot.items = slot.items.saturating_add(items);
        slot.chars = slot.chars.saturating_add(chars);
        slot.tokens = slot.tokens.saturating_add(tokens);
    }

    /// True while a run is queued, starting, running or waiting.
    pub fn run_active(&self) -> bool {
        self.active_run.is_some()
    }

    /// What the thread is doing at `now_ms`; None when no run is active and nothing is open.
    pub fn now(&self, now_ms: i64) -> Option<ActivityNow> {
        let at = |activity: Activity, since_ms: i64| ActivityNow {
            activity,
            since: iso_ms(since_ms.min(now_ms)).into(),
        };
        // Not filtered by run: an item's run id is claude's own command id, which the node may alias to the run it
        // reports, and the open items are cleared when a run ends anyway.
        if let Some(open) = self.open.values().max_by_key(|o| o.started_ms) {
            return Some(at(open.activity.clone(), open.started_ms));
        }
        if let Some((retry, since)) = &self.retry
            && self.active_run.is_some()
        {
            return Some(at(retry.clone(), *since));
        }
        self.active_run.as_ref()?;
        match (self.last_delta_ms, self.writing_since_ms) {
            (Some(last), Some(since)) if now_ms - last <= WRITING_FOR_MS => {
                Some(at(Activity::Writing, since))
            }
            (last, _) => {
                let since = last.map_or(self.quiet_since_ms, |l| {
                    self.quiet_since_ms.max(l + WRITING_FOR_MS)
                });
                Some(at(Activity::Thinking, since))
            }
        }
    }

    /// Summed over the runs the hub knows, plus the active run's usage so far. None before any usage arrived.
    pub fn tokens(&self) -> Option<Tokens> {
        let live = self
            .live_usage
            .as_ref()
            .filter(|(run, _)| !self.run_usage.contains_key(run));
        if self.run_usage.is_empty() && live.is_none() {
            return None;
        }
        let mut tokens = Tokens {
            input: 0,
            output: 0,
            cache_read: 0,
            live: live.is_some(),
        };
        for usage in self.run_usage.values().chain(live.map(|(_, u)| u)) {
            tokens.input += usage.input_tokens;
            tokens.output += usage.output_tokens;
            tokens.cache_read += usage.cache_read_input_tokens;
        }
        Some(tokens)
    }

    /// The last minute in complete 2 s buckets, ending at the start of the bucket `now_ms` falls in.
    pub fn spark(&self, now_ms: i64) -> Spark {
        let end = now_ms.div_euclid(BUCKET_MS);
        let samples: Vec<u8> = (end - SPARK_BUCKETS as i64..end)
            .map(|index| {
                let b = self.buckets[index.rem_euclid(SPARK_BUCKETS as i64) as usize];
                if b.index == index {
                    (16 * b.items as u64 + b.chars as u64 / 32 + b.tokens as u64 / 8).min(255) as u8
                } else {
                    0
                }
            })
            .collect();
        Spark {
            end_at: iso_ms(end * BUCKET_MS).into(),
            samples: List::unchecked(samples),
        }
    }

    pub fn text(&self) -> Option<&StreamText> {
        self.text.as_ref()
    }

    pub fn done(&self) -> &[DoneText] {
        &self.done
    }
}

fn clip<const MAX: usize>(s: &str) -> Text<0, MAX> {
    Text::unchecked(js_take(s, MAX))
}

/// The command's first line, without a leading `cd <dir> &&`.
pub fn command_line(command: &str) -> String {
    let first = command
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    match first
        .strip_prefix("cd ")
        .and_then(|rest| rest.split_once("&&"))
    {
        Some((_, after)) if !after.trim().is_empty() => after.trim().to_owned(),
        _ => first.to_owned(),
    }
}

fn relative(path: &str, root: Option<&str>) -> String {
    root.and_then(|r| path.strip_prefix(r))
        .and_then(|rest| rest.strip_prefix('/'))
        .unwrap_or(path)
        .to_owned()
}

fn input_str<'a>(input: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| input.get(*k).and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.split(['/', '?', '#']).next().unwrap_or(rest)
}

/// The live activity an open item stands for; None for items that are not work (permission prompts, errors).
pub fn activity_of(item: &ThreadItem, root: Option<&str>) -> Option<Activity> {
    Some(match &item.kind {
        ItemKind::Command { command, .. } => Activity::Command {
            text: clip(&command_line(command)),
        },
        ItemKind::FileChange { path, .. } => Activity::Edit {
            path: clip(&relative(path, root)),
        },
        ItemKind::Tool {
            tool_name, input, ..
        } => match tool_name.as_str() {
            "Read" | "NotebookRead" => Activity::Read {
                path: input_str(input, &["file_path", "notebook_path", "path"])
                    .map(|p| clip(&relative(p, root))),
                pattern: None,
            },
            "Grep" | "Glob" => Activity::Read {
                path: None,
                pattern: input_str(input, &["pattern"]).map(clip),
            },
            name => {
                let detail = match name {
                    "WebFetch" => input_str(input, &["url"]).map(host_of),
                    _ => input_str(
                        input,
                        &[
                            "description",
                            "query",
                            "url",
                            "command",
                            "path",
                            "file_path",
                            "prompt",
                        ],
                    ),
                };
                Activity::Tool {
                    name: Text::unchecked(js_take(name, 60)),
                    detail: detail.map(|d| clip(d.lines().next().unwrap_or(d))),
                }
            }
        },
        ItemKind::Compaction { .. } => Activity::Compacting,
        ItemKind::ApiRetry { .. } | ItemKind::NodeRetry { .. } => retry_of(item)?,
        ItemKind::Permission { .. } | ItemKind::Error { .. } => return None,
    })
}

fn retry_of(item: &ThreadItem) -> Option<Activity> {
    Some(match &item.kind {
        ItemKind::ApiRetry {
            attempt,
            max_retries,
            error_status,
            error,
            ..
        } => Activity::Retrying {
            attempt: *attempt,
            of: *max_retries,
            reason: clip(&match error_status {
                Some(529) => "overloaded".to_owned(),
                Some(status) => format!("{status}"),
                None => error.clone(),
            }),
        },
        ItemKind::NodeRetry {
            attempt,
            of,
            reason,
            ..
        } => Activity::Retrying {
            attempt: *attempt,
            of: *of,
            reason: clip(&super::shell_mapper::failure_class(reason.class)),
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::sessions::ThreadEvent;
    use serde_json::json;

    use super::*;

    fn event(v: serde_json::Value) -> ThreadEvent {
        serde_json::from_value(v).unwrap()
    }

    fn run(status: &str) -> ThreadEvent {
        event(
            json!({ "type": "run", "id": "r1", "status": status, "ordinal": 1,
                      "usage": if status == "completed" { json!({ "inputTokens": 100, "outputTokens": 20, "cacheReadInputTokens": 5, "cacheCreationInputTokens": 0 }) } else { json!(null) } }),
        )
    }

    fn item(id: &str, status: &str, kind: serde_json::Value) -> ThreadEvent {
        event(
            json!({ "type": "item", "id": id, "runId": "r1", "status": status, "title": "",
                      "startedAt": "2026-10-18T10:00:00.000Z", "updatedAt": "2026-10-18T10:00:00.000Z", "kind": kind }),
        )
    }

    fn delta(text: &str) -> ThreadEvent {
        event(json!({ "type": "delta", "messageId": "m1", "runId": "r1", "append": text }))
    }

    const T0: i64 = 1_760_000_000_000;

    fn message(id: &str, text: &str) -> ThreadEvent {
        event(
            json!({ "type": "message", "id": id, "runId": "r1", "role": "assistant", "text": text,
                      "createdAt": "2026-10-18T10:00:00.000Z" }),
        )
    }

    /// The node drops a delta still pending when its complete message lands: the complete text is kept for the run,
    /// so a reader can still land the words no delta carried. A new run starts over.
    #[test]
    fn keeps_the_runs_complete_messages_whatever_deltas_went_missing() {
        let mut t = ActivityTracker::default();
        t.apply(&message("m0", "before any run"), T0);
        t.apply(&run("running"), T0);
        t.apply(&delta("Reading the proposal and the"), T0 + 10);
        t.apply(
            &message("m1", "Reading the proposal and the current app code."),
            T0 + 20,
        );
        assert_eq!(
            t.text().unwrap().total,
            28,
            "the missing tail never streamed"
        );
        assert_eq!(
            t.done(),
            [DoneText {
                message_id: "m1".into(),
                text: "Reading the proposal and the current app code.".into()
            }]
        );
        for n in 0..10 {
            t.apply(&message(&format!("n{n}"), "more"), T0 + 30);
        }
        assert_eq!(t.done().len(), DONE_KEPT);
        assert_eq!(t.done().last().unwrap().message_id, "n9");
        t.apply(&run("completed"), T0 + 40);
        assert!(t.done().is_empty());
        // Followed mid-run: what the active run already said counts, an earlier run's doesn't.
        let said = |id: &str, run: &str| json!({ "id": id, "runId": run, "role": "assistant", "text": id, "createdAt": "2026-10-18T10:00:00.000Z" });
        t.apply(
            &event(json!({
                "type": "snapshot",
                "summary": {
                    "sessionId": "s1", "projectId": "p1", "title": "t", "status": "running", "model": "claude-haiku-5-5",
                    "effort": "low", "runtimeMode": "full-access", "activeRunId": "r2",
                    "createdAt": "2026-10-18T10:00:00.000Z", "updatedAt": "2026-10-18T10:00:00.000Z",
                },
                "messages": [said("old", "r1"), said("new", "r2")],
                "items": [],
                "runs": [{ "id": "r1", "status": "completed", "ordinal": 1 }, { "id": "r2", "status": "running", "ordinal": 2 }],
                "truncated": false,
            })),
            T0 + 50,
        );
        let ids: Vec<&str> = t.done().iter().map(|d| d.message_id.as_str()).collect();
        assert_eq!(ids, ["new"]);
    }

    #[test]
    fn says_what_the_thread_is_doing_now() {
        let mut t = ActivityTracker::default();
        t.set_root(Some("/w/fleetd/.fleetd/worktrees/T31/".into()));
        assert_eq!(t.now(T0), None, "no run: nothing to say");
        t.apply(&run("running"), T0);
        assert_eq!(t.now(T0 + 10).unwrap().activity, Activity::Thinking);
        t.apply(
            &item(
                "i1",
                "running",
                json!({ "type": "command", "command": "cd /w && cargo test -p fleetd\nmore" }),
            ),
            T0 + 100,
        );
        assert_eq!(
            t.now(T0 + 200).unwrap().activity,
            Activity::Command {
                text: Text::unchecked("cargo test -p fleetd")
            }
        );
        t.apply(&item("i2", "running", json!({ "type": "file_change", "toolName": "Edit", "path": "/w/fleetd/.fleetd/worktrees/T31/src/lib.rs" })), T0 + 300);
        // The newest open item wins.
        assert_eq!(
            t.now(T0 + 400).unwrap().activity,
            Activity::Edit {
                path: Text::unchecked("src/lib.rs")
            }
        );
        t.apply(
            &item(
                "i2",
                "completed",
                json!({ "type": "file_change", "toolName": "Edit", "path": "x" }),
            ),
            T0 + 500,
        );
        t.apply(
            &item(
                "i1",
                "completed",
                json!({ "type": "command", "command": "cargo test" }),
            ),
            T0 + 600,
        );
        t.apply(&delta("Done."), T0 + 700);
        let writing = t.now(T0 + 1000).unwrap();
        assert_eq!(writing.activity, Activity::Writing);
        assert_eq!(writing.since.0, iso_ms(T0 + 700));
        // Three quiet seconds after the text: waiting on the model again.
        assert_eq!(
            t.now(T0 + 700 + WRITING_FOR_MS + 1).unwrap().activity,
            Activity::Thinking
        );
        t.apply(&run("completed"), T0 + 5000);
        assert_eq!(t.now(T0 + 5001), None);
        let tokens = t.tokens().unwrap();
        assert_eq!((tokens.input, tokens.output, tokens.live), (100, 20, false));
    }

    #[test]
    fn live_usage_counts_until_the_run_reports_its_own() {
        let mut t = ActivityTracker::default();
        t.apply(&run("running"), T0);
        assert_eq!(t.tokens(), None);
        t.apply(&event(json!({ "type": "usage", "runId": "r1", "usage": { "inputTokens": 40, "outputTokens": 3, "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0 } })), T0 + 1);
        assert_eq!(t.tokens().map(|t| (t.input, t.live)), Some((40, true)));
        t.apply(&run("completed"), T0 + 2);
        assert_eq!(t.tokens().map(|t| (t.input, t.live)), Some((100, false)));
    }

    #[test]
    fn the_sparkline_counts_real_work_per_two_second_bucket() {
        let mut t = ActivityTracker::default();
        t.apply(&run("running"), T0);
        let start = T0 - T0.rem_euclid(2000);
        t.apply(
            &item(
                "a",
                "running",
                json!({ "type": "command", "command": "ls" }),
            ),
            start + 10,
        );
        t.apply(
            &item(
                "b",
                "running",
                json!({ "type": "command", "command": "ls" }),
            ),
            start + 20,
        );
        t.apply(&delta(&"x".repeat(64)), start + 2_100);
        let spark = t.spark(start + 4_000);
        let s = spark.samples.as_slice();
        assert_eq!(s.len(), SPARK_BUCKETS);
        assert_eq!(&s[SPARK_BUCKETS - 2..], &[32, 2]);
        assert!(s[..SPARK_BUCKETS - 2].iter().all(|v| *v == 0));
        assert_eq!(spark.end_at.0, iso_ms(start + 4_000));
        // A minute later every bucket has rolled off.
        assert!(t.spark(start + 70_000).samples.iter().all(|v| *v == 0));
    }

    #[test]
    fn output_that_did_not_stream_as_text_counts_once_per_report() {
        let usage = |out: u64| {
            event(
                json!({ "type": "usage", "runId": "r1", "usage": { "inputTokens": 40, "outputTokens": out, "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0 } }),
            )
        };
        let mut t = ActivityTracker::default();
        t.apply(&run("running"), T0);
        let start = T0 - T0.rem_euclid(2000);
        // The first report only sets the baseline, however much the run had already written.
        t.apply(&usage(5_000), start + 10);
        // A file written as tool input: 800 tokens that never streamed as text.
        t.apply(&usage(5_800), start + 2_010);
        // 400 characters of text (about 100 tokens) streamed, then a report of 160 more: 60 were not text.
        t.apply(&delta(&"y".repeat(400)), start + 4_010);
        t.apply(&usage(5_960), start + 4_500);
        let s = t.spark(start + 6_000).samples.to_vec();
        assert_eq!(s[SPARK_BUCKETS - 3], 0);
        assert_eq!(s[SPARK_BUCKETS - 2], 100, "800 tokens / 8");
        assert_eq!(
            s[SPARK_BUCKETS - 1],
            12 + 7,
            "400 chars / 32, then the 60 tokens that were not text / 8"
        );
    }

    #[test]
    fn streamed_text_keeps_a_bounded_tail_and_counts_everything() {
        let mut t = ActivityTracker::default();
        t.apply(&run("running"), T0);
        t.apply(&delta(&"a".repeat(1500)), T0);
        t.apply(&delta(&"b".repeat(1500)), T0 + 100);
        let text = t.text().unwrap();
        assert_eq!(text.total, 3000);
        assert_eq!(text.tail.chars().count(), TEXT_TAIL_CHARS);
        assert_eq!(text.since(2990), "b".repeat(10));
        // A reader that fell further behind than the tail gets the whole tail.
        assert_eq!(text.since(0).len(), TEXT_TAIL_CHARS);
    }
}
