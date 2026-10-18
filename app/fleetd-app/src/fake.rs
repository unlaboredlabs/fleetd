//! Deterministic fake data for the bench, which runs without a hub.

use std::fmt::Write;

use crate::state::ProjectKey;

use serde_json::{Value, json};

use fleetd_contracts::app::{AppClientMessage, AppServerMessage};
use fleetd_contracts::prompts::{
    Enforcement, Placeholder, PromptDetail, PromptGroup, PromptId, PromptKind, PromptOverride, PromptRef, PromptScope, PromptVersion, PromptWarning,
    PromptWarningCode, SafetyRule, SessionPrompt, SessionPromptRef, StalePrompt,
};

use crate::state::{Conn, Detail, Doctor, ProjectRow, State};

/// The order the bench and screenshots open: the contracts' coherent fixture board (W14 in storefront).
pub const FIXTURE_ORDER: &str = "W14";
/// The fixture's hub clock: the live frame's `at`.
pub const FIXTURE_NOW: &str = "2026-10-18T10:07:12.000Z";

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed | 1)
    }
    pub fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    pub fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

const PROJECTS: &[&str] = &[
    "storefront",
    "ops-plan",
    "web-app",
    "mailer",
    "api-proxy",
    "infra",
    "dotfiles",
    "zed-notes",
    "desktop-notify",
    "merge-train",
    "lab-harness",
    "billing-site",
    "docs-site",
    "mobile-shell",
    "ingest",
    "search-api",
    "metrics",
    "auth-gateway",
    "design-system",
    "release-bot",
];
const MACHINES: &[&str] = &["devbox", "buildbox", "devbox", "devbox", "buildbox"];
const VERBS: &[&str] = &["Fix", "Add", "Wire", "Speed up", "Remove", "Test", "Rename", "Split", "Harden", "Document"];
const NOUNS: &[&str] = &[
    "merge train rebase",
    "lead digest",
    "slot board",
    "wake scheduler",
    "ask batching",
    "node heartbeat",
    "diff endpoint",
    "event cursor",
    "usage parking",
    "desktop notifications",
    "doctor checks",
    "policy leases",
    "brief freezer",
    "verifier job",
    "thread tail",
    "secret sealing",
];
const AT: &str = "2026-10-17T10:00:00.000Z";

/// What a hub with 20 projects, two machines and one open ask batch looks like, for the bench (which
/// runs without a hub). The first project is open with its lead log.
pub fn fixture_state() -> State {
    let mut rng = Rng::new(7);
    let mut state = State::default();
    state.conn = Conn::Live;
    state.machines = ["devbox", "buildbox"]
        .iter()
        .map(|m| {
            from(json!({ "machineId": m, "name": m, "tags": [], "status": if *m == "buildbox" { "degraded" } else { "online" },
                "lastSeenAt": AT, "nodeVersion": "0.0.0",
                "degradedReason": if *m == "buildbox" { Some("claude on buildbox exited 3 times in 10 min") } else { None } }))
        })
        .collect();
    for (i, name) in PROJECTS.iter().enumerate() {
        let machine = MACHINES[i % MACHINES.len()];
        let project = json!({ "machineId": machine, "projectId": name, "title": name, "workspaceRoot": format!("/w/{name}"),
            "threads": { "running": rng.below(4), "waiting": rng.below(2), "idle": 3, "failed": 0 }, "lastActivityAt": AT });
        let workstreams: Vec<Value> = if i == 0 {
            fixture_workstreams()
        } else {
            (0..1 + rng.below(4))
                .map(|w| {
                    let title = format!("{} {}", rng.pick(VERBS), rng.pick(NOUNS));
                    json!({ "workstreamId": format!("W{}", i * 10 + w + 1), "projectRef": { "machineId": machine, "projectId": name },
                    "title": title, "source": { "text": title, "channel": "app", "by": "human", "at": AT },
                    "brief": { "goal": title, "why": "Asked for.", "pointers": [], "constraints": [], "tier": "M",
                        "doneWhen": [{ "type": "ci_green", "repo": format!("acme/{name}") }, { "type": "pr_merged", "repo": format!("acme/{name}") },
                                     { "type": "http", "url": "http://127.0.0.1:4790/healthz", "status": 200 }] },
                    "state": (["running", "converging", "verifying"][rng.below(3)]), "headline": format!("{} in review", title),
                    "headlineAt": AT, "createdAt": AT, "updatedAt": AT })
                })
                .collect()
        };
        let outcome = json!({ "project": project, "threads": [], "stale": machine == "buildbox", "asOf": AT, "workstreams": workstreams,
            "lead": { "projectRef": { "machineId": machine, "projectId": name }, "threadId": format!("lead-{name}"),
                "state": (["idle", "working", "working", "stalled"][rng.below(4)]), "startedAt": AT, "sessionGeneration": 0 } });
        state.projects.push(ProjectRow { summary: from(project), outcome: Some(from(outcome)), error: None });
    }
    let asks = [
        ("A7", "product", "Which path should the health endpoint use?", Some(vec!["/healthz", "/health"]), "/healthz"),
        ("A2", "money", "Raise the hub's Claude slot cap from 40 to 48 for this week?", None, "Keep 40"),
        ("A3", "irreversible", "Delete the old infra staging bucket (412 GB)?", None, "Delete it"),
    ];
    for (n, (id, class, text, options, rec)) in asks.iter().enumerate() {
        let mut ask = json!({ "askId": id, "projectRef": { "machineId": "devbox", "projectId": PROJECTS[n] }, "kind": "decide",
            "key": format!("fixture.ask{n}"), "class": class, "text": text, "options": options, "recommendation": rec,
            "blocks": "nothing", "proceededOnRec": n == 1, "state": "open", "batchId": "B1", "number": n + 1, "createdAt": AT });
        if n == 0 {
            ask["workstreamId"] = json!(FIXTURE_ORDER);
        }
        state.asks.insert(id.to_string(), from(ask));
    }
    state.batches = vec![from(json!({ "batchId": "B1", "createdAt": AT, "state": "open",
        "items": [{ "number": 1, "askId": "A7" }, { "number": 2, "askId": "A2" }, { "number": 3, "askId": "A3" }] }))];
    let checks = json!([
        { "id": "hub/gh_auth", "scope": "hub", "status": "ok", "message": "gh is logged in as wynn-dev." },
        { "id": "devbox/disk", "scope": "machine", "machineId": "devbox", "status": "warn", "message": "12 GB free on /home (under 20 GB)." },
        { "id": "buildbox/node", "scope": "machine", "machineId": "buildbox", "status": "fail", "message": "claude on buildbox exited 3 times in 10 min.",
          "fix": { "kind": "auto", "label": "Restart the node on buildbox" } },
        { "id": "buildbox/claude_auth", "scope": "machine", "machineId": "buildbox", "status": "unknown", "message": "Couldn't ask: the machine is degraded.",
          "fix": { "kind": "manual", "label": "Log in to Claude on buildbox", "command": "claude auth login" } },
    ]);
    state.doctor = Some(Doctor { checks: from(checks), checked_at: Some(AT.into()), error: None });
    state.detail = Some(Detail { key: ("devbox".into(), PROJECTS[0].into()), tail: from(fixture_tail()), tail_error: None, version: 1 });
    live_fixture(&mut state);
    state
}

