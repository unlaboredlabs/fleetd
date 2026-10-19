//! Checking the retro's answer. The model says whether a change is wording or a gate; the hub decides by the fields
//! the diff actually changes, so a gate change cannot pass as wording. Pure.
use super::diff::apply_unified_diff;
use super::types::{METRIC_CLASSES, PLAYBOOK_NAMES, PlaybookChange};
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

/// The only fields a wording change may touch. Every other frontmatter field is a gate, including any added later.
pub const WORDING_FIELDS: [&str; 1] = ["estimatePrior"];

/// At most this many changes are read from one answer.
pub const MAX_CHANGES: usize = 10;

/// The playbooks area's `parse_playbook`: the file's frontmatter fields, or its error text.
pub trait PlaybookParser: Send + Sync {
    fn parse(
        &self,
        text: &str,
        place: &str,
        expected_name: Option<&str>,
    ) -> Result<Map<String, Value>, String>;
}

#[derive(Clone, Debug)]
pub struct Accepted {
    pub change: PlaybookChange,
    /// "wording" or "gate".
    pub kind: &'static str,
    /// Frontmatter fields it changes, plus "body".
    pub fields: Vec<String>,
    /// The playbook file after the diff.
    pub after: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dropped {
    pub index: usize,
    pub playbook: Option<String>,
    pub reason: String,
}

pub struct Context<'a> {
    pub window_days: u32,
    /// Incident ids in the run's window.
    pub incidents: HashSet<String>,
    /// Each playbook's current file text.
    pub playbooks: HashMap<String, String>,
    /// Playbooks that may not change now, with why (a change still being measured, a gate ask still open).
    pub busy: HashMap<String, String>,
    pub parser: &'a dyn PlaybookParser,
}

static FRONTMATTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\r?\n(?s:.*?)\r?\n---(?:\r?\n|$)").unwrap());

fn body_of(text: &str) -> &str {
    &text[FRONTMATTER.find(text).map_or(0, |m| m.end())..]
}

/// Frontmatter fields whose values differ, plus "body" when the text below the frontmatter does.
pub fn changed_fields(
    before: &str,
    after: &str,
    place: &str,
    parser: &dyn PlaybookParser,
) -> Result<Vec<String>, String> {
    let a = parser.parse(before, place, None)?;
    let b = parser.parse(after, place, None)?;
    let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    let mut fields: Vec<String> = keys
        .into_iter()
        .filter(|k| a.get(*k) != b.get(*k))
        .cloned()
        .collect();
    if body_of(before).trim() != body_of(after).trim() {
        fields.push("body".into());
    }
    Ok(fields)
}

/// `String(value)` as JS prints it in these messages.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) => "null".into(),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| js_string(Some(x)))
            .collect::<Vec<_>>()
            .join(","),
        Some(other) => other.to_string(),
    }
}

/// One proposed change, checked against the run's window and the current playbooks.
pub fn check_change(
    raw: &Value,
    ctx: &Context,
    taken: &HashSet<String>,
) -> Result<Accepted, String> {
    let Some(item) = raw.as_object() else {
        return Err("it is not a JSON object".into());
    };
    let playbook = item.get("playbook");
    if !playbook
        .and_then(Value::as_str)
        .is_some_and(|p| PLAYBOOK_NAMES.contains(&p))
    {
        return Err(format!(
            "\"{}\" is not a playbook ({})",
            js_string(playbook),
            PLAYBOOK_NAMES.join(", ")
        ));
    }
    let metric = item.get("metric").and_then(|m| m.get("class"));
    if !metric
        .and_then(Value::as_str)
        .is_some_and(|m| METRIC_CLASSES.contains(&m))
    {
        return Err(format!(
            "\"{}\" is not a metric fleetd measures ({})",
            js_string(metric),
            METRIC_CLASSES.join(", ")
        ));
    }
    let change = PlaybookChange::decode(raw)
        .map_err(|e| format!("it does not match the change shape: {e}"))?;
    if change.fixes_incidents.is_empty() {
        return Err("it cites no incident it fixes".into());
    }
    let unknown: Vec<&str> = change
        .fixes_incidents
        .iter()
        .map(String::as_str)
        .filter(|id| !ctx.incidents.contains(*id))
        .collect();
    if !unknown.is_empty() {
        return Err(format!(
            "it cites {}, not incidents of the last {} days",
            unknown.join(", "),
            ctx.window_days
        ));
    }
    if let Some(busy) = ctx.busy.get(&change.playbook) {
        return Err(busy.clone());
    }
    if taken.contains(&change.playbook) {
        return Err(format!("a second change to {} in one run", change.playbook));
    }
    let before = ctx
        .playbooks
        .get(&change.playbook)
        .cloned()
        .unwrap_or_default();
    let after = apply_unified_diff(&before, &change.diff)?;
    let clip300 = |e: String| e.chars().take(300).collect::<String>();
    ctx.parser
        .parse(
            &after,
            &format!("{}.md after the diff", change.playbook),
            Some(&change.playbook),
        )
        .map_err(clip300)?;
    let fields = changed_fields(&before, &after, &change.playbook, ctx.parser).map_err(clip300)?;
    if fields.is_empty() {
        return Err("the diff changes nothing".into());
    }
    // The lead prompt has a section per kind of work; a playbook's leadInstructions reach no agent.
    if fields.iter().any(|f| f == "leadInstructions") {
        return Err("leadInstructions reach no agent; change the playbook's rules instead".into());
    }
    let kind = if fields
        .iter()
        .any(|f| f != "body" && !WORDING_FIELDS.contains(&f.as_str()))
    {
        "gate"
    } else {
        "wording"
    };
    if kind == "wording" && fields.iter().any(|f| f == "body") {
        return Err(format!(
            "a wording change may touch only {}; this one also changes the body",
            WORDING_FIELDS.join(" and ")
        ));
    }
    Ok(Accepted {
        change,
        kind,
        fields,
        after,
    })
}

