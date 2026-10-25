//! Factory metrics: what came out of a project and what it cost the person. Every figure counts **landed changes**:
//! a PR merged into the repo's default branch by any method, each member of a train batch once (the batch PR not at
//! all), or a commit pushed straight to the default branch. Repos are keyed by their remote, whatever the host, so
//! nothing here assumes GitHub, a CI or a release cadence. Every `ms` is a duration in milliseconds.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::prim::{Count, Int, Line, List, NonNegative, Positive, Text};
use crate::tasks::TaskId;
use crate::train::ChangeId;
use crate::verification::CommitSha;

/// A remote repository as `projects::short_remote` writes it: host, then path, no scheme, user or `.git`.
pub fn is_remote_repo(repo: &str) -> bool {
    let Some((host, path)) = repo.split_once('/') else {
        return false;
    };
    crate::prim::js_len(repo) <= 300
        && !host.is_empty()
        && !path.is_empty()
        && !path.ends_with('/')
        && !repo.contains("://")
        && !repo.contains("//")
        && !repo.contains('@')
        && !repo.chars().any(|c| c.is_whitespace() || c.is_control())
}

brand!(
    /// A repository by its origin remote, host first: "github.com/acme/web", "gitlab.example.com/team/api",
    /// "git.internal/srv/tools". The same repo checked out on two machines has one key.
    RemoteRepo,
    name = "RemoteRepo",
    check = is_remote_repo,
    expected = "a remote as host/path, e.g. github.com/acme/web"
);

brand!(
    /// A calendar day in the viewer's time zone, "YYYY-MM-DD".
    LocalDate, name = "LocalDate", pattern = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
);

/// How a landed change reached the default branch. The fixed order, bottom up on every chart, is the order here.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum MergeRoute {
    /// A Change the merge train merged, batch members included: "Through fleetd".
    Train,
    /// Written by fleetd (a Change, a `fleetd/T…` branch or a task's head) but landed without the train: "Made by
    /// fleetd, merged by you".
    FleetdByHand,
    /// A merged PR with no Change and no fleetd branch: "Merged outside fleetd".
    Outside,
    /// A first-parent commit on the default branch with no PR: "Pushed straight to the default branch". On a repo
    /// with no git host fleetd can read, direct pushes and outside merges can't be told apart and both read as `outside`.
    Direct,
    /// A route this build doesn't know (a newer hub). Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl MergeRoute {
    pub const ALL: [MergeRoute; 4] = [
        MergeRoute::Train,
        MergeRoute::FleetdByHand,
        MergeRoute::Outside,
        MergeRoute::Direct,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            MergeRoute::Train => "train",
            MergeRoute::FleetdByHand => "fleetd_by_hand",
            MergeRoute::Outside => "outside",
            MergeRoute::Direct => "direct",
            MergeRoute::Unknown => "unknown",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|r| r.as_str() == name)
    }

    /// fleetd wrote it: it belongs to an order, so it has an order-to-merged time and counts in "made by fleetd".
    pub fn made_by_fleetd(self) -> bool {
        matches!(self, MergeRoute::Train | MergeRoute::FleetdByHand)
    }
}

/// Why a merge into the repo is not a landed change. These are counted in the tooltips, never silently dropped.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum SkipWhy {
    /// Opened by a bot account (dependabot, renovate…): out of all four metrics.
    Bot,
    /// Merged into a base that is not the default branch and that the train doesn't guard.
    OtherBase,
    /// A release or sync PR whose head is a default branch, or itself the base of other PRs.
    MergeBack,
    /// A reason this build doesn't know (a newer hub). Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Who a PR's author or merger was, by the git host's account type: git authorship can't tell, because agents commit
/// under the person's own identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    Human,
    Bot,
    /// The merge train (merger only).
    Train,
    /// No git host to ask, or it didn't say.
    Unknown,
}

/// Where an order's `requested_at` came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RequestedBasis {
    /// The person submitted the order directly (app or MCP).
    Source,
    /// The earliest human chat message of the lead run that opened it.
    Chat,
    /// When the lead opened it: later than the real request by the lead's turn, and labelled so.
    Opened,
}

