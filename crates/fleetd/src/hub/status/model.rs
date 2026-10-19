//! The progress model: an item earns part of its size at each stage fleetd observed (an event, a PR or a CI state),
//! and moves smoothly inside a stage toward the next one without ever claiming it. Pure: callers load the facts and
//! the calibration (stage weights and durations measured from the time inspector's spans, `calib.rs`).
use std::collections::HashMap;

use fleetd_contracts::plan::{ItemStage, Size};
use fleetd_contracts::status::{DropReason, WeightsBasis};
use fleetd_contracts::train::ChangeState;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The stages that count, `Planned` (index 0) to `Verified` (index 8).
pub const STAGES: usize = 9;
/// Inside a stage an item earns at most this share of the next stage's weight.
pub const IN_STAGE_CAP: f64 = 0.9;
/// Past this multiple of the usual time for its stage an item is "slower than usual".
pub const SLOW_FACTOR: f64 = 1.5;
/// Finished units a project needs before its own weights or durations are used, else the fleet's, else defaults.
pub const MIN_WEIGHT_SAMPLES: i64 = 5;
pub const MIN_DURATION_SAMPLES: i64 = 3;

const MIN: i64 = 60_000;

/// Cumulative credit at each stage: `cum[0] = 0` (planned) up to `cum[8] = 1` (verified), never decreasing.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StageWeights {
    pub cum: [f64; STAGES],
}

impl Default for StageWeights {
    /// Where an item's time goes when nothing is measured yet: most of it writing (task started to first push), then
    /// review, CI, the train and the done-when checks.
    fn default() -> Self {
        Self::from_shares([0.0, 0.03, 0.06, 0.45, 0.52, 0.68, 0.78, 0.84, 1.0])
    }
}

impl StageWeights {
    /// From the median share of an item's wall time spent before each stage: clamped to [0, 1], made
    /// non-decreasing, and every stage after planned keeps at least 1% so reaching it always shows.
    pub fn from_shares(shares: [f64; STAGES]) -> Self {
        const FLOOR: f64 = 0.01;
        let mut cum = [0.0; STAGES];
        let mut prev: f64 = 0.0;
        for k in 1..STAGES {
            let s = if shares[k].is_finite() {
                shares[k].clamp(0.0, 1.0)
            } else {
                prev
            };
            cum[k] = s.max(prev);
            prev = cum[k];
        }
        // Make room for the floor on every step, then rescale so verified is exactly 1.
        let total = cum[STAGES - 1].max(f64::EPSILON);
        let spare = 1.0 - FLOOR * (STAGES - 1) as f64;
        let mut out = [0.0; STAGES];
        for k in 1..STAGES {
            let step = (cum[k] - cum[k - 1]) / total;
            out[k] = out[k - 1] + FLOOR + step * spare;
        }
        out[STAGES - 1] = 1.0;
        Self { cum: out }
    }

    /// What reaching `stage` adds.
    pub fn weight(&self, stage: usize) -> f64 {
        if stage == 0 || stage >= STAGES {
            0.0
        } else {
            self.cum[stage] - self.cum[stage - 1]
        }
    }
}

/// Usual time from each stage to the next (`p50[k]`: stage k to k+1), ms.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StageDurations {
    pub p50: [i64; STAGES - 1],
    pub p90: [i64; STAGES - 1],
    pub samples: i64,
}

impl StageDurations {
    /// A whole item of `total_ms` split along the weights; p90 at twice the median.
    pub fn spread(total_ms: i64, w: &StageWeights) -> Self {
        let mut p50 = [0; STAGES - 1];
        let mut p90 = [0; STAGES - 1];
        for k in 0..STAGES - 1 {
            p50[k] = ((total_ms as f64) * w.weight(k + 1))
                .round()
                .max(MIN as f64) as i64;
            p90[k] = 2 * p50[k];
        }
        Self {
            p50,
            p90,
            samples: 0,
        }
    }

    pub fn total_p50(&self) -> i64 {
        self.p50.iter().sum()
    }
}

/// An item of the plan, or a whole order with no plan items.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitKind {
    Item,
    Order,
}

/// Built-in item length by size when nothing is measured (the plan asks for items of about an hour or less).
pub fn default_total_ms(size: Size) -> i64 {
    match size {
        Size::S => 30 * MIN,
        Size::M => 60 * MIN,
        Size::L => 180 * MIN,
    }
}

