//! A project's own settings (Settings › Projects in the app): `project_settings_get`, `project_settings_set` and
//! `project_env_set`, and what the hub keeps of them: `project_settings.keep_worktrees` and the `project_env` rows.
//!
//! A variable is set on the project's node first, which keeps the value and adds it to every claude it starts for
//! the project; only then does the hub record it. The hub's row holds a plain variable's value and a secret's
//! fingerprint: a secret reaches the hub sealed to the node's box key, is relayed in the same call and is never
//! stored, logged or returned.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::mcp::{
    ErrorCode, ProjectEnvSetInput, ProjectEnvSetOutput, ProjectSettings, ProjectSettingsGetInput,
    ProjectSettingsGetOutput, ProjectSettingsSetInput, ProjectSettingsSetOutput,
};
use fleetd_contracts::node_link::CAP_PROJECT_SETTINGS;
use fleetd_contracts::prim::Count;
use fleetd_contracts::project_settings::{
    ENV_TOTAL_MAX_BYTES, ENV_VALUE_MAX_BYTES, env_total_over,
};
use fleetd_contracts::project_settings::{
    EnvValue, EnvVarKind, EnvVarName, EnvVarSet, PROJECT_ENV_MAX, ProjectEnvVar,
};
use fleetd_contracts::secrets::{Base64Alphabet, SEAL_OVERHEAD, SecretFingerprint, base64_bytes};
use rusqlite::{OptionalExtension, params};

use crate::hub::api::{
    Caller, Hub, Registry, ToolError, is_human, offline, require, unknown_machine, unknown_project,
};
use crate::hub::executor::tools::from_executor;
use crate::hub::store::{HubDb, StoreError};

pub fn register(tools: &mut Registry) {
    tools.add("project_settings_get", get);
    tools.add("project_settings_set", set);
    tools.add("project_env_set", env_set);
}

/// One row to write: a plain variable's value, or a secret's fingerprint.
pub struct EnvRow {
    pub name: EnvVarName,
    pub value: Option<EnvValue>,
    pub fingerprint: Option<SecretFingerprint>,
    /// The value's size, a secret's too.
    pub bytes: usize,
}

/// A change's value size: a plain value's own, a secret's from its sealed box less the seal's overhead.
fn set_bytes(v: &EnvVarSet) -> usize {
    match v {
        EnvVarSet::Plain { value, .. } => value.len(),
        EnvVarSet::Secret { sealed, .. } => base64_bytes(sealed.as_str(), Base64Alphabet::Base64)
            .unwrap_or_default()
            .saturating_sub(SEAL_OVERHEAD),
    }
}

pub struct ProjectSettingsStore<'a> {
    db: &'a HubDb,
}

impl HubDb {
    pub fn project_settings(&self) -> ProjectSettingsStore<'_> {
        ProjectSettingsStore { db: self }
    }
}