macro_rules! touch_kinds {
    ($($(#[$meta:meta])* $variant:ident = $name:literal, $source:ident;)*) => {
        /// One observed act by the person. Each kind folds into one [`HumanSource`] on the minutes chart.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
        #[schemars(extend("x-open" = true))]
        pub enum TouchKind {
            $($(#[$meta])* #[serde(rename = $name)] $variant,)*
            /// A kind this build doesn't know (a newer hub). Never sent.
            #[serde(other)]
            #[schemars(skip)]
            Unknown,
        }

        impl TouchKind {
            pub const ALL: &'static [TouchKind] = &[$(TouchKind::$variant,)*];

            pub fn as_str(self) -> &'static str {
                match self { $(TouchKind::$variant => $name,)* TouchKind::Unknown => "unknown" }
            }

            pub fn parse(name: &str) -> Option<Self> {
                match name { $($name => Some(TouchKind::$variant),)* _ => None }
            }

            pub fn source(self) -> HumanSource {
                match self { $(TouchKind::$variant => HumanSource::$source,)* TouchKind::Unknown => HumanSource::Other }
            }
        }
    };
}

touch_kinds! {
    /// A chat message the person sent, from the app or `fleetd chat`.
    ChatMessage = "chat.message", Chat;
    /// A command approval or secret request the person answered inline.
    ItemAnswered = "item.answered", Chat;
    /// An order the person submitted directly.
    OrderSubmitted = "order.submitted", Chat;
    /// A review submitted on the git host. Its credit is estimated: hosts keep when a review was sent, not how long it
    /// took.
    Review = "host.review", Reviews;
    /// A review comment or PR comment on the git host.
    Comment = "host.comment", Reviews;
    /// The app was focused on a project's screen with input in the last minute (`app.presence`).
    AppUse = "app.use", App;
    /// A fleetd call from the person's own Claude Code session.
    SessionCall = "session.call", Sessions;
    /// A steer the person sent an agent.
    Steer = "steer", Other;
    /// A decision the person recorded.
    Decision = "decision", Other;
    /// A PR the person merged by hand.
    MergeByHand = "merge.by_hand", Other;
    /// A commit the person pushed outside fleetd's branches.
    Commit = "commit", Other;
}

/// The minutes chart's series, at most five, in this fixed order bottom up.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum HumanSource {
    /// Chat messages, inline approvals and secrets, and orders.
    Chat,
    /// Reviews and comments on the git host: estimated.
    Reviews,
    App,
    /// The person's own Claude Code sessions registered with fleetd.
    Sessions,
    /// Steers, decisions, merges by hand, commits.
    Other,
}

impl HumanSource {
    pub const ALL: [HumanSource; 5] = [
        HumanSource::Chat,
        HumanSource::Reviews,
        HumanSource::App,
        HumanSource::Sessions,
        HumanSource::Other,
    ];

    /// Its minutes are estimated from a floor, not observed.
    pub fn estimated(self) -> bool {
        self == HumanSource::Reviews
    }
}

/// Where a repo's merges are read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum GitHost {
    #[serde(rename = "github")]
    GitHub,
    #[serde(rename = "gitlab")]
    GitLab,
    Gitea,
    Bitbucket,
    #[serde(rename = "azure_devops")]
    AzureDevOps,
    /// No host API fleetd can read: landed changes come from the default branch's first-parent log, and reviews,
    /// bots and PR open times are absent.
    Git,
    /// A host this build doesn't know (a newer hub). Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Landed changes per route.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RouteCounts {
    pub train: Count,
    pub fleetd_by_hand: Count,
    pub outside: Count,
    pub direct: Count,
}

/// Merges that are not landed changes, by why.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkipCount {
    pub why: SkipWhy,
    pub n: Count,
}

/// Lines changed by one route's landed changes, for the share's tooltip (the share itself is by count).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RouteLines {
    pub route: MergeRoute,
    pub additions: Count,
    pub deletions: Count,
}

/// One point of a tile's sparkline: the figure over one slice of the range.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SparkPoint {
    pub since: Timestamp,
    /// In the tile's unit. Absent when the slice has nothing to measure (no merges for a median).
    pub value: Option<NonNegative>,
}

pub type Spark = List<SparkPoint, 0, 12>;

/// Pull requests merged per day: landed changes of all four routes over the range's calendar days (today as a
/// fraction, at least an hour).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MergedTile {
    pub per_day: NonNegative,
    pub n: Count,
    pub by_route: RouteCounts,
    /// The previous period of the same length; absent when nothing was read that far back.
    pub previous_per_day: Option<NonNegative>,
    pub spark: Spark,
}

