//! Finish-all, pure: what counts as a child's value source, the inventory's ranking and text, and the idle rule.
//! `finish_all.rs` gathers the inputs (claims, GitHub issues, asks, a fixed `git grep`) and applies the result.
use std::sync::LazyLock;

use fleetd_contracts::ledger::{Workstream, WorkstreamId};
use regex::Regex;

pub const FINISH_ALL_IDLE: &str = "finish-all: nothing left with a value source";
pub const DEFAULT_MAX_CHILDREN: u32 = 5;
/// Fixed, so the count means the same in every project.
pub const TODO_GREP: [&str; 7] = ["git", "grep", "-I", "-c", "-w", "-E", "TODO|FIXME"];
/// The value sources a child workstream may serve.
pub const CHILD_SOURCES: [&str; 3] = ["issue:", "defect:", "done:"];

pub fn is_finish_all(w: &Workstream) -> bool {
    w.playbook
        .as_ref()
        .is_some_and(|p| p.as_ref().starts_with("finish-all@"))
}

pub struct Refusal {
    pub message: String,
    pub fix: String,
}

static DONE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^done:(\d+)$").unwrap());

/// Why `serves` cannot start a child of `parent`; None when it can. `open_children` are the parent's open children.
pub fn spawn_refusal(
    serves: &str,
    parent: &Workstream,
    open_children: &[&Workstream],
    max_children: u32,
) -> Option<Refusal> {
    if !CHILD_SOURCES
        .iter()
        .any(|prefix| serves.starts_with(prefix))
    {
        return Some(Refusal {
            message: format!("'{serves}' is not a value source a child can serve."),
            fix: "Pass serves issue:<#n|url> (an open issue), defect:<one line> (a failing check or error you saw) or done:<n> (a done-when check of the finish-all workstream). Never invent work.".into(),
        });
    }
    let checks = parent.brief.as_ref().map_or(0, |b| b.done_when.len());
    if let Some(m) = DONE.captures(serves)
        && m[1].parse::<usize>().map_or(true, |n| n >= checks)
    {
        let fix = if checks == 0 {
            "Use issue: or defect:; the finish-all workstream has no done-when checks.".to_string()
        } else {
            let range = if checks > 1 {
                format!(" to done:{}", checks - 1)
            } else {
                String::new()
            };
            format!("Use done:0{range}, or issue: or defect:.")
        };
        return Some(Refusal {
            message: format!("{} has no done-when check {serves}.", parent.workstream_id),
            fix,
        });
    }
    if let Some(same) = open_children.iter().find(|c| {
        c.parent
            .as_ref()
            .is_some_and(|p| p.serves.as_ref() == serves)
    }) {
        return Some(Refusal {
            message: format!("{} already serves {serves}.", same.workstream_id),
            fix: "Spawn a child for another item, or wait for it.".into(),
        });
    }
    if open_children.len() as u32 >= max_children {
        return Some(Refusal {
            message: format!(
                "{} already has {} open children, the most one finish-all run may have ({max_children}).",
                parent.workstream_id,
                open_children.len()
            ),
            fix: "Wait for one to finish; its result arrives in a wake.".into(),
        });
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    FailingCheck,
    Issue,
    /// A secret or command approval waiting on the person in chat.
    Request,
    Todo,
}

impl ItemKind {
    fn rank(self) -> u8 {
        match self {
            ItemKind::FailingCheck => 0,
            ItemKind::Issue => 1,
            ItemKind::Request => 2,
            ItemKind::Todo => 3,
        }
    }
    fn label(self) -> &'static str {
        match self {
            ItemKind::FailingCheck => "failing check",
            ItemKind::Issue => "open issue",
            ItemKind::Request => "waiting on the person",
            ItemKind::Todo => "TODO markers",
        }
    }
}

#[derive(Debug, Clone)]
pub struct InventoryItem {
    pub kind: ItemKind,
    pub text: String,
    /// Its value source; None for asks and TODO markers.
    pub serves: Option<String>,
    /// The open workstream already working on it.
    pub served_by: Option<WorkstreamId>,
}

/// Failing checks first (claimed work that is broken), then open issues, oldest first, then the rest. Stable.
pub fn rank_items(items: &[InventoryItem]) -> Vec<InventoryItem> {
    let mut ranked = items.to_vec();
    ranked.sort_by_key(|i| i.kind.rank());
    ranked
}

pub fn is_spawnable(item: &InventoryItem) -> bool {
    item.serves.is_some() && item.served_by.is_none()
}

static GITHUB: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"github\.com[/:]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$").unwrap()
});

/// `owner/name` of a GitHub remote URL (https or ssh), lowercased; None for any other remote.
pub fn github_repo_of(remote: &str) -> Option<String> {
    GITHUB
        .captures(remote.trim())
        .map(|m| format!("{}/{}", &m[1], &m[2]).to_lowercase())
}

static COUNT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r":(\d+)$").unwrap());

/// The TODO/FIXME count from `git grep -c` output (`path:count` per line). The node keeps only the output's tail, so a
/// long listing may have lost its first lines; then the count is a lower bound.
pub fn todo_count(output: &str, truncated: bool) -> (u64, bool) {
    let count = output
        .split('\n')
        .filter_map(|line| {
            COUNT
                .captures(line.trim())
                .and_then(|m| m[1].parse::<u64>().ok())
        })
        .sum();
    (count, truncated)
}

pub struct InventoryParent {
    pub workstream_id: WorkstreamId,
    pub open_children: usize,
    pub max_children: u32,
}

pub struct InventoryInput {
    pub project: String,
    pub parent: Option<InventoryParent>,
    pub items: Vec<InventoryItem>,
    /// Sources that could not be read, with why; while any is unread, nothing can be called finished.
    pub unread: Vec<String>,
}

/// The finish-all workstream goes idle when it has no open child and nothing it could start, as far as can be read.
pub fn should_idle(input: &InventoryInput) -> bool {
    input.parent.as_ref().is_some_and(|p| p.open_children == 0)
        && input.unread.is_empty()
        && !input.items.iter().any(is_spawnable)
}

pub fn render_inventory(input: &InventoryInput) -> String {
    let ranked = rank_items(&input.items);
    let (sourced, others): (Vec<_>, Vec<_>) = ranked.iter().partition(|i| i.serves.is_some());
    let head = match &input.parent {
        None => format!(
            "Inventory of {}, ranked (no open finish-all workstream):",
            input.project
        ),
        Some(p) => format!(
            "Inventory of {}, ranked; finish-all {} has {} of at most {} open children:",
            input.project, p.workstream_id, p.open_children, p.max_children
        ),
    };
    let mut lines = vec![head];
    if sourced.is_empty() {
        lines.push("Nothing with a value source.".into());
    }
    for (n, item) in sourced.iter().enumerate() {
        let progress = item
            .served_by
            .as_ref()
            .map(|w| format!(" (in progress: {w})"))
            .unwrap_or_default();
        lines.push(format!(
            "{}. {} — {} [{}]{progress}",
            n + 1,
            item.serves.as_deref().unwrap_or(""),
            item.text,
            item.kind.label()
        ));
    }
    if !others.is_empty() {
        lines.push("Without a value source (never a child):".into());
        for item in others {
            lines.push(format!("- {}", item.text));
        }
    }
    for why in &input.unread {
        lines.push(format!("Could not read {why}"));
    }
    if should_idle(input)
        && let Some(p) = &input.parent
    {
        lines.push(format!("{FINISH_ALL_IDLE}; {} is idle.", p.workstream_id));
    }
    lines.join("\n")
}
