//! The MCP server tools. Saving a server relays each secret's boxes to the nodes they were sealed to and records the
//! fingerprints they answer; the boxes themselves are never stored, logged or returned.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::mcp::{
    ErrorCode, McpServerRemoveInput, McpServerRemoveOutput, McpServerSetInput, McpServerSetOutput,
    McpServerTestInput, McpServerTestOutput, McpServersGetInput, McpServersGetOutput,
    McpSettingsSetInput, McpSettingsSetOutput,
};
use fleetd_contracts::mcp_servers::{
    MCP_SERVERS_MAX, McpField, McpScope, McpSealedOn, McpSecretKey, McpSecretSet, McpServer,
    McpTestResult, McpValue, McpValueName, McpValueSet,
};
use fleetd_contracts::node_link::CAP_MCP_SERVERS;
use fleetd_contracts::prim::True;
use fleetd_contracts::project_settings::EnvVarKind;

use super::{now, secret_scope};
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, allows, allows_everywhere, is_human, offline, require,
    unknown_project,
};
use crate::hub::executor::tools::from_executor;

pub fn register(tools: &mut Registry) {
    tools.add("mcp_servers_get", get);
    tools.add("mcp_server_set", set);
    tools.add("mcp_server_remove", remove);
    tools.add("mcp_settings_set", settings_set);
    tools.add("mcp_server_test", test);
}

/// A server runs whatever it is given on the machines its agents run on: only a person changes them, a project's with
/// operate on its machine, a global one with operate everywhere.
fn may_change(caller: &Caller, scope: &McpScope) -> Result<(), ToolError> {
    let allowed = match scope {
        McpScope::Project { machine_id, .. } => allows(caller, Role::Operate, Some(machine_id)),
        McpScope::Global => allows_everywhere(caller, Role::Operate),
    };
    if is_human(caller) && allowed {
        return Ok(());
    }
    Err(ToolError::new(
        ErrorCode::Forbidden,
        "Only a person changes the MCP servers agents get, with operate on every machine they reach.",
    )
    .with_fix("Change them in the desktop app: Settings › MCP servers, or the project's settings."))
}

fn project_of(hub: &Hub, scope: &McpScope) -> Result<Option<ProjectRef>, ToolError> {
    let McpScope::Project {
        machine_id,
        project_id,
    } = scope
    else {
        return Ok(None);
    };
    let r = ProjectRef {
        machine_id: machine_id.clone(),
        project_id: project_id.clone(),
    };
    if hub.store.project_get(&r)?.is_none() {
        return Err(unknown_project(&r));
    }
    Ok(Some(r))
}

/// The node can take MCP calls: online and new enough.
fn node_ready(hub: &Hub, m: &MachineId) -> Result<(), ToolError> {
    if !hub.executors.is_connected(m) {
        return Err(offline(m));
    }
    if !hub.link.node_can(m, CAP_MCP_SERVERS) {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("{m}'s node is too old to take MCP servers."),
        )
        .with_fix(format!("Update fleetd on {m} and restart its node.")));
    }
    Ok(())
}

fn not_found(scope: &McpScope, name: &str) -> ToolError {
    let place = match scope {
        McpScope::Global => "global".to_owned(),
        McpScope::Project { project_id, .. } => format!("project {project_id}'s"),
    };
    ToolError::new(
        ErrorCode::NotFound,
        format!("No {place} MCP server {name}."),
    )
    .with_fix("mcp_servers_get lists them.")
}

async fn get(
    hub: Arc<Hub>,
    caller: Caller,
    input: McpServersGetInput,
) -> Result<McpServersGetOutput, ToolError> {
    let store = hub.db.mcp_servers();
    let project = match &input.project {
        None => {
            require(&caller, Role::Read, None)?;
            Vec::new()
        }
        Some(r) => {
            require(&caller, Role::Read, Some(&r.machine_id))?;
            let scope = McpScope::Project {
                machine_id: r.machine_id.clone(),
                project_id: r.project_id.clone(),
            };
            project_of(&hub, &scope)?;
            store.list(&scope)?
        }
    };
    Ok(McpServersGetOutput {
        global: store.list(&McpScope::Global)?,
        project,
        user_servers: store.user_servers()?,
        next: None,
        truncated: None,
    })
}

