//! Deterministic fake data standing in for the hub until the app talks to it.

use std::fmt::Write;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadState {
    Running,
    Waiting,
    Done,
    Failed,
}

pub enum Row {
    Project { name: String, machine: &'static str, fleet: usize },
    Thread { title: String, state: ThreadState, age: String },
}

const PROJECTS: &[&str] = &[
    "fleetd", "t3-fork-plan", "hermes", "adri", "cliproxy", "forge-infra", "dotfiles", "zed-notes",
    "pwa-push", "merge-train", "lab-harness", "billing-site", "docs-site", "mobile-shell", "ingest",
    "search-api", "metrics", "auth-gateway", "design-system", "release-bot",
];
const MACHINES: &[&str] = &["forge", "mac", "forge", "forge", "mac"];
const VERBS: &[&str] = &[
    "Fix", "Add", "Wire", "Speed up", "Remove", "Test", "Rename", "Split", "Harden", "Document",
];
const NOUNS: &[&str] = &[
    "merge train rebase", "lead digest", "slot board", "wake scheduler", "ask batching",
    "node heartbeat", "diff endpoint", "event cursor", "usage parking", "PWA push", "doctor checks",
    "policy leases", "brief freezer", "verifier job", "thread tail", "secret sealing",
];

/// ~200 rows: projects with their threads underneath.
pub fn project_rows() -> Vec<Row> {
    let mut rng = Rng::new(7);
    let mut rows = Vec::with_capacity(200);
    for (i, name) in PROJECTS.iter().enumerate() {
        let threads = 9;
        rows.push(Row::Project {
            name: name.to_string(),
            machine: MACHINES[i % MACHINES.len()],
            fleet: 1 + rng.below(8),
        });
        for _ in 0..threads {
            let state = match rng.below(10) {
                0..=3 => ThreadState::Running,
                4..=5 => ThreadState::Waiting,
                6..=8 => ThreadState::Done,
                _ => ThreadState::Failed,
            };
            let title = format!("{} {}", rng.pick(VERBS), rng.pick(NOUNS));
            let age = match rng.below(3) {
                0 => format!("{}m", 1 + rng.below(59)),
                1 => format!("{}h", 1 + rng.below(23)),
                _ => format!("{}d", 1 + rng.below(9)),
            };
            rows.push(Row::Thread { title, state, age });
        }
    }
    rows
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogKind {
    Tool,
    Output,
    Thought,
    Ok,
    Error,
    User,
}

pub struct LogLine {
    pub kind: LogKind,
    pub text: String,
}

const FILES: &[&str] = &[
    "apps/hub/src/train.ts", "apps/hub/src/wake.ts", "apps/hub/src/lead/digest.ts",
    "apps/node/src/handshake.ts", "packages/contracts/src/events.ts", "apps/hub/src/slots.ts",
    "apps/cli/src/cli.ts", "app/fleetd-app/src/shell.rs",
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
    "train rebases before merge", "train parks on red CI", "wake fires once at T",
    "digest renders open asks", "lease blocks second writer", "cursor resumes after reconnect",
    "node restarts dead t3", "ask batches by key",
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
                self.push(LogKind::Tool, "● Bash(pnpm vitest run apps/hub)".to_string());
                self.push(LogKind::Output, " RUN  v4.1.2 /home/wynn/src/fleetd".to_string());
                for _ in 0..(3 + self.rng.below(6)) {
                    let t = self.rng.pick(TESTS);
                    let ms = 1 + self.rng.below(90);
                    if self.rng.below(12) == 0 {
                        self.push(LogKind::Error, format!(" × apps/hub/src/train.test.ts > {t} {ms}ms"));
                        self.push(LogKind::Error, "   AssertionError: expected 'parked' to be 'merged'".to_string());
                    } else {
                        self.push(LogKind::Ok, format!(" ✓ apps/hub/src/train.test.ts > {t} {ms}ms"));
                    }
                }
                let n = 20 + self.rng.below(40);
                self.push(LogKind::Output, format!(" Test Files  {} passed ({})", n / 4, n / 4));
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
    "const lease = await leases.acquire(task.areas, task.id);",
    "if (lease._tag === \"Conflict\") return yield* Effect.fail(new LeaseHeld({ area }));",
    "yield* git.fetch(repo, { ref: change.base });",
    "const head = yield* git.revParse(repo, \"HEAD\");",
    "for (const change of queue) {",
    "  yield* Effect.logInfo(\"train: rebasing\", { pr: change.pr });",
    "}",
    "return { position, head, checks: summary.checks };",
    "export const TrainEntry = Schema.Struct({ pr: Schema.Number, head: Schema.String });",
    "const result = yield* ci.waitForChecks(change.pr, { timeout: \"30 minutes\" });",
    "if (!result.green) yield* train.park(change, result.failing);",
    "// The merge must use the exact head CI tested, not the branch tip.",
    "yield* gh.merge(change.pr, { sha: head, method: \"squash\" });",
    "const digest = renderDigest(project, { since: lead.lastWake });",
    "",
];

/// A ~1k-line unified diff over a few files.
pub fn diff_text() -> String {
    let mut rng = Rng::new(42);
    let mut out = String::new();
    for file in ["apps/hub/src/train.ts", "apps/hub/src/leases.ts", "apps/hub/src/lead/digest.ts", "packages/contracts/src/train.ts"] {
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
            let _ = writeln!(out, "@@ -{old},{oc} +{new},{nc} @@ export const Train = Layer.effect(");
            for l in body {
                let _ = writeln!(out, "{l}");
            }
            old += oc;
            new += nc;
        }
    }
    out
}