/// The contracts' board (W14, W12 in storefront) plus a few cards elsewhere, W14's detail, the full live frame, and
/// W14's recent events.
fn live_fixture(state: &mut State) {
    let fleetd: ProjectKey = ("devbox".into(), "storefront".into());
    let board = crate::live::fixture::board_fixture();
    let board_json = serde_json::to_value(&board).unwrap();
    state.live.set_board(&fleetd, board);
    // A planning order in web-app and a queued one in mailer, made from W12's card.
    let w12 = board_json["orders"][1].clone();
    for (project, id, title, phase, detail) in [
        ("web-app", "W9", "Login flow cleanup", "working", Some("2 working")),
        ("mailer", "W21", "Retry bounced digests", "queued", Some("queued: slots 40/40")),
    ] {
        let mut card = w12.clone();
        let machine = MACHINES[PROJECTS.iter().position(|p| *p == project).unwrap() % MACHINES.len()];
        card["workstreamId"] = json!(id);
        card["projectRef"] = json!({ "machineId": machine, "projectId": project });
        card["title"] = json!(title);
        card["phase"] = json!(phase);
        card["phaseDetail"] = json!(detail);
        card["prs"] = json!([]);
        card["next"] = json!(null);
        card["settled"] = json!(0);
        card["total"] = json!(0);
        if id == "W9" {
            // Two lanes of its own, so the board has more than one card with agents under it.
            let lanes: Vec<Value> = board_json["orders"][0]["lanes"]
                .as_array()
                .unwrap()
                .iter()
                .take(2)
                .enumerate()
                .map(|(i, l)| {
                    let mut l = l.clone();
                    let task = format!("T{}", 41 + i);
                    l["laneId"] = json!(task);
                    l["taskId"] = json!(task);
                    l["pr"] = json!(null);
                    l["live"] = json!(null);
                    l
                })
                .collect();
            card["lanes"] = json!(lanes);
            card["total"] = json!(2);
        }
        card["createdAt"] = json!("2026-10-18T10:05:00.000Z");
        card["updatedAt"] = json!("2026-10-18T10:05:00.000Z");
        let out = json!({ "orders": [card], "trains": [], "at": FIXTURE_NOW });
        state.live.set_board(&(machine.into(), project.into()), from(out));
    }
    // W8, finished this morning: the order the time inspector's screenshots open.
    let mut storefront = serde_json::to_value(crate::live::fixture::board_fixture()).unwrap();
    storefront["orders"].as_array_mut().unwrap().push(crate::time::fixture::order_card());
    state.live.set_board(&fleetd, from(storefront));
    state.live.set_order(crate::live::fixture::order_fixture());
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let mut frame = crate::live::fixture::frame_fixture(crate::live::fixture::FULL);
    // The machine strip ages a report against the local clock: move each machine's report to the same distance
    // before now as before the fixture's own now, so buildbox reads "offline 12 m" here as it does in Status.
    let fixture_now = crate::live::state::parse_ms(FIXTURE_NOW).unwrap_or(now);
    if let Some(machines) = frame.machines.take() {
        let moved = machines
            .into_inner()
            .into_iter()
            .map(|mut m| {
                let at = crate::live::state::parse_ms(m.as_of.as_str()).unwrap_or(fixture_now);
                m.as_of = crate::live::state::fmt_iso(now - (fixture_now - at)).into();
                m
            })
            .collect();
        frame.machines = Some(fleetd_contracts::prim::List::unchecked(moved));
    }
    state.live.apply(frame, now);
    for (at, kind, data) in [
        ("2026-10-18T10:03:10.000Z", "task.started", json!({ "workstreamId": FIXTURE_ORDER, "taskId": "T31" })),
        ("2026-10-18T10:03:11.000Z", "task.started", json!({ "workstreamId": FIXTURE_ORDER, "taskId": "T33" })),
        ("2026-10-18T10:03:40.000Z", "pr.merged", json!({ "workstreamId": FIXTURE_ORDER, "prNumber": 211 })),
    ] {
        state.push_order_event(from(
            json!({ "seq": 1, "at": at, "type": kind, "summary": kind, "machineId": "devbox", "projectId": "storefront", "data": data }),
        ));
    }
}

