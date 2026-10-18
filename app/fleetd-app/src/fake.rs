//! Deterministic fake data for the bench, which runs without a hub.

use std::fmt::Write;

use crate::state::ProjectKey;

use serde_json::{Value, json};

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
    state.live.set_order(crate::live::fixture::order_fixture());
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    state.live.apply(crate::live::fixture::frame_fixture(crate::live::fixture::FULL), now);
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