impl ProjectSettingsStore<'_> {
    /// Whether a finished task's worktree stays: off until a person turns it on.
    pub fn keep_worktrees(&self, r: &ProjectRef) -> Result<bool, StoreError> {
        let saved: Option<bool> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT keep_worktrees FROM project_settings WHERE machine_id = ? AND project_id = ?",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        Ok(saved.unwrap_or(false))
    }

    pub fn set_keep_worktrees(&self, r: &ProjectRef, keep: bool) -> Result<(), StoreError> {
        // A new row keeps medium on, its default.
        self.db.with(|c| {
            c.execute(
                "INSERT INTO project_settings (machine_id, project_id, medium_allowed, keep_worktrees) VALUES (?, ?, 1, ?)
                 ON CONFLICT (machine_id, project_id) DO UPDATE SET keep_worktrees = excluded.keep_worktrees",
                params![r.machine_id.as_str(), r.project_id.as_str(), keep],
            )?;
            Ok(())
        })
    }

    /// The project's variables, by name.
    pub fn env(&self, r: &ProjectRef) -> Result<Vec<ProjectEnvVar>, StoreError> {
        self.db.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT name, kind, value, fingerprint, bytes, updated_at FROM project_env
                 WHERE machine_id = ? AND project_id = ? ORDER BY name",
            )?;
            let rows = stmt
                .query_map(
                    params![r.machine_id.as_str(), r.project_id.as_str()],
                    |row| {
                        let kind: String = row.get(1)?;
                        Ok(ProjectEnvVar {
                            name: EnvVarName::unchecked(row.get::<_, String>(0)?),
                            kind: if kind == "secret" {
                                EnvVarKind::Secret
                            } else {
                                EnvVarKind::Plain
                            },
                            value: row.get::<_, Option<String>>(2)?.map(EnvValue::unchecked),
                            fingerprint: row
                                .get::<_, Option<String>>(3)?
                                .map(SecretFingerprint::unchecked),
                            bytes: Count::unchecked(row.get(4)?),
                            updated_at: Timestamp(row.get(5)?),
                        })
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Writes `set` and deletes `remove` in one transaction.
    pub fn env_apply(
        &self,
        r: &ProjectRef,
        set: &[EnvRow],
        remove: &[EnvVarName],
        at: &Timestamp,
    ) -> Result<(), StoreError> {
        self.db.transaction(|c| {
            for name in remove {
                c.prepare_cached(
                    "DELETE FROM project_env WHERE machine_id = ? AND project_id = ? AND name = ?",
                )?
                .execute(params![
                    r.machine_id.as_str(),
                    r.project_id.as_str(),
                    name.as_str()
                ])?;
            }
            for row in set {
                let kind = if row.fingerprint.is_some() {
                    "secret"
                } else {
                    "plain"
                };
                c.prepare_cached(
                    "INSERT INTO project_env (machine_id, project_id, name, kind, value, fingerprint, bytes, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT (machine_id, project_id, name) DO UPDATE SET kind = excluded.kind,
                       value = excluded.value, fingerprint = excluded.fingerprint, bytes = excluded.bytes,
                       updated_at = excluded.updated_at",
                )?
                .execute(params![
                    r.machine_id.as_str(),
                    r.project_id.as_str(),
                    row.name.as_str(),
                    kind,
                    row.value.as_ref().map(|v| v.as_str()),
                    row.fingerprint.as_ref().map(|f| f.as_str()),
                    row.bytes as i64,
                    at.as_str(),
                ])?;
            }
            Ok(())
        })
    }
}

fn project_ref(machine_id: &MachineId, project_id: &ProjectId) -> ProjectRef {
    ProjectRef {
        machine_id: machine_id.clone(),
        project_id: project_id.clone(),
    }
}

/// The node can take the call: it is online and new enough.
fn node_ready(hub: &Hub, m: &MachineId) -> Result<(), ToolError> {
    if hub.store.machine_get(m)?.is_none() {
        return Err(unknown_machine(m));
    }
    if !hub.executors.is_connected(m) {
        return Err(offline(m));
    }
    if !hub.link.node_can(m, CAP_PROJECT_SETTINGS) {
        return Err(too_old(m));
    }
    Ok(())
}

pub fn too_old(m: &MachineId) -> ToolError {
    ToolError::new(
        ErrorCode::Invalid,
        format!("{m}'s node is too old to take project settings."),
    )
    .with_fix(format!("Update fleetd on {m} and restart its node."))
}

async fn settings_of(hub: &Hub, r: &ProjectRef) -> Result<ProjectSettings, ToolError> {
    let Some(project) = hub.store.project_get(r)? else {
        return Err(unknown_project(r));
    };
    let store = hub.db.project_settings();
    let m = &r.machine_id;
    let (worktrees, worktrees_unknown) = if !hub.executors.is_connected(m) {
        (None, Some(format!("{m} is offline.")))
    } else if !hub.link.node_can(m, CAP_PROJECT_SETTINGS) {
        (
            None,
            Some(format!(
                "{m}'s node is too old to say: update fleetd there."
            )),
        )
    } else {
        match hub.executors.project_worktrees(m, &r.project_id).await {
            Ok(w) => (Some(w), None),
            Err(e) => (None, Some(from_executor(e).message)),
        }
    };
    Ok(ProjectSettings {
        machine_id: r.machine_id.clone(),
        project_id: r.project_id.clone(),
        title: project.title,
        workspace_root: project.workspace_root,
        keep_worktrees: store.keep_worktrees(r)?,
        env: store.env(r)?,
        worktrees,
        worktrees_unknown,
    })
}

async fn get(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectSettingsGetInput,
) -> Result<ProjectSettingsGetOutput, ToolError> {
    require(&caller, Role::Read, Some(&input.machine_id))?;
    let r = project_ref(&input.machine_id, &input.project_id);
    Ok(ProjectSettingsGetOutput {
        settings: settings_of(&hub, &r).await?,
        next: None,
        truncated: None,
    })
}

async fn set(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectSettingsSetInput,
) -> Result<ProjectSettingsSetOutput, ToolError> {
    let m = &input.machine_id;
    require(&caller, Role::Operate, Some(m))?;
    let r = project_ref(m, &input.project_id);
    let Some(project) = hub.store.project_get(&r)? else {
        return Err(unknown_project(&r));
    };
    // The name lives on the node, which renames it in place: the machine stream then brings it back to every cache.
    if let Some(title) = &input.title
        && title.as_str() != project.title
    {
        if !hub.executors.is_connected(m) {
            return Err(offline(m));
        }
        hub.executors
            .project_upsert(m, &r.project_id, title.as_str(), &project.workspace_root)
            .await
            .map_err(from_executor)?;
    }
    if let Some(keep) = input.keep_worktrees {
        hub.db.project_settings().set_keep_worktrees(&r, keep)?;
    }
    let mut settings = settings_of(&hub, &r).await?;
    if let Some(title) = input.title {
        // Until the node's project event lands in the cache.
        settings.title = title.to_string();
    }
    Ok(ProjectSettingsSetOutput {
        settings,
        next: Some("New tasks of the project use these settings.".into()),
        truncated: None,
    })
}

async fn env_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectEnvSetInput,
) -> Result<ProjectEnvSetOutput, ToolError> {
    let m = &input.machine_id;
    require(&caller, Role::Operate, Some(m))?;
    if !is_human(&caller) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person sets a project's environment.",
        )
        .with_fix("Set it in the desktop app: Settings › Projects."));
    }
    let r = project_ref(m, &input.project_id);
    if hub.store.project_get(&r)?.is_none() {
        return Err(unknown_project(&r));
    }
    let store = hub.db.project_settings();
    // Each variable after the change, by name, with its value's size.
    let mut sizes: std::collections::BTreeMap<String, usize> = store
        .env(&r)?
        .into_iter()
        .map(|v| (v.name.into_inner(), v.bytes.get() as usize))
        .collect();
    for name in input.remove.iter() {
        sizes.remove(name.as_str());
    }
    sizes.extend(
        input
            .set
            .iter()
            .map(|v| (v.name().to_string(), set_bytes(v))),
    );
    let names = &sizes;
    if names.len() > PROJECT_ENV_MAX {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "A project takes at most {PROJECT_ENV_MAX} variables; this would make {}.",
                names.len()
            ),
        )
        .with_fix("Remove some first."));
    }
    if let Some(name) = input
        .set
        .iter()
        .find(|v| set_bytes(v) > ENV_VALUE_MAX_BYTES)
    {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("{}'s value is over 64 KiB.", name.name()),
        )
        .with_fix("Shorten it, or put a file on the machine and set its path instead."));
    }
    let total: usize = sizes.values().sum();
    if total > ENV_TOTAL_MAX_BYTES {
        return Err(ToolError::new(ErrorCode::Invalid, env_total_over(total))
            .with_fix("Remove or shorten some, or put large values in files on the machine."));
    }
    node_ready(&hub, m)?;
    let set = input.set.into_inner();
    let remove = input.remove.into_inner();
    let saved = hub
        .executors
        .project_env(m, &r.project_id, set.clone(), remove.clone())
        .await
        .map_err(from_executor)?;
    let mut rows = Vec::with_capacity(set.len());
    for v in set {
        rows.push(match v {
            EnvVarSet::Plain { name, value } => EnvRow {
                name,
                bytes: value.len(),
                value: Some(value),
                fingerprint: None,
            },
            ref secret @ EnvVarSet::Secret { ref name, .. } => {
                let (bytes, name) = (set_bytes(secret), name.clone());
                let Some(saved) = saved.iter().find(|s| s.name == name) else {
                    return Err(ToolError::new(
                        ErrorCode::Failed,
                        format!("{m}'s node saved {name} but sent no fingerprint for it."),
                    )
                    .with_fix(format!("Update fleetd on {m}, then set {name} again.")));
                };
                EnvRow {
                    name,
                    value: None,
                    fingerprint: Some(saved.fingerprint.clone()),
                    bytes,
                }
            }
        });
    }
    let at = super::now(&hub);
    store.env_apply(&r, &rows, &remove, &at)?;
    Ok(ProjectEnvSetOutput {
        env: store.env(&r)?,
        next: Some(
            "Every claude the node starts for the project from now on gets them; running sessions get them at their \
             next start."
                .into(),
        ),
        truncated: None,
    })
}
