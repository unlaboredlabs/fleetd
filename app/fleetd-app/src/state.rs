//! App state and its reducer. Everything the hub says arrives through [`State::apply`], every user
//! action through a method here; each returns the frames to send. No I/O, so it is unit-tested.
//!
//! Sync model: on every (re)connect, take a snapshot, start the event stream from its cursor, then
//! fetch each project's outcome and the open asks. Events only mark things to refetch. A refetch
//! asked for while the same one is in flight runs once more when it lands, never twice at once.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::client::Incoming;
use crate::protocol::*;

/// (machineId, projectId)
pub type ProjectKey = (String, String);

/// Messages in the lead log tail.
pub const TAIL_N: u32 = 50;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Purpose {
    Asks,
    Project(ProjectKey),
    Tail(ProjectKey),
    Reply,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Conn {
    Connecting { reason: Option<String>, retry_in: Option<Duration> },
    Live,
    Refused(String),
}

pub struct ProjectRow {
    pub summary: ProjectSummary,
    pub outcome: Option<ProjectOutcome>,
    pub error: Option<String>,
}

impl ProjectRow {
    pub fn key(&self) -> ProjectKey {
        (self.summary.machine_id.clone(), self.summary.project_id.clone())
    }

    pub fn lead(&self) -> Option<&Lead> {
        self.outcome.as_ref()?.lead.as_ref()
    }

    pub fn lead_thread(&self) -> Option<&ThreadSummary> {
        let lead = self.lead()?;
        self.outcome.as_ref()?.threads.iter().find(|t| t.thread_id == lead.thread_id)
    }

    pub fn workstreams(&self) -> &[Workstream] {
        self.outcome.as_ref().and_then(|o| o.workstreams.as_deref()).unwrap_or(&[])
    }

    /// The newest workstream status line, else the lead thread's latest line.
    pub fn headline(&self) -> Option<&str> {
        let from_workstream = self
            .workstreams()
            .iter()
            .filter_map(|w| Some((w.headline_at.as_deref()?, w.headline.as_deref()?)))
            .max_by(|a, b| a.0.cmp(b.0))
            .map(|(_, h)| h);
        from_workstream.or_else(|| self.lead_thread().map(|t| t.headline.as_str()).filter(|h| !h.is_empty()))
    }

    pub fn stale(&self) -> bool {
        self.outcome.as_ref().is_some_and(|o| o.stale)
    }
}

pub struct Detail {
    pub key: ProjectKey,
    /// Oldest first.
    pub tail: Vec<TailItem>,
    pub tail_error: Option<String>,
    /// Bumped whenever `tail` changes, so the view rebuilds its log rows only then.
    pub version: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Echo {
    pub text: String,
    pub ok: bool,
}

/// One numbered inbox line.
pub struct InboxItem<'a> {
    pub batch_id: &'a str,
    pub number: u32,
    pub ask: &'a Ask,
}

pub struct State {
    pub conn: Conn,
    pub machines: Vec<Machine>,
    pub projects: Vec<ProjectRow>,
    pub attention: Vec<HubEvent>,
    pub batches: Vec<Batch>,
    pub asks: HashMap<String, Ask>,
    pub asks_error: Option<String>,
    pub echo: Option<Echo>,
    pub detail: Option<Detail>,
    /// A hub error not tied to one call.
    pub notice: Option<String>,
    streaming: bool,
    snapshot_pending: bool,
    next_id: u64,
    pending: HashMap<String, Purpose>,
    inflight: HashSet<Purpose>,
    dirty: HashSet<Purpose>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            conn: Conn::Connecting { reason: None, retry_in: None },
            machines: Vec::new(),
            projects: Vec::new(),
            attention: Vec::new(),
            batches: Vec::new(),
            asks: HashMap::new(),
            asks_error: None,
            echo: None,
            detail: None,
            notice: None,
            streaming: false,
            snapshot_pending: false,
            next_id: 0,
            pending: HashMap::new(),
            inflight: HashSet::new(),
            dirty: HashSet::new(),
        }
    }
}

