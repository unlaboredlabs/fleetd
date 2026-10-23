//! M9: playbook frontmatter, the research brief floor, and where intake placed an order.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::ids::ProjectRef;
use crate::ledger::{Brief, PlaybookName};
use crate::prim::{Int, Line, MAX_SAFE_INT};

/// The YAML frontmatter of `playbooks/<name>.md`, or of its override in `~/.fleetd/hub/playbooks/`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Playbook {
    pub name: PlaybookName,
    /// Bumped by hand on changes to gates; the pin itself is the file's SHA.
    pub version: Int<1, MAX_SAFE_INT>,
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

    fn bugfix() -> Value {
        json!({
            "name": "bugfix",
            "version": 1,
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
    }

    #[test]
    fn research_brief_names_every_missing_field() {
        let brief = json!({
            "goal": "g", "why": "w", "pointers": [], "constraints": [],
            "doneWhen": ["both numbers are measured"],
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