async fn set(
    hub: Arc<Hub>,
    caller: Caller,
    input: McpServerSetInput,
) -> Result<McpServerSetOutput, ToolError> {
    may_change(&caller, &input.scope)?;
    let project = project_of(&hub, &input.scope)?;
    let store = hub.db.mcp_servers();
    let before = store.get(&input.scope, &input.name)?;
    if before.is_none() && store.list(&input.scope)?.len() >= MCP_SERVERS_MAX {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("A scope takes at most {MCP_SERVERS_MAX} MCP servers."),
        )
        .with_fix("Remove one first."));
    }
    let field_of = |field: McpField| match field {
        McpField::Env => &input.env,
        McpField::Header => &input.headers,
    };
    let saved_secret = |field: McpField, name: &McpValueName| -> Option<&McpValue> {
        before.as_ref()?.values().find_map(|(f, v)| {
            (f == field && &v.name == name && v.kind == EnvVarKind::Secret).then_some(v)
        })
    };
    // Every machine that gets a node call: those the new boxes are for, and those holding this server's secrets now.
    let mut targets: BTreeSet<MachineId> = BTreeSet::new();
    for field in [McpField::Env, McpField::Header] {
        for v in field_of(field).iter() {
            match v {
                McpValueSet::Secret { name, sealed } => {
                    for s in sealed {
                        if let Some(r) = &project
                            && s.machine_id != r.machine_id
                        {
                            return Err(ToolError::new(
                                ErrorCode::Invalid,
                                format!(
                                    "{name} is sealed to {}, but the project's machine is {}.",
                                    s.machine_id, r.machine_id
                                ),
                            )
                            .with_fix("Seal a project server's secrets to its own machine."));
                        }
                        targets.insert(s.machine_id.clone());
                    }
                }
                McpValueSet::Keep { name } => {
                    if saved_secret(field, name).is_none() {
                        return Err(ToolError::new(
                            ErrorCode::Invalid,
                            format!("{name} has no saved secret to keep."),
                        )
                        .with_fix("Type its value."));
                    }
                }
                McpValueSet::Plain { .. } => {}
            }
        }
    }
    if let Some(before) = &before {
        for (_, v) in before.values() {
            targets.extend(v.sealed_on.iter().map(|s| s.machine_id.clone()));
        }
    }
    if let Some(r) = &project
        && !targets.is_empty()
    {
        node_ready(&hub, &r.machine_id)?;
    }
    // What each reached node holds now, by (field, name) and machine; and why a global server's machine wasn't.
    let mut held: BTreeMap<(McpField, String), Vec<McpSealedOn>> = BTreeMap::new();
    let mut reached: BTreeSet<MachineId> = BTreeSet::new();
    let mut problems: Vec<String> = Vec::new();
    let scope = secret_scope(&input.scope);
    for m in &targets {
        if let Err(e) = node_ready(&hub, m) {
            problems.push(e.message);
            continue;
        }
        let mut set = Vec::new();
        let mut keep = Vec::new();
        for field in [McpField::Env, McpField::Header] {
            for v in field_of(field).iter() {
                match v {
                    McpValueSet::Secret { name, sealed } => {
                        if let Some(s) = sealed.iter().find(|s| &s.machine_id == m) {
                            set.push(McpSecretSet {
                                field,
                                name: name.clone(),
                                sealed: s.sealed.clone(),
                            });
                        }
                    }
                    McpValueSet::Keep { name } => {
                        if saved_secret(field, name)
                            .is_some_and(|v| v.sealed_on.iter().any(|s| &s.machine_id == m))
                        {
                            keep.push(McpSecretKey {
                                field,
                                name: name.clone(),
                            });
                        }
                    }
                    McpValueSet::Plain { .. } => {}
                }
            }
        }
        let saved = hub
            .executors
            .mcp_secrets(m, scope.clone(), input.name.clone(), set, keep)
            .await
            .map_err(from_executor);
        match saved {
            Ok(saved) => {
                reached.insert(m.clone());
                for s in saved {
                    held.entry((s.field, s.name.to_string()))
                        .or_default()
                        .push(McpSealedOn {
                            machine_id: m.clone(),
                            fingerprint: s.fingerprint,
                        });
                }
            }
            // A project server's machine is the only one: all or nothing.
            Err(e) if project.is_some() => return Err(e),
            Err(e) => problems.push(format!("{m}: {}", e.message)),
        }
    }
    let values = |field: McpField| -> Vec<McpValue> {
        field_of(field)
            .iter()
            .map(|v| match v {
                McpValueSet::Plain { name, value } => McpValue {
                    name: name.clone(),
                    kind: EnvVarKind::Plain,
                    value: Some(value.clone()),
                    sealed_on: Vec::new(),
                },
                McpValueSet::Secret { name, .. } | McpValueSet::Keep { name } => {
                    let mut sealed_on = held
                        .get(&(field, name.to_string()))
                        .cloned()
                        .unwrap_or_default();
                    // A kept secret stays recorded on a machine this save didn't reach: its node still has it.
                    if matches!(v, McpValueSet::Keep { .. })
                        && let Some(saved) = saved_secret(field, name)
                    {
                        sealed_on.extend(
                            saved
                                .sealed_on
                                .iter()
                                .filter(|s| !reached.contains(&s.machine_id))
                                .cloned(),
                        );
                    }
                    sealed_on.sort_by(|a, b| a.machine_id.cmp(&b.machine_id));
                    McpValue {
                        name: name.clone(),
                        kind: EnvVarKind::Secret,
                        value: None,
                        sealed_on,
                    }
                }
            })
            .collect()
    };
    let server = McpServer {
        scope: input.scope.clone(),
        name: input.name.clone(),
        enabled: input.enabled,
        roles: input.roles,
        transport: input.transport.clone(),
        env: values(McpField::Env),
        headers: values(McpField::Header),
        integration: input.integration.clone(),
        updated_at: now(&hub),
    };
    store.put(&server)?;
    let machines: Vec<MachineId> = match &project {
        Some(r) => vec![r.machine_id.clone()],
        None => hub
            .store
            .machines_list()?
            .into_iter()
            .map(|m| m.machine_id)
            .collect(),
    };
    let missing_on: Vec<MachineId> = machines
        .into_iter()
        .filter(|m| !server.secrets_missing_on(m).is_empty())
        .collect();
    let mut next = "Agents started from now on get it; a running agent gets it at its next start, after its next \
                    message."
        .to_owned();
    if !missing_on.is_empty() {
        let names: Vec<&str> = missing_on.iter().map(|m| m.as_str()).collect();
        next = format!(
            "{next} Its secrets aren't on {}, whose agents go without it until it is saved again while they are \
             online.",
            names.join(", ")
        );
    }
    if !problems.is_empty() {
        next = format!("{next} {}", problems.join(" "));
    }
    Ok(McpServerSetOutput {
        server,
        missing_on,
        next: Some(next),
        truncated: None,
    })
}