type Out = Vec<ClientMessage>;

impl State {
    pub fn apply(&mut self, incoming: Incoming) -> Out {
        match incoming {
            Incoming::Ready => {
                self.reset_calls();
                self.conn = Conn::Live;
                self.notice = None;
                self.snapshot_pending = true;
                vec![ClientMessage::Snapshot]
            }
            Incoming::Disconnected { reason, retry_in } => {
                self.reset_calls();
                self.conn = Conn::Connecting { reason: Some(reason), retry_in: Some(retry_in) };
                Vec::new()
            }
            Incoming::Unauthorized(message) => {
                self.reset_calls();
                self.conn = Conn::Refused(message);
                Vec::new()
            }
            Incoming::Message(message) => self.on_message(message),
        }
    }

    pub fn project(&self, key: &ProjectKey) -> Option<&ProjectRow> {
        self.projects.iter().find(|p| &p.key() == key)
    }

    pub fn machine(&self, machine_id: &str) -> Option<&Machine> {
        self.machines.iter().find(|m| m.machine_id == machine_id)
    }

    /// Open asks of open batches: newest batch first, then by number.
    pub fn inbox(&self) -> Vec<InboxItem<'_>> {
        let mut out = Vec::new();
        for batch in self.batches.iter().filter(|b| b.state == "open") {
            let mut items: Vec<_> = batch.items.iter().collect();
            items.sort_by_key(|i| i.number);
            for item in items {
                if let Some(ask) = self.asks.get(&item.ask_id).filter(|a| a.state == AskState::Open) {
                    out.push(InboxItem { batch_id: &batch.batch_id, number: item.number, ask });
                }
            }
        }
        out
    }

    pub fn open_project(&mut self, key: ProjectKey) -> Out {
        self.detail = Some(Detail { key: key.clone(), tail: Vec::new(), tail_error: None, version: 0 });
        let mut out: Out = self.request_project(&key).into_iter().collect();
        out.extend(self.request_tail());
        out
    }

    pub fn close_project(&mut self) {
        self.detail = None;
    }

    /// Sends a terse reply such as "1 go 2 nvm"; `batch_id` pins it to one batch.
    pub fn reply(&mut self, raw: &str, batch_id: Option<&str>) -> Out {
        if self.conn != Conn::Live {
            self.echo = Some(Echo { text: "Not connected to the hub; the reply was not sent.".into(), ok: false });
            return Vec::new();
        }
        let input = InboxReplyInput { raw: raw.to_string(), batch_id: batch_id.map(str::to_string) };
        vec![self.call(Purpose::Reply, &input)]
    }

    /// Periodic: keeps the open project's lead log fresh while the lead is at work.
    pub fn poll(&mut self) -> Out {
        let busy = self.detail.as_ref().and_then(|d| self.project(&d.key)).is_some_and(|row| {
            row.lead().is_some_and(|l| l.state == LeadState::Working) || row.lead_thread().is_some_and(|t| t.status == ThreadStatus::Running)
        });
        if busy && self.conn == Conn::Live { self.request_tail().into_iter().collect() } else { Vec::new() }
    }

    fn reset_calls(&mut self) {
        self.streaming = false;
        self.snapshot_pending = false;
        self.pending.clear();
        self.inflight.clear();
        self.dirty.clear();
    }

    fn call<I: Tool + Serialize>(&mut self, purpose: Purpose, input: &I) -> ClientMessage {
        self.next_id += 1;
        let id = format!("c{}", self.next_id);
        self.pending.insert(id.clone(), purpose.clone());
        if purpose != Purpose::Reply {
            self.inflight.insert(purpose);
        }
        ClientMessage::Call { id, tool: I::NAME.into(), input: serde_json::to_value(input).unwrap() }
    }

    /// A refetch: sent now, or once more after the in-flight one lands.
    fn refetch<I: Tool + Serialize>(&mut self, purpose: Purpose, input: &I) -> Option<ClientMessage> {
        if self.conn != Conn::Live {
            return None;
        }
        if self.inflight.contains(&purpose) {
            self.dirty.insert(purpose);
            return None;
        }
        Some(self.call(purpose, input))
    }

    fn request_asks(&mut self) -> Option<ClientMessage> {
        self.refetch(Purpose::Asks, &AsksListInput { state: Some(AskState::Open), batch_id: None })
    }

    fn request_project(&mut self, key: &ProjectKey) -> Option<ClientMessage> {
        self.refetch(Purpose::Project(key.clone()), &ProjectGetInput { machine_id: key.0.clone(), project_id: key.1.clone() })
    }

    fn request_tail(&mut self) -> Option<ClientMessage> {
        let key = self.detail.as_ref()?.key.clone();
        let thread_id = self.project(&key)?.lead()?.thread_id.clone();
        let input = ThreadTailInput { machine_id: key.0.clone(), thread_id, n: Some(TAIL_N), kinds: None };
        self.refetch(Purpose::Tail(key), &input)
    }

    fn request_snapshot(&mut self) -> Option<ClientMessage> {
        if self.conn != Conn::Live || self.snapshot_pending {
            return None;
        }
        self.snapshot_pending = true;
        Some(ClientMessage::Snapshot)
    }

    fn redo(&mut self, purpose: Purpose) -> Option<ClientMessage> {
        match purpose {
            Purpose::Asks => self.request_asks(),
            Purpose::Project(key) => self.request_project(&key),
            Purpose::Tail(_) => self.request_tail(),
            Purpose::Reply => None,
        }
    }

    fn on_message(&mut self, message: ServerMessage) -> Out {
        match message {
            ServerMessage::Ready(_) => Vec::new(),
            ServerMessage::Snapshot(status) => self.on_snapshot(status),
            ServerMessage::Event(event) => self.on_event(&event),
            ServerMessage::Result(result) => {
                let Some(purpose) = self.pending.remove(&result.id) else { return Vec::new() };
                self.inflight.remove(&purpose);
                let mut out = self.on_result(&purpose, result.output);
                if self.dirty.remove(&purpose) {
                    out.extend(self.redo(purpose));
                }
                out
            }
            ServerMessage::Error(error) => {
                let text = match &error.fix {
                    Some(fix) => format!("{} {fix}", error.message),
                    None => error.message.clone(),
                };
                let Some(purpose) = error.id.as_ref().and_then(|id| self.pending.remove(id)) else {
                    if error.id.is_none() {
                        self.notice = Some(text);
                    }
                    return Vec::new();
                };
                self.inflight.remove(&purpose);
                self.dirty.remove(&purpose);
                self.on_call_error(&purpose, text);
                Vec::new()
            }
        }
    }

    fn on_snapshot(&mut self, status: FleetStatus) -> Out {
        self.snapshot_pending = false;
        let mut out = Vec::new();
        if !self.streaming {
            self.streaming = true;
            out.push(ClientMessage::Events { cursor: status.cursor });
        }
        let mut old: HashMap<ProjectKey, ProjectRow> = self.projects.drain(..).map(|r| (r.key(), r)).collect();
        self.projects = status
            .projects
            .into_iter()
            .map(|summary| {
                let key = (summary.machine_id.clone(), summary.project_id.clone());
                let (outcome, error) = old.remove(&key).map_or((None, None), |r| (r.outcome, r.error));
                ProjectRow { summary, outcome, error }
            })
            .collect();
        self.machines = status.machines;
        self.attention = status.attention;
        let keys: Vec<ProjectKey> = self.projects.iter().map(ProjectRow::key).collect();
        out.extend(keys.iter().filter_map(|k| self.request_project(k)));
        out.extend(self.request_asks());
        out
    }

    fn on_event(&mut self, event: &HubEvent) -> Out {
        let mut out = Vec::new();
        let kind = event.kind.as_str();
        if kind.starts_with("machine.") {
            out.extend(self.request_snapshot());
        }
        if matches!(kind, "ask.created" | "ask.auto" | "batch.ready" | "decision.recorded") {
            out.extend(self.request_asks());
        }
        let project_scoped = ["workstream.", "lead.", "thread."].iter().any(|p| kind.starts_with(p));
        if let (true, Some(machine_id), Some(project_id)) = (project_scoped, &event.machine_id, &event.project_id) {
            let key = (machine_id.clone(), project_id.clone());
            if self.project(&key).is_some() {
                out.extend(self.request_project(&key));
            } else {
                out.extend(self.request_snapshot());
            }
        }
        if kind.starts_with("thread.") {
            let lead_thread = self.detail.as_ref().and_then(|d| self.project(&d.key)).and_then(|r| r.lead()).map(|l| l.thread_id.as_str());
            if lead_thread.is_some() && lead_thread == event.thread_id.as_deref() {
                out.extend(self.request_tail());
            }
        }
        out
    }

    fn on_result(&mut self, purpose: &Purpose, output: serde_json::Value) -> Out {
        match purpose {
            Purpose::Asks => match parse::<AsksListOutput>(output) {
                Ok(list) => {
                    self.batches = list.batches;
                    self.asks = list.asks.into_iter().map(|a| (a.ask_id.clone(), a)).collect();
                    self.asks_error = None;
                }
                Err(e) => self.asks_error = Some(e),
            },
            Purpose::Project(key) => {
                let parsed = parse::<ProjectOutcome>(output);
                let Some(row) = self.projects.iter_mut().find(|r| &r.key() == key) else { return Vec::new() };
                match parsed {
                    Ok(outcome) => {
                        row.outcome = Some(outcome);
                        row.error = None;
                    }
                    Err(e) => row.error = Some(e),
                }
                // The lead thread may be new (lead_restart): refresh its log.
                if self.detail.as_ref().is_some_and(|d| &d.key == key) {
                    return self.request_tail().into_iter().collect();
                }
            }
            Purpose::Tail(key) => {
                let parsed = parse::<ThreadTailOutput>(output);
                if let Some(detail) = self.detail.as_mut().filter(|d| &d.key == key) {
                    match parsed {
                        Ok(tail) => {
                            let mut items = tail.items;
                            items.reverse();
                            if items != detail.tail {
                                detail.tail = items;
                                detail.version += 1;
                            }
                            detail.tail_error = None;
                        }
                        Err(e) => detail.tail_error = Some(e),
                    }
                }
            }
            Purpose::Reply => {
                match parse::<InboxReplyOutput>(output) {
                    Ok(r) if r.parsed => self.echo = Some(Echo { text: r.echo.unwrap_or_else(|| "Done.".into()), ok: true }),
                    Ok(r) => self.echo = Some(Echo { text: r.hint.unwrap_or_else(|| "The hub couldn't read that reply.".into()), ok: false }),
                    Err(e) => self.echo = Some(Echo { text: e, ok: false }),
                }
                return self.request_asks().into_iter().collect();
            }
        }
        Vec::new()
    }

    fn on_call_error(&mut self, purpose: &Purpose, text: String) {
        match purpose {
            Purpose::Asks => self.asks_error = Some(text),
            Purpose::Project(key) => {
                if let Some(row) = self.projects.iter_mut().find(|r| &r.key() == key) {
                    row.error = Some(text);
                }
            }
            Purpose::Tail(key) => {
                if let Some(detail) = self.detail.as_mut().filter(|d| &d.key == key) {
                    detail.tail_error = Some(text);
                }
            }
            Purpose::Reply => self.echo = Some(Echo { text, ok: false }),
        }
    }
}

