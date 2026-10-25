//! The figures, pure: stored rows + range + zone → tiles, calendar days, the merge list and per-repo rows. Days are
//! calendar days in the viewer's zone and empty ones count: "per day" is a rate over the range. Medians and p90 don't
//! add across days, so everything is computed from rows on each read.
use std::collections::{BTreeMap, BTreeSet};

use chrono::{Days, NaiveDate, TimeZone as _};
use chrono_tz::Tz;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::metrics::{
    ActorKind, HumanTile, LocalDate, MergeRoute, MergedTile, MetricsDay, MetricsMerge,
    MetricsRepoRow, MetricsTiles, OrderToMergedTile, RemoteRepo, RequestedBasis, RouteCounts,
    RouteLines, SkipCount, SkipWhy, Spark, SparkPoint, ThroughFleetdTile,
};
use fleetd_contracts::prim::{Count, Line, List, NonNegative, Positive, Text};
use fleetd_contracts::tasks::TaskId;
use fleetd_contracts::train::ChangeId;
use fleetd_contracts::verification::CommitSha;

use super::store::{MergeRow, SKIPPED};
use crate::hub::store::iso_ms;

/// The day list's bound: a range is clamped to this many calendar days in its zone.
pub const MAX_DAYS: usize = 400;
pub const SPARK_POINTS: usize = 12;
const HOUR_MS: i64 = 3_600_000;

/// One calendar day of a range, cut to the range: `[start, end)`.
#[derive(Clone, Debug, PartialEq)]
pub struct Day {
    pub date: NaiveDate,
    pub start: i64,
    pub end: i64,
    /// The whole calendar day's length (23, 24 or 25 hours).
    pub len: i64,
}

pub fn local_date(ms: i64, tz: Tz) -> NaiveDate {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .with_timezone(&tz)
        .date_naive()
}

/// When `date` starts in `tz`: its midnight, or the first hour that exists where a DST gap swallows midnight.
pub fn day_start(date: NaiveDate, tz: Tz) -> i64 {
    (0..24)
        .find_map(|h| {
            tz.from_local_datetime(&date.and_hms_opt(h, 0, 0)?)
                .earliest()
        })
        .map_or_else(
            || {
                date.and_hms_opt(0, 0, 0)
                    .unwrap_or_default()
                    .and_utc()
                    .timestamp_millis()
            },
            |t| t.timestamp_millis(),
        )
}

fn next(date: NaiveDate) -> NaiveDate {
    date.checked_add_days(Days::new(1)).unwrap_or(date)
}

/// The `since` that keeps `[since, until)` within [`MAX_DAYS`] calendar days in `tz`: in a zone off UTC a range of
/// whole UTC days starts and ends mid-day, one day more than it is long.
pub fn clamp_since(since: i64, until: i64, tz: Tz) -> i64 {
    let last = local_date(until - 1, tz);
    let first = last
        .checked_sub_days(Days::new(MAX_DAYS as u64 - 1))
        .unwrap_or(last);
    since.max(day_start(first, tz))
}

/// The calendar days of `[since, until)` in `tz`, oldest first, each cut to the range.
pub fn days(since: i64, until: i64, tz: Tz) -> Vec<Day> {
    let mut out = Vec::new();
    let mut date = local_date(since, tz);
    while out.len() < MAX_DAYS {
        let (start, end) = (day_start(date, tz), day_start(next(date), tz));
        if start >= until || end <= start {
            break;
        }
        out.push(Day {
            date,
            start: start.max(since),
            end: end.min(until),
            len: end - start,
        });
        date = next(date);
    }
    out
}

/// How many days a run of days is worth for a rate: whole days 1 each, a cut one its share, at least an hour.
fn day_weight(days: &[Day]) -> f64 {
    days.iter()
        .map(|d| (d.end - d.start).max(HOUR_MS) as f64 / d.len.max(1) as f64)
        .map(|w| w.min(1.0))
        .sum()
}

pub fn route_of(row: &MergeRow) -> Option<MergeRoute> {
    MergeRoute::parse(&row.route)
}

fn skip_of(row: &MergeRow) -> Option<SkipWhy> {
    (row.route == SKIPPED)
        .then_some(row.skip_why.as_deref())
        .flatten()
        .and_then(|w| match w {
            "bot" => Some(SkipWhy::Bot),
            "other_base" => Some(SkipWhy::OtherBase),
            "merge_back" => Some(SkipWhy::MergeBack),
            _ => None,
        })
}

