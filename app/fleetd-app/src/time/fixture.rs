//! Bench and screenshot data for the time inspector, shaped as the hub's `time_*` tools return it (the contracts'
//! own types, built from JSON). One finished order, W8 in storefront, is laid down span by span so its lanes tile
//! and its critical path adds up to its wall time; a week of the fleet is made of orders like it. The roll-ups
//! here stand in for the hub's so the numbers on screen agree with the bars; they are bench data, not the rules.

use std::collections::{HashMap, HashSet};

use fleetd_contracts::live::AgentRole;
use fleetd_contracts::mcp::{ThreadWindowOutput, TimeBreakdownOutput, TimeInsightsOutput};
use fleetd_contracts::time::{CriticalPath, Span, SpanKind, SpanStatus, TimeScope};
use serde_json::{Map, Value, json};

use crate::fake::Rng;
use crate::live::state::{fmt_iso, parse_ms};
use crate::state::State;

/// The order the screenshots open.
pub const ORDER: &str = "W8";
const MIN: i64 = 60_000;

fn from<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture matches the contracts")
}

fn at(iso: &str) -> i64 {
    parse_ms(iso).expect("fixture time")
}

#[derive(Clone)]
struct Lane {
    lane: String,
    machine: Option<&'static str>,
    project: &'static str,
    order: String,
    task: Option<String>,
    thread: Option<String>,
    role: Option<AgentRole>,
}

struct Gen {
    out: Vec<Value>,
    id: i64,
    rng: Rng,
    /// Ten times the spans (short messages and calls), for the frame-budget check.
    dense: bool,
}

/// A leaf as laid down: (id, start, end).
type Leaf = (i64, i64, i64);

const PAGES: [&str; 3] = ["about", "pricing", "contact"];

impl Gen {
    fn new(seed: u64) -> Self {
        Self { out: Vec::new(), id: seed as i64 * 100_000, rng: Rng::new(seed), dense: std::env::var("FLEETD_TIME_DENSE").is_ok_and(|v| v == "1") }
    }

    fn r(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.rng.next() % (hi - lo).max(1) as u64) as i64
    }

    fn chance(&mut self, p: f64) -> bool {
        (self.rng.next() % 10_000) as f64 / 10_000. < p
    }

    fn span(&mut self, l: &Lane, kind: SpanKind, a: i64, b: i64, edit: impl FnOnce(&mut Map<String, Value>)) -> i64 {
        self.id += 1;
        let mut v = json!({ "id": self.id, "kind": kind, "cat": kind.category(), "lane": l.lane, "startMs": a, "endMs": b, "exclMs": b - a,
            "projectId": l.project, "workstreamId": l.order, "status": "ok" });
        let m = v.as_object_mut().unwrap();
        if let Some(machine) = l.machine {
            m.insert("machineId".into(), json!(machine));
        }
        if let Some(task) = &l.task {
            m.insert("taskId".into(), json!(task));
        }
        if let Some(thread) = &l.thread {
            m.insert("threadId".into(), json!(thread));
        }
        edit(m);
        self.out.push(v);
        self.id
    }

    fn leaf(&mut self, l: &Lane, kind: SpanKind, a: i64, b: i64, leaves: &mut Vec<Leaf>, edit: impl FnOnce(&mut Map<String, Value>)) {
        if b > a {
            let id = self.span(l, kind, a, b, edit);
            leaves.push((id, a, b));
        }
    }

    /// An agent at work from `from` to `to`: startup, then messages and tool calls, every gap between stream events
    /// a `claude.other` filler, so the lane tiles exactly. Every `suite_every`th call runs the full test suite.
    fn work(&mut self, l: &Lane, from: i64, to: i64, suite_every: usize, page: &str) -> Vec<Leaf> {
        let mut leaves = Vec::new();
        let k = if self.dense { 10 } else { 1 };
        let startup = self.r(6_000, 9_500);
        self.leaf(l, SpanKind::RunStartup, from, (from + startup).min(to), &mut leaves, |_| {});
        let mut c = from + startup;
        let mut i = 0usize;
        while c < to {
            let ft = self.r(1_500, 6_000) / k;
            let th = if self.chance(0.6) { self.r(2_000, 15_000) / k } else { 0 };
            let out = self.r(2_500, 20_000) / k;
            let end = (c + ft + th + out).min(to);
            let (tokens, thinking) = (self.r(80, 1_400), th / 40);
            let msg = self.span(l, SpanKind::ModelMessage, c, end, |m| {
                m.remove("exclMs");
                m.insert("extra".into(), json!({ "outputTokens": tokens, "thinkingTokens": thinking, "stopReason": "tool_use" }));
            });
            self.out.last_mut().unwrap()["itemId"] = json!(format!("msg_{msg}"));
            let mut p = c;
            for (kind, d) in [(SpanKind::ModelFirstToken, ft), (SpanKind::ModelThinking, th), (SpanKind::ModelOutput, out)] {
                let q = (p + d).min(end);
                self.leaf(l, kind, p, q, &mut leaves, |m| {
                    m.insert("parent".into(), json!(msg));
                });
                p = q;
            }
            c = end;
            if c >= to {
                break;
            }
            let gap = self.r(80, 400) / k;
            self.leaf(l, SpanKind::ClaudeOther, c, (c + gap).min(to), &mut leaves, |_| {});
            c += gap;
            if c >= to {
                break;
            }
            c = self.tool(l, c, to, i, suite_every, page, &mut leaves);
            if c < to {
                let gap = self.r(60, 300) / k;
                self.leaf(l, SpanKind::ClaudeOther, c, (c + gap).min(to), &mut leaves, |_| {});
                c += gap;
            }
            i += 1;
        }
        leaves
    }

    #[allow(clippy::too_many_arguments)]
    fn tool(&mut self, l: &Lane, c: i64, to: i64, i: usize, suite_every: usize, page: &str, leaves: &mut Vec<Leaf>) -> i64 {
        let k = if self.dense { 10 } else { 1 };
        let roll = self.rng.below(100);
        let file = format!("src/pages/{page}.tsx");
        let (kind, label, family, ms, fail, bytes): (SpanKind, String, &str, i64, f64, i64) = if i % suite_every == suite_every - 1 {
            (SpanKind::ToolBash, "npm test".into(), "npm test", self.r(118_000, 142_000), 0.35, self.r(20_000, 60_000))
        } else {
            match roll {
                0..30 => (SpanKind::ToolRead, file.clone(), "Read", self.r(150, 1_200), 0., self.r(800, 9_000)),
                30..40 => (SpanKind::ToolRead, format!("Grep: {}Section", capital(page)), "Grep", self.r(200, 900), 0., self.r(200, 3_000)),
                40..62 => (SpanKind::ToolEdit, file.clone(), "Edit", self.r(200, 1_500), 0., 0),
                62..74 => (SpanKind::ToolBash, format!("npm test -- src/pages/{page}"), "npm test", self.r(6_000, 14_000), 0.2, self.r(1_000, 6_000)),
                74..80 => (SpanKind::Git, "git status --short".into(), "git status", self.r(200, 500), 0., self.r(40, 400)),
                80..85 => (SpanKind::ToolMcp, "mcp__fleetd__task_report".into(), "mcp__fleetd__task_report", self.r(300, 900), 0., 120),
                85..89 => (SpanKind::ToolBash, "npm run build".into(), "npm run", self.r(70_000, 95_000), 0.05, self.r(4_000, 12_000)),
                89..94 => (SpanKind::ToolsParallel, String::new(), "", 0, 0., 0),
                _ => (SpanKind::ToolBash, "npx tsc --noEmit".into(), "npx tsc", self.r(9_000, 16_000), 0.1, self.r(100, 3_000)),
            }
        };
        if kind == SpanKind::ToolsParallel {
            let durs = [self.r(200, 900) / k, self.r(300, 1_400) / k, self.r(250, 1_100) / k];
            let end = (c + durs.iter().max().unwrap()).min(to);
            let group = self.span(l, SpanKind::ToolsParallel, c, end, |_| {});
            leaves.push((group, c, end));
            for (n, d) in durs.iter().enumerate() {
                let path = format!("src/pages/{}.tsx", PAGES[(n + i) % 3]);
                let start = c + n as i64 * 4;
                let id = self.span(l, SpanKind::ToolRead, start, (start + d).min(end), |m| {
                    m.remove("exclMs");
                    m.insert("parent".into(), json!(group));
                    m.insert("label".into(), json!(path));
                    m.insert("family".into(), json!("Read"));
                });
                self.out.last_mut().unwrap()["itemId"] = json!(format!("toolu_{id}"));
            }
            return end;
        }
        let ms = (ms / k).max(50);
        let end = (c + ms).min(to);
        let failed = fail > 0. && self.chance(fail);
        let bash = matches!(kind, SpanKind::ToolBash | SpanKind::Git);
        let claude = self.chance(0.3).then(|| ms - self.r(0, 40).min(ms));
        let id = self.span(l, kind, c, end, |m| {
            m.insert("label".into(), json!(label));
            m.insert("family".into(), json!(family));
            if bash {
                m.insert("exitCode".into(), json!(if failed { 1 } else { 0 }));
            }
            if bytes > 0 {
                m.insert("outBytes".into(), json!(bytes));
            }
            if failed {
                m.insert("status".into(), json!("failed"));
            }
            if let Some(cm) = claude {
                m.insert("extra".into(), json!({ "claudeMs": cm }));
            }
        });
        self.out.last_mut().unwrap()["itemId"] = json!(format!("toolu_{id}"));
        leaves.push((id, c, end));
        end
    }
}