/// Time from order to merged, over the landed changes that belong to an order (`train` and `fleetd_by_hand`).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrderToMergedTile {
    /// Absent when `n` is 0.
    pub median_ms: Option<Count>,
    pub p90_ms: Option<Count>,
    pub n: Count,
    /// Of `n`, those timed from when the lead opened the order rather than when the person asked.
    pub from_opened: Count,
    /// Landed changes with no order (`outside`, `direct`), shown as "n merged with no order".
    pub no_order: Count,
    /// PR opened to merged over every PR of every route, for a like-for-like comparison.
    pub pr_open_median_ms: Option<Count>,
    pub previous_median_ms: Option<Count>,
    pub spark: Spark,
}

/// The person's minutes per merged PR: a ratio of period totals, from what fleetd sees.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HumanTile {
    /// Minutes on fleetd work over its landed changes (`train` + `fleetd_by_hand`); absent when there are none.
    pub per_pr_ms: Option<Count>,
    /// The estimate: touches' credits, bridged into sessions where under 5 minutes apart, as a union.
    pub total_ms: Count,
    /// The low bound: the union of the credits alone, with no bridging.
    pub low_ms: Count,
    pub prs: Count,
    /// Visible minutes on outside work over `outside` + `direct` landed changes. Always a bare minimum: fleetd
    /// sees almost none of that work.
    pub outside_per_pr_ms: Option<Count>,
    pub outside_total_ms: Count,
    pub outside_prs: Count,
    pub previous_per_pr_ms: Option<Count>,
    pub spark: Spark,
}

/// Share of merged work through fleetd, by count.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThroughFleetdTile {
    /// `train` over all landed changes; absent when there are none.
    pub pct: Option<NonNegative>,
    /// `train` + `fleetd_by_hand` over all landed changes.
    pub made_by_fleetd_pct: Option<NonNegative>,
    pub n: Count,
    pub lines: List<RouteLines, 0, 8>,
    pub previous_pct: Option<NonNegative>,
    pub spark: Spark,
}

/// The KPI row: all four, equal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MetricsTiles {
    pub merged: MergedTile,
    pub order_to_merged: OrderToMergedTile,
    pub human: HumanTile,
    pub through_fleetd: ThroughFleetdTile,
}

/// The person's minutes from one source on one day.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SourceMs {
    pub source: HumanSource,
    pub ms: Count,
    pub touches: Count,
}

/// One calendar day in the viewer's zone; days with nothing are present too.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MetricsDay {
    pub day: LocalDate,
    pub merged: RouteCounts,
    /// Bots and other merges not counted that day.
    pub not_counted: List<SkipCount, 0, 8>,
    pub human: List<SourceMs, 0, 8>,
}

/// One landed change, for the list and the hovers.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MetricsMerge {
    pub repo: RemoteRepo,
    /// Absent on a direct push.
    pub pr_number: Option<Positive>,
    /// The merge, squash or pushed commit on the default branch.
    pub sha: Option<CommitSha>,
    pub title: Option<Line<1, 200>>,
    pub url: Option<Text<1, 500>>,
    pub route: MergeRoute,
    pub merged_at: Timestamp,
    /// The project that owns it on this hub; the same repo may be checked out by others (`MetricsRepoRow`).
    pub project_ref: Option<ProjectRef>,
    pub workstream_id: Option<WorkstreamId>,
    pub task_id: Option<TaskId>,
    pub change_id: Option<ChangeId>,
    /// The train's batch PR it landed in.
    pub batch_pr: Option<Positive>,
    pub requested_at: Option<Timestamp>,
    pub requested_basis: Option<RequestedBasis>,
    /// The stages between requested and merged: its first PR opened, its review passed.
    pub first_pr_at: Option<Timestamp>,
    pub review_passed_at: Option<Timestamp>,
    pub order_to_merged_ms: Option<Count>,
    pub pr_created_at: Option<Timestamp>,
    pub pr_open_to_merged_ms: Option<Count>,
    pub author: Option<ActorKind>,
    pub merged_by: Option<ActorKind>,
    pub additions: Option<Count>,
    pub deletions: Option<Count>,
    /// The person's touches that belong to this PR: reviews on it, its merge by hand.
    pub touches: Count,
    /// The ledger claim of a human session that saw this work before it landed.
    pub seen_claim: Option<Line<1, 120>>,
}

/// One repo's four numbers, for the cross-fleet table under "All projects".
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MetricsRepoRow {
    pub repo: RemoteRepo,
    /// Every project on this hub with it checked out, so the same merges show under each.
    pub projects: List<ProjectRef, 0, 20>,
    pub merged_per_day: NonNegative,
    pub n: Count,
    pub order_to_merged_median_ms: Option<Count>,
    pub human_per_pr_ms: Option<Count>,
    pub through_fleetd_pct: Option<NonNegative>,
    /// Merged per day over slices of the range.
    pub spark: Spark,
}

