//! M9: playbook frontmatter, the research brief floor, and the intake router's answer.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_with::skip_serializing_none;

use crate::ids::ProjectRef;
use crate::ledger::{Brief, CheckType, PlaybookName, Tier};
use crate::prim::{Int, Line, List, MAX_SAFE_INT, PositiveNumber, Text, UniqueList};

/// The brief's doneWhen needs at least one check whose type is in `any_of`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequiredCheck {
    pub any_of: UniqueList<CheckType, 1, { usize::MAX }>,
    /// Names it in the refusal, e.g. "a failing repro check" gives "bugfix needs a failing repro check (type test or
    /// cmd)".
    pub label: Option<Line<1, 100>>,
}

/// How a change of one tier is reviewed before the train merges it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRule {
    pub reviewers: Int<0, 4>,
    pub verifier: bool,
    /// The plan is written into the brief before it is frozen, and the writers start from that frozen plan. Not a
    /// separate review step: nothing waits on one.
    pub plan_first: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PlaybookReviewRules {
    #[serde(rename = "S")]
    pub s: ReviewRule,
    #[serde(rename = "M")]
    pub m: ReviewRule,
    #[serde(rename = "L")]
    pub l: ReviewRule,
}

impl PlaybookReviewRules {
    pub fn for_tier(&self, tier: Tier) -> &ReviewRule {
        match tier {
            Tier::S => &self.s,
            Tier::M => &self.m,
            Tier::L => &self.l,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookValueBar {
    pub max_review_rounds: Int<1, 10>,
    /// Every PR needs a `Source:` the train can resolve.
    pub require_source: bool,
}

/// The YAML frontmatter of `playbooks/<name>.md`, or of its override in `~/.fleetd/hub/playbooks/`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Playbook {
    pub name: PlaybookName,
    /// Bumped by hand on changes to gates, checks, tiers or value-bar thresholds; the pin itself is the file's SHA.
    pub version: Int<1, MAX_SAFE_INT>,
    /// Every entry must be met.
    pub required_checks: List<RequiredCheck, 0, 10>,
    pub tier_default: Tier,
    pub review_rules: PlaybookReviewRules,
    pub value_bar: PlaybookValueBar,
    /// Estimate multiplier until the tier has calibration samples.
    pub estimate_prior: PositiveNumber,
    /// Injected into the lead's intake wake and digest for workstreams on this playbook.
    pub lead_instructions: Text<1, 600>,
}

/// What the research playbook adds to the floor, as refusal text.
pub const RESEARCH_FIELDS_FIX: &str =
    "a research brief needs baseline, metric, decisionRule and budget.size (S, M or L)";

/// The research floor: `Err` names every missing field.
pub fn research_brief_rule(brief: &Brief) -> Result<(), String> {
    let mut missing = Vec::new();
    if brief.baseline.is_none() {
        missing.push("baseline");
    }
    if brief.metric.is_none() {
        missing.push("metric");
    }
    if brief.decision_rule.is_none() {
        missing.push("decisionRule");
    }
    if !brief
        .budget
        .as_ref()
        .is_some_and(|b| b.size.is_some() || b.agent_hours.is_some())
    {
        missing.push("budget.size");
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{RESEARCH_FIELDS_FIX}; missing {}",
            missing.join(", ")
        ))
    }
}

/// A Brief with the research fields present. Brief validation uses it when the workstream's playbook is research.
#[derive(Clone, Debug, PartialEq)]
pub struct ResearchBrief(pub Brief);

impl Serialize for ResearchBrief {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}

impl<'de> Deserialize<'de> for ResearchBrief {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let brief = Brief::deserialize(d)?;
        research_brief_rule(&brief).map_err(serde::de::Error::custom)?;
        Ok(Self(brief))
    }
}

impl JsonSchema for ResearchBrief {
    fn schema_name() -> Cow<'static, str> {
        "ResearchBrief".into()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        Brief::json_schema(generator)
    }
}

/// Where an intent went and why: the caller's project, `@<project>`, or the only project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntakeEcho {
    pub project_ref: ProjectRef,
    /// The playbook the caller gave; absent means the project's lead decides how to run it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<PlaybookName>,
    pub reason: Line<1, 200>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn review(reviewers: i64) -> Value {
        json!({ "reviewers": reviewers, "verifier": false, "planFirst": false })
    }

    fn bugfix() -> Value {
        json!({
            "name": "bugfix",
            "version": 1,
            "requiredChecks": [{ "anyOf": ["test", "cmd"], "label": "a failing repro check" }],
            "tierDefault": "S",
            "reviewRules": { "S": review(0), "M": review(1), "L": review(2) },
            "valueBar": { "maxReviewRounds": 2, "requireSource": true },
            "estimatePrior": 5,
            "leadInstructions": "Reproduce first.",
        })
    }

    fn with(mut base: Value, key: &str, value: Value) -> Value {
        base[key] = value;
        base
    }

    #[test]
    fn playbook_frontmatter() {
        let accepts = |v: Value| serde_json::from_value::<Playbook>(v).is_ok();
        assert!(accepts(bugfix()));
        assert!(!accepts(with(bugfix(), "name", json!("chore"))));
        assert!(!accepts(with(
            bugfix(),
            "requiredChecks",
            json!([{ "anyOf": ["repro"] }])
        )));
        assert!(!accepts(with(
            bugfix(),
            "requiredChecks",
            json!([{ "anyOf": [] }])
        )));
        assert!(accepts(with(
            bugfix(),
            "leadInstructions",
            json!("x".repeat(600))
        )));
        assert!(!accepts(with(
            bugfix(),
            "leadInstructions",
            json!("x".repeat(601))
        )));
        assert!(!accepts(with(
            bugfix(),
            "reviewRules",
            json!({ "S": review(0), "M": review(1) })
        )));
    }

    #[test]
    fn research_brief_names_every_missing_field() {
        let brief = json!({
            "goal": "g", "why": "w", "pointers": [], "constraints": [],
            "doneWhen": [{ "type": "judge", "criteria": "the judge reports both numbers" }],
            "tier": "M",
        });
        let mut research = brief.clone();
        research["baseline"] = json!("main at its current head");
        research["metric"] = json!("pass rate on the eval set");
        research["decisionRule"] =
            json!({ "better": "higher", "goAtLeast": 0.1, "stopBelow": 0.02 });
        research["budget"] = json!({ "size": "M" });
        assert!(serde_json::from_value::<ResearchBrief>(research.clone()).is_ok());
        assert!(serde_json::from_value::<Brief>(brief.clone()).is_ok());
        assert!(serde_json::from_value::<ResearchBrief>(brief).is_err());

        let mut partial = research;
        let object = partial.as_object_mut().unwrap();
        object.remove("baseline");
        object.remove("decisionRule");
        object.insert("budget".into(), json!({}));
        let message = serde_json::from_value::<ResearchBrief>(partial)
            .unwrap_err()
            .to_string();
        assert!(message.contains(RESEARCH_FIELDS_FIX), "{message}");
        assert!(
            message.contains("missing baseline, decisionRule, budget.size"),
            "{message}"
        );
    }
}
