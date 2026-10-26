//! Every text fleetd gives a model, each editable, with its shipped text, the placeholders the code fills in and the
//! safety rules the text carries. The shipped texts are `assets/prompts/<id>.md`. What the code fills in is facts:
//! event lines (`leads::events`), the state block (`leads::digest`), ids, names and reasons. Tool descriptions and
//! results are tied to their tools (the Agent tools page). Prompts a release retired are `retired`.
use fleetd_contracts::prompts::{Enforcement, Placeholder, PromptGroup, PromptKind, SafetyRule};

/// Which sessions pin an entry at their start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Audience {
    Lead,
    Task,
    /// Any thread: leads, tasks, and threads an outside agent launched.
    Any,
    /// Pinned by no session: the custom instructions, appended to the others.
    None,
}

pub struct Entry {
    pub id: &'static str,
    pub title: &'static str,
    pub kind: PromptKind,
    pub group: PromptGroup,
    pub audience: Audience,
    pub sent_when: &'static str,
    pub default: &'static str,
    /// `name=description; …`, a `!` after the name marks it required.
    placeholders: &'static str,
    rules: &'static [(&'static str, &'static str, &'static str, Enforcement)],
}

impl Entry {
    pub fn per_project(&self) -> bool {
        !matches!(self.kind, PromptKind::Oneshot)
    }

    pub fn placeholders(&self) -> Vec<Placeholder> {
        self.placeholders
            .split(';')
            .filter_map(|p| {
                let (name, description) = p.trim().split_once('=')?;
                let required = name.ends_with('!');
                Some(Placeholder {
                    name: name.trim_end_matches('!').to_owned(),
                    required,
                    description: description.trim().to_owned(),
                })
            })
            .collect()
    }

    pub fn safety_rules(&self) -> Vec<SafetyRule> {
        self.rules
            .iter()
            .map(|(id, label, needle, enforced)| SafetyRule {
                id: (*id).to_owned(),
                label: (*label).to_owned(),
                needle: (*needle).to_owned(),
                enforced: *enforced,
                present: None,
            })
            .collect()
    }

    /// Past this many characters an edit gets a `too_long` warning.
    pub fn budget(&self) -> usize {
        self.default.chars().count() * 3 + 500
    }
}

macro_rules! asset {
    ($id:literal) => {
        include_str!(concat!("../../../assets/prompts/", $id, ".md"))
    };
}

use Audience::{Any, Lead, Task};
use Enforcement::{Code, Prompt};
use PromptGroup as G;
use PromptKind as K;

macro_rules! entry {
    ($id:literal, $kind:ident, $group:ident, $aud:expr, $title:literal, $when:literal, $ph:expr, $rules:expr) => {
        Entry {
            id: $id,
            title: $title,
            kind: K::$kind,
            group: G::$group,
            audience: $aud,
            sent_when: $when,
            default: asset!($id),
            placeholders: $ph,
            rules: $rules,
        }
    };
}

const VERDICT: (&str, &str, &str, Enforcement) = (
    "one-verdict",
    "ends with one review verdict (the `report` tool)",
    r"`report` tool",
    Code,
);
const READ_ONLY: (&str, &str, &str, Enforcement) = (
    "read-only",
    "changes no files",
    r"do not change, commit or push",
    Prompt,
);