fn actor_of(s: Option<&str>) -> Option<ActorKind> {
    match s? {
        "human" => Some(ActorKind::Human),
        "bot" => Some(ActorKind::Bot),
        "train" => Some(ActorKind::Train),
        "unknown" => Some(ActorKind::Unknown),
        _ => None,
    }
}

fn basis_of(s: Option<&str>) -> Option<RequestedBasis> {
    match s? {
        "source" => Some(RequestedBasis::Source),
        "chat" => Some(RequestedBasis::Chat),
        "opened" => Some(RequestedBasis::Opened),
        _ => None,
    }
}

fn count(n: i64) -> Count {
    Count::unchecked(n.max(0))
}

fn ts(ms: i64) -> Timestamp {
    Timestamp(iso_ms(ms))
}

fn number(v: f64) -> NonNegative {
    NonNegative::unchecked(if v.is_finite() { v.max(0.0) } else { 0.0 })
}

/// The middle value; the mean of the two middle ones when even.
pub fn median(sorted: &[i64]) -> Option<i64> {
    let n = sorted.len();
    match n {
        0 => None,
        _ if n % 2 == 1 => Some(sorted[n / 2]),
        _ => Some((sorted[n / 2 - 1] + sorted[n / 2]) / 2),
    }
}

/// Nearest rank: the smallest value with at least `p` of the values at or under it.
pub fn percentile(sorted: &[i64], p: f64) -> Option<i64> {
    let n = sorted.len();
    (n > 0).then(|| sorted[((p * n as f64).ceil() as usize).clamp(1, n) - 1])
}

/// Time from order to merged of a landed change that belongs to an order.
pub fn order_ms(row: &MergeRow) -> Option<i64> {
    route_of(row)
        .filter(|r| r.made_by_fleetd())
        .and(row.requested_ms)
        .map(|req| (row.merged_ms - req).max(0))
}

fn pr_open_ms(row: &MergeRow) -> Option<i64> {
    row.pr_created_ms.map(|c| (row.merged_ms - c).max(0))
}

/// The four routes' figures over a set of rows.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stats {
    pub by_route: [i64; 4],
    pub order_ms: Vec<i64>,
    pub from_opened: i64,
    pub pr_open_ms: Vec<i64>,
    /// (additions, deletions, rows with lines) per route.
    pub lines: [(i64, i64, i64); 4],
}

impl Stats {
    pub fn of<'a>(rows: impl IntoIterator<Item = &'a MergeRow>) -> Self {
        let mut s = Stats::default();
        for row in rows {
            let Some(route) = route_of(row) else { continue };
            let Some(i) = MergeRoute::ALL.iter().position(|r| *r == route) else {
                continue;
            };
            s.by_route[i] += 1;
            if let Some(ms) = order_ms(row) {
                s.order_ms.push(ms);
                s.from_opened += i64::from(row.requested_basis.as_deref() == Some("opened"));
            }
            s.pr_open_ms.extend(pr_open_ms(row));
            if row.additions.is_some() || row.deletions.is_some() {
                let l = &mut s.lines[i];
                l.0 += row.additions.unwrap_or(0);
                l.1 += row.deletions.unwrap_or(0);
                l.2 += 1;
            }
        }
        s.order_ms.sort_unstable();
        s.pr_open_ms.sort_unstable();
        s
    }

    pub fn n(&self) -> i64 {
        self.by_route.iter().sum()
    }

    fn train(&self) -> i64 {
        self.by_route[0]
    }

    fn made_by_fleetd(&self) -> i64 {
        self.by_route[0] + self.by_route[1]
    }

    fn no_order(&self) -> i64 {
        self.by_route[2] + self.by_route[3]
    }

    pub fn pct(&self) -> Option<f64> {
        (self.n() > 0).then(|| 100.0 * self.train() as f64 / self.n() as f64)
    }

    fn made_pct(&self) -> Option<f64> {
        (self.n() > 0).then(|| 100.0 * self.made_by_fleetd() as f64 / self.n() as f64)
    }

    fn counts(&self) -> RouteCounts {
        RouteCounts {
            train: count(self.by_route[0]),
            fleetd_by_hand: count(self.by_route[1]),
            outside: count(self.by_route[2]),
            direct: count(self.by_route[3]),
        }
    }
}