/// What a repo's figures were read from.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RepoCoverage {
    pub repo: RemoteRepo,
    pub host: GitHost,
    pub default_branch: Option<Line<1, 255>>,
    /// The last good read of its host's API or its git log.
    pub last_read: Option<Timestamp>,
    /// Merges are known from here on (the first read backfills 90 days).
    pub known_since: Option<Timestamp>,
}

/// A repo whose reads are failing: its figures stop at `since`, never a silent zero.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RepoStale {
    pub repo: RemoteRepo,
    pub since: Timestamp,
    /// "GitHub not read since 14:02: `gh` is signed out".
    pub reason: Line<1, 200>,
}

/// What the numbers cover and what they can't.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MetricsCoverage {
    pub repos: List<RepoCoverage, 0, 200>,
    pub stale: List<RepoStale, 0, 200>,
    /// What fleetd can't see of the person's time, one plain line each, for the info sheet.
    pub invisible: List<Line<1, 200>, 0, 12>,
}

/// The previous period of the same length, for the compare toggle.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MetricsComparePeriod {
    pub since: Timestamp,
    pub until: Timestamp,
    pub days: List<MetricsDay, 0, 400>,
}

/// Days the hub keeps landed changes and touches: 400 by default, at least 30.
pub type MetricsRetentionDays = Int<30, 400>;

// Event data the metrics add to the log.

/// `app.presence`: the app was focused on a project's screen (the event's machine and project) with input in the
/// last 60 s, for one interval. Only that: never keystrokes or content. At most one per minute per key.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppPresenceData {
    /// Epoch milliseconds on the hub clock.
    pub from_ms: Count,
    pub to_ms: Count,
    /// The human key's name.
    pub by: Option<Line<1, 80>>,
}

