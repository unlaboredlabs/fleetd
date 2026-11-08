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
    McpTestResult, McpValue, McpValueName, McpValueSet, OAUTH_HEADER,
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
/// operate on its machine. A global one (and whether agents get the person's own) reaches every teammate's agents, so
/// it takes admin on every machine: an owner's or admin's device, never a member's (D209).
pub(crate) fn may_change(caller: &Caller, scope: &McpScope) -> Result<(), ToolError> {
    let allowed = match scope {
        McpScope::Project { machine_id, .. } => allows(caller, Role::Operate, Some(machine_id)),
        McpScope::Global => allows_everywhere(caller, Role::Admin),
    };
    if is_human(caller) && allowed {
        return Ok(());
    }
    if let (true, McpScope::Project { machine_id, .. }) = (is_human(caller), scope) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            format!("You can't change this project's MCP servers: that takes Operate access to {machine_id}."),
        )
        .with_fix("Ask the hub's owner or an admin to give it to you."));
    }
    if is_human(caller) && matches!(scope, McpScope::Global) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Global MCP servers reach every teammate's agents: only the hub's owners and admins change them.",
        )
        .with_fix("Ask an owner or admin (Settings › Hub › Every project › Tools & skills), or add the server to one project in its settings."));
    }
    Err(ToolError::new(
        ErrorCode::Forbidden,
        "Only a person changes the MCP servers agents get, with operate on every machine they reach.",
    )
    .with_fix("Change them in the desktop app: Settings › Hub › Every project › Tools & skills, or the project's settings."))
}

pub(crate) fn project_of(hub: &Hub, scope: &McpScope) -> Result<Option<ProjectRef>, ToolError> {
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
pub(crate) fn node_ready(hub: &Hub, m: &MachineId) -> Result<(), ToolError> {
    if !hub.executors.is_connected(m) {
        return Err(offline(m));
    }
    if !hub.link.node_can(m, CAP_MCP_SERVERS) {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("fleetd on {m} is too old to run MCP servers."),
        )
        .with_fix(format!("Update fleetd on {m}, then try again.")));
    }
    Ok(())
}