/// Measured parameters of one scope (a project, or the fleet).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Params {
    pub weights: Option<StageWeights>,
    pub weight_samples: i64,
    /// Per (kind, size).
    pub durations: Vec<DurationRow>,
    /// Planning's median share of an order's wall time, and its median length.
    pub planning_share: Option<f64>,
    pub planning_p50_ms: Option<i64>,
    pub planning_samples: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DurationRow {
    pub kind: UnitKind,
    pub size: Size,
    pub durations: StageDurations,
}

impl Params {
    fn durations(&self, kind: UnitKind, size: Size) -> Option<&StageDurations> {
        self.durations
            .iter()
            .find(|d| {
                d.kind == kind && d.size == size && d.durations.samples >= MIN_DURATION_SAMPLES
            })
            .map(|d| &d.durations)
    }
}

/// How close predicted p50s came to the actual finish: four in five within ±`within_pct`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Accuracy {
    pub within_pct: i64,
    pub samples: i64,
}

/// What the model is calibrated with, recomputed nightly by `calib.rs`. `Default` is the built-in model.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Calibration {
    pub fleet: Params,
    /// By project key (`machine/project`).
    pub projects: HashMap<String, Params>,
    pub accuracy: Option<Accuracy>,
    pub computed_ms: i64,
}

pub const DEFAULT_PLANNING_SHARE: f64 = 0.08;
pub const DEFAULT_PLANNING_MS: i64 = 10 * MIN;

/// The weights and durations one unit is measured against, after the project → fleet → default fallback.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub weights: StageWeights,
    pub basis: WeightsBasis,
    pub durations: StageDurations,
}

impl Calibration {
    pub fn resolve(&self, pkey: &str, kind: UnitKind, size: Size) -> Resolved {
        let project = self.projects.get(pkey);
        let (weights, basis) = match (project, &self.fleet) {
            (Some(p), _) if p.weight_samples >= MIN_WEIGHT_SAMPLES && p.weights.is_some() => {
                (p.weights.clone().unwrap_or_default(), WeightsBasis::Project)
            }
            (_, f) if f.weight_samples >= MIN_WEIGHT_SAMPLES && f.weights.is_some() => {
                (f.weights.clone().unwrap_or_default(), WeightsBasis::Fleet)
            }
            _ => (StageWeights::default(), WeightsBasis::Default),
        };
        let durations = project
            .and_then(|p| p.durations(kind, size))
            .or_else(|| self.fleet.durations(kind, size))
            .cloned()
            .unwrap_or_else(|| StageDurations::spread(default_total_ms(size), &weights));
        Resolved {
            weights,
            basis,
            durations,
        }
    }

    /// Planning's share of an order and its usual length.
    pub fn planning(&self, pkey: &str) -> (f64, i64) {
        let pick = |p: &Params| {
            (p.planning_samples >= MIN_DURATION_SAMPLES)
                .then_some((p.planning_share?, p.planning_p50_ms?))
        };
        let (share, ms) = self
            .projects
            .get(pkey)
            .and_then(pick)
            .or_else(|| pick(&self.fleet))
            .unwrap_or((DEFAULT_PLANNING_SHARE, DEFAULT_PLANNING_MS));
        (share.clamp(0.02, 0.3), ms.max(MIN))
    }
}

/// The stages fleetd observed for one unit, with when each was reached. A stage the unit fell back from (a failed
/// review or CI) is left out by the caller, so the furthest one listed is where it is now.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ItemFacts {
    pub reached: Vec<(ItemStage, i64)>,
}

impl ItemFacts {
    /// The furthest stage and when it was entered.
    pub fn current(&self) -> (ItemStage, i64) {
        self.reached
            .iter()
            .filter(|(s, _)| *s != ItemStage::Unknown)
            .max_by_key(|(s, at)| (*s, std::cmp::Reverse(*at)))
            .copied()
            .unwrap_or((ItemStage::Planned, 0))
    }
}

/// A unit the model credits: a plan item, or an order with no plan items (its tasks and PRs are its stages).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum UnitKey {
    Item(i64),
    Order(String),
}