fn parse<T: DeserializeOwned>(output: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(output).map_err(|e| format!("Unexpected answer from the hub: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const AT: &str = "2026-10-17T10:00:00.000Z";

    fn project_json(m: &str, p: &str) -> Value {
        json!({ "machineId": m, "projectId": p, "title": p, "workspaceRoot": format!("/w/{p}"),
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT })
    }

    fn snapshot(projects: &[(&str, &str)], cursor: u64) -> Incoming {
        let projects: Vec<Value> = projects.iter().map(|(m, p)| project_json(m, p)).collect();
        let frame = json!({ "t": "snapshot", "machines": [{ "machineId": "lab-a", "name": "lab-a", "tags": [], "status": "online",
            "lastSeenAt": AT, "t3": null, "nodeVersion": "0.0.0" }], "projects": projects, "attention": [], "cursor": cursor });
        Incoming::Message(serde_json::from_value(frame).unwrap())
    }

    fn result(id: &str, output: Value) -> Incoming {
        Incoming::Message(ServerMessage::Result(CallResult { id: id.into(), output }))
    }

    fn event(kind: &str, project: Option<&str>, thread: Option<&str>) -> Incoming {
        Incoming::Message(ServerMessage::Event(HubEvent {
            seq: 9,
            at: AT.into(),
            kind: kind.into(),
            machine_id: project.or(thread).map(|_| "lab-a".into()),
            project_id: project.map(Into::into),
            thread_id: thread.map(Into::into),
            summary: kind.into(),
            data: None,
        }))
    }

    /// (id, tool) of each call in `out`.
    fn calls(out: &[ClientMessage]) -> Vec<(String, String)> {
        out.iter()
            .filter_map(|m| match m {
                ClientMessage::Call { id, tool, .. } => Some((id.clone(), tool.clone())),
                _ => None,
            })
            .collect()
    }

    fn outcome(p: &str, lead_thread: Option<&str>, lead_state: &str) -> Value {
        let mut o = json!({ "project": project_json("lab-a", p), "threads": [], "stale": false, "asOf": AT });
        if let Some(t) = lead_thread {
            o["lead"] = json!({ "projectRef": { "machineId": "lab-a", "projectId": p }, "threadId": t, "state": lead_state,
                                "startedAt": AT, "sessionGeneration": 0 });
        }
        o
    }

    fn ask(id: &str, number: u32, state: &str) -> Value {
        json!({ "askId": id, "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "kind": "decide", "key": "api.path",
                "class": "product", "text": "Path?", "recommendation": "/healthz", "blocks": "nothing", "proceededOnRec": true,
                "state": state, "batchId": "B1", "number": number, "createdAt": AT })
    }

    /// Connected, snapshotted with projects p1 and p2, and every initial call answered.
    fn synced() -> State {
        let mut s = State::default();
        s.apply(Incoming::Ready);
        let out = s.apply(snapshot(&[("lab-a", "p1"), ("lab-a", "p2")], 0));
        for (id, tool) in calls(&out) {
            let output = match tool.as_str() {
                "asks_list" => json!({ "batches": [], "asks": [] }),
                _ => outcome(if s.pending[&id] == Purpose::Project(("lab-a".into(), "p1".into())) { "p1" } else { "p2" }, Some("lead-1"), "idle"),
            };
            s.apply(result(&id, output));
        }
        s
    }

    #[test]
    fn connect_takes_a_snapshot_then_streams_and_fetches() {
        let mut s = State::default();
        assert_eq!(s.apply(Incoming::Ready), vec![ClientMessage::Snapshot]);
        let out = s.apply(snapshot(&[("lab-a", "p1"), ("lab-a", "p2")], 41));
        assert_eq!(out[0], ClientMessage::Events { cursor: 41 });
        let tools: Vec<String> = calls(&out).into_iter().map(|(_, t)| t).collect();
        assert_eq!(tools, ["project_get", "project_get", "asks_list"]);
        assert_eq!(s.projects.len(), 2);
    }

    #[test]
    fn results_fill_the_row_their_id_belongs_to() {
        let s = synced();
        let p1 = s.project(&("lab-a".into(), "p1".into())).unwrap();
        assert_eq!(p1.lead().unwrap().thread_id, "lead-1");
        assert_eq!(p1.outcome.as_ref().unwrap().project.project_id, "p1");
        assert!(s.pending.is_empty() && s.inflight.is_empty());
    }

    #[test]
    fn events_while_a_fetch_is_in_flight_coalesce_into_one_more() {
        let mut s = synced();
        let first = calls(&s.apply(event("ask.created", None, None)));
        assert_eq!(first.len(), 1);
        assert!(s.apply(event("batch.ready", None, None)).is_empty());
        assert!(s.apply(event("decision.recorded", None, None)).is_empty());
        let after = calls(&s.apply(result(&first[0].0, json!({ "batches": [], "asks": [] }))));
        assert_eq!(after.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["asks_list"]);
        assert!(calls(&s.apply(result(&after[0].0, json!({ "batches": [], "asks": [] })))).is_empty());
    }

    #[test]
    fn project_events_refetch_that_project_and_unknown_ones_resnapshot() {
        let mut s = synced();
        let out = s.apply(event("workstream.created", Some("p2"), None));
        assert_eq!(s.pending.values().collect::<Vec<_>>(), [&Purpose::Project(("lab-a".into(), "p2".into()))]);
        assert_eq!(calls(&out).len(), 1);
        assert_eq!(s.apply(event("lead.started", Some("p9"), None)), vec![ClientMessage::Snapshot]);
        // Only one snapshot in flight; a second one doesn't restart the event stream.
        assert!(s.apply(event("machine.offline", None, None)).is_empty());
        let out = s.apply(snapshot(&[("lab-a", "p1"), ("lab-a", "p2"), ("lab-a", "p9")], 50));
        assert!(!out.iter().any(|m| matches!(m, ClientMessage::Events { .. })));
        assert_eq!(s.projects.len(), 3);
        assert!(s.project(&("lab-a".into(), "p1".into())).unwrap().outcome.is_some(), "known outcomes survive a resnapshot");
    }

    #[test]
    fn a_reconnect_drops_answers_meant_for_the_old_connection() {
        let mut s = synced();
        let old = calls(&s.apply(event("ask.created", None, None)));
        s.apply(Incoming::Disconnected { reason: "gone".into(), retry_in: Duration::from_secs(1) });
        assert!(matches!(s.conn, Conn::Connecting { .. }));
        assert!(s.reply("1 go", None).is_empty(), "replies are not sent while offline");
        assert!(!s.echo.as_ref().unwrap().ok);
        s.apply(Incoming::Ready);
        assert!(s.apply(result(&old[0].0, json!({ "batches": [], "asks": [ask("A1", 1, "open")] }))).is_empty());
        assert!(s.asks.is_empty());
    }

    #[test]
    fn inbox_lists_open_asks_of_open_batches_by_number() {
        let mut s = synced();
        let id = calls(&s.apply(event("batch.ready", None, None)))[0].0.clone();
        let batches = json!([{ "batchId": "B1", "createdAt": AT, "state": "open",
            "items": [{ "number": 2, "askId": "A2" }, { "number": 1, "askId": "A1" }, { "number": 3, "askId": "A3" }] }]);
        s.apply(result(&id, json!({ "batches": batches, "asks": [ask("A1", 1, "open"), ask("A2", 2, "answered"), ask("A3", 3, "open")] })));
        let items: Vec<(u32, &str)> = s.inbox().iter().map(|i| (i.number, i.ask.ask_id.as_str())).collect();
        assert_eq!(items, [(1, "A1"), (3, "A3")]);
    }

    #[test]
    fn reply_sends_inbox_reply_and_shows_the_echo_or_hint() {
        let mut s = synced();
        let out = s.reply("1 go", Some("B1"));
        let ClientMessage::Call { id, tool, input } = &out[0] else { panic!() };
        assert_eq!((tool.as_str(), input), ("inbox_reply", &json!({ "raw": "1 go", "batchId": "B1" })));
        let refresh = calls(&s.apply(result(id, json!({ "parsed": true, "echo": "Logged: 1 → /healthz (D1)", "applied": [] }))));
        assert_eq!(s.echo, Some(Echo { text: "Logged: 1 → /healthz (D1)".into(), ok: true }));
        assert_eq!(refresh[0].1, "asks_list");

        let ClientMessage::Call { id, .. } = &s.reply("purple", None)[0] else { panic!() };
        s.apply(result(id, json!({ "parsed": false, "applied": [], "hint": "Start with an item number." })));
        assert_eq!(s.echo, Some(Echo { text: "Start with an item number.".into(), ok: false }));
    }

    #[test]
    fn call_errors_land_where_the_call_was_for() {
        let mut s = synced();
        let id = calls(&s.apply(event("ask.created", None, None)))[0].0.clone();
        s.apply(Incoming::Message(ServerMessage::Error(ErrorFrame {
            id: Some(id),
            code: ErrorCode::NotFound,
            message: "No tool asks_list.".into(),
            fix: Some("Upgrade the hub.".into()),
        })));
        assert_eq!(s.asks_error.as_deref(), Some("No tool asks_list. Upgrade the hub."));
        assert!(s.inflight.is_empty());
    }

    #[test]
    fn open_project_tails_its_lead_and_lead_thread_events_refresh_it() {
        let mut s = synced();
        let key: ProjectKey = ("lab-a".into(), "p1".into());
        let out = calls(&s.open_project(key.clone()));
        assert_eq!(out.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["project_get", "thread_tail"]);
        let tail_id = &out[1].0;
        let thread = json!({ "machineId": "lab-a", "threadId": "lead-1", "projectId": "p1", "title": "lead", "status": "running",
            "headline": "", "latestMessageTail": "", "lastProgressAt": AT, "stale": false, "asOf": AT });
        let items = json!([{ "kind": "message", "at": AT, "role": "assistant", "text": "newest" },
                           { "kind": "message", "at": AT, "role": "user", "text": "oldest" }]);
        s.apply(result(tail_id, json!({ "items": items, "thread": thread })));
        let detail = s.detail.as_ref().unwrap();
        assert!(matches!(&detail.tail[0], TailItem::Message { text, .. } if text == "oldest"));
        assert_eq!(detail.version, 1);

        assert!(calls(&s.apply(event("thread.completed", None, Some("other")))).is_empty());
        let out = calls(&s.apply(event("thread.completed", None, Some("lead-1"))));
        assert_eq!(out.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(), ["thread_tail"]);
    }

    #[test]
    fn poll_refreshes_the_tail_only_while_the_lead_works() {
        let mut s = synced();
        let key: ProjectKey = ("lab-a".into(), "p1".into());
        for (id, _) in calls(&s.open_project(key.clone())) {
            s.apply(result(&id, if s.pending[&id] == Purpose::Tail(key.clone()) { json!({ "items": [], "thread": {
                "machineId": "lab-a", "threadId": "lead-1", "projectId": "p1", "title": "lead", "status": "idle", "headline": "",
                "latestMessageTail": "", "lastProgressAt": AT, "stale": false, "asOf": AT } }) } else { outcome("p1", Some("lead-1"), "idle") }));
        }
        assert!(s.poll().is_empty());
        let id = calls(&s.apply(event("lead.woken", Some("p1"), None)))[0].0.clone();
        s.apply(result(&id, outcome("p1", Some("lead-1"), "working")));
        // The project refresh already asked for the tail; a poll meanwhile doesn't double it.
        assert!(s.poll().is_empty());
    }

    #[test]
    fn a_refused_key_stops_everything() {
        let mut s = synced();
        s.apply(Incoming::Unauthorized("Unknown agent key.".into()));
        assert_eq!(s.conn, Conn::Refused("Unknown agent key.".into()));
        assert!(s.open_project(("lab-a".into(), "p1".into())).is_empty());
    }
}
