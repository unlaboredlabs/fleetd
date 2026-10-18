//! Deterministic fake data for the bench, which runs without a hub.

use std::fmt::Write;

use serde_json::{Value, json};

use crate::state::{Conn, Detail, Doctor, ProjectRow, State};

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
    "fleetd",
    "t3-fork-plan",
    "hermes",
    "adri",
    "cliproxy",
    "forge-infra",
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
const MACHINES: &[&str] = &["forge", "mac", "forge", "forge", "mac"];
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
    state.machines = ["forge", "mac"]
        .iter()
        .map(|m| {
            from(json!({ "machineId": m, "name": m, "tags": [], "status": if *m == "mac" { "degraded" } else { "online" },
                "lastSeenAt": AT, "t3": { "version": "2fbd4318fc", "protocol": 2 }, "nodeVersion": "0.0.0",
                "degradedReason": if *m == "mac" { Some("T3 restarted 3 times in 10 min") } else { None } }))
        })
        .collect();
    for (i, name) in PROJECTS.iter().enumerate() {
        let machine = MACHINES[i % MACHINES.len()];
        let project = json!({ "machineId": machine, "projectId": name, "title": name, "workspaceRoot": format!("/w/{name}"),
            "threads": { "running": rng.below(4), "waiting": rng.below(2), "idle": 3, "failed": 0 }, "lastActivityAt": AT });
        let workstreams: Vec<Value> = (0..1 + rng.below(4))
            .map(|w| {
                let title = format!("{} {}", rng.pick(VERBS), rng.pick(NOUNS));
                json!({ "workstreamId": format!("W{}", i * 10 + w + 1), "projectRef": { "machineId": machine, "projectId": name },
                    "title": title, "source": { "text": title, "channel": "app", "by": "human", "at": AT },
                    "brief": { "goal": title, "why": "Asked for.", "pointers": [], "constraints": [], "tier": "M",
                        "doneWhen": [{ "type": "ci_green", "repo": format!("wynn-dev/{name}") }, { "type": "pr_merged", "repo": format!("wynn-dev/{name}") },
                                     { "type": "http", "url": "http://127.0.0.1:4790/healthz", "status": 200 }] },
                    "state": (["running", "converging", "verifying"][rng.below(3)]), "headline": format!("{} in review", title),
                    "headlineAt": AT, "createdAt": AT, "updatedAt": AT })
            })
            .collect();
        let outcome = json!({ "project": project, "threads": [], "stale": machine == "mac", "asOf": AT, "workstreams": workstreams,
            "lead": { "projectRef": { "machineId": machine, "projectId": name }, "threadId": format!("lead-{name}"),
                "state": (["idle", "working", "working", "stalled"][rng.below(4)]), "startedAt": AT, "sessionGeneration": 0 } });
        state.projects.push(ProjectRow { summary: from(project), outcome: Some(from(outcome)), error: None });
    }
    let asks = [
        ("A1", "product", "Which path should the health endpoint use?", Some(vec!["/healthz", "/health"]), "/healthz"),
        ("A2", "money", "Raise the hub's Claude slot cap from 40 to 48 for this week?", None, "Keep 40"),
        ("A3", "irreversible", "Delete the old forge-infra staging bucket (412 GB)?", None, "Delete it"),
    ];
    for (n, (id, class, text, options, rec)) in asks.iter().enumerate() {
        let ask = json!({ "askId": id, "projectRef": { "machineId": "forge", "projectId": PROJECTS[n] }, "kind": "decide",
            "key": format!("fixture.ask{n}"), "class": class, "text": text, "options": options, "recommendation": rec,
            "blocks": "nothing", "proceededOnRec": n == 0, "state": "open", "batchId": "B1", "number": n + 1, "createdAt": AT });
        state.asks.insert(id.to_string(), from(ask));
    }
    state.batches = vec![from(json!({ "batchId": "B1", "createdAt": AT, "state": "open",
        "items": [{ "number": 1, "askId": "A1" }, { "number": 2, "askId": "A2" }, { "number": 3, "askId": "A3" }] }))];
    let checks = json!([
        { "id": "hub/gh_auth", "scope": "hub", "status": "ok", "message": "gh is logged in as wynn-dev." },
        { "id": "forge/disk", "scope": "machine", "machineId": "forge", "status": "warn", "message": "12 GB free on /home (under 20 GB)." },
        { "id": "mac/t3", "scope": "machine", "machineId": "mac", "status": "fail", "message": "T3 restarted 3 times in 10 min.",
          "fix": { "kind": "auto", "label": "Restart T3 on mac" } },
        { "id": "mac/claude_auth", "scope": "machine", "machineId": "mac", "status": "unknown", "message": "Couldn't ask: the machine is degraded.",
          "fix": { "kind": "manual", "label": "Log in to Claude on mac", "command": "claude /login" } },
    ]);
    state.doctor = Some(Doctor { checks: from(checks), checked_at: Some(AT.into()), error: None });
    state.detail = Some(Detail { key: ("forge".into(), PROJECTS[0].into()), tail: Vec::new(), tail_error: None, version: 0 });
    state
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
    User,
    /// Added and removed lines of a diff in an action's output.
    DiffAdd,
    DiffDel,
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
    "node_restarts_dead_t3",
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