fn capital(s: &str) -> String {
    let mut c = s.chars();
    c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
}

#[derive(Clone)]
struct OrderSpec {
    id: String,
    project: &'static str,
    machine: &'static str,
    start: i64,
    change: &'static str,
    pr: i64,
    seed: u64,
    suite_every: usize,
    /// Task numbers start here: T21 for W8.
    tasks: i64,
    /// Every interval stretched by this much: the week before ran slower.
    slow: f64,
}

/// A week of the fleet: W8 (the screenshots' order) and five like it.
fn week() -> Vec<OrderSpec> {
    let o = |id: &str, project, machine, start: &str, change, pr, seed, suite_every, tasks| OrderSpec {
        id: id.into(),
        project,
        machine,
        start: at(start),
        change,
        pr,
        seed,
        suite_every,
        tasks,
        slow: 1.,
    };
    vec![
        o("W8", "storefront", "devbox", "2026-10-18T08:10:00.000Z", "X7", 205, 11, 12, 20),
        o("W3", "web-app", "buildbox", "2026-10-12T14:00:00.000Z", "X2", 188, 12, 10, 60),
        o("W5", "mailer", "devbox", "2026-10-13T09:30:00.000Z", "X4", 194, 13, 14, 70),
        o("W6", "storefront", "devbox", "2026-10-14T11:00:00.000Z", "X5", 199, 14, 11, 80),
        o("W7", "api-proxy", "buildbox", "2026-10-16T16:20:00.000Z", "X6", 201, 15, 13, 90),
        o("W2", "web-app", "devbox", "2026-10-17T10:05:00.000Z", "X1", 183, 16, 12, 100),
    ]
}

/// The week before, for compare: the same orders, with the full suite run more often.
fn before(spec: &OrderSpec) -> OrderSpec {
    OrderSpec { start: spec.start - 7 * 86_400_000, seed: spec.seed + 50, suite_every: (spec.suite_every / 2).max(5), slow: 1.3, ..spec.clone() }
}

struct Built {
    spans: Vec<Value>,
    path: Value,
    wall: (i64, i64),
    roles: HashMap<String, AgentRole>,
    machine: &'static str,
    project: &'static str,
}