/// Something fleetd observed about a unit. The caller sends an order's facts to each of its units (an item is
/// `BriefFrozen` when it is added to an order whose brief is frozen, or when the brief freezes later).
#[derive(Clone, Debug, PartialEq)]
pub enum What {
    Created,
    BriefFrozen,
    TaskStarted,
    /// A linked task pushed its branch (a `git push` or `gh pr create` span).
    Pushed,
    /// A linked Change was created (state `queued`) or moved to `state`.
    ChangeState {
        change: String,
        state: ChangeState,
    },
    /// fleetd verified it (`plan.verified`, or `workstream.done` for an order).
    Verified,
    /// A later check failed: it is no longer verified.
    Reopened,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Obs {
    pub at_ms: i64,
    pub unit: UnitKey,
    pub what: What,
}

/// Where a Change puts its item. A failed review, a red CI or a rebase conflict send the item back to "PR open";
/// a refused or abandoned Change no longer counts.
pub fn change_stage(state: ChangeState) -> Option<ItemStage> {
    use ChangeState::*;
    Some(match state {
        Queued | Reviewing | NeedsRebase | CiFailed => ItemStage::PrOpen,
        Ready | Rebasing | Ci => ItemStage::ReviewPassed,
        Merging => ItemStage::CiGreen,
        Merged => ItemStage::Merged,
        Refused | Abandoned => return None,
    })
}

#[derive(Default)]
struct Fold {
    created: Option<i64>,
    brief: Option<i64>,
    started: Option<i64>,
    pushed: Option<i64>,
    /// change → (first seen, its stage, entered that stage).
    changes: HashMap<String, (i64, Option<ItemStage>, i64)>,
    verified: Option<i64>,
}

/// Each unit's observed stages as of `until_ms`, from observations in any order. Only what fleetd saw counts: a
/// stage is listed once it was observed, and a unit that fell back (its Change went back to review or red CI) is
/// where its Changes are now.
pub fn observe(obs: &[Obs], until_ms: i64) -> HashMap<UnitKey, ItemFacts> {
    let mut sorted: Vec<&Obs> = obs.iter().filter(|o| o.at_ms <= until_ms).collect();
    sorted.sort_by_key(|o| o.at_ms);
    let mut folds: HashMap<UnitKey, Fold> = HashMap::new();
    for o in sorted {
        let f = folds.entry(o.unit.clone()).or_default();
        let first = |slot: &mut Option<i64>| {
            slot.get_or_insert(o.at_ms);
        };
        match &o.what {
            What::Created => first(&mut f.created),
            What::BriefFrozen => first(&mut f.brief),
            What::TaskStarted => first(&mut f.started),
            What::Pushed => first(&mut f.pushed),
            What::ChangeState { change, state } => {
                let stage = change_stage(*state);
                let e = f
                    .changes
                    .entry(change.clone())
                    .or_insert((o.at_ms, stage, o.at_ms));
                if e.1 != stage {
                    e.1 = stage;
                    e.2 = o.at_ms;
                }
            }
            What::Verified => first(&mut f.verified),
            What::Reopened => f.verified = None,
        }
    }
    folds
        .into_iter()
        .map(|(k, f)| {
            let mut reached = Vec::new();
            let mut push = |s: ItemStage, at: Option<i64>| {
                if let Some(at) = at {
                    reached.push((s, at));
                }
            };
            push(ItemStage::Planned, f.created);
            push(ItemStage::BriefFrozen, f.brief);
            push(ItemStage::TaskStarted, f.started);
            push(ItemStage::FirstPush, f.pushed);
            let live: Vec<&(i64, Option<ItemStage>, i64)> =
                f.changes.values().filter(|c| c.1.is_some()).collect();
            if let Some(opened) = live.iter().map(|c| c.0).min() {
                let (stage, since) = live
                    .iter()
                    .filter_map(|c| Some((c.1?, c.2)))
                    .min_by_key(|(s, at)| (*s, std::cmp::Reverse(*at)))
                    .unwrap_or((ItemStage::PrOpen, opened));
                let opened = if stage == ItemStage::PrOpen {
                    since
                } else {
                    opened
                };
                push(ItemStage::PrOpen, Some(opened));
                if stage > ItemStage::PrOpen {
                    push(stage, Some(since));
                }
            }
            push(ItemStage::Verified, f.verified);
            (k, ItemFacts { reached })
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct ItemProgress {
    pub stage: ItemStage,
    /// Share of the unit credited, 0 to 1. Below the next stage's cumulative weight until that stage is observed.
    pub credit: f64,
    pub verified: bool,
    /// Past 1.5× the usual time for its current stage.
    pub slower: bool,
    pub remaining_p50_ms: i64,
    pub remaining_p90_ms: i64,
}

/// Stage credit plus in-stage smoothing: `cum[k] + weight(k+1) × min(elapsed / usual, 0.9)`.
pub fn item_progress(f: &ItemFacts, now: i64, r: &Resolved) -> ItemProgress {
    let (stage, entered) = f.current();
    let k = stage.index();
    if stage == ItemStage::Verified {
        return ItemProgress {
            stage,
            credit: 1.0,
            verified: true,
            slower: false,
            remaining_p50_ms: 0,
            remaining_p90_ms: 0,
        };
    }
    let elapsed = (now - entered).max(0);
    let usual = r.durations.p50[k].max(1);
    let frac = (elapsed as f64 / usual as f64).min(IN_STAGE_CAP);
    let credit = r.weights.cum[k] + r.weights.weight(k + 1) * frac;
    // A unit over its usual time still has some of the stage left: never "due now".
    let left = |d: i64| (d - elapsed).max(usual / 10);
    let rest50: i64 = r.durations.p50[k + 1..].iter().sum();
    let rest90: i64 = r.durations.p90[k + 1..].iter().sum();
    ItemProgress {
        stage,
        credit,
        verified: false,
        slower: elapsed as f64 > SLOW_FACTOR * usual as f64,
        remaining_p50_ms: left(usual) + rest50,
        remaining_p90_ms: left(r.durations.p90[k].max(usual)) + rest90,
    }
}

/// An order's planning: while its lead plans (no plan items, no task started yet) it has its own bar.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Planning {
    pub active: bool,
    /// 0 to 1: elapsed over the usual planning time, at most 0.9 while active; 1 after.
    pub credit: f64,
    /// Planning's share of the order, fixed once the plan exists.
    pub share: f64,
    pub since_ms: i64,
}

pub fn planning(
    since_ms: i64,
    ended_ms: Option<i64>,
    now: i64,
    share: f64,
    usual_ms: i64,
) -> Planning {
    match ended_ms {
        Some(_) => Planning {
            active: false,
            credit: 1.0,
            share,
            since_ms,
        },
        None => Planning {
            active: true,
            credit: ((now - since_ms).max(0) as f64 / usual_ms.max(1) as f64).min(IN_STAGE_CAP),
            share,
            since_ms,
        },
    }
}

/// One unit's part of a scope's figure.
#[derive(Clone, Debug, PartialEq)]
pub struct Unit {
    pub points: f64,
    pub progress: ItemProgress,
}

/// An order's units with its planning share; units outside any order go in with `planning: None`.
#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    /// The order's size in points (its items', or its tier's while it has none).
    pub points: f64,
    pub planning: Option<Planning>,
    pub units: Vec<Unit>,
    /// Every must unit is verified (the order is done).
    pub done: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Estimate {
    /// 0 to 100.
    pub pct: i64,
    pub verified_pct: i64,
    pub in_flight_pct: i64,
}

/// A scope's estimate: Σ credit over Σ points. Within an order, planning holds its share and the units the rest.
/// 100 only when everything is verified.
pub fn estimate(groups: &[Group]) -> Estimate {
    let (mut total, mut credit, mut verified) = (0.0, 0.0, 0.0);
    for g in groups {
        if g.points <= 0.0 {
            continue;
        }
        let unit_pts: f64 = g.units.iter().map(|u| u.points).sum();
        let (frac, vfrac) = if unit_pts > 0.0 {
            (
                g.units
                    .iter()
                    .map(|u| u.points * u.progress.credit)
                    .sum::<f64>()
                    / unit_pts,
                g.units
                    .iter()
                    .filter(|u| u.progress.verified)
                    .map(|u| u.points)
                    .sum::<f64>()
                    / unit_pts,
            )
        } else {
            (0.0, 0.0)
        };
        let (share, pc) = g.planning.map_or((0.0, 0.0), |p| (p.share, p.credit));
        total += g.points;
        credit += g.points * (share * pc + (1.0 - share) * frac);
        verified += g.points * if g.done { 1.0 } else { (1.0 - share) * vfrac };
    }
    if total <= 0.0 {
        return Estimate::default();
    }
    let all_done = groups.iter().all(|g| g.points <= 0.0 || g.done);
    let pct_of = |x: f64| {
        let p = (100.0 * x / total).floor() as i64;
        if all_done { p.min(100) } else { p.min(99) }
    };
    let verified_pct = pct_of(verified);
    let pct = pct_of(credit).max(verified_pct);
    Estimate {
        pct,
        verified_pct,
        in_flight_pct: pct - verified_pct,
    }
}

/// p50 and p90 of a scope's remaining time: the units' remaining stage time spread over the slots the scope can use,
/// and never shorter than its longest unit or `after` chain (`floor_ms`, at each percentile).
pub fn scope_eta(
    units: &[&ItemProgress],
    parallel: usize,
    floor_ms: (i64, i64),
    now: i64,
) -> (i64, i64) {
    let open: Vec<&&ItemProgress> = units.iter().filter(|u| !u.verified).collect();
    if open.is_empty() {
        return (now, now);
    }
    let par = parallel.clamp(1, open.len()) as i64;
    let sum50: i64 = open.iter().map(|u| u.remaining_p50_ms).sum();
    let sum90: i64 = open.iter().map(|u| u.remaining_p90_ms).sum();
    let long50 = open.iter().map(|u| u.remaining_p50_ms).max().unwrap_or(0);
    let long90 = open.iter().map(|u| u.remaining_p90_ms).max().unwrap_or(0);
    let p50 = (sum50 / par).max(long50).max(floor_ms.0);
    let p90 = (sum90 / par).max(long90).max(floor_ms.1).max(p50);
    (now + p50, now + p90)
}

/// One point of a scope's series.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub at_ms: i64,
    pub pct: i64,
    pub verified: i64,
    pub drop: Option<PointDrop>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PointDrop {
    pub reason: DropReason,
    pub from_pct: i64,
    pub text: String,
}

/// Something observed that may lower a figure: added scope, a failed review or CI (an item falls back a stage), or a
/// reopened item.
#[derive(Clone, Debug, PartialEq)]
pub struct Cause {
    pub at_ms: i64,
    pub reason: DropReason,
    pub text: String,
}

/// The drop cause an event is, if any: `data` is the event's `data` object. Scope it to the figure's orders first.
pub fn cause_of(event_type: &str, data: &Value, at_ms: i64) -> Option<Cause> {
    let str_of = |k: &str| data.get(k).and_then(Value::as_str);
    let pr = || {
        data.get("prNumber").and_then(Value::as_i64).map_or_else(
            || str_of("changeId").unwrap_or("a PR").to_owned(),
            |n| format!("#{n}"),
        )
    };
    let (reason, text) = match event_type {
        "plan.changed" => match str_of("kind")? {
            "scope" if data.get("deltaSize").and_then(Value::as_i64).unwrap_or(0) > 0 => {
                (DropReason::ScopeChange, str_of("note")?.to_owned())
            }
            "milestone_reopened" => (DropReason::ScopeChange, str_of("note")?.to_owned()),
            "reopened" => (DropReason::Reopened, str_of("note")?.to_owned()),
            _ => return None,
        },
        "change.ci_failed" => (DropReason::CiFailed, format!("CI failed on {}", pr())),
        "review.verdict" if data.get("blocking").and_then(Value::as_i64).unwrap_or(0) > 0 => {
            let n = data.get("blocking").and_then(Value::as_i64).unwrap_or(0);
            let on = str_of("pr")
                .and_then(|u| u.rsplit('/').next())
                .map_or_else(String::new, |n| format!(" on #{n}"));
            (
                DropReason::ReviewFailed,
                format!(
                    "review found {n} blocking issue{}{on}",
                    if n == 1 { "" } else { "s" }
                ),
            )
        }
        "change.state" => {
            let from = serde_json::from_value::<ChangeState>(data.get("from")?.clone()).ok()?;
            let to = serde_json::from_value::<ChangeState>(data.get("to")?.clone()).ok()?;
            if change_stage(to)? >= change_stage(from)? {
                return None;
            }
            match to {
                ChangeState::CiFailed => (DropReason::CiFailed, format!("CI failed on {}", pr())),
                ChangeState::NeedsRebase => {
                    (DropReason::CiFailed, format!("{} needs a rebase", pr()))
                }
                _ => (
                    DropReason::ReviewFailed,
                    format!("{} went back to review", pr()),
                ),
            }
        }
        _ => return None,
    };
    Some(Cause {
        at_ms,
        reason,
        text: crate::hub::plan::clip(&text, 200),
    })
}

/// The next point. The estimate may fall only when a cause was observed since the previous point, and that point
/// says why; otherwise it holds. Verified likewise falls only on added scope or a reopened item.
pub fn next_point(
    prev: Option<&Point>,
    raw_pct: i64,
    raw_verified: i64,
    causes: &[Cause],
    now: i64,
) -> Point {
    let Some(p) = prev else {
        return Point {
            at_ms: now,
            pct: raw_pct.max(raw_verified),
            verified: raw_verified,
            drop: None,
        };
    };
    let since: Vec<&Cause> = causes
        .iter()
        .filter(|c| c.at_ms > p.at_ms && c.at_ms <= now)
        .collect();
    let verified = if raw_verified < p.verified
        && !since
            .iter()
            .any(|c| matches!(c.reason, DropReason::ScopeChange | DropReason::Reopened))
    {
        p.verified
    } else {
        raw_verified
    };
    let (pct, drop) = if raw_pct >= p.pct {
        (raw_pct, None)
    } else if let Some(c) = since.iter().max_by_key(|c| c.at_ms) {
        (
            raw_pct,
            Some(PointDrop {
                reason: c.reason,
                from_pct: p.pct,
                text: c.text.clone(),
            }),
        )
    } else {
        (p.pct, None)
    };
    Point {
        at_ms: now,
        pct: pct.max(verified),
        verified,
        drop,
    }
}

/// Whether `next` adds anything to a series ending in `last`.
pub fn changes(last: Option<&Point>, next: &Point) -> bool {
    last.is_none_or(|l| l.pct != next.pct || l.verified != next.verified || next.drop.is_some())
}

/// Points kept per scope.
pub const SERIES_CAP: usize = 96;

#[cfg(test)]
mod tests {
    use super::*;

    const M: i64 = MIN;

    fn facts(reached: &[(ItemStage, i64)]) -> ItemFacts {
        ItemFacts {
            reached: reached.to_vec(),
        }
    }

    fn resolved() -> Resolved {
        Calibration::default().resolve("p", UnitKind::Item, Size::M)
    }

    #[test]
    fn reaching_a_stage_credits_its_cumulative_weight() {
        let r = resolved();
        let at = facts(&[
            (ItemStage::Planned, 0),
            (ItemStage::BriefFrozen, 0),
            (ItemStage::PrOpen, 10 * M),
        ]);
        let p = item_progress(&at, 10 * M, &r);
        assert_eq!(p.stage, ItemStage::PrOpen);
        assert!(
            (p.credit - r.weights.cum[ItemStage::PrOpen.index()]).abs() < 1e-9,
            "no time in the stage yet"
        );
        let done = facts(&[(ItemStage::PrOpen, 0), (ItemStage::Verified, 5 * M)]);
        let p = item_progress(&done, 6 * M, &r);
        assert!(p.verified && p.credit == 1.0 && p.remaining_p50_ms == 0);
    }

    #[test]
    fn inside_a_stage_credit_moves_but_never_claims_the_next_stage() {
        let r = resolved();
        let k = ItemStage::TaskStarted.index();
        let usual = r.durations.p50[k];
        let f = facts(&[(ItemStage::TaskStarted, 0)]);
        let half = item_progress(&f, usual / 2, &r).credit;
        let expect = r.weights.cum[k] + r.weights.weight(k + 1) * 0.5;
        assert!((half - expect).abs() < 1e-6, "{half} vs {expect}");
        let mut last = 0.0;
        for t in [0, usual / 4, usual / 2, usual, 3 * usual, 100 * usual] {
            let c = item_progress(&f, t, &r).credit;
            assert!(c >= last, "never falls with time");
            assert!(
                c < r.weights.cum[k + 1],
                "never reaches FirstPush unobserved"
            );
            last = c;
        }
        let capped = r.weights.cum[k] + r.weights.weight(k + 1) * IN_STAGE_CAP;
        assert!((last - capped).abs() < 1e-9, "the 0.9 cap");
    }

    #[test]
    fn past_one_and_a_half_times_the_usual_it_is_slower_than_usual_not_inflated() {
        let r = resolved();
        let k = ItemStage::PrOpen.index();
        let usual = r.durations.p50[k];
        let f = facts(&[(ItemStage::PrOpen, 0)]);
        assert!(!item_progress(&f, usual * 3 / 2, &r).slower);
        let late = item_progress(&f, usual * 3 / 2 + 1, &r);
        assert!(late.slower);
        assert!(
            late.remaining_p50_ms > 0,
            "an overdue stage still has time left"
        );
        assert_eq!(late.credit, item_progress(&f, usual * 10, &r).credit);
    }

    #[test]
    fn observations_fold_into_stages_and_a_failed_ci_falls_back() {
        let item = UnitKey::Item(1);
        let obs = |at: i64, what: What| Obs {
            at_ms: at,
            unit: item.clone(),
            what,
        };
        let cs = |at: i64, change: &str, state: ChangeState| {
            obs(
                at,
                What::ChangeState {
                    change: change.into(),
                    state,
                },
            )
        };
        let all = vec![
            obs(0, What::Created),
            obs(1, What::BriefFrozen),
            obs(2, What::TaskStarted),
            cs(5, "X1", ChangeState::Queued),
            cs(6, "X1", ChangeState::Reviewing),
            cs(8, "X1", ChangeState::Ready),
            cs(9, "X1", ChangeState::Ci),
            cs(10, "X1", ChangeState::CiFailed),
            cs(12, "X1", ChangeState::Reviewing),
        ];
        let at = |t: i64| observe(&all, t)[&item].current();
        assert_eq!(at(2), (ItemStage::TaskStarted, 2));
        assert_eq!(
            at(6),
            (ItemStage::PrOpen, 5),
            "reviewing keeps the PR-open time"
        );
        assert_eq!(
            at(9),
            (ItemStage::ReviewPassed, 8),
            "ready → ci stays in one stage"
        );
        assert_eq!(
            at(10),
            (ItemStage::PrOpen, 10),
            "red CI: back to PR open, from now"
        );
        assert_eq!(at(12), (ItemStage::PrOpen, 10));
        let mut two = all.clone();
        two.push(cs(13, "X1", ChangeState::Merged));
        two.push(cs(14, "X2", ChangeState::Queued));
        assert_eq!(
            observe(&two, 14)[&item].current(),
            (ItemStage::PrOpen, 14),
            "every live Change counts"
        );
        two.push(cs(15, "X2", ChangeState::Abandoned));
        assert_eq!(
            observe(&two, 15)[&item].current(),
            (ItemStage::Merged, 13),
            "an abandoned one doesn't"
        );
        two.push(obs(16, What::Verified));
        assert_eq!(observe(&two, 16)[&item].current().0, ItemStage::Verified);
        two.push(obs(17, What::Reopened));
        assert_eq!(observe(&two, 17)[&item].current().0, ItemStage::Merged);
    }

    #[test]
    fn the_estimate_is_never_100_until_verified_and_planning_counts() {
        let r = resolved();
        let unit = |stage: ItemStage, pts: f64| Unit {
            points: pts,
            progress: item_progress(&facts(&[(stage, 0)]), 0, &r),
        };
        let planning_now = planning(0, None, 5 * M, 0.1, 10 * M);
        assert!(planning_now.active && (planning_now.credit - 0.5).abs() < 1e-9);
        let drafting = Group {
            points: 3.0,
            planning: Some(planning_now),
            units: vec![],
            done: false,
        };
        let e = estimate(std::slice::from_ref(&drafting));
        assert_eq!(
            (e.pct, e.verified_pct),
            (5, 0),
            "half of a 10% planning share, not 0%"
        );
        let long = planning(0, None, 100 * M, 0.1, 10 * M);
        assert!((long.credit - IN_STAGE_CAP).abs() < 1e-9);
        let planned = Group {
            points: 4.0,
            planning: Some(planning(0, Some(10 * M), 20 * M, 0.1, 10 * M)),
            units: vec![unit(ItemStage::Verified, 1.0), unit(ItemStage::Merged, 3.0)],
            done: false,
        };
        let e = estimate(std::slice::from_ref(&planned));
        assert!(e.pct <= 99 && e.pct > e.verified_pct);
        assert_eq!(e.verified_pct, 22, "0.9 × 1/4 of the order");
        let done = Group {
            done: true,
            units: vec![
                unit(ItemStage::Verified, 1.0),
                unit(ItemStage::Verified, 3.0),
            ],
            ..planned
        };
        assert_eq!(
            estimate(&[done]),
            Estimate {
                pct: 100,
                verified_pct: 100,
                in_flight_pct: 0
            }
        );
    }

    #[test]
    fn the_estimate_drops_only_with_a_marker() {
        let p0 = next_point(None, 40, 20, &[], 0);
        assert_eq!((p0.pct, p0.verified), (40, 20));
        let held = next_point(Some(&p0), 35, 20, &[], 60_000);
        assert_eq!((held.pct, held.drop.clone()), (40, None), "no cause: hold");
        let old = Cause {
            at_ms: 0,
            reason: DropReason::CiFailed,
            text: "CI failed on #1".into(),
        };
        assert_eq!(
            next_point(Some(&p0), 35, 20, &[old], 60_000).pct,
            40,
            "a cause before the last point is spent"
        );
        let ci = Cause {
            at_ms: 30_000,
            reason: DropReason::CiFailed,
            text: "CI failed on #212".into(),
        };
        let fell = next_point(Some(&p0), 35, 20, std::slice::from_ref(&ci), 60_000);
        assert_eq!(fell.pct, 35);
        let d = fell.drop.unwrap();
        assert_eq!(
            (d.reason, d.from_pct, d.text.as_str()),
            (DropReason::CiFailed, 40, "CI failed on #212")
        );
        assert_eq!(
            next_point(Some(&p0), 35, 10, &[ci], 60_000).verified,
            20,
            "CI never un-verifies"
        );
        let scope = Cause {
            at_ms: 30_000,
            reason: DropReason::ScopeChange,
            text: "+2 items: lab run".into(),
        };
        let p = next_point(Some(&p0), 30, 15, &[scope], 60_000);
        assert_eq!((p.pct, p.verified), (30, 15));
        assert!(!changes(Some(&p0), &next_point(Some(&p0), 40, 20, &[], 1)));
    }

    #[test]
    fn causes_come_from_observed_events_only() {
        use serde_json::json;
        let c = cause_of(
            "change.state",
            &json!({ "from": "ci", "to": "ci_failed", "prNumber": 212 }),
            5,
        )
        .unwrap();
        assert_eq!(
            (c.reason, c.text.as_str()),
            (DropReason::CiFailed, "CI failed on #212")
        );
        let c = cause_of(
            "change.state",
            &json!({ "from": "ready", "to": "reviewing", "prNumber": 3 }),
            5,
        )
        .unwrap();
        assert_eq!(c.reason, DropReason::ReviewFailed);
        assert!(cause_of("change.state", &json!({ "from": "ready", "to": "ci" }), 5).is_none());
        assert!(
            cause_of(
                "plan.changed",
                &json!({ "kind": "scope", "deltaSize": -3, "note": "x" }),
                5
            )
            .is_none()
        );
        let c = cause_of(
            "plan.changed",
            &json!({ "kind": "scope", "deltaSize": 3, "note": "+1 item: y" }),
            5,
        );
        assert_eq!(c.unwrap().reason, DropReason::ScopeChange);
        let c = cause_of(
            "review.verdict",
            &json!({ "blocking": 2, "pr": "https://github.com/a/b/pull/9" }),
            5,
        );
        assert_eq!(c.unwrap().text, "review found 2 blocking issues on #9");
        assert!(cause_of("review.verdict", &json!({ "blocking": 0 }), 5).is_none());
    }

    #[test]
    fn weights_come_from_time_shares_with_fallbacks() {
        let w = StageWeights::from_shares([0.0, 0.0, 0.1, 0.05, 0.6, 0.7, 0.9, 0.95, 1.0]);
        assert_eq!(w.cum[0], 0.0);
        assert_eq!(w.cum[STAGES - 1], 1.0);
        for k in 1..STAGES {
            assert!(w.weight(k) >= 0.01 - 1e-12, "stage {k} keeps a floor");
        }
        assert!(w.cum[3] >= w.cum[2], "made non-decreasing");
        assert!(
            w.weight(4) > w.weight(2),
            "where the time goes, the weight goes"
        );

        let measured = |n: i64| Params {
            weights: Some(w.clone()),
            weight_samples: n,
            durations: vec![DurationRow {
                kind: UnitKind::Item,
                size: Size::M,
                durations: StageDurations {
                    p50: [M; STAGES - 1],
                    p90: [2 * M; STAGES - 1],
                    samples: n,
                },
            }],
            planning_share: Some(0.2),
            planning_p50_ms: Some(4 * M),
            planning_samples: n,
        };
        let mut cal = Calibration {
            fleet: measured(5),
            ..Default::default()
        };
        cal.projects.insert("p".into(), measured(2));
        let r = cal.resolve("p", UnitKind::Item, Size::M);
        assert_eq!(
            r.basis,
            WeightsBasis::Fleet,
            "2 project samples are too few"
        );
        assert_eq!(
            r.durations.p50[0], M,
            "project durations need 3, fleet has 5"
        );
        assert_eq!(cal.planning("p"), (0.2, 4 * M));
        cal.projects.insert("p".into(), measured(6));
        assert_eq!(
            cal.resolve("p", UnitKind::Item, Size::M).basis,
            WeightsBasis::Project
        );
        let none = Calibration::default();
        let r = none.resolve("p", UnitKind::Order, Size::L);
        assert_eq!(r.basis, WeightsBasis::Default);
        assert!(
            (r.durations.total_p50() - default_total_ms(Size::L)).abs() < 9 * M,
            "defaults spread by weight"
        );
        assert_eq!(
            none.planning("p"),
            (DEFAULT_PLANNING_SHARE, DEFAULT_PLANNING_MS)
        );
        assert_eq!(
            cal.resolve("q", UnitKind::Item, Size::S).basis,
            WeightsBasis::Fleet,
            "unknown project: fleet"
        );
    }

    #[test]
    fn the_eta_range_spreads_remaining_work_over_slots() {
        let r = resolved();
        let p = item_progress(&facts(&[(ItemStage::TaskStarted, 0)]), 0, &r);
        let units = [&p, &p, &p, &p];
        let (a50, a90) = scope_eta(&units, 1, (0, 0), 0);
        let (b50, b90) = scope_eta(&units, 4, (0, 0), 0);
        assert_eq!(a50, 4 * p.remaining_p50_ms);
        assert_eq!(b50, p.remaining_p50_ms, "four slots: as long as one item");
        assert!(a90 >= a50 && b90 >= b50);
        assert_eq!(
            scope_eta(&units, 4, (10 * b50, 0), 0).0,
            10 * b50,
            "the after-chain floors it"
        );
    }
}