pub(crate) fn not_found(scope: &McpScope, name: &str) -> ToolError {
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
    if input.integration.is_some() && project.is_none() {
        // Only a project's lead asks before a tool runs: one saved for every project would reach agents unasked.
        return Err(ToolError::new(
            ErrorCode::Invalid,
            "An integration asks you before its tools send anything, which only a project's lead does.",
        )
        .with_fix("Add it in one project's settings: its lead asks you before each send."));
    }
    if let Some(r) = project.as_ref().filter(|_| input.integration.is_some())
        && !hub.link.node_can(
            &r.machine_id,
            fleetd_contracts::node_link::CAP_ONE_LEAD_MODE,
        )
        && !crate::hub::integrations::is_navi(&hub.db, r)?
    {
        // An older node runs this project's lead with full access, which would send unasked.
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "{}'s node is too old for its lead to ask before a send.",
                r.machine_id
            ),
        )
        .with_fix(format!(
            "Run fleetd update on {}, then add it again.",
            r.machine_id
        )));
    }
    let store = hub.db.mcp_servers();
    let before = store.get(&input.scope, &input.name)?;
    if before.is_none() && store.list(&input.scope)?.len() >= MCP_SERVERS_MAX {
        let place = match &input.scope {
            McpScope::Global => "for every project",
            McpScope::Project { .. } => "in this project",
        };
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "There are already {MCP_SERVERS_MAX} MCP servers {place}, the most fleetd takes."
            ),
        )
        .with_fix("Remove one first."));
    }
    let saved_secret = |field: McpField, name: &McpValueName| -> Option<&McpValue> {
        before.as_ref()?.values().find_map(|(f, v)| {
            (f == field && &v.name == name && v.kind == EnvVarKind::Secret).then_some(v)
        })
    };
    // A server signed in with OAuth keeps its sign-in, and its token on the machine, through a save that leaves its
    // URL and its Authorization header alone; a new URL, or a typed Authorization, ends it.
    let typed_token = input
        .headers
        .iter()
        .any(|v| v.name().as_str().eq_ignore_ascii_case(OAUTH_HEADER));
    let had_sign_in = before.as_ref().is_some_and(|b| b.oauth.is_some());
    let signs_in = had_sign_in
        && !typed_token
        && before
            .as_ref()
            .is_some_and(|b| b.transport == input.transport);
    let token = McpValueName::unchecked(OAUTH_HEADER);
    let env: Vec<McpValueSet> = input.env.iter().cloned().collect();
    let headers: Vec<McpValueSet> = input
        .headers
        .iter()
        .cloned()
        .chain(
            (signs_in && saved_secret(McpField::Header, &token).is_some()).then(|| {
                McpValueSet::Keep {
                    name: token.clone(),
                }
            }),
        )
        .collect();
    let field_of = |field: McpField| -> &[McpValueSet] {
        match field {
            McpField::Env => &env,
            McpField::Header => &headers,
        }
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
    // Read again: a renewal may have changed the sign-in while the nodes answered.
    let oauth = match signs_in {
        true => store.get(&input.scope, &input.name)?.and_then(|s| s.oauth),
        false => None,
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
        oauth,
        updated_at: now(&hub),
    };
    store.put(&server)?;
    if had_sign_in && !signs_in {
        crate::hub::mcp_oauth::forget(&hub, &input.scope, &input.name).await;
    }
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
    if before.oauth.is_some() {
        crate::hub::mcp_oauth::forget(&hub, &input.scope, &input.name).await;
    }
    crate::hub::mcp_oauth::removed(&hub, &input.scope, &input.name)?;
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

/// Has each online node forget the secrets queued for it ([`super::McpServerStore::forgets`]); one offline, or too
/// old, is asked again on the next round.
pub async fn forget_queued(hub: &Hub) {
    let store = hub.db.mcp_servers();
    let queued = match store.forgets() {
        Ok(queued) => queued,
        Err(e) => {
            tracing::warn!("MCP secrets to forget not read: {e}");
            return;
        }
    };
    for (m, scope, name) in queued {
        if node_ready(hub, &m).is_err() {
            continue;
        }
        let forgot = hub
            .executors
            .mcp_secrets(&m, scope.clone(), name.clone(), Vec::new(), Vec::new())
            .await;
        match forgot {
            Ok(_) => {
                if let Err(e) = store.forgot(&m, &scope, &name) {
                    tracing::warn!(machine_id = %m, server = %name, "MCP secrets forgotten, not noted: {e}");
                }
            }
            Err(e) => {
                tracing::warn!(machine_id = %m, server = %name, "MCP secrets not forgotten: {e}")
            }
        }
    }
}

/// [`forget_queued`] each minute, until the hub stops.
pub async fn run_forget(hub: Arc<Hub>) {
    loop {
        forget_queued(&hub).await;
        hub.clock.sleep(std::time::Duration::from_secs(60)).await;
    }
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
    if let Some(oauth) = server.oauth.as_ref().filter(|_| !super::signed_in(&server)) {
        return Ok(McpServerTestOutput {
            machine_id,
            result: McpTestResult {
                error: Some(oauth.problem.clone().unwrap_or_else(|| {
                    format!(
                        "{} isn't signed in yet: sign in with your own account.",
                        server.name
                    )
                })),
                sign_in: Some(true),
                ..Default::default()
            },
            next: Some("mcp_oauth_start opens its sign-in.".into()),
            truncated: None,
        });
    }
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
    let project_id = project.map(|r| r.project_id);
    let mut result = hub
        .executors
        .mcp_test(&machine_id, project_id.clone(), session.clone())
        .await
        .map_err(from_executor)?;
    if result.error.as_deref().is_some_and(refused) {
        result = turned_away(&hub, &server, &machine_id, project_id, session, result).await?;
    }
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

/// A test the server turned away (HTTP 401).
fn refused(error: &str) -> bool {
    error.contains("401")
}

/// A test the server turned away: a signed-in server's token is renewed and tested again, and one the service won't
/// renew is signed out; a server with no key that asks for sign-in says so.
async fn turned_away(
    hub: &Hub,
    server: &McpServer,
    machine_id: &MachineId,
    project_id: Option<fleetd_contracts::ids::ProjectId>,
    session: fleetd_contracts::mcp_servers::McpSessionServer,
    result: McpTestResult,
) -> Result<McpTestResult, ToolError> {
    use crate::hub::mcp_oauth::{Renewed, renew_now, url_of};
    if server.oauth.is_some() {
        let renewed = renew_now(hub, &server.scope, &server.name)
            .await
            .map_err(|why| ToolError::new(ErrorCode::Failed, why))?;
        return match renewed {
            // Tested again as the server is now: its header may have reached the machine since the first test.
            Renewed::Yes => {
                let now = hub.db.mcp_servers().get(&server.scope, &server.name)?;
                let session = now
                    .as_ref()
                    .and_then(|s| super::for_session(s, machine_id))
                    .unwrap_or(session);
                Ok(hub
                    .executors
                    .mcp_test(machine_id, project_id, session)
                    .await
                    .map_err(from_executor)?)
            }
            Renewed::SignedOut => {
                let problem = hub
                    .db
                    .mcp_servers()
                    .get(&server.scope, &server.name)?
                    .and_then(|s| s.oauth?.problem);
                Ok(McpTestResult {
                    error: Some(problem.unwrap_or_else(|| {
                        format!("{} signed fleetd out: sign in again.", server.name)
                    })),
                    sign_in: Some(true),
                    ..result
                })
            }
            Renewed::Later => Ok(result),
        };
    }
    let keyed = server
        .headers
        .iter()
        .any(|v| v.name.as_str().eq_ignore_ascii_case(OAUTH_HEADER));
    match url_of(server) {
        Some((url, sse))
            if !keyed && crate::hub::mcp_oauth::oauth::offers_sign_in(url, sse).await =>
        {
            Ok(McpTestResult {
                error: Some(format!(
                    "{} asks you to sign in with your own account, not a key.",
                    server.name
                )),
                sign_in: Some(true),
                ..result
            })
        }
        _ => Ok(result),
    }
}
