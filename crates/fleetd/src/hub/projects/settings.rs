//! A project's own settings (Settings › Projects in the app): `project_settings_get`, `project_settings_set` and
//! `project_env_set`, and what the hub keeps of them: `project_settings.keep_worktrees`, `project_settings.setup` (the
//! commands each new worktree runs before its agent starts, sent with each task's launch), `project_settings.train`
//! (the checks the merge train waits for, and those it leaves for after the merge), `project_settings.preview` (how a
//! preview someone asks for runs, W58) and the `project_env` rows.
//!
//! A repo of the project (W79) can have its own `setup` and `preview` (`repos.setup`, `repos.preview`): a call that
//! names the repo reads and writes those, and an empty one is the project's. A task's launch and a preview read their
//! repo's, for now always the project's own repo (none for a plain directory). Everything else is the project's.
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
use fleetd_contracts::preview::PreviewConfig;
use fleetd_contracts::prim::Count;
use fleetd_contracts::project_settings::{
    ENV_TOTAL_MAX_BYTES, ENV_VALUE_MAX_BYTES, env_total_over,
};
use fleetd_contracts::project_settings::{
    EnvValue, EnvVarKind, EnvVarName, EnvVarSet, PROJECT_ENV_MAX, ProjectEnvVar, TrainSettings,
    WorktreeSetup,
};
use fleetd_contracts::repos::{ProjectRepo, RepoId, RepoName};
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

    /// The project's setup commands; `None` when it has none.
    pub fn setup(&self, r: &ProjectRef) -> Result<Option<WorktreeSetup>, StoreError> {
        let saved: Option<Option<String>> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT setup FROM project_settings WHERE machine_id = ? AND project_id = ?",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        Ok(saved
            .flatten()
            .and_then(|json| serde_json::from_str::<WorktreeSetup>(&json).ok())
            .filter(|s| !s.is_empty()))
    }

    /// Replaces the project's setup commands; none turns setup off.
    pub fn set_setup(&self, r: &ProjectRef, setup: &WorktreeSetup) -> Result<(), StoreError> {
        let json = (!setup.is_empty())
            .then(|| serde_json::to_string(setup))
            .transpose()?;
        self.db.with(|c| {
            c.execute(
                "INSERT INTO project_settings (machine_id, project_id, medium_allowed, setup) VALUES (?, ?, 1, ?)
                 ON CONFLICT (machine_id, project_id) DO UPDATE SET setup = excluded.setup",
                params![r.machine_id.as_str(), r.project_id.as_str(), json],
            )?;
            Ok(())
        })
    }

    /// How the merge train treats the project's repo's checks; the defaults when none are set.
    pub fn train(&self, r: &ProjectRef) -> Result<TrainSettings, StoreError> {
        let saved: Option<Option<String>> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT train FROM project_settings WHERE machine_id = ? AND project_id = ?",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        Ok(saved
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default())
    }

    /// How a preview of the project runs (Try it); none until a person sets one or approves an agent's proposal.
    pub fn preview(&self, r: &ProjectRef) -> Result<Option<PreviewConfig>, StoreError> {
        let saved: Option<Option<String>> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT preview FROM project_settings WHERE machine_id = ? AND project_id = ?",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        Ok(saved
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok()))
    }

    /// Replaces how a preview runs; one with no target turns Try it off for the project.
    pub fn set_preview(&self, r: &ProjectRef, preview: &PreviewConfig) -> Result<(), StoreError> {
        let json = (!preview.targets().is_empty())
            .then(|| serde_json::to_string(preview))
            .transpose()?;
        self.db.with(|c| {
            c.execute(
                "INSERT INTO project_settings (machine_id, project_id, medium_allowed, preview) VALUES (?, ?, 1, ?)
                 ON CONFLICT (machine_id, project_id) DO UPDATE SET preview = excluded.preview",
                params![r.machine_id.as_str(), r.project_id.as_str(), json],
            )?;
            Ok(())
        })
    }

    /// The setup commands a new worktree of `repo` runs: the repo's own, else the project's; `repo` none (the project's
    /// own directory, or a plain directory): the project's.
    pub fn setup_in(
        &self,
        r: &ProjectRef,
        repo: Option<&RepoId>,
    ) -> Result<Option<WorktreeSetup>, StoreError> {
        if let Some(repo) = repo
            && let Some(setup) = self
                .repo_json(repo, "setup")?
                .and_then(|json| serde_json::from_str::<WorktreeSetup>(&json).ok())
                .filter(|s| !s.is_empty())
        {
            return Ok(Some(setup));
        }
        self.setup(r)
    }

    /// Replaces `repo`'s setup commands; none gives it the project's. `repo` none: the project's, as `set_setup`.
    pub fn set_setup_in(
        &self,
        r: &ProjectRef,
        repo: Option<&RepoId>,
        setup: &WorktreeSetup,
    ) -> Result<(), StoreError> {
        let Some(repo) = repo else {
            return self.set_setup(r, setup);
        };
        let json = (!setup.is_empty())
            .then(|| serde_json::to_string(setup))
            .transpose()?;
        self.set_repo_json(repo, "setup", json)
    }

    /// How a preview of `repo` runs: the repo's own setting, else the project's; `repo` none: the project's.
    pub fn preview_in(
        &self,
        r: &ProjectRef,
        repo: Option<&RepoId>,
    ) -> Result<Option<PreviewConfig>, StoreError> {
        if let Some(repo) = repo
            && let Some(preview) = self
                .repo_json(repo, "preview")?
                .and_then(|json| serde_json::from_str(&json).ok())
        {
            return Ok(Some(preview));
        }
        self.preview(r)
    }

    /// Replaces how a preview of `repo` runs; one with no target gives it the project's. `repo` none: the project's, as
    /// `set_preview`.
    pub fn set_preview_in(
        &self,
        r: &ProjectRef,
        repo: Option<&RepoId>,
        preview: &PreviewConfig,
    ) -> Result<(), StoreError> {
        let Some(repo) = repo else {
            return self.set_preview(r, preview);
        };
        let json = (!preview.targets().is_empty())
            .then(|| serde_json::to_string(preview))
            .transpose()?;
        self.set_repo_json(repo, "preview", json)
    }

    /// A repo's own `setup` or `preview`, as JSON; none when it takes the project's.
    fn repo_json(&self, repo: &RepoId, column: &'static str) -> Result<Option<String>, StoreError> {
        let Some(n) = crate::hub::repos::store::number(repo) else {
            return Ok(None);
        };
        let saved: Option<Option<String>> = self.db.with(|c| {
            Ok(c.query_row(
                &format!("SELECT {column} FROM repos WHERE n = ?"),
                [n],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        Ok(saved.flatten())
    }

    fn set_repo_json(
        &self,
        repo: &RepoId,
        column: &'static str,
        json: Option<String>,
    ) -> Result<(), StoreError> {
        let Some(n) = crate::hub::repos::store::number(repo) else {
            return Ok(());
        };
        self.db.with(|c| {
            c.execute(
                &format!("UPDATE repos SET {column} = ? WHERE n = ?"),
                params![json, n],
            )?;
            Ok(())
        })
    }

    /// Replaces the train settings; the defaults clear them.
    pub fn set_train(&self, r: &ProjectRef, train: &TrainSettings) -> Result<(), StoreError> {
        let json = (*train != TrainSettings::default())
            .then(|| serde_json::to_string(train))
            .transpose()?;
        self.db.with(|c| {
            c.execute(
                "INSERT INTO project_settings (machine_id, project_id, medium_allowed, train) VALUES (?, ?, 1, ?)
                 ON CONFLICT (machine_id, project_id) DO UPDATE SET train = excluded.train",
                params![r.machine_id.as_str(), r.project_id.as_str(), json],
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

/// The setup commands a new task's worktree runs: its repo's, else the project's. A task's repo is, for now, the
/// project's own (none for a plain directory).
pub fn task_setup(hub: &Hub, r: &ProjectRef) -> Result<Option<WorktreeSetup>, StoreError> {
    let repo = hub.repos.own(r)?.map(|repo| repo.repo_id);
    hub.db.project_settings().setup_in(r, repo.as_ref())
}

/// How a preview of the project runs: its repo's setting, else the project's. A preview's repo is, for now, the
/// project's own (none for a plain directory).
pub fn preview_config(hub: &Hub, r: &ProjectRef) -> Result<Option<PreviewConfig>, StoreError> {
    let repo = hub.repos.own(r)?.map(|repo| repo.repo_id);
    hub.db.project_settings().preview_in(r, repo.as_ref())
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

/// The repo named in a call, `None` when none is; an unknown one is refused, with the project's repos to pick from.
fn repo_named(
    hub: &Hub,
    r: &ProjectRef,
    name: Option<&RepoName>,
) -> Result<Option<ProjectRepo>, ToolError> {
    let Some(name) = name else { return Ok(None) };
    if let Some(repo) = hub.repos.repo_by_name(r, name)? {
        return Ok(Some(repo));
    }
    let names: Vec<String> = hub
        .repos
        .repos_of(r)?
        .into_iter()
        .map(|repo| repo.name.into_inner())
        .collect();
    let fix = if names.is_empty() {
        "It has no repos: leave repo out for the project's own settings.".to_owned()
    } else {
        format!(
            "Name one of its repos ({}), or leave repo out for the project's own settings.",
            names.join(", ")
        )
    };
    Err(ToolError::new(
        ErrorCode::NotFound,
        format!(
            "Project {} on {} has no repo {name}.",
            r.project_id, r.machine_id
        ),
    )
    .with_fix(fix))
}

/// The project's settings, with `setup` and `preview` those of `repo` when one is given.
async fn settings_of(
    hub: &Hub,
    r: &ProjectRef,
    repo: Option<&ProjectRepo>,
) -> Result<ProjectSettings, ToolError> {
    let Some(project) = hub.store.project_get(r)? else {
        return Err(unknown_project(r));
    };
    let store = hub.db.project_settings();
    let repo_id = repo.map(|repo| &repo.repo_id);
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
        repo: repo.map(|repo| repo.name.clone()),
        keep_worktrees: store.keep_worktrees(r)?,
        env: store.env(r)?,
        setup: store.setup_in(r, repo_id)?.unwrap_or_default(),
        train: store.train(r)?,
        preview: store.preview_in(r, repo_id)?,
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
    if hub.store.project_get(&r)?.is_none() {
        return Err(unknown_project(&r));
    }
    let repo = repo_named(&hub, &r, input.repo.as_ref())?;
    Ok(ProjectSettingsGetOutput {
        settings: settings_of(&hub, &r, repo.as_ref()).await?,
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
    let repo = repo_named(&hub, &r, input.repo.as_ref())?;
    let repo_id = repo.as_ref().map(|repo| &repo.repo_id);
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
    if let Some(setup) = &input.setup {
        hub.db.project_settings().set_setup_in(&r, repo_id, setup)?;
    }
    if let Some(train) = &input.train {
        hub.db.project_settings().set_train(&r, train)?;
    }
    if let Some(preview) = &input.preview {
        hub.db
            .project_settings()
            .set_preview_in(&r, repo_id, preview)?;
    }
    let mut settings = settings_of(&hub, &r, repo.as_ref()).await?;
    if let Some(title) = input.title {
        // Until the node's project event lands in the cache.
        settings.title = title.to_string();
    }
    let next = if input.preview.is_some()
        && input.train.is_none()
        && input.setup.is_none()
        && input.keep_worktrees.is_none()
    {
        "Try it runs previews this way from the next one someone asks for; nothing starts now."
            .to_owned()
    } else if input.train.is_some() && input.setup.is_none() && input.keep_worktrees.is_none() {
        "The merge train uses these settings from its next pass.".to_owned()
    } else if input.setup.as_ref().is_some_and(|s| !s.is_empty())
        && !hub
            .link
            .node_can(m, fleetd_contracts::node_link::CAP_WORKTREE_SETUP)
    {
        format!(
            "New tasks of the project use these settings. {m}'s node is too old to run setup commands: update fleetd there."
        )
    } else {
        "New tasks of the project use these settings.".to_owned()
    };
    Ok(ProjectSettingsSetOutput {
        settings,
        next: Some(next),
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
