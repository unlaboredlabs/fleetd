// The research verdict as one plain line. Pure.
import type { DecisionRule, MetricValues, ResearchOutcome } from "@fleetd/contracts";

/** Six significant digits, so 0.6 − 0.5 reads 0.1. */
const num = (n: number) => String(Number(n.toPrecision(6)));

/** What the verdict rests on, and for INCONCLUSIVE what evidence would change it. */
export const verdictText = (outcome: ResearchOutcome, rule: DecisionRule, values: MetricValues, metric: string | undefined): string => {
  const improvement = (values.candidate - values.baseline) * (rule.better === "lower" ? -1 : 1);
  const on = metric === undefined ? "" : ` on ${metric}`;
  const measured = `candidate ${num(values.candidate)} vs baseline ${num(values.baseline)}${on} (${rule.better} is better): improvement ${num(improvement)}`;
  switch (outcome) {
    case "go":
      return `GO: ${measured}, at least the go line ${num(rule.goAtLeast)}.`;
    case "stop":
      return `STOP: ${measured}, below the stop line ${num(rule.stopBelow)}. STOP is a success: the question is answered.`;
    case "inconclusive":
      return `INCONCLUSIVE: ${measured}, between the stop line ${num(rule.stopBelow)} and the go line ${num(rule.goAtLeast)}. An improvement of at least ${num(rule.goAtLeast)} would make it GO; one below ${num(rule.stopBelow)} would make it STOP.`;
  }
};