pub enum Validated {
    Checked {
        accepted: Vec<Accepted>,
        dropped: Vec<Dropped>,
    },
    Error(String),
}

/// The model's answer text: `{"changes": [...]}`, possibly wrapped in prose or a code fence.
pub fn validate_answer(text: &str, ctx: &Context) -> Validated {
    let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) else {
        return Validated::Error("the answer has no JSON object".into());
    };
    if end < start {
        return Validated::Error("the answer has no JSON object".into());
    }
    let Ok(raw) = serde_json::from_str::<Value>(&text[start..=end]) else {
        return Validated::Error("the answer is not valid JSON".into());
    };
    let Some(changes) = raw.get("changes").and_then(Value::as_array) else {
        return Validated::Error("the answer has no \"changes\" list".into());
    };
    let mut accepted = Vec::new();
    let mut dropped = Vec::new();
    let mut taken = HashSet::new();
    for (index, item) in changes.iter().enumerate() {
        let playbook = item
            .get("playbook")
            .and_then(Value::as_str)
            .map(str::to_string);
        if index >= MAX_CHANGES {
            dropped.push(Dropped {
                index,
                playbook,
                reason: format!("more than {MAX_CHANGES} changes in one answer"),
            });
            continue;
        }
        match check_change(item, ctx, &taken) {
            Err(reason) => dropped.push(Dropped {
                index,
                playbook,
                reason,
            }),
            Ok(a) => {
                taken.insert(a.change.playbook.clone());
                accepted.push(a);
            }
        }
    }
    Validated::Checked { accepted, dropped }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Top-level frontmatter keys with their raw text (nested lines included), enough to tell which field a diff
    /// changes. The hub uses the playbooks area's YAML parser.
    struct Frontmatter;
    impl PlaybookParser for Frontmatter {
        fn parse(
            &self,
            text: &str,
            place: &str,
            expected: Option<&str>,
        ) -> Result<Map<String, Value>, String> {
            let fm = FRONTMATTER
                .find(text)
                .ok_or_else(|| format!("playbook {place} has no frontmatter"))?
                .as_str();
            let mut out = Map::new();
            let mut key = String::new();
            for line in fm.lines().filter(|l| *l != "---") {
                if !line.starts_with(' ') && line.contains(':') {
                    let (k, v) = line.split_once(':').unwrap();
                    key = k.to_string();
                    out.insert(key.clone(), json!(v.trim()));
                } else if let Some(Value::String(v)) = out.get_mut(&key) {
                    v.push('\n');
                    v.push_str(line.trim());
                }
            }
            if out
                .get("estimatePrior")
                .and_then(Value::as_str)
                .is_some_and(|v| v.starts_with('-'))
            {
                return Err(format!(
                    "playbook {place} is invalid: estimatePrior must be positive"
                ));
            }
            let name = out
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if let Some(e) = expected.filter(|e| *e != name) {
                return Err(format!(
                    "playbook {place} is invalid: its name is {name} but the file is {e}.md"
                ));
            }
            Ok(out)
        }
    }

    const BUGFIX: &str = "---\nname: bugfix\nversion: 1\ntierDefault: S\nreviewRules:\n  S: { reviewers: 0 }\n  M: { reviewers: 1 }\nvalueBar:\n  maxReviewRounds: 3\nestimatePrior: 5\nleadInstructions: >-\n  Bugfix. First a repro.\n  Idle is success.\n---\n\n# Bugfix\n\nA reported defect.\n";

    /// A one-line edit as a model writes it: the changed line with one line of context each side, a wrong line number.
    fn edit(from: &str, to: &str) -> String {
        let lines: Vec<&str> = BUGFIX.split('\n').collect();
        let i = lines.iter().position(|l| *l == from).unwrap();
        format!(
            "--- a/bugfix.md\n+++ b/bugfix.md\n@@ -40,3 +40,3 @@\n {}\n-{from}\n+{to}\n {}\n",
            lines[i - 1],
            lines[i + 1]
        )
    }

    fn change(diff: &str, kind: &str) -> Value {
        json!({
            "playbook": "bugfix", "diff": diff, "kind": kind, "fixesIncidents": ["I1"],
            "metric": { "class": "false_claim", "op": "decrease", "windowDays": 14 }, "expected": "fewer false claims",
        })
    }

    fn check(items: Vec<Value>) -> (Vec<Accepted>, Vec<Dropped>) {
        let ctx = Context {
            window_days: 14,
            incidents: ["I1".to_string()].into(),
            playbooks: [("bugfix".to_string(), BUGFIX.to_string())].into(),
            busy: HashMap::new(),
            parser: &Frontmatter,
        };
        match validate_answer(
            &format!(
                "Here you go:\n```json\n{}\n```",
                json!({ "changes": items })
            ),
            &ctx,
        ) {
            Validated::Checked { accepted, dropped } => (accepted, dropped),
            Validated::Error(e) => panic!("{e}"),
        }
    }

    fn fields(a: &Accepted) -> Vec<&str> {
        a.fields.iter().map(String::as_str).collect()
    }

    #[test]
    fn the_hub_classifies_a_change_by_the_fields_it_touches_not_by_what_the_model_says() {
        let (wording, dropped) = check(vec![change(
            &edit(
                "  Idle is success.",
                "  Run the repro yourself before you claim done.",
            ),
            "wording",
        )]);
        assert!(wording.is_empty());
        assert!(
            dropped[0]
                .reason
                .starts_with("leadInstructions reach no agent")
        );

        let (prior, _) = check(vec![change(
            &edit("estimatePrior: 5", "estimatePrior: 4"),
            "gate",
        )]);
        assert_eq!(
            (prior[0].kind, fields(&prior[0])),
            ("wording", vec!["estimatePrior"])
        );

        // A gate field passed off as wording is a gate change.
        let (gate, _) = check(vec![change(
            &edit("  maxReviewRounds: 3", "  maxReviewRounds: 2"),
            "wording",
        )]);
        assert_eq!(
            (gate[0].kind, fields(&gate[0]), gate[0].change.kind.as_str()),
            ("gate", vec!["valueBar"], "wording")
        );

        // Wording and a gate in one diff make it a gate change.
        let both = "@@ -8,4 +8,4 @@\n valueBar:\n-  maxReviewRounds: 3\n-estimatePrior: 5\n+  maxReviewRounds: 5\n+estimatePrior: 4\n leadInstructions: >-\n";
        let (mixed, dropped) = check(vec![change(both, "wording")]);
        assert_eq!(dropped, []);
        assert_eq!(
            (mixed[0].kind, fields(&mixed[0])),
            ("gate", vec!["estimatePrior", "valueBar"])
        );
    }

    #[test]
    fn a_wording_change_may_not_touch_the_body_and_a_change_must_stay_a_valid_playbook() {
        let (accepted, dropped) = check(vec![change(&edit("# Bugfix", "# Bug fixing"), "wording")]);
        assert!(accepted.is_empty());
        assert!(
            dropped[0]
                .reason
                .starts_with("a wording change may touch only estimatePrior"),
            "{}",
            dropped[0].reason
        );
        let (_, dropped) = check(vec![change(
            &edit("estimatePrior: 5", "estimatePrior: -1"),
            "wording",
        )]);
        assert!(dropped[0].reason.contains("is invalid"));
        let (_, dropped) = check(vec![change(&edit("name: bugfix", "name: feature"), "gate")]);
        assert!(
            dropped[0]
                .reason
                .contains("its name is feature but the file is bugfix.md")
        );
        // One change per playbook per run.
        let one = change(&edit("estimatePrior: 5", "estimatePrior: 4"), "wording");
        let (accepted, dropped) = check(vec![one.clone(), one]);
        assert_eq!(
            (accepted.len(), dropped[0].reason.as_str()),
            (1, "a second change to bugfix in one run")
        );
    }
}
