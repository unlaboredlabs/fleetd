//! Estimate calibration: a tier's measured actual/raw ratio and the ETA it gives a raw estimate. Pure.
//! TS spec: apps/hub/src/estimates/calibration.ts.
use fleetd_contracts::prim::{Count, NonNegative, PositiveNumber};
use fleetd_contracts::verification::Eta;

/// The ratio used until a tier has MIN_SAMPLES done workstreams (DESIGN §6: leads are ~5x optimistic).
pub const PRIOR_RATIO: f64 = 5.0;
pub const MIN_SAMPLES: u32 = 5;
pub const P80_MIN_SAMPLES: u32 = 10;
/// How many of the tier's latest done workstreams the ratio looks at.
pub const WINDOW: usize = 20;
/// actual/raw above this is an estimate miss.
pub const MISS_RATIO: f64 = 2.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Calibration {
    pub ratio: f64,
    pub samples: u32,
    /// The 80th-percentile ratio, from P80_MIN_SAMPLES on.
    pub p80_ratio: Option<f64>,
}

fn median(sorted: &[f64]) -> f64 {
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    }
}

/// Nearest-rank percentile.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    let rank = (p * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1)]
}

/// `ratios` are actual/raw of the tier's latest done workstreams, newest first; only the first WINDOW count.
/// Non-positive and non-finite ones are dropped. `prior` is the pinned playbook's estimatePrior, if any.
pub fn calibrate(ratios: &[f64], prior: Option<f64>) -> Calibration {
    let mut sorted: Vec<f64> = ratios
        .iter()
        .take(WINDOW)
        .copied()
        .filter(|r| r.is_finite() && *r > 0.0)
        .collect();
    sorted.sort_by(f64::total_cmp);
    let samples = sorted.len() as u32;
    if samples < MIN_SAMPLES {
        return Calibration {
            ratio: prior.unwrap_or(PRIOR_RATIO),
            samples,
            p80_ratio: None,
        };
    }
    Calibration {
        ratio: median(&sorted),
        samples,
        p80_ratio: (samples >= P80_MIN_SAMPLES).then(|| percentile(&sorted, 0.8)),
    }
}

/// `Math.round`: halves round up, towards +∞.
pub(crate) fn js_round(n: f64) -> f64 {
    (n + 0.5).floor()
}

pub(crate) fn round1(n: f64) -> f64 {
    js_round(n * 10.0) / 10.0
}

pub fn eta_of(raw_minutes: f64, c: &Calibration) -> Eta {
    Eta {
        raw_minutes: NonNegative::unchecked(raw_minutes),
        calibrated_minutes: NonNegative::unchecked(round1(raw_minutes * c.ratio)),
        ratio: PositiveNumber::unchecked(js_round(c.ratio * 100.0) / 100.0),
        samples: Count::unchecked(i64::from(c.samples)),
        p80_minutes: c
            .p80_ratio
            .map(|p| NonNegative::unchecked(round1(raw_minutes * p))),
    }
}

fn duration(minutes: f64) -> String {
    let m = js_round(minutes) as i64;
    if m < 60 {
        return format!("{m}m");
    }
    let rest = if m % 60 == 0 {
        String::new()
    } else {
        format!("{:02}m", m % 60)
    };
    format!("{}h{rest}", m / 60)
}

/// JS number formatting for the ratio: integers without ".0".
fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// One line for digests, e.g. "eta 3h20m (raw 40m × 5, prior, 2 of 5 samples)" or
/// "eta 1h (raw 30m × 2, 12 samples; p80 1h30m)".
pub fn eta_text(eta: &Eta) -> String {
    let basis = if eta.samples.get() < i64::from(MIN_SAMPLES) {
        format!("prior, {} of {MIN_SAMPLES} samples", eta.samples)
    } else {
        format!("{} samples", eta.samples)
    };
    let p80 = eta
        .p80_minutes
        .map(|p| format!("; p80 {}", duration(p.get())))
        .unwrap_or_default();
    format!(
        "eta {} (raw {} × {}, {basis}{p80})",
        duration(eta.calibrated_minutes.get()),
        duration(eta.raw_minutes.get()),
        js_number(eta.ratio.get())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cal(ratio: f64, samples: u32, p80_ratio: Option<f64>) -> Calibration {
        Calibration {
            ratio,
            samples,
            p80_ratio,
        }
    }

    #[test]
    fn calibrate_table() {
        let cases: &[(&str, Vec<f64>, Calibration)] = &[
            ("no samples: the 5.0 prior", vec![], cal(5.0, 0, None)),
            (
                "4 samples: still the prior",
                vec![1.0, 1.0, 1.0, 1.0],
                cal(5.0, 4, None),
            ),
            (
                "5 samples: the median",
                vec![3.0, 1.0, 2.0, 5.0, 4.0],
                cal(3.0, 5, None),
            ),
            (
                "6 samples: the mean of the middle two",
                vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
                cal(3.5, 6, None),
            ),
            (
                "10 samples: p80 by nearest rank",
                vec![10.0, 1.0, 9.0, 2.0, 8.0, 3.0, 7.0, 4.0, 6.0, 5.0],
                cal(5.5, 10, Some(8.0)),
            ),
            (
                "zero and non-finite ratios are dropped",
                vec![0.0, f64::NAN, f64::INFINITY, 2.0, 2.0, 2.0, 2.0, 2.0],
                cal(2.0, 5, None),
            ),
        ];
        for (name, ratios, expected) in cases {
            assert_eq!(calibrate(ratios, None), *expected, "{name}");
        }
    }

    #[test]
    fn playbook_prior_below_five_samples_only() {
        assert_eq!(calibrate(&[1.0, 1.0], Some(3.0)), cal(3.0, 2, None));
        assert_eq!(calibrate(&[2.0; 5], Some(3.0)), cal(2.0, 5, None));
    }

    #[test]
    fn only_the_latest_twenty() {
        let mut ratios = vec![1.5; 20];
        ratios.extend([9.0; 21]);
        assert_eq!(calibrate(&ratios, None), cal(1.5, 20, Some(1.5)));
    }

    #[test]
    fn eta_scales_and_reads() {
        use serde_json::json;
        let prior = eta_of(40.0, &cal(5.0, 2, None));
        assert_eq!(
            serde_json::to_value(&prior).unwrap(),
            json!({ "rawMinutes": 40, "calibratedMinutes": 200, "ratio": 5, "samples": 2 })
        );
        let measured = eta_of(30.0, &cal(2.0, 12, Some(3.0)));
        assert_eq!(
            serde_json::to_value(&measured).unwrap(),
            json!({ "rawMinutes": 30, "calibratedMinutes": 60, "ratio": 2, "samples": 12, "p80Minutes": 90 })
        );
        assert_eq!(
            eta_text(&prior),
            "eta 3h20m (raw 40m × 5, prior, 2 of 5 samples)"
        );
        assert_eq!(
            eta_text(&measured),
            "eta 1h (raw 30m × 2, 12 samples; p80 1h30m)"
        );
        assert_eq!(
            eta_text(&eta_of(60.0, &cal(1.75, 10, Some(2.0)))),
            "eta 1h45m (raw 1h × 1.75, 10 samples; p80 2h)"
        );
    }
}