/// One order end to end: the lead freezes the brief, three writers (two wait for a slot), one asks you, a reviewer,
/// the PR through review, the train line, a rebase and CI with three checks, then merge. 1h42m of wall.
fn build_order(spec: &OrderSpec) -> Built {
    let mut g = Gen::new(spec.seed);
    let t0 = spec.start;
    let m = |x: f64| t0 + (x * spec.slow * MIN as f64) as i64;
    let order = spec.id.to_string();
    let thread_lane = |task: Option<&str>, thread: &str, role: AgentRole| Lane {
        lane: format!("thread:{}/{thread}", spec.machine),
        machine: Some(spec.machine),
        project: spec.project,
        order: order.clone(),
        task: task.map(str::to_string),
        thread: Some(thread.to_string()),
        role: Some(role),
    };
    let task = |k: i64| format!("T{}", spec.tasks + k);
    let lead = thread_lane(None, &format!("lead-{}", spec.project), AgentRole::Lead);
    let w: Vec<Lane> = (1..=3).map(|k| thread_lane(Some(&task(k)), &format!("s-{}", spec.tasks + k), AgentRole::Implementer)).collect();
    let rev = thread_lane(Some(&task(5)), &format!("s-{}", spec.tasks + 5), AgentRole::Reviewer);
    let other = |lane: String, machine: Option<&'static str>| Lane {
        lane,
        machine,
        project: spec.project,
        order: order.clone(),
        task: None,
        thread: None,
        role: None,
    };
    let asks = other(format!("asks:{}", spec.id), None);
    let change = other(format!("change:{}", spec.change), None);
    let train = other(format!("train:acme/{}", spec.project), Some(spec.machine));
    let mut path: Vec<(i64, i64, i64)> = Vec::new();

    // The lead: intake, then short wakes. Its turns are split across the orders they served.
    let lead_burst = |g: &mut Gen, a: f64, b: f64| g.work(&lead, m(a), m(b), 99, "about");
    path.extend(lead_burst(&mut g, 0., 3.));
    lead_burst(&mut g, 20., 21.);
    lead_burst(&mut g, 52., 54.);
    lead_burst(&mut g, 71., 72.5);

    // Writer a starts at once; b and c wait for a slot.
    g.work(&w[0], m(3.), m(52.), spec.suite_every, PAGES[0]);
    let reason = |m: &mut Map<String, Value>| {
        m.insert("extra".into(), json!({ "reason": "slots: 40/40 in use" }));
    };
    g.span(&w[1], SpanKind::QueueSlot, m(3.), m(9.), reason);
    g.work(&w[1], m(9.), m(48.), spec.suite_every + 2, PAGES[1]);
    let q = g.span(&w[2], SpanKind::QueueSlot, m(3.), m(7.), reason);
    path.push((q, m(3.), m(7.)));
    path.extend(g.work(&w[2], m(7.), m(20.), spec.suite_every, PAGES[2]));
    g.span(&w[2], SpanKind::Idle, m(20.), m(54.), |_| {});
    path.extend(g.work(&w[2], m(54.), m(71.), spec.suite_every, PAGES[2]));
    // One API retry in writer b, inside its work.
    g.span(&w[1], SpanKind::WaitRetryApi, m(48.), m(48.75), |m| {
        m.insert("extra".into(), json!({ "httpStatus": 529, "statedDelayMs": 30_000, "attempt": 1 }));
    });

    // Writer c asked which region to deploy to; the ask sat in its batch, then waited on you.
    let key = |m: &mut Map<String, Value>| {
        m.insert("extra".into(), json!({ "key": "deploy.region" }));
    };
    let b = g.span(&asks, SpanKind::AskBatching, m(20.), m(26.), key);
    path.push((b, m(20.), m(26.)));
    let wa = g.span(&asks, SpanKind::WaitAsk, m(26.), m(54.), |m| {
        m.insert("extra".into(), json!({ "key": "deploy.region", "decidedBy": "human", "answeredBy": "you" }));
    });
    path.push((wa, m(26.), m(54.)));
    g.span(&asks, SpanKind::AskInfo, m(31.), m(32.), |m| {
        m.insert("extra".into(), json!({ "key": "copy.tone" }));
    });

    // The reviewer, then the PR through the train.
    g.work(&rev, m(71.), m(80.), 99, PAGES[0]);
    let label = |m: &mut Map<String, Value>| {
        m.insert("label".into(), json!(format!("#{}", spec.pr)));
    };
    for (kind, a, b) in [(SpanKind::ChangeReview, 71., 80.), (SpanKind::ChangeQueue, 80., 80.4), (SpanKind::ChangeRebase, 80.4, 81.)] {
        let id = g.span(&change, kind, m(a), m(b), label);
        path.push((id, m(a), m(b)));
    }
    for (label, a, b) in [("git fetch origin", 80.4, 80.5), ("git rebase origin/main", 80.5, 80.8), ("git push --force-with-lease", 80.8, 81.)] {
        g.span(&train, SpanKind::Git, m(a), m(b), |m| {
            m.insert("label".into(), json!(label));
            m.insert("family".into(), json!(label.split(' ').take(2).collect::<Vec<_>>().join(" ")));
            m.insert("exitCode".into(), json!(0));
        });
    }
    let ci = g.span(&change, SpanKind::ChangeCi, m(81.), m(101.7), label);
    // GitHub's stamps are whole seconds.
    let sec = |x: f64| m(x).div_euclid(1000) * 1000;
    let e2e_end = 101.4 - (spec.seed % 3) as f64 * 1.5;
    for (name, a, b) in [("lint", 81.3, 83.1), ("build", 81.4, 88.9), ("e2e (webkit)", 81.5, e2e_end)] {
        let id = g.span(&change, SpanKind::CiCheck, sec(a), sec(b), |m| {
            m.remove("exclMs");
            m.insert("parent".into(), json!(ci));
            m.insert(
                "extra".into(),
                json!({ "check": name, "url": format!("https://github.com/acme/{}/actions/runs/{}", spec.project, 9_100_000 + spec.seed * 10) }),
            );
        });
        if name == "e2e (webkit)" {
            path.push((ci, m(81.), sec(a)));
            path.push((id, sec(a), sec(b)));
            path.push((ci, sec(b), m(101.7)));
        }
    }
    let mg = g.span(&change, SpanKind::ChangeMerge, m(101.7), m(102.), label);
    path.push((mg, m(101.7), m(102.)));

    let mut roles = HashMap::new();
    for l in [&lead, &w[0], &w[1], &w[2], &rev] {
        roles.insert(l.thread.clone().unwrap(), l.role.unwrap());
    }
    let by_id: HashMap<i64, &Value> = g.out.iter().map(|v| (v["id"].as_i64().unwrap(), v)).collect();
    let mut totals: HashMap<String, i64> = HashMap::new();
    let segments: Vec<Value> = path
        .iter()
        .map(|&(id, a, b)| {
            let s = by_id[&id];
            *totals.entry(s["cat"].as_str().unwrap().to_string()).or_default() += b - a;
            json!({ "spanId": id, "lane": s["lane"], "kind": s["kind"], "cat": s["cat"], "startMs": a, "endMs": b, "label": s.get("label") })
        })
        .collect();
    let path_total: i64 = path.iter().map(|(_, a, b)| b - a).sum();
    debug_assert_eq!(path_total, m(102.) - m(0.), "the path adds up to the wall");
    let agent: i64 = g.out.iter().filter(|v| v["kind"] != "idle").filter_map(|v| v["exclMs"].as_i64()).sum();
    let path = json!({ "startMs": m(0.), "endMs": m(102.), "segments": segments, "segmentsTruncated": false,
        "totals": totals.iter().map(|(c, ms)| json!({ "cat": c, "ms": ms })).collect::<Vec<_>>(),
        "nothingRunningMs": 0, "offPathMs": agent - path_total });
    Built { spans: g.out, path, wall: (m(0.), m(102.)), roles, machine: spec.machine, project: spec.project }
}