/// W14 and W12 as the storefront project outcome lists them, with W14's brief.
fn fixture_workstreams() -> Vec<Value> {
    let brief = json!({ "goal": "Fix the cart total rounding for multi-currency orders", "why": "Asked for.", "pointers": [], "constraints": [], "tier": "M",
        "doneWhen": [{ "type": "pr_merged", "repo": "acme/storefront" }, { "type": "http", "url": "http://127.0.0.1:4790/healthz", "status": 200 }] });
    let w = |id: &str, title: &str, state: &str, brief: Option<&Value>| {
        json!({ "workstreamId": id, "projectRef": { "machineId": "devbox", "projectId": "storefront" }, "title": title,
            "source": { "text": title, "channel": "app", "by": "human", "at": AT }, "brief": brief, "state": state,
            "createdAt": AT, "updatedAt": AT })
    };
    vec![w("W14", "Fix cart total rounding", "running", Some(&brief)), w("W12", "Faster product search", "converging", None)]
}

/// The storefront lead's recent log: W14's thread with a finished turn, a run about W12, and the lead at work now.
fn fixture_tail() -> Value {
    let at = |m: &str| format!("2026-10-18T10:{m}.000Z");
    let msg = |m: &str, role: &str, text: &str| json!({ "kind": "message", "at": at(m), "role": role, "text": text });
    let act = |m: &str, kind: &str, summary: &str, failed: bool| json!({ "kind": "action", "at": at(m), "action": { "at": at(m), "kind": kind, "status": if failed { "failed" } else { "completed" }, "summary": summary, "failed": failed } });
    json!([
        msg("02:01", "user", "New order W14 from you: Fix the cart total rounding for multi-currency orders."),
        act("02:04", "command", "fleetd inventory", false),
        act("02:18", "command", "rg -n roundTotal src/cart", false),
        act("02:31", "command", "npm test -- cart", false),
        act("02:49", "command", "fleetd brief create --workstream W14 --file brief.json", false),
        msg("02:50", "assistant", "Froze the brief for W14: 2 checks, tier M. Starting an implementer on src/cart/total.ts and a reviewer for #211."),
        msg("03:20", "assistant", "W12's PR #208 is in CI; nothing to do until it lands."),
        act("03:21", "command", "gh pr checks 208", false),
        msg("03:30", "assistant", "W12 needs no action."),
        msg(
            "05:02",
            "assistant",
            "T31 is editing src/cart/total.ts for W14. I asked you which path the health endpoint should use; T31 continues with /healthz meanwhile."
        ),
        act("06:40", "command", "fleetd task list --workstream W14", false),
        act("06:52", "command", "fleetd change status X12", false),
    ])
}

/// The time inspector's tools, answered from `time::fixture` as the hub would.
pub fn time_answer(state: &mut State) {
    crate::time::fixture::answer(state);
}

pub fn time_linked(state: &mut State) {
    crate::time::fixture::answer_linked(state);
}

pub fn time_window(state: &mut State) {
    crate::time::fixture::answer_window(state);
}

pub fn time_store(state: &mut State) {
    crate::time::fixture::answer_store(state);
}

/// The Status view's `status_get`, answered from `status::fixture` at once. `status_wait` is left open, as a hub
/// with nothing new would; `FLEETD_SCREEN=…+skeleton` leaves `status_get` open too, and `…+stale` answers with two
/// sources gone quiet.
pub fn status_answer(state: &mut State, out: Vec<AppClientMessage>) {
    use crate::status::fixture::{Variant, doc};
    let screen = std::env::var("FLEETD_SCREEN").unwrap_or_default();
    if screen.contains("skeleton") {
        return;
    }
    let variant = if screen.contains("stale") { Variant::Stale } else { Variant::Live };
    for message in out {
        if let AppClientMessage::Call { id, tool, input } = message
            && tool.as_str() == "status_get"
        {
            let scope = from(input["scope"].clone());
            let output = json!({ "doc": doc(&scope, variant) });
            state.apply(crate::client::Incoming::Message(AppServerMessage::Result { id, output }));
        }
    }
}

fn from<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture matches the contracts")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogKind {
    Tool,
    Output,
    Thought,
    Ok,
    Error,
}

pub struct LogLine {
    pub kind: LogKind,
    pub text: String,
}

const FILES: &[&str] = &[
    "crates/fleetd/src/hub/train/mod.rs",
    "crates/fleetd/src/hub/wakes/mod.rs",
    "crates/fleetd/src/hub/leads/digest.rs",
    "crates/fleetd/src/node/link.rs",
    "crates/fleetd-contracts/src/events.rs",
    "crates/fleetd/src/hub/slots/mod.rs",
    "crates/fleetd/src/cli/mod.rs",
    "app/fleetd-app/src/shell.rs",
];
const THOUGHTS: &[&str] = &[
    "The rebase fails because the lease check runs before the fetch; moving it after.",
    "Tests for the train cover the happy path only, adding a conflict case first.",
    "The event cursor is stored per subscription, so a reconnect should resume cleanly.",
    "This duplicates the digest renderer in the CLI; reusing the hub's instead.",
    "The stall watchdog fires at 120s but long cargo builds exceed that; making it per-task.",
    "Checking whether the node already scrubs secrets from command output before adding it.",
];
const TESTS: &[&str] = &[
    "train_rebases_before_merge",
    "train_parks_on_red_ci",
    "wake_fires_once_at_t",
    "digest_renders_open_asks",
    "lease_blocks_second_writer",
    "cursor_resumes_after_reconnect",
    "node_restarts_dead_claude",
    "ask_batches_by_key",
];

/// Produces realistic agent transcript lines, endlessly.
pub struct LogStream {
    rng: Rng,
    queue: Vec<LogLine>,
    tick: u64,
}

