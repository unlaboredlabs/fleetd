//! The research verdict as one plain line. Pure. The outcome itself is `ledger::research_outcome` (contracts).
use fleetd_contracts::ledger::{DecisionRule, DecisionRuleBetter, MetricValues, ResearchOutcome};

use crate::hub::leads::brief::js_f64;

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

/// Six significant digits, so 0.6 − 0.5 reads 0.1 (`String(Number(n.toPrecision(6)))`).
fn num(n: f64) -> String {
    let rounded: f64 = format!("{n:.5e}").parse().unwrap_or(n);
    js_f64(rounded)
}

/// What the verdict rests on, and for INCONCLUSIVE what evidence would change it.
pub fn verdict_text(
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
    match outcome {
        ResearchOutcome::Go => format!(
            "GO: {measured}, at least the go line {}.",
            num(rule.go_at_least.get())
        ),
        ResearchOutcome::Stop => format!(
            "STOP: {measured}, below the stop line {}. STOP is a success: the question is answered.",
            num(rule.stop_below.get())
        ),
        ResearchOutcome::Inconclusive => format!(
            "INCONCLUSIVE: {measured}, between the stop line {} and the go line {}. An improvement of at least {} would make it GO; one below {} would make it STOP.",
            num(rule.stop_below.get()),
            num(rule.go_at_least.get()),
            num(rule.go_at_least.get()),
            num(rule.stop_below.get())
        ),
    }
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
            verdict_text(ResearchOutcome::Go, &higher, &v(0.5, 0.6), Some("hit rate")),
            "GO: candidate 0.6 vs baseline 0.5 on hit rate (higher is better): improvement 0.1, at least the go line 0.1."
        );
        let lower = rule(DecisionRuleBetter::Lower, 50.0, 20.0);
        assert_eq!(
            verdict_text(
                ResearchOutcome::Inconclusive,
                &lower,
                &v(400.0, 370.0),
                None
            ),
            "INCONCLUSIVE: candidate 370 vs baseline 400 (lower is better): improvement 30, between the stop line 20 and the go line 50. An improvement of at least 50 would make it GO; one below 20 would make it STOP."
        );
    }
}
