//! The research verdict as the lead's event line. Pure. The outcome itself is `ledger::research_outcome` (contracts).
use fleetd_contracts::ledger::{DecisionRule, DecisionRuleBetter, MetricValues, ResearchOutcome};

use crate::hub::leads::events::Event;

fn sign(rule: &DecisionRule) -> f64 {
    match rule.better {
        DecisionRuleBetter::Lower => -1.0,
        DecisionRuleBetter::Higher => 1.0,
    }
}

fn better_text(rule: &DecisionRule) -> &'static str {
    match rule.better {
        DecisionRuleBetter::Lower => "lower",
        DecisionRuleBetter::Higher => "higher",
    }
}

/// `String(n)` in JS: integers without a fraction, exponent form only from 1e21 up and below 1e-6.
fn js_f64(f: f64) -> String {
    if !f.is_finite() {
        return "null".into();
    }
    if f == 0.0 {
        return "0".into();
    }
    let abs = f.abs();
    if (1e-6..1e21).contains(&abs) {
        // Rust's Display is the shortest round-trip form without an exponent, as JS prints in this range.
        return format!("{f}");
    }
    let s = format!("{f:e}");
    match s.split_once('e') {
        Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
        _ => s,
    }
}

/// Six significant digits, so 0.6 − 0.5 reads 0.1 (`String(Number(n.toPrecision(6)))`).
fn num(n: f64) -> String {
    let rounded: f64 = format!("{n:.5e}").parse().unwrap_or(n);
    js_f64(rounded)
}

/// The verdict as the lead's event line: what it rests on, and the go and stop lines that would change it.
pub fn verdict_text(
    workstream_id: &str,
    outcome: ResearchOutcome,
    rule: &DecisionRule,
    values: &MetricValues,
    metric: Option<&str>,
) -> String {
    let (baseline, candidate) = (values.baseline.get(), values.candidate.get());
    let improvement = (candidate - baseline) * sign(rule);
    let on = metric.map(|m| format!(" on {m}")).unwrap_or_default();
    let measured = format!(
        "candidate {} vs baseline {}{on} ({} is better): improvement {}",
        num(candidate),
        num(baseline),
        better_text(rule),
        num(improvement)
    );
    Event::ResearchVerdict {
        workstream: workstream_id,
        verdict: outcome,
        measured: &measured,
        go: &num(rule.go_at_least.get()),
        stop: &num(rule.stop_below.get()),
    }
    .render()
}

#[cfg(test)]
mod tests {
    use super::*;

    use fleetd_contracts::ledger::research_outcome;
    use fleetd_contracts::prim::Finite;

    fn rule(better: DecisionRuleBetter, go_at_least: f64, stop_below: f64) -> DecisionRule {
        DecisionRule {
            better,
            go_at_least: Finite::unchecked(go_at_least),
            stop_below: Finite::unchecked(stop_below),
        }
    }
    fn v(baseline: f64, candidate: f64) -> MetricValues {
        MetricValues {
            baseline: Finite::unchecked(baseline),
            candidate: Finite::unchecked(candidate),
        }
    }

    #[test]
    fn go_stop_and_inconclusive_with_the_tolerance_on_the_lines() {
        let higher = rule(DecisionRuleBetter::Higher, 0.1, 0.02);
        assert_eq!(research_outcome(&higher, &v(0.5, 0.6)), ResearchOutcome::Go);
        assert_eq!(
            research_outcome(&higher, &v(0.5, 0.55)),
            ResearchOutcome::Inconclusive
        );
        assert_eq!(
            research_outcome(&higher, &v(0.5, 0.52)),
            ResearchOutcome::Inconclusive
        );
        assert_eq!(
            research_outcome(&higher, &v(0.5, 0.51)),
            ResearchOutcome::Stop
        );
        assert_eq!(
            research_outcome(&higher, &v(0.5, 0.3)),
            ResearchOutcome::Stop
        );
    }

    #[test]
    fn a_drop_is_the_improvement_when_lower_is_better() {
        let lower = rule(DecisionRuleBetter::Lower, 50.0, 50.0);
        assert_eq!(
            research_outcome(&lower, &v(400.0, 300.0)),
            ResearchOutcome::Go
        );
        assert_eq!(
            research_outcome(&lower, &v(400.0, 380.0)),
            ResearchOutcome::Stop
        );
        assert_eq!(
            research_outcome(&lower, &v(400.0, 500.0)),
            ResearchOutcome::Stop
        );
        assert_eq!(
            research_outcome(&lower, &v(400.0, 350.0)),
            ResearchOutcome::Go
        );
    }

    #[test]
    fn verdict_lines() {
        let higher = rule(DecisionRuleBetter::Higher, 0.1, 0.1);
        assert_eq!(
            verdict_text(
                "W2",
                ResearchOutcome::Go,
                &higher,
                &v(0.5, 0.6),
                Some("hit rate")
            ),
            "- W2 research verdict GO: candidate 0.6 vs baseline 0.5 on hit rate (higher is better): improvement 0.1 (go line 0.1, stop line 0.1)"
        );
        let lower = rule(DecisionRuleBetter::Lower, 50.0, 20.0);
        assert_eq!(
            verdict_text(
                "W2",
                ResearchOutcome::Inconclusive,
                &lower,
                &v(400.0, 370.0),
                None
            ),
            "- W2 research verdict INCONCLUSIVE: candidate 370 vs baseline 400 (lower is better): improvement 30 (go line 50, stop line 20)"
        );
    }
}