// ---- roll-ups --------------------------------------------------------------------------------

fn median(v: &mut [i64]) -> i64 {
    v.sort_unstable();
    v.get(v.len() / 2).copied().unwrap_or(0)
}

struct Data {
    spans: Vec<Span>,
    paths: Vec<CriticalPath>,
    wall: i64,
    gaps: Vec<Value>,
}

fn dur(s: &Span) -> i64 {
    s.end_ms.map_or(0, |e| e.get()) - s.start_ms.get()
}

fn is_cmd(s: &Span) -> bool {
    matches!(s.kind, SpanKind::ToolBash | SpanKind::Git | SpanKind::ToolMcp)
}

fn breakdown_json(d: &Data) -> Value {
    let mut cats: HashMap<String, (i64, i64, HashMap<String, (i64, i64)>)> = HashMap::new();
    for s in &d.spans {
        let Some(ex) = s.excl_ms.map(|e| e.get()) else { continue };
        if s.kind == SpanKind::Idle {
            continue;
        }
        let cat = serde_json::to_value(s.cat).unwrap().as_str().unwrap().to_string();
        let e = cats.entry(cat).or_default();
        e.0 += ex;
        e.1 += 1;
        let k = e.2.entry(s.kind.as_str().to_string()).or_default();
        k.0 += ex;
        k.1 += 1;
    }
    let agent: i64 = cats.values().map(|c| c.0).sum();
    let by_category: Vec<Value> = cats
        .iter()
        .map(|(cat, (ms, n, kinds))| {
            json!({ "cat": cat, "ms": ms, "n": n,
            "kinds": kinds.iter().map(|(k, (ms, n))| json!({ "kind": k, "ms": ms, "n": n })).collect::<Vec<_>>() })
        })
        .collect();
    // Commands, per call.
    let mut cmds: HashMap<String, (String, Vec<i64>, i64)> = HashMap::new();
    for s in d.spans.iter().filter(|s| is_cmd(s)) {
        let e = cmds.entry(s.label.as_ref().map(|l| l.to_string()).unwrap_or_default()).or_insert((
            s.family.as_ref().map(|f| f.to_string()).unwrap_or_default(),
            Vec::new(),
            0,
        ));
        e.1.push(dur(s));
        e.2 += (s.status == SpanStatus::Failed) as i64;
    }
    let mut top: Vec<(String, String, Vec<i64>, i64)> = cmds.into_iter().map(|(l, (f, d, x))| (l, f, d, x)).collect();
    top.sort_by_key(|c| std::cmp::Reverse(c.2.iter().sum::<i64>()));
    let top_commands: Vec<Value> = top
        .into_iter()
        .take(8)
        .map(|(label, family, mut d, failed)| {
            let total: i64 = d.iter().sum();
            let max = *d.iter().max().unwrap_or(&0);
            json!({ "label": label, "family": family, "n": d.len(), "totalMs": total, "p50Ms": median(&mut d), "maxMs": max, "failed": failed })
        })
        .collect();
    let repeated: Vec<Value> = repeats(&d.spans)
        .into_iter()
        .take(5)
        .map(|r| json!({ "label": r.label, "threadId": r.thread, "taskId": r.task, "n": r.ids.len(), "totalMs": r.total }))
        .collect();
    let checks = check_stats(d);
    let waits: Vec<&Span> = d.spans.iter().filter(|s| s.kind == SpanKind::WaitAsk).collect();
    let longest = waits.iter().max_by_key(|s| dur(s));
    let human_wait = json!({ "totalMs": waits.iter().map(|s| dur(s)).sum::<i64>(), "n": waits.len(),
        "longest": longest.map(|s| json!({ "spanId": s.id, "ms": dur(s), "label": s.extra.as_ref().and_then(|e| e.key.clone()) })) });
    json!({ "wallMs": d.wall, "agentMs": agent, "byCategory": by_category, "topCommands": top_commands, "repeated": repeated,
        "ciChecks": checks, "humanWait": human_wait, "retentionDays": 30, "storedBytes": d.spans.len() as i64 * 170 + 38_000_000,
        "coverage": { "complete": d.gaps.is_empty(), "gaps": d.gaps } })
}