impl LogStream {
    pub fn new(seed: u64) -> Self {
        Self { rng: Rng::new(seed), queue: Vec::new(), tick: 0 }
    }

    pub fn next_line(&mut self) -> LogLine {
        if self.queue.is_empty() {
            self.refill();
        }
        self.tick += 1;
        let mut line = self.queue.remove(0);
        let ms = self.tick * 20;
        line.text = format!("{:02}:{:02}:{:02}.{:03}  {}", 9 + ms / 3_600_000 % 24, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000, line.text);
        line
    }

    fn push(&mut self, kind: LogKind, text: String) {
        self.queue.push(LogLine { kind, text });
    }

    fn refill(&mut self) {
        let file = self.rng.pick(FILES);
        match self.rng.below(5) {
            0 => {
                let thought = self.rng.pick(THOUGHTS).to_string();
                self.push(LogKind::Thought, thought);
            }
            1 => {
                self.push(LogKind::Tool, format!("● Read({file})"));
                let n = 40 + self.rng.below(400);
                self.push(LogKind::Output, format!("  └  Read {n} lines"));
            }
            2 => {
                self.push(LogKind::Tool, format!("● Edit({file})"));
                let (a, r) = (1 + self.rng.below(30), self.rng.below(12));
                self.push(LogKind::Output, format!("  └  Updated {file} with {a} additions and {r} removals"));
            }
            3 => {
                self.push(LogKind::Tool, "● Bash(cargo test -p fleetd hub::train)".to_string());
                let n = 3 + self.rng.below(6);
                self.push(LogKind::Output, format!("running {n} tests"));
                let mut failed = 0;
                for _ in 0..n {
                    let t = self.rng.pick(TESTS);
                    if self.rng.below(12) == 0 {
                        failed += 1;
                        self.push(LogKind::Error, format!("test hub::train::tests::{t} ... FAILED"));
                        self.push(LogKind::Error, "   assertion `left == right` failed: left: \"parked\", right: \"merged\"".to_string());
                    } else {
                        self.push(LogKind::Ok, format!("test hub::train::tests::{t} ... ok"));
                    }
                }
                let ms = 1 + self.rng.below(900);
                let (result, passed) = if failed == 0 { ("ok", n) } else { ("FAILED", n - failed) };
                self.push(LogKind::Output, format!("test result: {result}. {passed} passed; {failed} failed; finished in 0.{ms:03}s"));
            }
            _ => {
                self.push(LogKind::Tool, "● Bash(cargo build --release)".to_string());
                for c in ["serde v1.0.228", "smallvec v1.15.1", "taffy v0.9.2", "gpui v0.2.2", "fleetd-app v0.0.0"] {
                    self.push(LogKind::Output, format!("   Compiling {c}"));
                }
                if self.rng.below(6) == 0 {
                    self.push(LogKind::Error, "warning: unused variable: `lease`".to_string());
                }
                let (s, tenths) = (10 + self.rng.below(80), self.rng.below(10));
                self.push(LogKind::Ok, format!("    Finished `release` profile [optimized] target(s) in {s}.{tenths}s"));
            }
        }
    }
}

const CODE: &[&str] = &[
    "let lease = leases.acquire(&task.areas, &task.id)?;",
    "let Lease::Granted(lease) = lease else { return Err(TaskError::lease_held(area)) };",
    "git.fetch(&repo, &change.base).await?;",
    "let head = git.rev_parse(&repo, \"HEAD\").await?;",
    "for change in &queue {",
    "    tracing::info!(pr = change.pr, \"train: rebasing\");",
    "}",
    "Ok(Position { position, head, checks: summary.checks })",
    "pub struct TrainEntry { pub pr: u64, pub head: String }",
    "let result = ci.wait_for_checks(change.pr, Duration::from_secs(30 * 60)).await?;",
    "if !result.green { train.park(&change, &result.failing)?; }",
    "// The merge must use the exact head CI tested, not the branch tip.",
    "gh.merge(change.pr, &head, MergeMethod::Squash).await?;",
    "let digest = render_digest(&project, lead.last_wake);",
    "",
];

/// A ~1k-line unified diff over a few files (for the diff view's tests until the hub serves diffs).
#[allow(dead_code)]
pub fn diff_text() -> String {
    let mut rng = Rng::new(42);
    let mut out = String::new();
    for file in [
        "crates/fleetd/src/hub/train/mod.rs",
        "crates/fleetd/src/hub/leases/mod.rs",
        "crates/fleetd/src/hub/leads/digest.rs",
        "crates/fleetd-contracts/src/train.rs",
    ] {
        let _ = writeln!(out, "diff --git a/{file} b/{file}");
        let _ = writeln!(out, "index {:07x}..{:07x} 100644", rng.next() & 0xfffffff, rng.next() & 0xfffffff);
        let _ = writeln!(out, "--- a/{file}\n+++ b/{file}");
        let (mut old, mut new) = (1u32, 1u32);
        for _ in 0..14 {
            old += 5 + rng.below(30) as u32;
            new = new.max(old.saturating_sub(10)) + rng.below(4) as u32;
            let mut body = Vec::new();
            let (mut oc, mut nc) = (0, 0);
            for _ in 0..(14 + rng.below(10)) {
                let code = rng.pick(CODE);
                match rng.below(6) {
                    0 | 1 => {
                        body.push(format!("-    {code}"));
                        oc += 1;
                    }
                    2 | 3 => {
                        body.push(format!("+    {code}"));
                        nc += 1;
                    }
                    _ => {
                        body.push(format!("     {code}"));
                        oc += 1;
                        nc += 1;
                    }
                }
            }
            let _ = writeln!(out, "@@ -{old},{oc} +{new},{nc} @@ impl Train {{");
            for l in body {
                let _ = writeln!(out, "{l}");
            }
            old += oc;
            new += nc;
        }
    }
    out
}

