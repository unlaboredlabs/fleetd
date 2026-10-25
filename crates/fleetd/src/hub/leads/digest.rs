//! The lead digest: the code-rendered project state at the top of a lead's first message and every wake (the event
//! lines follow it, `events`). It is the lead's real memory, so it must stay small (DIGEST_MAX_CHARS) and say plainly
//! what was left out. A fixed format, not a prompt.
use std::collections::{HashMap, HashSet};

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::{
    Decision, DecisionScope, DoneWhen, HumanRequest, Workstream, WorkstreamId, WorkstreamState,
};
use fleetd_contracts::prim::js_len;

use super::events::AgentsLine;

/// About 1,500 tokens: ids, keys and paths run near 3 characters a token.
pub const DIGEST_MAX_CHARS: usize = 4500;
/// Decisions listed by full value; the rest only appear by key under "do not re-ask".
pub const DIGEST_DECISIONS: usize = 10;

/// What backs a workstream's status beyond the lead's word.
#[derive(Debug, Clone, Default)]
pub struct WorkstreamFacts {
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
    /// Work on the project's repo and base that isn't its own: claims, other projects' writers and Changes, and
    /// recent landings outside the train. None leaves the section out.
    pub elsewhere: Option<Vec<String>>,
    pub facts: &'a HashMap<WorkstreamId, WorkstreamFacts>,
}

/// Whitespace runs collapsed, trimmed, and cut to `max` with "…".
pub fn one_line(text: &str, max: usize) -> String {
    clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), max)
}

/// `text` cut to `max` UTF-16 units, the last one "…": the contracts' text limits count in those.
pub fn clip(text: &str, max: usize) -> String {
    if js_len(text) <= max {
        return text.to_string();
    }
    let mut used = 0;
    let mut out: String = text
        .chars()
        .take_while(|c| {
            used += c.len_utf16();
            used < max
        })
        .collect();
    out.push('…');
    out
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

/// The done-when lines as `done:<n> <line>`.
pub fn done_when_text(lines: &[DoneWhen], max: usize) -> String {
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| format!("done:{i} {}", one_line(line.as_ref(), max)))
        .collect::<Vec<_>>()
        .join("; ")
}

fn workstream_lines(w: &Workstream, facts: Option<&WorkstreamFacts>) -> String {
    let head = format!(
        "- {} {}: {}",
        w.workstream_id,
        state_text(w.state),
        one_line(&w.title, 120)
    );
    let Some(brief) = &w.brief else {
        return format!(
            "{head}\n  no brief yet: register it with `brief` {{workstreamId: \"{}\"}}",
            w.workstream_id
        );
    };
    let steers = facts
        .and_then(|f| f.steers.as_ref())
        .map(|s| format!("\n  steers: {s}"))
        .unwrap_or_default();
    let plan = facts
        .and_then(|f| f.plan.as_ref())
        .map(|p| format!("\n  {p}"))
        .unwrap_or_default();
    format!(
        "{head}\n  done when: {}{plan}{steers}",
        done_when_text(&brief.done_when, 120)
    )
}

pub fn state_text(state: WorkstreamState) -> &'static str {
    match state {
        WorkstreamState::Open => "open",
        WorkstreamState::Done => "done",
        WorkstreamState::Stopped => "stopped",
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

/// A unit enum's wire name, e.g. `WorkstreamState::Open` → "open".
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
const ELSEWHERE: usize = 3;
const REQUESTS: usize = 4;
const DECISIONS: usize = 5;
const DO_NOT_RE_ASK: usize = 6;

pub fn render_lead_digest(input: &DigestInput) -> String {
    let open: HashSet<&WorkstreamId> = input.workstreams.iter().map(|w| &w.workstream_id).collect();
    let ranked = rank_decisions(input.decisions, &open);
    let mut keys: Vec<String> = Vec::new();
    for key in ranked.iter().map(|d| d.key.to_string()) {
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
    if let Some(agents) = &input.agents {
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
            "`agents`",
            "\n",
        ),
        Section::new(
            "Merge train",
            input.train.clone().unwrap_or_default(),
            12,
            "older ones not shown",
            "\n",
        ),
        Section::new(
            "Elsewhere",
            input.elsewhere.clone().unwrap_or_default(),
            8,
            crate::hub::work::elsewhere::CUT_FIRST,
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
    if input.elsewhere.is_some() {
        shown.push(ELSEWHERE);
    }
    shown.extend([REQUESTS, DECISIONS, DO_NOT_RE_ASK]);

    let render = |sections: &[Section]| {
        let parts: Vec<String> = shown.iter().map(|&i| sections[i].render()).collect();
        format!("{head}\n\n{}", parts.join("\n\n"))
    };
    // Lowest value first: the key list, then decisions, work elsewhere, requests, agents, the train, and the work last.
    // The first pass keeps a few of each so no section vanishes while another is long; the second trims to nothing if
    // it must.
    let drop_order: [(usize, usize); 7] = [
        (DO_NOT_RE_ASK, 30),
        (DECISIONS, 3),
        (ELSEWHERE, 3),
        (REQUESTS, 5),
        (TASKS, 5),
        (TRAIN, 4),
        (WORKSTREAMS, 5),
    ];
    let mut text = render(&sections);
    for pass in [1, 0] {
        for (section, floor) in drop_order {
            while text.chars().count() > DIGEST_MAX_CHARS
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_digest_stays_under_the_cap_and_says_what_it_left_out() {
        let project_ref: ProjectRef =
            serde_json::from_value(serde_json::json!({ "machineId": "lab-a", "projectId": "p1" }))
                .unwrap();
        let decisions: Vec<Decision> = (1..=300)
            .map(|n| {
                serde_json::from_value(serde_json::json!({
                    "decisionId": format!("D{n}"), "key": format!("style.rule_{n}"),
                    "scope": { "kind": "global" }, "value": "x".repeat(150), "source": "human",
                    "state": "active", "at": "2026-10-19T10:00:00.000Z",
                }))
                .unwrap()
            })
            .collect();
        let text = render_lead_digest(&DigestInput {
            project_ref: &project_ref,
            title: "app",
            at: "2026-10-19T10:00:00.000Z",
            workstreams: &[],
            open_requests: &[],
            decisions: &decisions,
            agents: None,
            tasks: None,
            train: None,
            elsewhere: None,
            facts: &HashMap::new(),
        });
        assert!(text.chars().count() <= DIGEST_MAX_CHARS, "{}", text.len());
        assert!(text.contains("more: `decisions_search`)"), "{text}");
        assert!(
            text.contains("more: check with `decisions_search`)"),
            "{text}"
        );
    }

    #[test]
    fn clips_within_the_contracts_utf16_limit() {
        assert_eq!(clip("short", 10), "short");
        let clipped = clip(&"🙂".repeat(150), 200);
        assert_eq!(js_len(&clipped), 199);
        assert!(clipped.ends_with("🙂…"));
    }
}