/// `repo.advanced`: a node's fetch saw the remote's default branch move, so the hub reads the repo's merges now.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RepoAdvancedData {
    pub repo: RemoteRepo,
    pub branch: Line<1, 255>,
    /// Absent on the first fetch the node saw.
    pub from: Option<CommitSha>,
    pub to: CommitSha,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_repos_name_any_host_and_nothing_else() {
        for repo in [
            "github.com/acme/web",
            "gitlab.example.com/team/sub/api",
            "git.internal:2222/srv/tools",
            "dev.azure.com/org/project/_git/repo",
        ] {
            assert!(RemoteRepo::new(repo).is_ok(), "{repo}");
        }
        for repo in [
            "",
            "acme",
            "github.com/",
            "/acme/web",
            "https://github.com/acme/web",
            "git@github.com:acme/web",
            "github.com//web",
            "github.com/acme web",
        ] {
            assert!(RemoteRepo::new(repo).is_err(), "{repo}");
        }
    }

    #[test]
    fn names_round_trip_and_match_the_wire() {
        for route in MergeRoute::ALL {
            assert_eq!(MergeRoute::parse(route.as_str()), Some(route));
            assert_eq!(serde_json::to_value(route).unwrap(), route.as_str());
        }
        let mut names = std::collections::HashSet::new();
        for kind in TouchKind::ALL {
            assert!(names.insert(kind.as_str()), "{kind:?}");
            assert_eq!(TouchKind::parse(kind.as_str()), Some(*kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
        assert!(MergeRoute::Train.made_by_fleetd() && MergeRoute::FleetdByHand.made_by_fleetd());
        assert!(!MergeRoute::Outside.made_by_fleetd() && !MergeRoute::Direct.made_by_fleetd());
    }

    #[test]
    fn every_source_has_a_touch_and_only_host_touches_are_estimated() {
        for source in HumanSource::ALL {
            assert!(
                TouchKind::ALL.iter().any(|k| k.source() == source),
                "{source:?}"
            );
        }
        let estimated: Vec<_> = TouchKind::ALL
            .iter()
            .filter(|k| k.source().estimated())
            .collect();
        assert_eq!(estimated, [&TouchKind::Review, &TouchKind::Comment]);
    }

    #[test]
    fn the_tools_and_events_are_in_the_schemas() {
        use crate::auth::Role;
        use crate::events::HubEventType;
        use crate::mcp::McpToolName;

        assert_eq!(
            McpToolName::parse("metrics_get").map(McpToolName::scope),
            Some(Role::Read)
        );
        assert_eq!(
            McpToolName::parse("metrics_retention_set").map(McpToolName::scope),
            Some(Role::Admin)
        );
        let docs = crate::schema::json_schemas();
        let tools = &docs["McpTools"]["$defs"]["McpTools"]["properties"];
        for key in [
            "metrics_get.input",
            "metrics_get.output",
            "metrics_retention_set.input",
        ] {
            assert!(tools.get(key).is_some(), "{key}");
        }
        let input = &docs["McpTools"]["$defs"]["MetricsGetInput"];
        assert_eq!(input["required"], serde_json::json!(["since", "tz"]));
        let events = &docs["HubEventData"]["$defs"]["HubEventData"]["properties"];
        for t in [HubEventType::AppPresence, HubEventType::RepoAdvanced] {
            assert!(events.get(t.as_str()).is_some(), "{t:?}");
            assert_eq!(serde_json::to_value(t).unwrap(), t.as_str());
        }
        // Open enums: the app's TypeScript admits a newer hub's values.
        for name in ["MergeRoute", "SkipWhy", "GitHost"] {
            let def = &docs["McpTools"]["$defs"]
                .get(name)
                .or(docs["HubEventData"]["$defs"].get(name));
            assert_eq!(
                def.map(|d| &d["x-open"]),
                Some(&serde_json::json!(true)),
                "{name}"
            );
        }
    }

    #[test]
    fn the_input_defaults_and_bounds_hold() {
        use crate::mcp::{MetricsGetInput, MetricsRetentionSetInput};
        use serde_json::json;

        let input: MetricsGetInput =
            serde_json::from_value(json!({ "since": "2026-10-01T00:00:00.000Z", "tz": "UTC" }))
                .unwrap();
        assert!(!input.compare && input.project_ref.is_none() && input.until.is_none());
        for bad in [
            json!({ "since": "2026-10-01T00:00:00.000Z" }),
            json!({ "since": "2026-10-01T00:00:00.000Z", "tz": "+01:00" }),
            json!({ "tz": "UTC" }),
        ] {
            assert!(
                serde_json::from_value::<MetricsGetInput>(bad.clone()).is_err(),
                "{bad}"
            );
        }
        for (days, ok) in [(29, false), (30, true), (400, true), (401, false)] {
            let decoded = serde_json::from_value::<MetricsRetentionSetInput>(
                json!({ "retentionDays": days }),
            );
            assert_eq!(decoded.is_ok(), ok, "{days}");
        }
    }

    #[test]
    fn event_data_reads_back_and_refuses_a_bad_repo() {
        use serde_json::json;

        let sha = "5c4cc175aa00000000000000000000000000beef";
        let data = json!({ "repo": "gitlab.example.com/team/api", "branch": "main", "to": sha });
        let advanced: RepoAdvancedData = serde_json::from_value(data.clone()).unwrap();
        assert_eq!(advanced.from, None);
        assert_eq!(serde_json::to_value(&advanced).unwrap(), data);
        let bad =
            json!({ "repo": "https://gitlab.example.com/team/api", "branch": "main", "to": sha });
        assert!(serde_json::from_value::<RepoAdvancedData>(bad).is_err());

        let outside: crate::events::TrainEventData = serde_json::from_value(json!({
            "repo": "acme/web", "prNumber": 12, "mergedSha": sha, "mergedAt": "2026-10-20T09:30:00.000Z",
            "head": "fleetd/T45-metrics", "authorKind": "human", "mergedByKind": "human",
        }))
        .unwrap();
        assert_eq!(outside.author_kind, Some(ActorKind::Human));
        // An older hub's pr.merged_outside, without the new fields, still reads.
        let older: crate::events::TrainEventData =
            serde_json::from_value(json!({ "repo": "acme/web", "prNumber": 12, "mergedSha": sha }))
                .unwrap();
        assert_eq!((older.merged_at, older.head), (None, None));
    }

    #[test]
    fn values_from_a_newer_hub_degrade_instead_of_failing_the_read() {
        let route: MergeRoute = serde_json::from_value(serde_json::json!("cherry_pick")).unwrap();
        assert_eq!(route, MergeRoute::Unknown);
        let kind: TouchKind = serde_json::from_value(serde_json::json!("voice.note")).unwrap();
        assert_eq!(
            (kind, kind.source()),
            (TouchKind::Unknown, HumanSource::Other)
        );
        let why: SkipWhy = serde_json::from_value(serde_json::json!("revert")).unwrap();
        assert_eq!(why, SkipWhy::Unknown);
        let host: GitHost = serde_json::from_value(serde_json::json!("sourcehut")).unwrap();
        assert_eq!(host, GitHost::Unknown);
    }
}