// ---- prompts --------------------------------------------------------------------------------------

/// The bench's stand-in for the hub's prompt tools (`prompts_list`, `prompt_get`, `prompt_set`, `prompt_reset`,
/// `session_prompt_get`): a few real default texts, one stale hub-wide edit of the lead prompt, one project edit, and
/// custom instructions, so Settings → Prompts, Instructions and the "what this agent was told" sheet work offline.
pub struct PromptHub {
    prompts: Vec<FakePrompt>,
}

struct FakePrompt {
    id: &'static str,
    title: &'static str,
    kind: PromptKind,
    group: PromptGroup,
    sent_when: &'static str,
    per_project: bool,
    default: String,
    placeholders: Vec<(&'static str, bool, &'static str)>,
    rules: Vec<(&'static str, &'static str, &'static str, Enforcement)>,
    global: Option<Edit>,
    projects: Vec<((String, String), Edit)>,
}

/// An override and the default text it was edited from.
struct Edit {
    text: String,
    base: Option<String>,
}

const LEAD_START: &str = include_str!("../fixtures/prompts/lead.start.md");
const TASK_BRIEF_WRITE: &str = include_str!("../fixtures/prompts/task.brief.write.md");
const REVIEWER: &str = include_str!("../fixtures/prompts/review.reviewer.md");
const WAKE_INTENT: &str = include_str!("../fixtures/prompts/wake.intent.md");
const WAKE_TASK_RESULT: &str = include_str!("../fixtures/prompts/wake.task_result.md");
const NUDGE: &str = include_str!("../fixtures/prompts/watchdog.nudge.md");
const ROUTER: &str = include_str!("../fixtures/prompts/router.md");
const STATUS_HEADLINE: &str = include_str!("../fixtures/prompts/status.headline.md");
const BUGFIX: &str = "Bugfix. First a repro: a test or cmd check that fails on main today, in the brief's doneWhen. The fix is done when \
it passes. One writer per area, a worktree per task. Review by tier: S none, M one reviewer, L plan first. Every PR carries Source: \
done:<n>. Never merge; the train does. Fix this bug only: no refactors, no polish loops. When the repro passes, claim done. Idle is success.";
const STATUS_LINE: &str =
    "- Report a one-line status per workstream with `fleetd status set`. Your status shows as \"lead says\"; only passed checks show as ✓.\n";
const SECRETS: &str = "Secrets come through `fleetd ask --kind secret`; ";
/// Where the fixture's soft length budget sits; the hub's budgets are per prompt.
const TOO_LONG: usize = 12_000;

fn storefront() -> (String, String) {
    ("devbox".into(), "storefront".into())
}

/// A stand-in for git's blob SHA: FNV-1a, which is stable and needs no crate.
fn fnv(text: &str, seed: u64) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325 ^ seed, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3))
}

fn fake_ref(id: &str, text: &str) -> PromptRef {
    PromptRef::unchecked(format!("{id}@{:010x}", fnv(text, 0) & 0xff_ffff_ffff))
}

