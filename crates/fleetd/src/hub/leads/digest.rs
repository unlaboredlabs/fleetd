//! The lead digest: the code-rendered project state at the top of a lead's first message and every wake (the event
//! lines follow it, `events`). It is the lead's real memory, so it must stay small (DIGEST_MAX_TOKENS) and say plainly
//! what was left out. A fixed format, not a prompt.
use std::collections::{HashMap, HashSet};

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::{
    CheckSpec, Decision, DecisionScope, HumanRequest, Workstream, WorkstreamId, WorkstreamState,
};

use super::events::AgentsLine;
use crate::hub::playbooks::finish_all_rules::is_finish_all;

pub const DIGEST_MAX_TOKENS: usize = 1500;
/// Decisions listed by full value; the rest only appear by key under "do not re-ask".
pub const DIGEST_DECISIONS: usize = 10;

/// Conservative token estimate: ~3 characters per token. English prose runs nearer 4, but keys, ids and paths
/// tokenize worse, and overshooting the budget is the failure that matters.
pub fn estimate_tokens(text: &str) -> usize {
    utf16_len(text).div_ceil(3)
}

/// JS string length, which older hubs measured in.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// What backs a workstream's status beyond the lead's word: the checks its latest claim passed and its ETA.
#[derive(Debug, Clone, Default)]
pub struct WorkstreamFacts {
    /// Check indexes the latest finished claim passed.
    pub passed: HashSet<usize>,
    /// The human's latest direct steers to its tasks and whether each was acknowledged.
    pub steers: Option<String>,
    /// "plan: 5/8 items, 62%" when the order has plan items.
    pub plan: Option<String>,
}

pub struct DigestInput<'a> {
    pub project_ref: &'a ProjectRef,
    pub title: &'a str,
    pub at: &'a str,
    /// Open workstreams, newest first.
    pub workstreams: &'a [Workstream],
    /// The project's open secret and approval requests: what waits on the person in chat.
    pub open_requests: &'a [HumanRequest],
    /// Active decisions along the project's scope chain, any order.
    pub decisions: &'a [Decision],
    /// The agents line; None leaves it out.
    pub agents: Option<AgentsLine>,
    /// Lines from the tasks area; None leaves the section out.
    pub tasks: Option<Vec<String>>,
    /// Lines from the merge train; None leaves the section out.
    pub train: Option<Vec<String>>,
    pub facts: &'a HashMap<WorkstreamId, WorkstreamFacts>,
}

/// Whitespace runs collapsed, trimmed, and cut to `max` with "…".
pub fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    clip_utf16(&flat, max)
}

/// `flat.length > max ? flat.slice(0, max - 1) + "…" : flat`, in UTF-16 units as older hubs counted.
pub fn clip_utf16(flat: &str, max: usize) -> String {
    if utf16_len(flat) <= max {
        return flat.to_string();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in flat.chars() {
        if used + c.len_utf16() > max.saturating_sub(1) {
            break;
        }
        used += c.len_utf16();
        out.push(c);
    }
    out.push('…');
    out
}

pub fn describe_check(check: &CheckSpec) -> String {
    match check {
        CheckSpec::PrMerged { repo, pr } => {
            format!(
                "PR {}merged in {repo}",
                pr.map(|p| format!("#{p} ")).unwrap_or_default()
            )
        }
        CheckSpec::CiGreen { repo, r#ref } => {
            format!(
                "CI green on {repo}{}",
                r#ref.as_ref().map(|r| format!("@{r}")).unwrap_or_default()
            )
        }
        CheckSpec::Http {
            url,
            status,
            contains,
        } => format!(
            "GET {url} → {status}{}",
            contains
                .as_ref()
                .map(|c| format!(" containing \"{c}\""))
                .unwrap_or_default()
        ),
        CheckSpec::Cmd {
            machine_id,
            argv,
            expect_exit,
        } => {
            format!("on {machine_id}: `{}` exits {expect_exit}", argv.join(" "))
        }
        CheckSpec::Test { repo, test_id } => format!("test {test_id} passes in {repo}"),
        CheckSpec::Judge { criteria } => format!("judge: {criteria}"),
        CheckSpec::Human { question } => format!("human confirms: {question}"),
    }
}

fn scope_label(d: &Decision) -> String {
    match &d.scope {
        DecisionScope::Workstream { workstream_id } => workstream_id.to_string(),
        DecisionScope::Project { .. } => "project".into(),
        DecisionScope::Global => "global".into(),
    }
}

/// Open workstreams' own decisions first, then the project's, then global ones; newest first within each.
pub fn rank_decisions<'a>(
    decisions: &'a [Decision],
    open: &HashSet<&WorkstreamId>,
) -> Vec<&'a Decision> {
    let rank = |d: &Decision| match &d.scope {
        DecisionScope::Workstream { workstream_id } => {
            if open.contains(workstream_id) {
                0
            } else {
                3
            }
        }
        DecisionScope::Project { .. } => 1,
        DecisionScope::Global => 2,
    };
    let mut ranked: Vec<&Decision> = decisions.iter().collect();
    ranked.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then_with(|| b.at.as_str().cmp(a.at.as_str()))
    });
    ranked
}