struct Repeat {
    label: String,
    thread: String,
    task: Option<String>,
    ids: Vec<i64>,
    total: i64,
}

/// Runs of the same command in one session with no edit between them, at least three long.
fn repeats(spans: &[Span]) -> Vec<Repeat> {
    let mut by_thread: HashMap<String, Vec<&Span>> = HashMap::new();
    for s in spans.iter().filter(|s| s.kind == SpanKind::ToolBash || s.kind == SpanKind::ToolEdit) {
        if let Some(t) = &s.thread_id {
            by_thread.entry(t.to_string()).or_default().push(s);
        }
    }
    let mut out = Vec::new();
    for (thread, mut list) in by_thread {
        list.sort_by_key(|s| s.start_ms.get());
        let mut runs: HashMap<String, Vec<&Span>> = HashMap::new();
        for s in list {
            if s.kind == SpanKind::ToolEdit {
                for (label, run) in runs.drain() {
                    if run.len() >= 3 {
                        out.push(Repeat {
                            label,
                            thread: thread.clone(),
                            task: run[0].task_id.as_ref().map(|t| t.to_string()),
                            ids: run.iter().map(|s| s.id.get()).collect(),
                            total: run.iter().map(|s| dur(s)).sum(),
                        });
                    }
                }
                continue;
            }
            runs.entry(s.label.as_ref().map(|l| l.to_string()).unwrap_or_default()).or_default().push(s);
        }
        for (label, run) in runs {
            if run.len() >= 3 {
                out.push(Repeat {
                    label,
                    thread: thread.clone(),
                    task: run[0].task_id.as_ref().map(|t| t.to_string()),
                    ids: run.iter().map(|s| s.id.get()).collect(),
                    total: run.iter().map(|s| dur(s)).sum(),
                });
            }
        }
    }
    out.sort_by_key(|r| std::cmp::Reverse(r.total));
    out
}

/// Per check name; a check's excess is how much later it finished than the second-latest check of its run.
fn check_stats(d: &Data) -> Vec<Value> {
    let mut by_name: HashMap<String, (Vec<i64>, i64)> = HashMap::new();
    let mut by_order: HashMap<String, Vec<&Span>> = HashMap::new();
    for s in d.spans.iter().filter(|s| s.kind == SpanKind::CiCheck) {
        let name = s.extra.as_ref().and_then(|e| e.check.as_ref()).map(|c| c.to_string()).unwrap_or_default();
        by_name.entry(name).or_default().0.push(dur(s));
        by_order.entry(s.workstream_id.as_ref().map(|w| w.to_string()).unwrap_or_default()).or_default().push(s);
    }
    for list in by_order.values_mut() {
        list.sort_by_key(|s| s.end_ms.map_or(0, |e| e.get()));
        if let [.., second, last] = list.as_slice() {
            let name = last.extra.as_ref().and_then(|e| e.check.as_ref()).map(|c| c.to_string()).unwrap_or_default();
            by_name.entry(name).or_default().1 += last.end_ms.unwrap().get() - second.end_ms.unwrap().get();
        }
    }
    let mut out: Vec<(String, Vec<i64>, i64)> = by_name.into_iter().map(|(n, (d, x))| (n, d, x)).collect();
    out.sort_by_key(|c| std::cmp::Reverse(c.1.iter().sum::<i64>()));
    out.into_iter()
        .map(|(name, mut d, excess)| {
            let total: i64 = d.iter().sum();
            let max = *d.iter().max().unwrap_or(&0);
            json!({ "name": name, "n": d.len(), "totalMs": total, "p50Ms": median(&mut d), "maxMs": max, "criticalExcessMs": excess })
        })
        .collect()
}