impl PromptHub {
    pub fn new() -> Self {
        use Enforcement::{Code, Prompt};
        let lead_rules = vec![
            ("never-write-code", "The lead never writes code", "never write code", Prompt),
            ("tasks-only", "Agents start only as fleetd tasks", "only fleetd tasks count", Prompt),
            ("secrets-via-ask", "Secrets come only through ask --kind secret", "secrets come through", Code),
            ("gated-run", "Prod writes, spends and deletes only through gated run", "gated run", Code),
            ("train-merges", "Only the merge train merges", "only fleetd's merge train merges", Code),
            ("no-re-ask", "Never re-ask a key the digest lists", "never re-ask", Prompt),
        ];
        // The release before this one shipped the lead prompt without the status line; the human edited that text.
        let old_default = LEAD_START.replacen(STATUS_LINE, "", 1);
        let yours = old_default.replacen(SECRETS, "", 1).replacen(
            "How you work:\n",
            "How you work:\n- Prefer one writer per pull request; split anything bigger into several tasks.\n",
            1,
        );
        let task_rules = vec![
            ("areas-only", "Writers change only their areas", "only change files in these areas", Code),
            ("never-merge", "Never merge; the train does", "never merge", Code),
            ("no-subagents", "No subagents", "do not hand it to subagents", Code),
        ];
        let prompts = vec![
            FakePrompt {
                id: "lead.start",
                title: "Lead: role and commands",
                kind: PromptKind::Start,
                group: PromptGroup::Lead,
                sent_when: "at each lead start and every lead restart, followed by the project digest",
                per_project: true,
                default: LEAD_START.to_string(),
                placeholders: vec![("project", true, "The project's name."), ("projectRef", true, "machine/project, as the CLI takes it.")],
                rules: lead_rules,
                global: Some(Edit { text: yours, base: Some(old_default) }),
                projects: Vec::new(),
            },
            FakePrompt {
                id: "task.brief.write",
                title: "Writer task brief",
                kind: PromptKind::Start,
                group: PromptGroup::Tasks,
                sent_when: "at every writer task start and every retry of it",
                per_project: true,
                default: TASK_BRIEF_WRITE.to_string(),
                placeholders: vec![
                    ("taskId", true, "T31"),
                    ("kind", false, "write"),
                    ("workstreamId", false, "W14"),
                    ("project", false, "The project's name."),
                    ("title", false, "The task's title."),
                    ("task", true, "The lead's text for this task."),
                    ("workstream", false, "The goal, done-when and serves block."),
                    ("areas", true, "The areas it may change, with their globs."),
                    ("branch", true, "Its own branch."),
                    ("baseBranch", false, "The project's default branch."),
                    ("serves", true, "What it serves, for the PR's Source: line."),
                ],
                rules: task_rules,
                global: None,
                projects: vec![(
                    storefront(),
                    Edit {
                        text: TASK_BRIEF_WRITE.replacen("## Rules\n", "## Rules\n- Use pnpm, never npm: the lockfile is pnpm-lock.yaml.\n", 1),
                        base: Some(TASK_BRIEF_WRITE.to_string()),
                    },
                )],
            },
            FakePrompt {
                id: "review.reviewer",
                title: "Independent PR review",
                kind: PromptKind::Start,
                group: PromptGroup::ReviewsAndChecks,
                sent_when: "per PR head per round, by the train's tier rules, to Claude or Codex",
                per_project: true,
                default: REVIEWER.to_string(),
                placeholders: vec![
                    ("prUrl", true, "The PR's URL."),
                    ("repo", false, "owner/name"),
                    ("prNumber", true, "The PR number."),
                    ("tier", false, "S, M or L."),
                    ("headSha", true, "The head commit reviewed."),
                    ("serves", false, "The done-when it serves."),
                ],
                rules: vec![("independent", "The reviewer does not read the PR description", "do not read the pr description", Prompt)],
                global: None,
                projects: Vec::new(),
            },
            FakePrompt {
                id: "wake.intent",
                title: "New order",
                kind: PromptKind::Wake,
                group: PromptGroup::WakesAndMessages,
                sent_when: "in a lead wake, per new order",
                per_project: true,
                default: WAKE_INTENT.to_string(),
                placeholders: vec![("workstreamId", true, "W14"), ("text", true, "The order's text.")],
                rules: Vec::new(),
                global: None,
                projects: Vec::new(),
            },
            FakePrompt {
                id: "wake.task_result",
                title: "A task's result",
                kind: PromptKind::Wake,
                group: PromptGroup::WakesAndMessages,
                sent_when: "in a lead wake, per task end",
                per_project: true,
                default: WAKE_TASK_RESULT.to_string(),
                placeholders: ["taskId", "verb", "title", "where", "receipts", "result"].iter().map(|n| (*n, true, "")).collect(),
                rules: Vec::new(),
                global: None,
                projects: Vec::new(),
            },
            FakePrompt {
                id: "watchdog.nudge",
                title: "Stall nudge",
                kind: PromptKind::Msg,
                group: PromptGroup::WakesAndMessages,
                sent_when: "once per stalled run",
                per_project: true,
                default: NUDGE.to_string(),
                placeholders: Vec::new(),
                rules: Vec::new(),
                global: Some(Edit {
                    text: "You seem stalled. Say in one line what you are waiting for, then continue.\n".into(),
                    base: Some(NUDGE.to_string()),
                }),
                projects: Vec::new(),
            },
            FakePrompt {
                id: "router",
                title: "Order router",
                kind: PromptKind::Oneshot,
                group: PromptGroup::OneShots,
                sent_when: "for each order without @project or a template prefix",
                per_project: false,
                default: ROUTER.to_string(),
                placeholders: vec![("projects", true, "Every project, one per line."), ("intent", true, "The order's text.")],
                rules: vec![("json-only", "Answer JSON only", "json", Prompt)],
                global: None,
                projects: Vec::new(),
            },
            FakePrompt {
                id: "status.headline",
                title: "Status headline",
                kind: PromptKind::Oneshot,
                group: PromptGroup::OneShots,
                sent_when: "when a viewed status scope's facts change",
                per_project: false,
                default: STATUS_HEADLINE.to_string(),
                placeholders: vec![("facts", true, "The fact list as JSON."), ("scope", true, "fleet, a project or an order")],
                rules: vec![
                    ("no-tools", "uses no tools", "do not use tools", Code),
                    ("one-line", "replies with one line of at most 160 characters", "one line", Code),
                ],
                global: None,
                projects: Vec::new(),
            },
            FakePrompt {
                id: "playbook.bugfix",
                title: "Bugfix playbook",
                kind: PromptKind::Playbook,
                group: PromptGroup::Playbooks,
                sent_when: "in the digest and the order's wake while a workstream pins the bugfix playbook",
                per_project: false,
                default: BUGFIX.to_string(),
                placeholders: Vec::new(),
                rules: vec![("never-merge", "Never merge", "never merge", Code)],
                global: None,
                projects: Vec::new(),
            },
            FakePrompt {
                id: crate::prompts::INSTRUCTIONS,
                title: "Custom instructions",
                kind: PromptKind::Instructions,
                group: PromptGroup::Instructions,
                sent_when: "appended to every lead and task first message",
                per_project: true,
                default: String::new(),
                placeholders: Vec::new(),
                rules: Vec::new(),
                global: Some(Edit {
                    text: "Keep pull requests under 400 changed lines; split bigger work.\nWrite commit messages in plain language.\n".into(),
                    base: Some(String::new()),
                }),
                projects: vec![(
                    storefront(),
                    Edit { text: "Use pnpm, not npm. The staging site is https://staging.storefront.test.\n".into(), base: Some(String::new()) },
                )],
            },
        ];
        Self { prompts }
    }