fn in_days<'a>(rows: &'a [MergeRow], days: &[Day]) -> impl Iterator<Item = &'a MergeRow> {
    let (from, to) = (
        days.first().map_or(0, |d| d.start),
        days.last().map_or(0, |d| d.end),
    );
    rows.iter()
        .filter(move |r| r.merged_ms >= from && r.merged_ms < to)
}

/// Up to [`SPARK_POINTS`] runs of whole days, as even as they divide.
fn slices(days: &[Day]) -> Vec<&[Day]> {
    let k = days.len().min(SPARK_POINTS);
    (0..k)
        .map(|i| &days[i * days.len() / k..(i + 1) * days.len() / k])
        .collect()
}

fn spark(rows: &[MergeRow], days: &[Day], value: impl Fn(&Stats, &[Day]) -> Option<f64>) -> Spark {
    List::unchecked(
        slices(days)
            .into_iter()
            .map(|slice| SparkPoint {
                since: ts(slice[0].start),
                value: value(&Stats::of(in_days(rows, slice)), slice).map(number),
            })
            .collect(),
    )
}

fn per_day(s: &Stats, days: &[Day]) -> f64 {
    let w = day_weight(days);
    if w > 0.0 { s.n() as f64 / w } else { 0.0 }
}

/// A range's rows (landed and skipped) and days, and whether the figures before it were read.
pub struct Period<'a> {
    pub rows: &'a [MergeRow],
    pub days: &'a [Day],
}

/// The KPI row. `previous` is the period of the same length before, when its merges were known.
pub fn tiles(cur: &Period, previous: Option<&Period>) -> MetricsTiles {
    let s = Stats::of(cur.rows);
    let prev = previous.map(|p| (Stats::of(p.rows), p.days));
    let ms = |v: Option<i64>| v.map(count);
    MetricsTiles {
        merged: MergedTile {
            per_day: number(per_day(&s, cur.days)),
            n: count(s.n()),
            by_route: s.counts(),
            previous_per_day: prev.as_ref().map(|(p, d)| number(per_day(p, d))),
            spark: spark(cur.rows, cur.days, |s, d| Some(per_day(s, d))),
        },
        order_to_merged: OrderToMergedTile {
            median_ms: ms(median(&s.order_ms)),
            p90_ms: ms(percentile(&s.order_ms, 0.9)),
            n: count(s.order_ms.len() as i64),
            from_opened: count(s.from_opened),
            no_order: count(s.no_order()),
            pr_open_median_ms: ms(median(&s.pr_open_ms)),
            previous_median_ms: prev.as_ref().and_then(|(p, _)| ms(median(&p.order_ms))),
            spark: spark(cur.rows, cur.days, |s, _| {
                median(&s.order_ms).map(|m| m as f64)
            }),
        },
        // The person's minutes come with the touches (metrics PR 4): none are counted yet.
        human: HumanTile {
            per_pr_ms: None,
            total_ms: count(0),
            low_ms: count(0),
            prs: count(s.made_by_fleetd()),
            outside_per_pr_ms: None,
            outside_total_ms: count(0),
            outside_prs: count(s.no_order()),
            previous_per_pr_ms: None,
            spark: List::unchecked(Vec::new()),
        },
        through_fleetd: ThroughFleetdTile {
            pct: s.pct().map(number),
            made_by_fleetd_pct: s.made_pct().map(number),
            n: count(s.n()),
            lines: List::unchecked(
                MergeRoute::ALL
                    .iter()
                    .zip(s.lines)
                    .filter(|(_, l)| l.2 > 0)
                    .map(|(route, l)| RouteLines {
                        route: *route,
                        additions: count(l.0),
                        deletions: count(l.1),
                    })
                    .collect(),
            ),
            previous_pct: prev.as_ref().and_then(|(p, _)| p.pct()).map(number),
            spark: spark(cur.rows, cur.days, |s, _| s.pct()),
        },
    }
}