/// The findings this data fires, with the numbers the hub's rules would give.
fn findings(d: &Data, fleet: bool) -> Vec<(String, String, Vec<(String, i64)>, Vec<i64>)> {
    let mut out = Vec::new();
    let fmt = super::fmt_dur;
    // full_suite_repeat
    let mut suite: Vec<&Span> = d.spans.iter().filter(|s| s.kind == SpanKind::ToolBash && s.label.as_deref() == Some("npm test")).collect();
    suite.sort_by_key(|s| s.start_ms.get());
    let total: i64 = suite.iter().map(|s| dur(s)).sum();
    if suite.len() >= 5 && total >= 10 * MIN {
        let edits: Vec<(String, i64)> = d
            .spans
            .iter()
            .filter(|s| s.kind == SpanKind::ToolEdit)
            .filter_map(|s| Some((s.thread_id.as_ref()?.to_string(), s.start_ms.get())))
            .collect();
        let mut last: HashMap<String, i64> = HashMap::new();
        let mut k = 0;
        for s in &suite {
            let t = s.thread_id.as_ref().map(|t| t.to_string()).unwrap_or_default();
            if let Some(&prev) = last.get(&t)
                && !edits.iter().any(|(et, at)| *et == t && *at > prev && *at < s.start_ms.get())
            {
                k += 1;
            }
            last.insert(t, s.start_ms.get());
        }
        out.push((
            "full_suite_repeat".into(),
            format!(
                "agents ran the full test suite `npm test` {}× ({}); {k} run{} followed no edit since the previous run",
                suite.len(),
                fmt(total),
                if k == 1 { "" } else { "s" }
            ),
            vec![("runs".into(), suite.len() as i64), ("totalMs".into(), total), ("noEdit".into(), k)],
            suite.iter().map(|s| s.id.get()).collect(),
        ));
    }
    // ci_check_critical, across orders.
    let mut e2e: Vec<&Span> = d.spans.iter().filter(|s| s.extra.as_ref().and_then(|e| e.check.as_deref()) == Some("e2e (webkit)")).collect();
    let orders: HashSet<String> = e2e.iter().filter_map(|s| s.workstream_id.as_ref().map(|w| w.to_string())).collect();
    let excess = check_stats(d).iter().find(|c| c["name"] == "e2e (webkit)").and_then(|c| c["criticalExcessMs"].as_i64()).unwrap_or(0);
    if fleet && orders.len() >= 2 && excess >= 3 * MIN {
        let mut ds: Vec<i64> = e2e.iter().map(|s| dur(s)).collect();
        out.push((
            "ci_check_critical".into(),
            format!(
                "CI check `e2e (webkit)` adds {} on the critical path of {} orders (median {} per run)",
                fmt(excess),
                orders.len(),
                fmt(median(&mut ds))
            ),
            vec![("excessMs".into(), excess), ("orders".into(), orders.len() as i64)],
            {
                e2e.sort_by_key(|s| s.start_ms.get());
                e2e.iter().map(|s| s.id.get()).collect()
            },
        ));
    }
    // human_wait
    let waits: Vec<&Span> = d.spans.iter().filter(|s| s.kind == SpanKind::WaitAsk).collect();
    let wait_total: i64 = waits.iter().map(|s| dur(s)).sum();
    if wait_total >= 10 * MIN {
        let longest = waits.iter().max_by_key(|s| dur(s)).unwrap();
        out.push((
            "human_wait".into(),
            format!(
                "waited {} on your answers ({} ask{}); longest: `{}` {}",
                fmt(wait_total),
                waits.len(),
                if waits.len() == 1 { "" } else { "s" },
                longest.extra.as_ref().and_then(|e| e.key.as_deref()).unwrap_or("?"),
                fmt(dur(longest))
            ),
            vec![("totalMs".into(), wait_total), ("asks".into(), waits.len() as i64)],
            waits.iter().map(|s| s.id.get()).collect(),
        ));
    }
    // batching_delay, on critical paths.
    let path_ids: HashSet<i64> = d.paths.iter().flat_map(|p| p.segments.iter()).filter_map(|s| s.span_id.map(|i| i.get())).collect();
    let batching: Vec<&Span> = d.spans.iter().filter(|s| s.kind == SpanKind::AskBatching && path_ids.contains(&s.id.get())).collect();
    let bt: i64 = batching.iter().map(|s| dur(s)).sum();
    if bt >= 5 * MIN {
        out.push((
            "batching_delay".into(),
            format!("asks sat {} in batches before you saw them", fmt(bt)),
            vec![("totalMs".into(), bt)],
            batching.iter().map(|s| s.id.get()).collect(),
        ));
    }
    // slots_full (fleet lane)
    let full: Vec<&Span> = d.spans.iter().filter(|s| s.kind == SpanKind::SlotsFull).collect();
    if !full.is_empty() {
        let ft: i64 = full.iter().map(|s| dur(s)).sum();
        let peak = full.iter().filter_map(|s| s.extra.as_ref().and_then(|e| e.peak_queued).map(|p| p.get())).max().unwrap_or(0);
        out.push((
            "slots_full".into(),
            format!("slots were full for {} while {peak} tasks queued (cap 40)", fmt(ft)),
            vec![("totalMs".into(), ft), ("peakQueued".into(), peak)],
            full.iter().map(|s| s.id.get()).chain(d.spans.iter().filter(|s| s.kind == SpanKind::QueueSlot).map(|s| s.id.get())).take(200).collect(),
        ));
    }
    // slow_commands: the top one.
    let b = breakdown_json(d);
    if let Some(c) = b["topCommands"].as_array().and_then(|a| a.first()) {
        let label = c["label"].as_str().unwrap_or("").to_string();
        let ids: Vec<i64> =
            d.spans.iter().filter(|s| is_cmd(s) && s.label.as_deref() == Some(label.as_str())).map(|s| s.id.get()).take(200).collect();
        out.push((
            "slow_commands".into(),
            format!("`{label}`: {}×, {}, median {}", c["n"], fmt(c["totalMs"].as_i64().unwrap_or(0)), fmt(c["p50Ms"].as_i64().unwrap_or(0))),
            vec![("runs".into(), c["n"].as_i64().unwrap_or(0)), ("totalMs".into(), c["totalMs"].as_i64().unwrap_or(0))],
            ids,
        ));
    }
    // startup
    let mut startups: Vec<i64> = d.spans.iter().filter(|s| s.kind == SpanKind::RunStartup).map(dur).collect();
    let n = startups.len();
    let p50 = median(&mut startups);
    if p50 >= 5_000 {
        out.push((
            "startup".into(),
            format!("starting claude took {} per run ({n} runs)", fmt(p50)),
            vec![("p50Ms".into(), p50), ("runs".into(), n as i64)],
            d.spans.iter().filter(|s| s.kind == SpanKind::RunStartup).map(|s| s.id.get()).take(200).collect(),
        ));
    }
    if !d.gaps.is_empty() {
        out.push((
            "coverage".into(),
            "timeline incomplete for 1 session (buildbox runs a fleetd older than the hub)".into(),
            vec![("sessions".into(), 1)],
            Vec::new(),
        ));
    }
    out
}

fn insights_json(now: &Data, before: Option<&Data>, fleet: bool) -> Value {
    let cur = findings(now, fleet);
    let prev = before.map(|b| findings(b, fleet));
    let mut list: Vec<Value> = Vec::new();
    let nums = |n: &[(String, i64)]| n.iter().map(|(k, v)| json!({ "name": k, "value": v })).collect::<Vec<_>>();
    for (rule, msg, numbers, ids) in &cur {
        let mut v = json!({ "rule": rule, "message": msg, "numbers": nums(numbers), "spanIds": ids.iter().take(200).collect::<Vec<_>>() });
        if let Some(prev) = &prev {
            let p = prev.iter().find(|p| &p.0 == rule);
            v["compare"] = json!(p.map_or_else(|| nums(&numbers.iter().map(|(k, _)| (k.clone(), 0)).collect::<Vec<_>>()), |p| nums(&p.2)));
            v["firedIn"] = json!(if p.is_some() { "both" } else { "current" });
        }
        list.push(v);
    }
    if let Some(prev) = &prev {
        for (rule, msg, numbers, _) in prev.iter().filter(|p| !cur.iter().any(|c| c.0 == p.0)) {
            list.push(json!({ "rule": rule, "message": msg, "numbers": nums(&numbers.iter().map(|(k, _)| (k.clone(), 0)).collect::<Vec<_>>()),
                "spanIds": [], "compare": nums(numbers), "firedIn": "compare" }));
        }
    }
    json!({ "insights": list })
}

