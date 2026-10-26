//! The fleetd versions this CLI, the hub and each node run, and the one line `fleetd status` and `fleetd doctor` print
//! when they differ. A version of `0.0.0` (a local build, or a hub or node from before they reported a real one) is
//! unknown: never flagged as older or different.
use std::time::Duration;

use fleetd_contracts::mcp::HubInfoOutput;
use fleetd_contracts::model::{Machine, MachineStatus};
use serde_json::json;

use super::mcp_client::McpClient;

const UNKNOWN: &str = "0.0.0";

/// The hub's `hub_info`; the error is one plain reason.
pub async fn hub_info(client: &mut McpClient) -> Result<HubInfoOutput, String> {
    let result = client
        .call_tool("hub_info", json!({}), Duration::from_secs(30))
        .await
        .map_err(|e| match e.message() {
            m if m.contains("not found") => "the hub's fleetd is too old to say".to_owned(),
            m => m,
        })?;
    if result.is_error {
        return Err(result.body["message"]
            .as_str()
            .map_or_else(|| result.body.to_string(), str::to_owned));
    }
    serde_json::from_value(result.body)
        .map_err(|e| format!("hub_info answered in an unknown shape: {e}"))
}

/// The versions line for the hub `client` reaches, or None when everything known matches (or the hub can't say).
pub async fn line(client: &mut McpClient) -> Option<String> {
    let hub = hub_info(client).await.ok().map(|i| i.version);
    let machines: Vec<Machine> = client
        .call_tool("fleetd_status", json!({}), Duration::from_secs(30))
        .await
        .ok()
        .and_then(|r| serde_json::from_value(r.body["machines"].clone()).ok())
        .unwrap_or_default();
    let nodes: Vec<(String, String)> = machines
        .into_iter()
        .filter(|m| m.status != MachineStatus::Offline)
        .map(|m| (m.name, m.node_version))
        .collect();
    mismatch(crate::version(), hub.as_deref(), &nodes)
}

/// "Versions differ: A on this CLI, the hub; B on node mac. …", each version by its label and raw version, or None when the known versions all match.
pub fn mismatch(cli: &str, hub: Option<&str>, nodes: &[(String, String)]) -> Option<String> {
    let mut who: Vec<(&str, String)> = vec![(cli, "this CLI".to_owned())];
    who.extend(hub.map(|v| (v, "the hub".to_owned())));
    who.extend(
        nodes
            .iter()
            .map(|(name, v)| (v.as_str(), format!("node {name}"))),
    );
    let mut groups: Vec<(&str, Vec<String>)> = Vec::new();
    for (version, name) in who {
        if version.is_empty() || version == UNKNOWN {
            continue;
        }
        match groups.iter_mut().find(|(v, _)| *v == version) {
            Some((_, names)) => names.push(name),
            None => groups.push((version, vec![name])),
        }
    }
    if groups.len() < 2 {
        return None;
    }
    let parts: Vec<String> = groups
        .iter()
        .map(|(v, names)| format!("{} on {}", crate::version_shown(v), names.join(", ")))
        .collect();
    Some(format!(
        "Versions differ: {}. Run `fleetd update` on each machine that's behind.",
        parts.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nodes(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(n, v)| ((*n).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn matching_versions_say_nothing() {
        let v = "0.4.1";
        assert_eq!(
            mismatch(v, Some(v), &nodes(&[("builder", v), ("mac", v)])),
            None
        );
        assert_eq!(mismatch(v, None, &[]), None);
    }

    #[test]
    fn a_mismatch_is_one_line_naming_who_runs_what() {
        let line = mismatch(
            "0.0.0-nightly.202610221107+333368c",
            Some("0.0.0-nightly.202610211030+abc1234"),
            &nodes(&[
                ("builder", "0.0.0-nightly.202610211030+abc1234"),
                ("mac", "0.0.0-nightly.202610221107+333368c"),
            ]),
        )
        .unwrap();
        assert_eq!(
            line,
            "Versions differ: Nightly · Oct 22, 11:07 UTC · 333368c (0.0.0-nightly.202610221107+333368c) \
             on this CLI, node mac; Nightly · Oct 21, 10:30 UTC · abc1234 (0.0.0-nightly.202610211030+abc1234) \
             on the hub, node builder. Run `fleetd update` on each machine that's behind."
        );
        assert!(!line.contains('\n'));
    }

    #[test]
    fn version_0_0_0_is_unknown_never_different() {
        // A hub or node from before they reported their version says 0.0.0; so does a local build.
        assert_eq!(
            mismatch("0.4.1", Some("0.0.0"), &nodes(&[("builder", "0.0.0")])),
            None
        );
        assert_eq!(mismatch("0.0.0", Some("0.4.1"), &[]), None);
    }
}
