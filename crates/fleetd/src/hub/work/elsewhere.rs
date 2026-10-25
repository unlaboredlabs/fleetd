//! What a lead reads of the work that isn't its own: the digest's "Elsewhere" lines (claims, other projects' writers
//! and Changes on the same repo and base, and recent landings outside the train), and the landing `plan covered`
//! names. Landings come through [`Landings`], which the landing scanner fills in; until it is set there are none.
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::verification::CommitSha;
use fleetd_contracts::work::{
    ClaimOwner, ClaimOwnerKind, LandingRoute, WorkItem, WorkItemKind, WorkKey, WorkScope,
};

use crate::hub::leads::digest::one_line;
use crate::hub::store::StoreError;

/// Landings the digest shows: the newest this many outside the train, from the last `LANDINGS_SHOWN_MS`.
pub const LANDINGS_SHOWN: usize = 5;
pub const LANDINGS_SHOWN_MS: i64 = 24 * 3_600_000;
/// Each line is cut to this many characters.
const LINE_MAX: usize = 200;

/// A commit that reached a base, as the lead reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct Landed {
    pub sha: CommitSha,
    pub at_ms: i64,
    pub route: LandingRoute,
    /// The PR it merged as, when its message or the host names one: "#57", or its URL.
    pub pr: Option<String>,
    pub subject: String,
    pub author_email: Option<String>,
    /// The work it matched exactly: "P5", "T12", "C7".
    pub covers: Vec<String>,
}

/// Every commit that landed on a watched base, however it got there.
pub trait Landings: Send + Sync {
    /// The scope's landings at or after `since_ms` that didn't come through the train, newest first, at most `limit`.
    fn outside(
        &self,
        scope: &WorkScope,
        since_ms: i64,
        limit: usize,
    ) -> Result<Vec<Landed>, StoreError>;
    /// The scope's one landing whose sha starts with `sha`; `None` when there is none, or more than one.
    fn find(&self, scope: &WorkScope, sha: &str) -> Result<Option<Landed>, StoreError>;
}

/// How it reached the base, for a person: "pushed straight to main, outside fleetd".
pub fn how(landed: &Landed, base: &str) -> String {
    match landed.route {
        LandingRoute::Train => "merged by the train".into(),
        LandingRoute::PrOutside => match &landed.pr {
            Some(pr) => format!("PR {pr} merged outside fleetd"),
            None => "merged outside fleetd".into(),
        },
        LandingRoute::DirectPush => format!("pushed straight to {base}, outside fleetd"),
    }
}

pub fn short_sha(sha: &CommitSha) -> &str {
    &sha.as_str()[..7]
}

/// The evidence on an item it covers: "abc1234 pushed straight to main, outside fleetd: feat: dark mode".
pub fn evidence(landed: &Landed, base: &str) -> String {
    one_line(
        &format!(
            "{} {}: {}",
            short_sha(&landed.sha),
            how(landed, base),
            landed.subject
        ),
        LINE_MAX,
    )
}

fn landing_line(landed: &Landed, base: &str) -> String {
    let by = landed
        .author_email
        .as_ref()
        .map(|e| format!(" by {e}"))
        .unwrap_or_default();
    let covers = if landed.covers.is_empty() {
        String::new()
    } else {
        format!(" · covers {}", landed.covers.join(", "))
    };
    one_line(
        &format!(
            "- {} {}{by}: {}{covers}",
            short_sha(&landed.sha),
            how(landed, base),
            landed.subject
        ),
        LINE_MAX,
    )
}

fn owner_text(owner: &ClaimOwner) -> String {
    let who = match owner.kind {
        ClaimOwnerKind::HumanSession => "a person",
        ClaimOwnerKind::AgentKey => "an agent key",
        ClaimOwnerKind::Lead => "the lead of",
    };
    match (owner.kind, &owner.label) {
        (ClaimOwnerKind::Lead, _) => format!("{who} {}", owner.key_id),
        (_, Some(label)) => format!("{who} ({label})"),
        (_, None) => who.to_owned(),
    }
}

fn key_text(key: &WorkKey) -> String {
    match key {
        WorkKey::Issue(issue) => issue.to_string(),
        WorkKey::Item(item) => item.to_string(),
        WorkKey::Pr(url) => url.to_string(),
        WorkKey::Branch(branch) => format!("branch {branch}"),
    }
}

fn project_text(r: Option<&ProjectRef>) -> String {
    r.map_or_else(
        || "another project".into(),
        |r| format!("{}/{}", r.machine_id, r.project_id),
    )
}

fn item_line(item: &WorkItem) -> String {
    let what = match item.kind {
        WorkItemKind::Claim => {
            let claim = if item.state == "expired" {
                "expired claim"
            } else {
                "claimed"
            };
            let by = item.owner.as_ref().map(owner_text).unwrap_or_default();
            format!("{claim} by {by}")
        }
        WorkItemKind::Task => format!(
            "writer of {}, {}",
            project_text(item.project_ref.as_ref()),
            item.state
        ),
        WorkItemKind::Change => format!(
            "PR of {}, {}",
            project_text(item.project_ref.as_ref()),
            item.state
        ),
        WorkItemKind::Pr => format!("open PR, {}", item.state),
        WorkItemKind::Planned => format!("planned in {}", project_text(item.project_ref.as_ref())),
    };
    let keys: Vec<String> = item.keys.iter().map(key_text).collect();
    let on = if item.kind == WorkItemKind::Claim && !keys.is_empty() {
        format!(" · on {}", keys.join(", "))
    } else {
        String::new()
    };
    one_line(
        &format!("- {} {what}: {}{on}", item.id, item.title),
        LINE_MAX,
    )
}

/// Whether the item is the lead's own work: its project's writers and Changes, and claims its lead holds.
fn own(item: &WorkItem, project_ref: &ProjectRef) -> bool {
    match item.kind {
        WorkItemKind::Claim => item.owner.as_ref().is_some_and(|o| {
            o.kind == ClaimOwnerKind::Lead
                && o.key_id.as_str()
                    == format!("{}/{}", project_ref.machine_id, project_ref.project_id)
        }),
        _ => item.project_ref.as_ref() == Some(project_ref),
    }
}

/// The digest's Elsewhere lines: landings outside the train first (newest first), then the in-flight items that
/// aren't the project's own, in the view's order (expired claims last).
pub fn lines(
    project_ref: &ProjectRef,
    scope: &WorkScope,
    in_flight: &[WorkItem],
    landings: &[Landed],
) -> Vec<String> {
    landings
        .iter()
        .filter(|l| l.route != LandingRoute::Train)
        .take(LANDINGS_SHOWN)
        .map(|l| landing_line(l, scope.base.as_str()))
        .chain(
            in_flight
                .iter()
                .filter(|i| !own(i, project_ref))
                .map(item_line),
        )
        .collect()
}