// ---- answers ---------------------------------------------------------------------------------

struct Filter {
    project: Option<String>,
    machine: Option<String>,
    role: Option<AgentRole>,
}

fn collect(specs: &[OrderSpec], only: Option<&str>, f: &Filter) -> (Data, HashMap<String, AgentRole>) {
    let mut spans = Vec::new();
    let mut paths = Vec::new();
    let mut wall = 0;
    let mut roles = HashMap::new();
    for spec in specs {
        if only.is_some_and(|w| w != spec.id.as_str()) {
            continue;
        }
        let b = build_order(spec);
        if f.project.as_deref().is_some_and(|p| p != b.project) || f.machine.as_deref().is_some_and(|m| m != b.machine) {
            continue;
        }
        wall += b.wall.1 - b.wall.0;
        roles.extend(b.roles.clone());
        for v in b.spans {
            let s: Span = from(v);
            let role = s.thread_id.as_ref().and_then(|t| b.roles.get(t.as_str()).copied());
            if f.role.is_some_and(|want| role != Some(want)) {
                continue;
            }
            spans.push(s);
        }
        paths.push(from::<CriticalPath>(b.path));
    }
    (Data { spans, paths, wall, gaps: Vec::new() }, roles)
}

/// Fills `state.time` with what the hub would answer to its open query.
pub fn answer(state: &mut State) {
    let Some(q) = state.time.query.clone() else { return };
    let tf = &q.breakdown.filters;
    let mut f = Filter { project: None, machine: tf.machine_id.as_ref().map(|m| m.to_string()), role: tf.role };
    let order = match &q.scope {
        TimeScope::Order { workstream_id } => Some(workstream_id.to_string()),
        TimeScope::Project { project_ref } => {
            f.project = Some(project_ref.project_id.to_string());
            None
        }
        TimeScope::Machine { machine_id } => {
            f.machine = Some(machine_id.to_string());
            None
        }
        _ => None,
    };
    // Any order the bench opens gets W8's shape; the timeline is the point, not which order it is.
    let mut specs = week();
    if let Some(w) = order.as_ref().filter(|w| !specs.iter().any(|s| &s.id == *w)) {
        specs = vec![OrderSpec { id: w.clone(), ..specs[0].clone() }];
    }
    let (mut now, _) = collect(&specs, order.as_deref(), &f);
    let fleet = order.is_none();
    if fleet {
        add_fleet_lane(&mut now);
        if f.project.is_none() {
            now.gaps.push(json!({ "why": "node_older", "machineId": "buildbox", "fromMs": at("2026-10-16T16:20:00.000Z"), "toMs": at("2026-10-16T18:02:00.000Z") }));
        }
    }
    let prev = (q.breakdown.compare.is_some() && fleet).then(|| {
        let older: Vec<OrderSpec> = specs.iter().map(before).collect();
        collect(&older, None, &f).0
    });
    let mut b = breakdown_json(&now);
    if let (Some(p), Some(prev)) = (&q.breakdown.compare, &prev) {
        let pb = breakdown_json(prev);
        b["compare"] =
            json!({ "since": p.since, "until": p.until, "wallMs": pb["wallMs"], "agentMs": pb["agentMs"], "byCategory": pb["byCategory"] });
    }
    if let (Some(_), Some(path)) = (&order, now.paths.first()) {
        b["criticalPath"] = serde_json::to_value(path).unwrap();
    }
    let t = &mut state.time;
    t.breakdown = Some(Ok(from::<TimeBreakdownOutput>(b)));
    t.insights = Some(Ok(from::<TimeInsightsOutput>(insights_json(&now, prev.as_ref(), fleet))));
    if q.spans {
        let mut spans = now.spans;
        spans.sort_by_key(|s| s.id.get());
        t.spans = spans;
    }
    t.spans_done = true;
    t.version += 1;
}

/// Slot saturation on the fleet lane: the cap was hit three times in the week.
fn add_fleet_lane(d: &mut Data) {
    for (n, (a, mins)) in [("2026-10-13T09:40:00.000Z", 18), ("2026-10-16T16:25:00.000Z", 12), ("2026-10-18T08:12:00.000Z", 10)].iter().enumerate() {
        let start = at(a);
        d.spans.push(from(json!({ "id": 9_000_000 + n, "kind": "slots.full", "cat": "queue", "lane": "fleet", "startMs": start,
            "endMs": start + mins * MIN, "status": "ok", "extra": { "peakQueued": 3 - n.min(1), "cap": 40 } })));
    }
}

/// The spans a finding or a row links to.
pub fn answer_linked(state: &mut State) {
    let Some((linked, _)) = state.time.linked.clone() else { return };
    let ids: Option<HashSet<i64>> = linked.rule.and_then(|rule| {
        let ins = state.time.insights.as_ref()?.as_ref().ok()?;
        let i = ins.insights.iter().find(|i| i.rule == rule)?;
        Some(i.span_ids.iter().map(|s| s.get()).collect())
    });
    let (mut d, _) = collect(&week(), None, &Filter { project: None, machine: None, role: None });
    add_fleet_lane(&mut d);
    let spans: Vec<Span> = d
        .spans
        .into_iter()
        .filter(|s| ids.as_ref().is_none_or(|ids| ids.contains(&s.id.get()) || linked.label.is_some()))
        .filter(|s| linked.keeps(s))
        .take(500)
        .collect();
    if let Some((_, slot)) = state.time.linked.as_mut() {
        *slot = Some(Ok(spans));
    }
    state.time.version += 1;
}