    /// The hub's answer to one app call, or `None` for a call this fake doesn't serve.
    pub fn answer(&mut self, message: &AppClientMessage) -> Option<AppServerMessage> {
        let AppClientMessage::Call { id, tool, input } = message else { return None };
        let project = input.get("projectRef").map(|p| (str_at(p, "machineId"), str_at(p, "projectId")));
        let output = match tool.as_str() {
            "prompts_list" => Ok(json!({ "prompts": self.prompts.iter().map(|p| p.summary(project.as_ref())).collect::<Vec<_>>() })),
            "prompt_get" => self.find(input).map(|p| serde_json::to_value(p.detail(project.as_ref())).unwrap()),
            "prompt_set" => self.set(input, project),
            "prompt_reset" => self.find_mut(input).map(|p| {
                match input.get("scope").and_then(Value::as_str) {
                    Some("project") => p.projects.retain(|(k, _)| Some(k) != project.as_ref()),
                    _ => p.global = None,
                }
                let (text, scope) = p.effective(project.as_ref());
                json!({ "effective": p.version(&text), "scope": scope })
            }),
            "session_prompt_get" => Ok(json!({ "session": self.session(&str_at(input, "machineId"), &str_at(input, "threadId")) })),
            _ => return None,
        };
        Some(match output {
            Ok(output) => AppServerMessage::Result { id: id.clone(), output },
            Err(message) => AppServerMessage::Error(from(json!({ "id": id, "code": "not_found", "message": message }))),
        })
    }

    fn find(&self, input: &Value) -> Result<&FakePrompt, String> {
        let id = str_at(input, "id");
        self.prompts.iter().find(|p| p.id == id).ok_or(format!("No prompt {id}."))
    }

    fn find_mut(&mut self, input: &Value) -> Result<&mut FakePrompt, String> {
        let id = str_at(input, "id");
        self.prompts.iter_mut().find(|p| p.id == id).ok_or(format!("No prompt {id}."))
    }

    fn set(&mut self, input: &Value, project: Option<(String, String)>) -> Result<Value, String> {
        let text = str_at(input, "text");
        let p = self.find_mut(input)?;
        if text.is_empty() && p.id != crate::prompts::INSTRUCTIONS {
            return Err("A prompt can't be empty.".into());
        }
        let warnings = p.warnings(&text);
        let r = fake_ref(p.id, &text);
        if input.get("dryRun").and_then(Value::as_bool) != Some(true) {
            let edit = Edit { text, base: Some(p.default.clone()) };
            match (input.get("scope").and_then(Value::as_str), project) {
                (Some("project"), Some(key)) if p.per_project => {
                    p.projects.retain(|(k, _)| *k != key);
                    p.projects.push((key, edit));
                }
                _ => p.global = Some(edit),
            }
        }
        Ok(json!({ "ref": r, "warnings": warnings }))
    }

