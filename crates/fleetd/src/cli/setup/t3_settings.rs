//! T3's settings.json with the fleetd Claude instance applied.

use super::ordered_json::{Json, Object};

/// The T3 provider instance fleetd launches every thread on.
pub const FLEETD_INSTANCE: &str = "fleetd";

/// The fleetd Claude instance denies every T3 tool and Claude's own subagent tools, so every fan-out is a fleetd
/// task in a fleetd slot (DESIGN §3.2). T3 keeps one value per launch flag, so they share one comma-separated list.
pub const FLEETD_LAUNCH_ARGS: &str = "--disallowedTools mcp__t3-code__*,Task,Workflow";

fn object(value: Option<&Json>) -> Object {
    value.and_then(Json::as_object).cloned().unwrap_or_default()
}

/// T3's settings.json with the fleetd instance and `autoResumeLimitedThreads: false` applied, keeping everything
/// else the user or T3 stored there, in its order, as a JS spread does. Errs on a file that is not a JSON object
/// rather than overwrite it.
pub fn apply_fleetd_settings(existing: Option<&str>, claude_dir: &str) -> Result<String, String> {
    let settings = match existing {
        None => Json::parse(r#"{"enableProviderUpdateChecks":false}"#)?,
        Some(text) => Json::parse(text)?,
    };
    let Json::Object(mut settings) = settings else {
        return Err("T3 settings.json is not a JSON object".into());
    };
    let mut instances = object(settings.get("providerInstances"));
    let mut instance = object(instances.get(FLEETD_INSTANCE));
    let mut config = object(instance.get("config"));
    config.insert("homePath", Json::str(claude_dir));
    config.insert("launchArgs", Json::str(FLEETD_LAUNCH_ARGS));
    instance.insert("driver", Json::str("claudeAgent"));
    instance.insert("displayName", Json::str("fleetd"));
    instance.insert("config", Json::Object(config));
    instances.insert(FLEETD_INSTANCE, Json::Object(instance));
    // fleetd parks a limited thread and resumes it at the reset itself; T3 resuming it too would double the turn.
    settings.insert("autoResumeLimitedThreads", Json::Bool(false));
    settings.insert("providerInstances", Json::Object(instances));
    Ok(format!("{}\n", Json::Object(settings).pretty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_users_settings_in_place() {
        let existing = r#"{"theme":"dark","autoResumeLimitedThreads":true,"providerInstances":{"codex":{"driver":"codex"},"fleetd":{"driver":"claudeAgent","config":{"autoCompactWindow":"300000","launchArgs":""}}}}"#;
        let text = apply_fleetd_settings(Some(existing), "/home/wynn/.fleetd/claude").unwrap();
        let expected = r#"{"theme":"dark","autoResumeLimitedThreads":false,"providerInstances":{"codex":{"driver":"codex"},"fleetd":{"driver":"claudeAgent","config":{"autoCompactWindow":"300000","launchArgs":"--disallowedTools mcp__t3-code__*,Task,Workflow","homePath":"/home/wynn/.fleetd/claude"},"displayName":"fleetd"}}}"#;
        assert_eq!(
            serde_json::to_string(&Json::parse(&text).unwrap()).unwrap(),
            expected
        );
        assert_eq!(
            apply_fleetd_settings(Some(&text), "/home/wynn/.fleetd/claude").unwrap(),
            text
        );
        assert!(apply_fleetd_settings(Some("[]"), "/c").is_err());
        assert!(apply_fleetd_settings(Some("{nope"), "/c").is_err());
    }
}