async fn remove(
    hub: Arc<Hub>,
    caller: Caller,
    input: McpServerRemoveInput,
) -> Result<McpServerRemoveOutput, ToolError> {
    may_change(&caller, &input.scope)?;
    let store = hub.db.mcp_servers();
    let Some(before) = store.get(&input.scope, &input.name)? else {
        return Err(not_found(&input.scope, &input.name));
    };
    store.remove(&input.scope, &input.name)?;
    // Each node holding its secrets forgets them; one offline keeps them unused until the server is saved again.
    let holders: BTreeSet<MachineId> = before
        .values()
        .flat_map(|(_, v)| v.sealed_on.iter().map(|s| s.machine_id.clone()))
        .collect();
    for m in holders {
        if node_ready(&hub, &m).is_err() {
            continue;
        }
        let forgot = hub
            .executors
            .mcp_secrets(
                &m,
                secret_scope(&input.scope),
                input.name.clone(),
                Vec::new(),
                Vec::new(),
            )
            .await;
        if let Err(e) = forgot {
            tracing::warn!(machine_id = %m, server = %input.name, "MCP secrets not forgotten: {e}");
        }
    }
    Ok(McpServerRemoveOutput {
        ok: True,
        next: Some(
            "Agents started from now on go without it; a running agent keeps it until its next start.".into(),
        ),
        truncated: None,
    })
}

async fn settings_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: McpSettingsSetInput,
) -> Result<McpSettingsSetOutput, ToolError> {
    may_change(&caller, &McpScope::Global)?;
    let store = hub.db.mcp_servers();
    store.set_user_servers(input.user_servers)?;
    Ok(McpSettingsSetOutput {
        user_servers: store.user_servers()?,
        next: Some(
            "Agents started from now on run this way; a running agent at its next start, after its next message."
                .into(),
        ),
        truncated: None,
    })
}

async fn test(
    hub: Arc<Hub>,
    caller: Caller,
    input: McpServerTestInput,
) -> Result<McpServerTestOutput, ToolError> {
    let project = project_of(&hub, &input.scope)?;
    let Some(server) = hub.db.mcp_servers().get(&input.scope, &input.name)? else {
        return Err(not_found(&input.scope, &input.name));
    };
    let machine_id = match (&project, &input.machine_id) {
        (Some(r), _) => r.machine_id.clone(),
        (None, Some(m)) => m.clone(),
        (None, None) => hub
            .store
            .machines_list()?
            .into_iter()
            .map(|m| m.machine_id)
            .find(|m| node_ready(&hub, m).is_ok())
            .ok_or_else(|| {
                ToolError::new(
                    ErrorCode::MachineOffline,
                    "No machine is online to test the server on.",
                )
                .with_fix("Start a node, then test again.")
            })?,
    };
    require(&caller, Role::Operate, Some(&machine_id))?;
    node_ready(&hub, &machine_id)?;
    let missing = server.secrets_missing_on(&machine_id);
    let Some(session) = super::for_session(&server, &machine_id) else {
        let names: Vec<&str> = missing.iter().map(|n| n.as_str()).collect();
        return Ok(McpServerTestOutput {
            machine_id: machine_id.clone(),
            result: McpTestResult {
                error: Some(format!(
                    "{} isn't on {machine_id}: save the server again while {machine_id} is online.",
                    names.join(", ")
                )),
                ..Default::default()
            },
            next: None,
            truncated: None,
        });
    };
    let mut result = hub
        .executors
        .mcp_test(&machine_id, project.map(|r| r.project_id), session)
        .await
        .map_err(from_executor)?;
    for tool in &mut result.tools {
        tool.policy = Some(crate::hub::integrations::policy::tool_policy(
            &server, &tool.name,
        ));
    }
    Ok(McpServerTestOutput {
        machine_id,
        result,
        next: None,
        truncated: None,
    })
}