// `train-only-merges` is a prompt rule: the hub only sees a merge outside the train after the fact (`pr.merged_outside`).
pub const ENTRIES: &[Entry] = &[
    entry!(
        "lead.start",
        Start,
        Lead,
        Lead,
        "Lead",
        "lead start and every fresh lead start, followed by the state block",
        "project!=the project's title; projectRef!=<machineId>/<projectId>",
        &[
            (
                "never-write-code",
                "the lead never writes code",
                r"never write code",
                Prompt
            ),
            (
                "ask-big-calls",
                "asks the human only for product, money or irreversible calls",
                r"product, money or irreversible calls",
                Prompt
            ),
            (
                "numbered-with-rec",
                "asks as numbered items, each with a recommendation",
                r"Rec|recommend",
                Prompt
            ),
            (
                "speak-when-it-matters",
                "writes only for results, problems and the human's decisions; silent on steps along the way",
                r"Stay silent on steps along the way",
                Prompt
            ),
            (
                "one-message-per-change",
                "one short message per real change, outcome first",
                r"One short message per real change, outcome first",
                Prompt
            ),
            (
                "no-status-only",
                "never posts a status-only or \"nothing needs you\" message; a turn with nothing to say replies `(quiet)`, which fleetd never posts",
                r"Never post a status-only message",
                Prompt
            ),
            (
                "plain-words",
                "no fleetd ids, tool names, paths or process words unless asked",
                r"No tool names, file paths",
                Prompt
            ),
            (
                "no-time",
                "never estimates time",
                r"Never estimate time",
                Prompt
            ),
            (
                "secrets-via-request",
                "secrets only through `request_secret`",
                r"request_secret",
                Code
            ),
            (
                "gated-run",
                "prod writes, spends and deletes only through `gated_run`",
                r"gated_run",
                Code
            ),
            (
                "parallel-by-default",
                "splits approved work into parts whose files don't overlap and runs them in parallel while slots are free",
                r"Parallel by default",
                Prompt
            ),
            (
                "train-only-merges",
                "only the merge train merges",
                r"never merge",
                Prompt
            ),
            (
                "agent-not-human",
                "takes an agent's chat message as input, never as the human's answer or approval",
                r"never as the human's answer",
                Code
            ),
        ]
    ),
    entry!(
        "lead.voice",
        Start,
        Lead,
        Lead,
        "Voice",
        "after the lead prompt, at every lead start",
        "",
        &[(
            "chat-only-voice",
            "the casual voice stays out of commits, PR bodies, docs and briefs",
            r"stay plain and precise",
            Prompt
        )]
    ),
    entry!(
        "lead.profiles",
        Start,
        Lead,
        Lead,
        "Task profiles",
        "after the lead prompt, while the project allows medium (project_set)",
        "",
        &[
            (
                "mechanical-only",
                "medium only for mechanical work, never for design or anything subtle",
                r"only for mechanical work",
                Prompt
            ),
            (
                "reviews-high",
                "reviews always run high",
                r"Reviews always run high",
                Code
            ),
            (
                "redo-on-high",
                "a medium task whose review finds blockers twice is redone on high",
                r"redone on high",
                Prompt
            ),
        ]
    ),
    entry!(
        "lead.wake",
        Msg,
        Lead,
        Lead,
        "Project updates",
        "each time fleetd brings the lead up to date: the project's state, then one line per event since the last time",
        "state!=the state block: the project's work, agents, decisions and train; events!=one line per event",
        &[]
    ),
    entry!(
        "chat.human",
        Msg,
        Lead,
        Lead,
        "Chat: the human",
        "with each chat message the human sends the lead",
        "text!=the human's words; files=the attached files' paths, or nothing",
        &[]
    ),
    entry!(
        "chat.agent",
        Msg,
        Lead,
        Lead,
        "Chat: an agent",
        "with each chat message an agent or integration with its own key sends the lead",
        "agent!=the key's name; text!=its words; files=the attached files' paths, or nothing",
        &[(
            "agent-not-human",
            "takes it as input, never as the human's answer or approval",
            r"never as the human's answer",
            Code
        )]
    ),
    entry!(
        "steer.message",
        Msg,
        Messages,
        Any,
        "Steer",
        "per steer (steer_send, task message), straight to the agent, at its next tool boundary or now",
        "id!=the steer, S<n>; who!=the human or your lead; scope!=the order (W<n> 'title') or the task (T<n> (kind) for W<n>); text!=the words; references=references and attachments, or nothing",
        &[]
    ),
    entry!(
        "task.brief.write",
        Start,
        Tasks,
        Task,
        "Writer brief",
        "every write task attempt",
        "taskId!=T<n>; kind=write; workstreamId=W<n>; project=the project's title; title=the task's title; task!=the lead's task text; workstream=the order's whole brief (goal, why, pointers, constraints, done-when) and the decisions it names by id or key, or nothing; elsewhere=work in flight elsewhere it may overlap, or nothing; branch!=the task's branch; baseBranch=the default branch",
        &[(
            "train-only-merges",
            "never merges; the train does",
            r"never merge",
            Prompt
        ),]
    ),
    entry!(
        "task.brief.read",
        Start,
        Tasks,
        Task,
        "Reader brief",
        "every read task attempt",
        "taskId!=T<n>; kind=read; workstreamId=W<n>; project=the project's title; title=the task's title; task!=the lead's task text; workstream=the order's whole brief (goal, why, pointers, constraints, done-when) and the decisions it names by id or key, or nothing; baseBranch=the default branch; workspace!=where it works: its own worktree, or the project's checkout on an older node",
        &[READ_ONLY]
    ),
    entry!(
        "task.brief.review",
        Start,
        Tasks,
        Task,
        "Review task brief",
        "every attempt of a review task the lead spawns (the train's reviews use Reviewer)",
        "taskId!=T<n>; kind=review; workstreamId=W<n>; project=the project's title; title=the task's title; task!=the lead's task text; workstream=the order's whole brief (goal, why, pointers, constraints, done-when) and the decisions it names by id or key, or nothing; baseBranch=the default branch; workspace!=where it works: its own worktree, or the project's checkout on an older node",
        &[READ_ONLY, VERDICT]
    ),
    entry!(
        "review.reviewer",
        Start,
        ReviewsAndChecks,
        Task,
        "Reviewer",
        "once per PR patch, fresh, blocking findings only",
        "prUrl!=the PR; repo=owner/name; prNumber!=its number; headSha!=the head reviewed",
        &[
            (
                "independent-review",
                "does not read the PR description or comments",
                r"do not read the PR description",
                Prompt
            ),
            READ_ONLY,
            VERDICT,
        ]
    ),
    entry!(
        "review.delta",
        Start,
        ReviewsAndChecks,
        Task,
        "Reviewer: what changed since the last review",
        "after Reviewer, when an earlier round reviewed another head of the PR",
        "reviewedSha!=the head reviewed before; headSha!=the head to review",
        &[]
    ),
    entry!(
        "pr.fix",
        Msg,
        Messages,
        Task,
        "Fix your PR",
        "to a PR's author when the train can't rebase it, its CI is red, or a review finds blocking findings",
        "pr!=the PR and its change; problem!=what is wrong; findings=the review's findings, or nothing; branch!=the PR's branch",
        &[(
            "train-only-merges",
            "never merges; the train does",
            r"never merge",
            Prompt
        )]
    ),
    entry!(
        "task.pause",
        Msg,
        Messages,
        Task,
        "Pause above max agents",
        "to each running agent above a lowered max agents, when a person pauses the extras",
        "maxAgents!=the new max agents",
        &[]
    ),
    entry!(
        "task.resume",
        Msg,
        Messages,
        Task,
        "Resume after a pause",
        "to a paused agent once a slot frees for it",
        "",
        &[]
    ),
    entry!(
        "task.recover",
        Msg,
        Messages,
        Task,
        "Resume after a run died",
        "to an agent whose run was cut off (its node stopped, its process was killed, a stall), when fleetd resumes it",
        "cause!=why the run ended, in plain words; doing!=the last thing it did; used!=the recoveries used of the most fleetd makes",
        &[]
    ),
    entry!(
        "task.handoff",
        Start,
        Tasks,
        Task,
        "Handoff to a fresh thread",
        "after the task's brief, when fleetd restarts an agent in a new thread (its context filled up again, or its thread could not resume)",
        "why!=why it restarted; workspace!=where the work is; tail!=the earlier agent's last words; commits!=the branch's commits, or none; uncommitted!=uncommitted paths, or none; pr!=its open PR, or none",
        &[]
    ),
    entry!(
        "usage.continue",
        Msg,
        Messages,
        Any,
        "Continue after a usage limit",
        "to a lead or agent a usage limit parked, once the limit resets",
        "",
        &[]
    ),
    Entry {
        id: INSTRUCTIONS,
        title: "Custom instructions",
        kind: K::Instructions,
        group: G::Instructions,
        audience: Audience::None,
        sent_when: "appended to every lead and task first message, global then project",
        default: asset!("instructions"),
        placeholders: "",
        rules: &[],
    },
];

pub const INSTRUCTIONS: &str = "instructions";

pub fn get(id: &str) -> Option<&'static Entry> {
    ENTRIES.iter().find(|e| e.id == id)
}

/// The entry, for ids the code names; a typo fails every test that renders it.
pub fn entry(id: &str) -> &'static Entry {
    get(id).unwrap_or_else(|| panic!("no prompt {id} in the registry"))
}