/// The transcript around a clicked span: its lane's messages and calls, as `thread_window` returns them.
pub fn answer_window(state: &mut State) {
    let Some(((_, thread, item), _)) = state.time.window.clone() else { return };
    let (d, _) = collect(&week(), None, &Filter { project: None, machine: None, role: None });
    let mut lane: Vec<&Span> = d
        .spans
        .iter()
        .filter(|s| s.thread_id.as_deref() == Some(thread.as_str()) && s.item_id.is_some())
        .filter(|s| s.kind != SpanKind::ToolsParallel)
        .collect();
    lane.sort_by_key(|s| s.start_ms.get());
    let focus = lane.iter().position(|s| s.item_id.as_deref() == Some(item.as_str()));
    let (from_ix, to_ix) = focus.map_or((0, 0), |f| (f.saturating_sub(10), (f + 11).min(lane.len())));
    let says = [
        "Reading the page and its test before touching the layout.",
        "The pricing table renders twice in the test; checking the fixture.",
        "Running the tests again to see if that fixed it.",
        "Edited the section heading; the test expects the old copy, updating it.",
        "Build passes. Reporting progress to the lead.",
    ];
    let items: Vec<Value> = lane[from_ix..to_ix]
        .iter()
        .enumerate()
        .map(|(n, s)| {
            let iso = fmt_iso(s.start_ms.get());
            if s.kind == SpanKind::ModelMessage {
                return json!({ "kind": "message", "at": iso, "role": "assistant", "text": says[(s.id.get() as usize + n) % says.len()] });
            }
            let failed = s.status == SpanStatus::Failed;
            let kind = match s.kind {
                SpanKind::ToolBash | SpanKind::Git => "command",
                SpanKind::ToolEdit => "file_change",
                _ => "tool_call",
            };
            let tail = match (s.label.as_deref(), failed) {
                (Some("npm test"), true) => Some("FAIL src/pages/pricing.test.tsx\n  ● PricingTable › renders each plan once\n    Expected 3 rows, received 6\nTests: 1 failed, 141 passed, 142 total\nExit code 1"),
                (Some("npm test"), false) => Some("PASS src/pages/about.test.tsx\nPASS src/pages/pricing.test.tsx\nTests: 142 passed, 142 total\nTime: 128.4 s"),
                (Some("npm run build"), _) => Some("vite v6.2.0 building for production...\n✓ 412 modules transformed.\ndist/index.html 0.61 kB\n✓ built in 81.20s"),
                _ => None,
            };
            json!({ "kind": "action", "at": iso, "action": { "at": iso, "kind": kind, "status": if failed { "failed" } else { "completed" },
                "summary": s.label.as_deref().map_or_else(|| super::kind_word(s.kind).to_string(), str::to_string), "outputTail": tail,
                "exitCode": s.exit_code, "failed": failed } })
        })
        .collect();
    let out = json!({ "items": items, "focus": focus.map(|f| f - from_ix) });
    if let Some((_, slot)) = state.time.window.as_mut() {
        *slot = Some(Ok(from::<ThreadWindowOutput>(out)));
    }
    state.time.version += 1;
}

/// Settings → Data.
pub fn answer_store(state: &mut State) {
    state.time.store = Some(Ok((30, 41_900_000)));
    state.time.version += 1;
}

/// W8 and its lanes as the live board lists them, so the timeline names lanes by role and task.
pub fn order_card() -> Value {
    let lane = |k: i64, role: &str, title: &str| {
        json!({ "laneId": format!("T{}", 20 + k), "role": role, "taskId": format!("T{}", 20 + k),
            "threadRef": { "machineId": "devbox", "threadId": format!("s-{}", 20 + k) }, "title": title, "model": "claude-sonnet-5-5",
            "status": "done", "startedAt": "2026-10-18T08:13:00.000Z", "endedAt": "2026-10-18T09:30:00.000Z" })
    };
    json!({ "workstreamId": ORDER, "projectRef": { "machineId": "devbox", "projectId": "storefront" }, "title": "Add three short pages",
        "state": "done", "template": "feature", "phase": "done", "needsYou": 0, "lanes": [lane(1, "implementer", "about page"), lane(2, "implementer", "pricing page"), lane(3, "implementer", "contact page"),
            lane(5, "reviewer", "review #205")],
        "prs": [{ "changeId": "X7", "repo": "acme/storefront", "number": 205, "url": "https://github.com/acme/storefront/pull/205", "state": "merged",
            "reviewsDone": 1, "reviewsNeeded": 1 }],
        "settled": 4, "total": 4, "createdAt": "2026-10-18T08:10:00.000Z", "updatedAt": "2026-10-18T09:52:00.000Z" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fixture_order_tiles_its_lanes_and_its_path_adds_up_to_its_wall() {
        let b = build_order(&week()[0]);
        let path: CriticalPath = from(b.path);
        let sum: i64 = path.segments.iter().map(|s| s.end_ms.get() - s.start_ms.get()).sum();
        assert_eq!(sum, path.end_ms.get() - path.start_ms.get());
        let spans: Vec<Span> = b.spans.into_iter().map(from).collect();
        // Each agent lane's leaves (excl time) cover its runs with no overlap.
        let mut by_lane: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
        for s in spans.iter().filter(|s| s.excl_ms.is_some() && s.lane.starts_with("thread:")) {
            by_lane.entry(s.lane.to_string()).or_default().push((s.start_ms.get(), s.end_ms.unwrap().get()));
        }
        for (lane, mut iv) in by_lane {
            iv.sort();
            for w in iv.windows(2) {
                assert!(w[0].1 <= w[1].0, "{lane}: {w:?} overlap");
            }
        }
    }
}