/// Every day of the period, empty ones too: merges by route, and merges not counted by why.
pub fn day_list(p: &Period) -> Vec<MetricsDay> {
    p.days
        .iter()
        .map(|d| {
            let rows: Vec<&MergeRow> = p
                .rows
                .iter()
                .filter(|r| r.merged_ms >= d.start && r.merged_ms < d.end)
                .collect();
            let mut skipped: BTreeMap<SkipWhy, i64> = BTreeMap::new();
            for why in rows.iter().filter_map(|r| skip_of(r)) {
                *skipped.entry(why).or_default() += 1;
            }
            MetricsDay {
                day: LocalDate::unchecked(d.date.format("%Y-%m-%d").to_string()),
                merged: Stats::of(rows.iter().copied()).counts(),
                not_counted: List::unchecked(
                    skipped
                        .into_iter()
                        .map(|(why, n)| SkipCount { why, n: count(n) })
                        .collect(),
                ),
                human: List::unchecked(Vec::new()),
            }
        })
        .collect()
}

fn project_ref(machine: &str, project: &str) -> Option<ProjectRef> {
    Some(ProjectRef {
        machine_id: MachineId::new(machine).ok()?,
        project_id: ProjectId::new(project).ok()?,
    })
}

/// One landed change for the list; `None` for a skipped merge or a row this build can't name.
pub fn merge_item(row: &MergeRow) -> Option<MetricsMerge> {
    let route = route_of(row)?;
    let project_ref = row
        .machine_id
        .as_deref()
        .zip(row.project_id.as_deref())
        .and_then(|(m, p)| project_ref(m, p));
    Some(MetricsMerge {
        repo: RemoteRepo::new(&row.repo).ok()?,
        pr_number: row.pr_number.and_then(|n| Positive::new(n).ok()),
        sha: row
            .merged_sha
            .as_deref()
            .and_then(|s| CommitSha::new(s).ok()),
        title: row
            .title
            .as_deref()
            .and_then(|t| Line::new(crate::node::util::head_utf16(t, 200)).ok()),
        url: row.url.as_deref().and_then(|u| Text::new(u).ok()),
        route,
        merged_at: ts(row.merged_ms),
        project_ref,
        workstream_id: row
            .workstream_id
            .as_deref()
            .and_then(|w| WorkstreamId::new(w).ok()),
        task_id: row.task_id.as_deref().and_then(|t| TaskId::new(t).ok()),
        change_id: row.change_id.as_deref().and_then(|c| ChangeId::new(c).ok()),
        batch_pr: row.batch_pr.and_then(|n| Positive::new(n).ok()),
        requested_at: row.requested_ms.filter(|_| route.made_by_fleetd()).map(ts),
        requested_basis: basis_of(row.requested_basis.as_deref())
            .filter(|_| route.made_by_fleetd()),
        first_pr_at: row.first_pr_ms.map(ts),
        review_passed_at: row.review_passed_ms.map(ts),
        order_to_merged_ms: order_ms(row).map(count),
        pr_created_at: row.pr_created_ms.map(ts),
        pr_open_to_merged_ms: pr_open_ms(row).map(count),
        author: actor_of(row.author_kind.as_deref()),
        merged_by: actor_of(row.merged_by_kind.as_deref()),
        additions: row.additions.map(count),
        deletions: row.deletions.map(count),
        touches: count(0),
        seen_claim: row.seen_claim.as_deref().and_then(|c| Line::new(c).ok()),
    })
}

/// One row per repo, every repo in `projects` included even with no merges, for the cross-fleet table.
pub fn repo_rows(
    p: &Period,
    projects: &BTreeMap<String, BTreeSet<(String, String)>>,
) -> Vec<MetricsRepoRow> {
    projects
        .iter()
        .filter_map(|(repo, refs)| {
            let rows: Vec<MergeRow> = p.rows.iter().filter(|r| &r.repo == repo).cloned().collect();
            let s = Stats::of(&rows);
            Some(MetricsRepoRow {
                repo: RemoteRepo::new(repo).ok()?,
                projects: List::unchecked(
                    refs.iter()
                        .filter_map(|(m, p)| project_ref(m, p))
                        .take(20)
                        .collect(),
                ),
                merged_per_day: number(per_day(&s, p.days)),
                n: count(s.n()),
                order_to_merged_median_ms: median(&s.order_ms).map(count),
                human_per_pr_ms: None,
                through_fleetd_pct: s.pct().map(number),
                spark: spark(&rows, p.days, |s, d| Some(per_day(s, d))),
            })
        })
        .collect()
}
