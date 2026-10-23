//! The prompts a person can edit: the real instructions fleetd gives a model, each with its shipped text, the
//! placeholders the code fills in and the safety rules the text carries. The shipped texts are
//! `assets/prompts/<id>.md`. Everything else fleetd tells agents is fixed: event lines (`leads::events`), the state
//! block (`leads::digest`) and plain notices (`fixed`). Prompts a release retired are `retired`.
use fleetd_contracts::prompts::{Enforcement, Placeholder, PromptGroup, PromptKind, SafetyRule};

/// Which sessions pin an entry at their start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Audience {
    Lead,
    Task,
    /// Any thread: leads, tasks, and threads an outside agent launched.
    Any,
    /// Resolved at each call (the retro).
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

// `train-only-merges` is a prompt rule: the hub only sees a merge outside the train after the fact (`policy_bypass`).
pub const ENTRIES: &[Entry] = &[
    entry!(
        "lead.start",
        Start,
        Lead,
        Lead,
        "Lead",
        "lead start and every lead_restart, followed by the state block",
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
                "train-only-merges",
                "only the merge train merges",
                r"never merge",
                Prompt
            ),
            (
                "claim-done",
                "done only through `claim_done`",
                r"claim_done",
                Code
            ),
        ]
    ),
    entry!(
        "steer.message",
        Msg,
        Messages,
        Any,
        "Steer",
        "per steer (steer_send, task message), straight to the agent, at its next tool boundary or now",
        "id!=the steer, S<n>; who!=the human or your lead; scope!=the order (W<n> 'title') or the task (T<n> (kind) for W<n>); text!=the words; references=references and attachments, or nothing",
        &[(
            "names-steer",
            "asks the agent to name the steer first, so its receipt can say it was acknowledged",
            r"\{\{id\}\}:",
            Prompt
        )]
    ),
    entry!(
        "task.brief.write",
        Start,
        Tasks,
        Task,
        "Writer brief",
        "every write task attempt",
        "taskId!=T<n>; kind=write; workstreamId=W<n>; project=the project's title; title=the task's title; task!=the lead's task text; workstream=the order's goal, done-when and what this serves, or nothing; areas!=the leased areas and their globs; branch!=the task's branch; baseBranch=the default branch; serves!=what the task serves",
        &[
            (
                "areas",
                "changes only its areas",
                r"only change files in these areas",
                Code
            ),
            (
                "train-only-merges",
                "never merges; the train does",
                r"never merge",
                Prompt
            ),
        ]
    ),
    entry!(
        "review.reviewer",
        Start,
        ReviewsAndChecks,
        Task,
        "Reviewer",
        "per PR head per review round, by the tier's rules; Claude or Codex",
        "prUrl!=the PR; repo=owner/name; prNumber!=its number; tier=S, M or L; headSha!=the head reviewed; serves=what the PR serves",
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
        "review.verifier",
        Start,
        ReviewsAndChecks,
        Task,
        "Verifier",
        "tier L, per PR head",
        "prUrl!=the PR; repo=owner/name; prNumber!=its number; tier=S, M or L; headSha!=the head verified",
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
        "judge",
        Start,
        ReviewsAndChecks,
        Task,
        "Judge",
        "per `judge` done-when check of each claim",
        "workstreamId!=W<n>; claimId=C<n>; checkIndex=the check's index; criteria!=the criterion; artifacts!=PRs and branches to read",
        &[
            (
                "trust-no-claim",
                "trusts no claim in the artifacts",
                r"trust no claim",
                Prompt
            ),
            VERDICT
        ]
    ),
    entry!(
        "judge.research",
        Start,
        ReviewsAndChecks,
        Task,
        "Research judge",
        "per `judge` check of a research claim",
        "workstreamId!=W<n>; claimId=C<n>; checkIndex=the check's index; criteria!=the criterion; artifacts!=PRs and branches to read; metric!=the metric; baseline!=the baseline",
        &[
            (
                "trust-no-claim",
                "trusts no claim in the artifacts",
                r"trust no claim",
                Prompt
            ),
            VERDICT
        ]
    ),
    entry!(
        "retro",
        Oneshot,
        OneShots,
        Audience::None,
        "Retro / triage",
        "each retro run (at most 2 a day)",
        "windowDays!=the window; metrics!=the metric classes; incidents!=the incidents; playbooks!=the playbook files",
        &[
            ("no-tools", "uses no tools", r"do not use tools", Code),
            ("at-most-3", "at most 3 changes", r"at most 3 changes", Code),
        ]
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