/// The done-when list as `done:<n>`, the index `--serves` and claims use; ✓ only where fleetd's own check passed.
pub fn done_when_text(checks: &[CheckSpec], passed: Option<&HashSet<usize>>, max: usize) -> String {
    checks
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let tick = if passed.is_some_and(|p| p.contains(&i)) {
                " ✓"
            } else {
                ""
            };
            format!("done:{i}{tick} {}", one_line(&describe_check(c), max))
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn workstream_lines(w: &Workstream, facts: Option<&WorkstreamFacts>) -> String {
    let playbook = w.playbook.as_ref().map(|p| {
        p.as_str()
            .split_once('@')
            .map_or(p.as_str(), |(name, _)| name)
    });
    let child = w
        .parent
        .as_ref()
        .map(|p| {
            format!(
                ", child of {} for {}",
                p.workstream_id,
                one_line(p.serves.as_ref(), 80)
            )
        })
        .unwrap_or_default();
    let tag = if playbook.is_none() && child.is_empty() {
        String::new()
    } else {
        format!(" ({}{child})", playbook.unwrap_or("no playbook"))
    };
    let head = format!(
        "- {} {}{tag}: {}",
        w.workstream_id,
        state_text(w.state),
        one_line(&w.title, 120)
    );
    if w.state == WorkstreamState::Idle && is_finish_all(w) {
        return format!(
            "{head}\n  finish-all: nothing left with a value source; `inventory` again only when something new comes in"
        );
    }
    let Some(brief) = &w.brief else {
        return format!(
            "{head}\n  no brief yet: register it with `brief` {{workstreamId: \"{}\"}}",
            w.workstream_id
        );
    };
    let status = w
        .headline
        .as_ref()
        .map(|h| format!("\n  lead says: {}", one_line(h.as_ref(), 200)))
        .unwrap_or_default();
    let steers = facts
        .and_then(|f| f.steers.as_ref())
        .map(|s| format!("\n  steers: {s}"))
        .unwrap_or_default();
    let plan = facts
        .and_then(|f| f.plan.as_ref())
        .map(|p| format!("\n  {p}"))
        .unwrap_or_default();
    format!(
        "{head}{status}\n  done when: {}{plan}{steers}",
        done_when_text(&brief.done_when, facts.map(|f| &f.passed), 120)
    )
}

pub fn state_text(state: WorkstreamState) -> &'static str {
    match state {
        WorkstreamState::Draft => "draft",
        WorkstreamState::Running => "running",
        WorkstreamState::Converging => "converging",
        WorkstreamState::Verifying => "verifying",
        WorkstreamState::Done => "done",
        WorkstreamState::Idle => "idle",
        WorkstreamState::Stopped => "stopped",
        WorkstreamState::Failed => "failed",
    }
}

fn request_line(r: &HumanRequest) -> String {
    let what = match (&r.secret, &r.gated, &r.permission) {
        (Some(s), _, _) => format!("secret {} to enter", s.key),
        (_, Some(g), _) => format!("approve your command: {}", one_line(g.reason.as_str(), 120)),
        (_, _, Some(p)) => format!(
            "approve a tool prompt: {} {}",
            p.tool_name,
            one_line(p.summary.as_str(), 120)
        ),
        _ => one_line(r.text.as_str(), 120),
    };
    let again = r
        .evidence
        .as_ref()
        .map(|e| format!(" (open again: {})", one_line(e.as_str(), 160)))
        .unwrap_or_default();
    format!("- {} {what}{again}", r.request_id)
}

fn decision_line(d: &Decision) -> String {
    format!(
        "- {} {} = {} ({}, {})",
        d.decision_id,
        d.key,
        one_line(d.value.as_ref(), 200),
        scope_label(d),
        serde_plain(&d.source)
    )
}

