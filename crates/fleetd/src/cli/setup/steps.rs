//! The hub's setup steps in the terminal (docs/design/setup.md): `fleetd init` and `fleetd doctor` list the hub's steps
//! (setup_list), one line each, and `fleetd init --step <id>` opens one as a guide: why, numbered parts with the values
//! to paste and the provider's pages, and where the result is saved.
//! Secrets are never typed here: a step that takes one says where in the app it is sealed.

use std::time::Duration;

use fleetd_contracts::setup::{HubSetupStep, SetupNeed, SetupStatus, SetupStepId, matches_check};
use serde_json::{Value, json};

use super::Failure;
use super::checklist::{Checklist, State};
use crate::cli::mcp_client::McpClient;
use crate::hub::doctor::checks::DoctorCheck;

/// What the hub answered, or a refusal as a failure with its fix.
async fn call(client: &mut McpClient, tool: &str, input: Value) -> Result<Value, Failure> {
    let result = client
        .call_tool(tool, input, Duration::from_secs(120))
        .await
        .map_err(|error| Failure {
            message: format!("{tool} failed: {}", error.message()),
            fix: if error.message().contains("not found") {
                "fleetd update, so the hub has setup steps".into()
            } else {
                "fleetd doctor shows whether the hub is up; then run fleetd init again".into()
            },
        })?;
    if result.is_error {
        let text = |key: &str| {
            result
                .body
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        return Err(Failure {
            message: text("message").unwrap_or_else(|| result.body.to_string()),
            fix: text("fix").unwrap_or_else(|| "fleetd init again".into()),
        });
    }
    Ok(result.body)
}

fn shape(error: serde_json::Error) -> Failure {
    Failure {
        message: format!("the hub's setup steps came in an unknown shape: {error}"),
        fix: "fleetd update, so this CLI matches the hub".into(),
    }
}

/// The hub's steps; `None` from a hub too old to have them.
pub async fn list(client: &mut McpClient) -> Result<Option<Vec<HubSetupStep>>, Failure> {
    match call(client, "setup_list", json!({})).await {
        Ok(body) => serde_json::from_value(body["steps"].clone())
            .map(Some)
            .map_err(shape),
        Err(f) if f.message.contains("not found") => Ok(None),
        Err(f) => Err(f),
    }
}

/// Runs one step's checks now.
pub async fn test(client: &mut McpClient, id: SetupStepId) -> Result<HubSetupStep, Failure> {
    let body = call(client, "setup_test", json!({ "step": id })).await?;
    serde_json::from_value(body["step"].clone()).map_err(shape)
}

/// Puts a step off for later.
pub async fn skip(client: &mut McpClient, id: SetupStepId) -> Result<HubSetupStep, Failure> {
    let body = call(client, "setup_skip", json!({ "step": id, "skipped": true })).await?;
    serde_json::from_value(body["step"].clone()).map_err(shape)
}

pub fn need_words(need: &SetupNeed) -> String {
    match need {
        SetupNeed::Required => "required".into(),
        SetupNeed::Before { what } => format!("before {what}"),
        SetupNeed::Optional => "optional".into(),
    }
}

/// How to open the step again: its fix's command where a command fixes it, else `fleetd init --step <id>`.
fn resume(step: &HubSetupStep) -> String {
    step.fix
        .as_ref()
        .and_then(|f| f.command.as_ref())
        .map(|c| c.to_string())
        .unwrap_or_else(|| format!("fleetd init --step {}", step.id.as_str()))
}

/// The step's line: done with what its checks say; a required one left fails with how to do it; one that wants a look
/// fails or warns as its check does, with its fix; one not needed yet says when it is, and how to open it.
pub fn line(step: &HubSetupStep) -> (State, String, Option<String>) {
    let said = step
        .said
        .as_deref()
        .unwrap_or_default()
        .trim_end_matches('.');
    match step.status {
        SetupStatus::Done => {
            let detail = match &step.way {
                Some(way) => format!("with {way}: {said}"),
                None => said.to_owned(),
            };
            (State::Done, detail, None)
        }
        // As its check says: a failing one fails, whatever the step's need; a warning stays one.
        SetupStatus::Look => {
            let state = if step.failing == Some(true) {
                State::Failed
            } else {
                State::Warn
            };
            (state, said.to_owned(), Some(resume(step)))
        }
        SetupStatus::Todo if step.need == SetupNeed::Required => {
            let detail = if said.is_empty() {
                step.why.trim_end_matches('.')
            } else {
                said
            };
            (
                State::Failed,
                format!("required: {detail}"),
                Some(resume(step)),
            )
        }
        SetupStatus::Todo => (
            State::Skipped,
            format!(
                "{} · fleetd init --step {}",
                need_words(&step.need),
                step.id.as_str()
            ),
            None,
        ),
        SetupStatus::Skipped => (
            State::Skipped,
            format!("later · fleetd init --step {}", step.id.as_str()),
            None,
        ),
    }
}

/// One checklist line per step.
pub fn show(list: &mut Checklist, steps: &[HubSetupStep]) {
    for step in steps {
        let (state, detail, fix) = line(step);
        list.finish(&step.title, state, &detail, fix.as_deref());
    }
}

/// The doctor's checks no step owns (disk, a stale session, a fork behind): the steps already speak for theirs.
pub fn unowned(checks: &[DoctorCheck], steps: &[HubSetupStep]) -> Vec<DoctorCheck> {
    checks
        .iter()
        .filter(|c| {
            !steps
                .iter()
                .flat_map(|s| &s.ways)
                .flat_map(|w| &w.checks)
                .any(|p| matches_check(p, &c.id))
        })
        .cloned()
        .collect()
}

/// Administration's sections, as the app names them; Claude's subscription way is a person's own, in Settings.
fn place_words(place: &str) -> String {
    let name = match place {
        "claude" => {
            return "Administration › Claude for the hub's API key; Settings › Claude for your own subscription"
                .to_owned();
        }
        "google" => "Google",
        "invites" => "Invites",
        "machines" => "Machines",
        "people" => "People",
        other => other,
    };
    format!("Administration › {name}")
}

/// The step as a guide, for the terminal: why, its numbered parts (what to open, then what to fill in there, a value
/// on a line of its own so it copies whole), and what happens after.
pub fn guide(step: &HubSetupStep) -> String {
    let mut out = vec![step.why.clone()];
    for (n, part) in step.parts.iter().enumerate() {
        out.push(String::new());
        let optional = if part.optional == Some(true) {
            " (optional)"
        } else {
            ""
        };
        out.push(format!("{}. {}{optional}", n + 1, part.title));
        if let Some(note) = &part.note {
            out.push(format!("   {note}"));
        }
        for link in &part.links {
            out.push(format!("   {}: {}", link.label, link.url));
        }
        for v in &part.values {
            if v.plain == Some(true) {
                out.push(format!("   {}: {}", v.label, v.value));
            } else {
                out.push(format!("   {}:", v.label));
                out.extend(v.value.lines().map(|l| format!("     {l}")));
            }
            if let Some(note) = &v.note {
                out.push(format!("     {note}"));
            }
        }
    }
    let after = match (&step.fields_note, &step.place) {
        (Some(note), _) => Some(note.clone()),
        (None, Some(place)) => Some(format!("In the app: {}.", place_words(place))),
        _ => None,
    };
    if let Some(after) = after {
        out.push(String::new());
        out.push(after);
    }
    if let Some(test) = &step.test {
        out.push(String::new());
        out.push(format!("Test: {}.", test.trim_end_matches('.')));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::doctor::checks::DoctorStatus;
    use crate::hub::setup::{guides, read};

    const HUB: &str = "http://devbox.your-tailnet.ts.net:4790";

    fn check(id: &str, status: DoctorStatus, message: &str) -> DoctorCheck {
        DoctorCheck {
            id: id.into(),
            scope: "machine".into(),
            machine_id: None,
            status,
            message: message.into(),
            fix: None,
        }
    }

    fn steps(checks: &[DoctorCheck]) -> Vec<HubSetupStep> {
        read(
            guides(HUB),
            checks,
            &[SetupStepId::Notion].into_iter().collect(),
        )
    }

    #[test]
    fn each_step_is_one_line_saying_what_is_left_and_how_to_open_it() {
        let checks = [
            check(
                "hub/reachable",
                DoctorStatus::Ok,
                "The hub answers at its own address.",
            ),
            check("devbox/online", DoctorStatus::Ok, "devbox is online."),
            check(
                "devbox/claude_login",
                DoctorStatus::Fail,
                "devbox: claude is not logged in, so its sessions can't start.",
            ),
        ];
        let lines: Vec<_> = steps(&checks).iter().map(line).collect();
        assert_eq!(
            lines,
            [
                (
                    State::Done,
                    "The hub answers at its own address".into(),
                    None
                ),
                (State::Done, "devbox is online".into(), None),
                (
                    State::Failed,
                    "devbox: claude is not logged in, so its sessions can't start".into(),
                    Some("fleetd init --step claude".into())
                ),
                (
                    State::Skipped,
                    "before the first PR · fleetd init --step github".into(),
                    None
                ),
                (
                    State::Skipped,
                    "optional · fleetd init --step people".into(),
                    None
                ),
                (
                    State::Skipped,
                    "optional · fleetd init --step google".into(),
                    None
                ),
                (
                    State::Skipped,
                    "later · fleetd init --step notion".into(),
                    None
                ),
            ]
        );
        // With no machine yet, the step says why it matters.
        let (state, detail, fix) = line(&steps(&[])[1]);
        assert_eq!(state, State::Failed);
        assert_eq!(
            detail,
            "required: Agents run on machines; the hub's own machine can be one"
        );
        assert_eq!(fix.as_deref(), Some("fleetd init --step machines"));
    }

    #[test]
    fn a_step_fails_only_when_its_check_does() {
        // A degraded machine warns: agents still run, so nothing required is left.
        let degraded = [check(
            "devbox/online",
            DoctorStatus::Warn,
            "devbox is degraded.",
        )];
        let machines = &steps(&degraded)[1];
        assert_eq!(line(machines).0, State::Warn);
        assert!(!machines.required_left());
        let offline = [check(
            "devbox/online",
            DoctorStatus::Fail,
            "devbox is offline.",
        )];
        let machines = &steps(&offline)[1];
        assert_eq!(line(machines).0, State::Failed);
        assert!(machines.required_left());
        // gh logged out fails the GitHub step though it is only needed before the first PR.
        let gh = [check(
            "hub/gh_auth",
            DoctorStatus::Fail,
            "gh is not logged in on the hub.",
        )];
        assert_eq!(line(&steps(&gh)[3]).0, State::Failed);
    }

    #[test]
    fn the_doctor_lists_only_the_checks_no_step_speaks_for() {
        let checks = [
            check(
                "hub/gh_auth",
                DoctorStatus::Fail,
                "gh is not logged in on the hub.",
            ),
            check(
                "devbox/claude_login",
                DoctorStatus::Fail,
                "devbox: not logged in.",
            ),
            check("devbox/disk", DoctorStatus::Warn, "devbox has 2 GB free."),
            check("hub/repo_ci", DoctorStatus::Fail, "No CI on acme/app."),
        ];
        let left: Vec<_> = unowned(&checks, &steps(&checks))
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(left, ["devbox/disk", "hub/repo_ci"]);
    }

    #[test]
    fn a_guide_puts_each_value_on_its_own_line_and_says_where_secrets_go() {
        let google = steps(&[])
            .into_iter()
            .find(|s| s.id == SetupStepId::Google)
            .unwrap();
        let text = guide(&google);
        assert!(text.starts_with("Each person's Navi reads"), "{text}");
        assert!(
            text.contains("\n1. Create a Google Cloud project\n"),
            "{text}"
        );
        assert!(
            text.contains("   Project name:\n     fleetd-devbox\n"),
            "{text}"
        );
        assert!(
            text.contains("\n6. Gmail in real time (optional)\n"),
            "{text}"
        );
        assert!(text.contains("on Administration › Google"), "{text}");
        assert!(
            text.ends_with("Test: Ask Google whether it knows this client."),
            "{text}"
        );
        let people = steps(&[])
            .into_iter()
            .find(|s| s.id == SetupStepId::People)
            .unwrap();
        assert!(guide(&people).contains("In the app: Administration › Invites."));
        let claude = steps(&[])
            .into_iter()
            .find(|s| s.id == SetupStepId::Claude)
            .unwrap();
        assert!(
            guide(&claude).contains(
                "In the app: Administration › Claude for the hub's API key; Settings › Claude for your own subscription."
            ),
            "{}",
            guide(&claude)
        );
    }
}