    /// What a session of the fixture was sent at its start: the lead's prompt as pinned before the human's latest
    /// edit, or a writer's brief, each with the custom instructions appended.
    fn session(&self, machine: &str, thread: &str) -> SessionPrompt {
        let get = |id: &str| self.prompts.iter().find(|p| p.id == id).unwrap();
        let key = storefront();
        let instructions = get(crate::prompts::INSTRUCTIONS);
        let mut refs = Vec::new();
        let (main, vars): (&FakePrompt, Vec<(&str, String)>) = if thread.starts_with("lead") || thread == "s-lead" {
            (get("lead.start"), vec![("project", "storefront".into()), ("projectRef", "devbox/storefront".into())])
        } else {
            let task = format!("T{}", thread.trim_start_matches("s-"));
            (
                get("task.brief.write"),
                vec![
                    ("taskId", task),
                    ("kind", "write".into()),
                    ("workstreamId", "W14".into()),
                    ("project", "storefront".into()),
                    ("title", "Cart total rounds per line".into()),
                    ("task", "Round each line before summing in src/cart/total.ts, and add a test for 3 × 0.10.".into()),
                    ("workstream", "\n\n## Workstream W14\nGoal: cart totals match the receipt to the cent.\nDone when: ci_green acme/storefront; pr_merged acme/storefront.".into()),
                    ("areas", "cart (src/cart/**)".into()),
                    ("branch", "fleetd/t31-cart-rounding".into()),
                    ("baseBranch", "main".into()),
                    ("serves", "done:0".into()),
                ],
            )
        };
        let (text, scope) = main.effective(Some(&key));
        refs.push(SessionPromptRef { id: PromptId::unchecked(main.id), r#ref: fake_ref(main.id, &text), scope });
        let mut out = text;
        for (name, value) in vars {
            out = out.replacen(&format!("{{{{{name}}}}}"), &value, 1);
        }
        let global = instructions.global.as_ref().map(|e| e.text.trim_end()).unwrap_or_default();
        let project = instructions.projects.iter().find(|(k, _)| *k == key).map(|(_, e)| e.text.trim_end()).unwrap_or_default();
        out.push_str(&format!("\n\n## Custom instructions from the human\n{global}\n{project}\n"));
        for (scope, text) in [(PromptScope::Global, global), (PromptScope::Project, project)] {
            refs.push(SessionPromptRef { id: PromptId::unchecked(crate::prompts::INSTRUCTIONS), r#ref: fake_ref("instructions", text), scope });
        }
        if main.id == "lead.start" {
            out.push_str("\n# storefront: current truth, trust it over your memory\nWorkstreams:\n- W14 running: Cart total off by a cent\n");
            for id in ["wake.intent", "wake.task_result", "watchdog.nudge"] {
                let (text, scope) = get(id).effective(Some(&key));
                refs.push(SessionPromptRef { id: PromptId::unchecked(id), r#ref: fake_ref(id, &text), scope });
            }
        }
        SessionPrompt {
            machine_id: fleetd_contracts::ids::MachineId::unchecked(machine),
            thread_id: fleetd_contracts::ids::ThreadId::unchecked(thread),
            project_ref: Some(crate::prompts::project_ref(&key)),
            started_at: fleetd_contracts::ids::Timestamp("2026-10-18T09:12:40.000Z".into()),
            text_sha: format!("{:016x}{:016x}{:08x}", fnv(&out, 0), fnv(&out, 1), fnv(&out, 2) as u32),
            text: out,
            refs,
            disallowed_tools: [
                "Task",
                "Workflow",
                "AskUserQuestion",
                "EnterPlanMode",
                "ExitPlanMode",
                "CronCreate",
                "CronDelete",
                "CronList",
                "ScheduleWakeup",
                "EnterWorktree",
                "ExitWorktree",
            ]
            .iter()
            .map(|t| t.to_string())
            .collect(),
        }
    }
}

impl FakePrompt {
    /// The text in effect for `project` (or hub-wide) and its level.
    fn effective(&self, project: Option<&(String, String)>) -> (String, PromptScope) {
        if let Some((_, e)) = self.projects.iter().find(|(k, _)| Some(k) == project).filter(|_| self.per_project) {
            return (e.text.clone(), PromptScope::Project);
        }
        match &self.global {
            Some(e) => (e.text.clone(), PromptScope::Global),
            None => (self.default.clone(), PromptScope::Default),
        }
    }

    fn effective_edit(&self, project: Option<&(String, String)>) -> Option<(&Edit, PromptScope)> {
        match self.effective(project).1 {
            PromptScope::Project => self.projects.iter().find(|(k, _)| Some(k) == project).map(|(_, e)| (e, PromptScope::Project)),
            PromptScope::Global => self.global.as_ref().map(|e| (e, PromptScope::Global)),
            PromptScope::Default => None,
        }
    }

    fn summary(&self, project: Option<&(String, String)>) -> Value {
        let (text, scope) = self.effective(project);
        let stale = self.stale(project).is_some();
        json!({ "id": self.id, "title": self.title, "kind": self.kind, "group": self.group, "sentWhen": self.sent_when, "scope": scope,
            "defaultRef": fake_ref(self.id, &self.default),
            "overrideRef": (scope != PromptScope::Default).then(|| fake_ref(self.id, &text)), "stale": stale })
    }

    fn version(&self, text: &str) -> PromptVersion {
        PromptVersion { r#ref: fake_ref(self.id, text), text: text.to_string() }
    }

    fn edit(&self, e: &Edit) -> PromptOverride {
        PromptOverride { r#ref: fake_ref(self.id, &e.text), text: e.text.clone(), base: e.base.as_ref().map(|b| fake_ref(self.id, b)) }
    }

    fn stale(&self, project: Option<&(String, String)>) -> Option<StalePrompt> {
        let (edit, scope) = self.effective_edit(project)?;
        if edit.base.as_deref() == Some(self.default.as_str()) {
            return None;
        }
        let base = edit.base.as_deref().unwrap_or(&self.default);
        let (merged, conflicts) = match diffy::merge(base, &self.default, &edit.text) {
            Ok(m) => (m, false),
            Err(m) => (m, true),
        };
        Some(StalePrompt {
            scope,
            base: edit.base.as_ref().map(|b| self.version(b)),
            current: self.version(&self.default),
            yours: self.version(&edit.text),
            merged,
            conflicts,
        })
    }

    fn detail(&self, project: Option<&(String, String)>) -> PromptDetail {
        let (text, scope) = self.effective(project);
        let lower = text.to_lowercase();
        PromptDetail {
            id: PromptId::unchecked(self.id),
            title: self.title.into(),
            kind: self.kind,
            group: self.group,
            sent_when: self.sent_when.into(),
            per_project: self.per_project,
            default: self.version(&self.default),
            global: self.global.as_ref().map(|e| self.edit(e)),
            project: self.projects.iter().find(|(k, _)| Some(k) == project).filter(|_| self.per_project).map(|(_, e)| self.edit(e)),
            scope,
            effective: self.version(&text),
            placeholders: self
                .placeholders
                .iter()
                .map(|(name, required, description)| Placeholder {
                    name: name.to_string(),
                    required: *required,
                    description: description.to_string(),
                })
                .collect(),
            safety_rules: self
                .rules
                .iter()
                .map(|(id, label, needle, enforced)| SafetyRule {
                    id: id.to_string(),
                    label: label.to_string(),
                    needle: needle.to_string(),
                    enforced: *enforced,
                    present: Some(lower.contains(needle)),
                })
                .collect(),
            warnings: self.warnings(&text),
            stale: self.stale(project),
        }
    }

    fn warnings(&self, text: &str) -> Vec<PromptWarning> {
        let warn = |code, message: String| PromptWarning { code, message, placeholder: None, rule: None, enforced: None };
        let mut out = Vec::new();
        for (name, required, _) in &self.placeholders {
            if *required && !text.contains(&format!("{{{{{name}}}}}")) {
                out.push(PromptWarning {
                    placeholder: Some(name.to_string()),
                    ..warn(PromptWarningCode::PlaceholderMissing, format!("{{{{{name}}}}} is gone, so agents won't be told it."))
                });
            }
        }
        for name in text.split("{{").skip(1).filter_map(|rest| rest.split_once("}}").map(|(n, _)| n)) {
            if !self.placeholders.iter().any(|(p, _, _)| *p == name) {
                out.push(PromptWarning {
                    placeholder: Some(name.to_string()),
                    ..warn(PromptWarningCode::PlaceholderUnknown, format!("{{{{{name}}}}} isn't filled in for this prompt; it is sent as written."))
                });
            }
        }
        let lower = text.to_lowercase();
        for (id, label, needle, enforced) in &self.rules {
            if !lower.contains(needle) {
                out.push(PromptWarning {
                    rule: Some(id.to_string()),
                    enforced: Some(*enforced),
                    ..warn(PromptWarningCode::SafetyRuleMissing, format!("The text no longer says: {label}."))
                });
            }
        }
        if text.len() > TOO_LONG {
            out.push(warn(PromptWarningCode::TooLong, format!("{} characters; past {TOO_LONG}, agents read it less closely.", text.len())));
        }
        out
    }
}

fn str_at(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}