/// A unit enum's wire name, e.g. `WorkstreamState::Running` → "running".
pub fn serde_plain<T: serde::Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        _ => String::new(),
    }
}

struct Section {
    title: &'static str,
    items: Vec<String>,
    /// Items left out, on top of any trimmed to fit.
    omitted: usize,
    more: &'static str,
    join: &'static str,
}

impl Section {
    fn new(
        title: &'static str,
        items: Vec<String>,
        max: usize,
        more: &'static str,
        join: &'static str,
    ) -> Self {
        let omitted = items.len().saturating_sub(max);
        let mut items = items;
        items.truncate(max);
        Section {
            title,
            items,
            omitted,
            more,
            join,
        }
    }

    fn render(&self) -> String {
        let body = if self.items.is_empty() && self.omitted == 0 {
            "none".to_string()
        } else {
            self.items.join(self.join)
        };
        let more = if self.omitted == 0 {
            String::new()
        } else {
            format!(
                "{}(+{} more: {})",
                if self.items.is_empty() { "" } else { self.join },
                self.omitted,
                self.more
            )
        };
        format!("## {}\n{body}{more}", self.title)
    }
}

// Section indexes, in render order.
const WORKSTREAMS: usize = 0;
const TASKS: usize = 1;
const TRAIN: usize = 2;
const REQUESTS: usize = 3;
const DECISIONS: usize = 4;
const DO_NOT_RE_ASK: usize = 5;

pub fn render_lead_digest(input: &DigestInput) -> String {
    let open: HashSet<&WorkstreamId> = input.workstreams.iter().map(|w| &w.workstream_id).collect();
    let ranked = rank_decisions(input.decisions, &open);
    let mut keys: Vec<String> = Vec::new();
    for key in ranked
        .iter()
        .map(|d| d.key.to_string())
    {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }

    let mut head = format!(
        "# project {} ({}/{}), {}",
        one_line(input.title, 80),
        input.project_ref.machine_id,
        input.project_ref.project_id,
        input.at
    );
    if let Some(agents) = input.agents {
        head.push_str(&format!("\n{agents}"));
    }

    let mut sections = vec![
        Section::new(
            "Work",
            input
                .workstreams
                .iter()
                .map(|w| workstream_lines(w, input.facts.get(&w.workstream_id)))
                .collect(),
            20,
            "older ones not shown",
            "\n",
        ),
        Section::new(
            "Agents",
            input.tasks.clone().unwrap_or_default(),
            20,
            "`list_agents`",
            "\n",
        ),
        Section::new(
            "Merge train",
            input.train.clone().unwrap_or_default(),
            12,
            "`change_status`",
            "\n",
        ),
        Section::new(
            "Waiting on the person (in chat)",
            input.open_requests.iter().map(request_line).collect(),
            20,
            "older ones not shown",
            "\n",
        ),
        Section::new(
            "Decisions",
            ranked.iter().map(|d| decision_line(d)).collect(),
            DIGEST_DECISIONS,
            "`decisions_search`",
            "\n",
        ),
        Section::new(
            "Decided already: never ask again",
            keys,
            200,
            "check with `decisions_search`",
            ", ",
        ),
    ];

    let mut shown: Vec<usize> = vec![WORKSTREAMS];
    if input.tasks.is_some() {
        shown.push(TASKS);
    }
    if input.train.is_some() {
        shown.push(TRAIN);
    }
    shown.extend([REQUESTS, DECISIONS, DO_NOT_RE_ASK]);

    let render = |sections: &[Section]| {
        let parts: Vec<String> = shown.iter().map(|&i| sections[i].render()).collect();
        format!("{head}\n\n{}", parts.join("\n\n"))
    };
    // Lowest value first: the key list, then decisions, requests, agents, the train, and the work last. The first pass
    // keeps a few of each so no section vanishes while another is long; the second trims to nothing if it must.
    let drop_order: [(usize, usize); 6] = [
        (DO_NOT_RE_ASK, 30),
        (DECISIONS, 3),
        (REQUESTS, 5),
        (TASKS, 5),
        (TRAIN, 4),
        (WORKSTREAMS, 5),
    ];
    let mut text = render(&sections);
    for pass in [1, 0] {
        for (section, floor) in drop_order {
            while estimate_tokens(&text) > DIGEST_MAX_TOKENS
                && sections[section].items.len() > floor * pass
            {
                sections[section].items.pop();
                sections[section].omitted += 1;
                text = render(&sections);
            }
        }
    }
    text
}
