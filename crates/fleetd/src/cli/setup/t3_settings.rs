//! T3's settings.json with the fleetd Claude instance applied.

use serde_json::{Map, Value, json};

/// The T3 provider instance fleetd launches every thread on.
pub const FLEETD_INSTANCE: &str = "fleetd";

/// The fleetd Claude instance denies every T3 tool and Claude's own subagent tools, so every fan-out is a fleetd
/// task in a fleetd slot (DESIGN §3.2). T3 keeps one value per launch flag, so they share one comma-separated list.
pub const FLEETD_LAUNCH_ARGS: &str = "--disallowedTools mcp__t3-code__*,Task,Workflow";

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// T3's settings.json with the fleetd instance and `autoResumeLimitedThreads: false` applied, keeping everything
/// else the user or T3 stored there (in its order, as a JS spread does). Errs on a file that is not a JSON object
/// rather than overwrite it.
pub fn apply_fleetd_settings(existing: Option<&str>, claude_dir: &str) -> Result<String, String> {
    let mut settings = match existing {
        None => json!({ "enableProviderUpdateChecks": false }),
        Some(text) => serde_json::from_str::<Value>(text).map_err(|error| error.to_string())?,
    };
    let Some(settings) = settings.as_object_mut() else {
        return Err("T3 settings.json is not a JSON object".into());
    };
    let mut instances = object(settings.get("providerInstances"));
    let mut instance = object(instances.get(FLEETD_INSTANCE));
    let mut config = object(instance.get("config"));
    config.insert("homePath".into(), json!(claude_dir));
    config.insert("launchArgs".into(), json!(FLEETD_LAUNCH_ARGS));
    instance.insert("driver".into(), json!("claudeAgent"));
    instance.insert("displayName".into(), json!("fleetd"));
    instance.insert("config".into(), Value::Object(config));
    instances.insert(FLEETD_INSTANCE.into(), Value::Object(instance));
    // fleetd parks a limited thread and resumes it at the reset itself; T3 resuming it too would double the turn.
    settings.insert("autoResumeLimitedThreads".into(), json!(false));
    settings.insert("providerInstances".into(), Value::Object(instances));
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(settings).expect("JSON serializes")
    ))
}
