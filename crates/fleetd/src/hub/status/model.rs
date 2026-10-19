//! The progress model: an item earns part of its size at each stage fleetd observed (an event, a PR or a CI state),
//! and moves smoothly inside a stage toward the next one without ever claiming it. Pure: callers load the facts and
//! the calibration (stage weights and durations measured from the time inspector's spans, `calib.rs`).
use std::collections::HashMap;

use fleetd_contracts::plan::{ItemStage, Size};
use fleetd_contracts::status::{DropReason, WeightsBasis};
use serde::{Deserialize, Serialize};

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
