//! The hub's task profiles (Administration › Profiles): `profiles_list`, `profile_create`, `profile_update`,
//! `profile_delete`, and the `profiles` rows they keep, one per profile, exactly one of them the default. Each project
//! allows the default and the profiles in its `project_profiles` rows (`project_set`).
//!
//! The executor reads [`ProfileStore::chosen`] at each launch. When claude refuses a profile's model, the node runs the
//! session on the runner's own model and says so on the session; the executor then marks the profiles on that model
//! refused ([`ProfileStore::refuse`]), and new agents run on the runner's own until a person sets the model again.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::effort::{
    Effort, ModelName, ModelSource, PROFILES_MAX, Profile, ProfileId, ProfileModel, ProfileName,
};
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::mcp::{
    ErrorCode, ProfileCreateInput, ProfileCreateOutput, ProfileDeleteInput, ProfileDeleteOutput,
    ProfileUpdateInput, ProfileUpdateOutput, ProfilesListInput, ProfilesListOutput,
};
use fleetd_contracts::node_link::CAP_CLAUDE_MODELS;
use fleetd_contracts::prim::{Line, List, True};
use fleetd_contracts::sessions::ApiModel;
use rusqlite::{OptionalExtension, params};

use crate::hub::api::{Caller, Hub, Registry, ToolError, error, require, unknown_project};
use crate::hub::people::tools::administrator;
use crate::hub::store::{HubDb, StoreError, iso_ms};

pub fn register(tools: &mut Registry) {
    tools.add("profiles_list", list);
    tools.add("profile_create", create);
    tools.add("profile_update", update);
    tools.add("profile_delete", delete);
}

/// fleetd's own list of current Claude models, for a hub without an API key or whose endpoint lists none.
pub const BUILTIN_MODELS: [(&str, &str); 8] = [
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-fable-5-1", "Claude Fable 5.1"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
    ("claude-fable-5", "Claude Fable 5"),
    ("claude-opus-5", "Claude Opus 5"),
    ("claude-sonnet-5", "Claude Sonnet 5"),
    ("claude-opus-4-8", "Claude Opus 4.8"),
];

/// The models Claude Code offers fast mode on.
pub const FAST_MODELS: [&str; 3] = ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"];

pub fn has_fast(model: &str) -> bool {
    FAST_MODELS.contains(&model)
}

/// What a launch on one profile sends the node: its name, its model unless claude refused it, its effort and fast
/// mode, and the default profile's model for claude's helper calls.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chosen {
    pub profile: ProfileName,
    pub model: Option<ModelName>,
    pub effort: Effort,
    pub fast: bool,
    pub helper_model: Option<ModelName>,
}

/// A new profile, or what an update changes.
#[derive(Clone, Debug, Default)]
pub struct ProfileEdit {
    pub name: Option<ProfileName>,
    pub note: Option<String>,
    pub model: Option<ModelName>,
    pub effort: Option<Effort>,
    pub fast: Option<bool>,
    pub default: bool,
}

/// A change the profiles refuse, in a person's words, or the store failing.
#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("{0}")]
    Refused(String),
}

impl From<ProfileError> for ToolError {
    fn from(e: ProfileError) -> Self {
        match e {
            ProfileError::Refused(why) => error(
                ErrorCode::Invalid,
                format!("{why}."),
                "Pick another and try again.",
            ),
            ProfileError::Store(e) => e.into(),
        }
    }
}

pub struct ProfileStore<'a> {
    db: &'a HubDb,
}

impl HubDb {
    pub fn profiles(&self) -> ProfileStore<'_> {
        ProfileStore { db: self }
    }
}

const COLUMNS: &str = "id, name, note, model, effort, fast, is_default, refused, set_at";

fn row_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    let effort: String = row.get(4)?;
    Ok(Profile {
        id: ProfileId::unchecked(row.get(0)?),
        name: ProfileName::unchecked(row.get::<_, String>(1)?),
        note: Line::unchecked(row.get::<_, String>(2)?),
        model: ModelName::unchecked(row.get::<_, String>(3)?),
        effort: Effort::parse(&effort).unwrap_or(Effort::High),
        fast: row.get(5)?,
        default: row.get(6)?,
        refused: row.get(7)?,
        updated_at: Timestamp(row.get(8)?),
    })
}

impl ProfileStore<'_> {
    /// Every profile, the default first, then by name.
    pub fn list(&self) -> Result<Vec<Profile>, StoreError> {
        self.db.with(|c| {
            let mut stmt = c.prepare_cached(&format!(
                "SELECT {COLUMNS} FROM profiles ORDER BY is_default DESC, name"
            ))?;
            Ok(stmt
                .query_map([], row_of)?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    pub fn get(&self, id: ProfileId) -> Result<Option<Profile>, StoreError> {
        self.db.with(|c| {
            Ok(c.query_row(
                &format!("SELECT {COLUMNS} FROM profiles WHERE id = ?"),
                [id.get()],
                row_of,
            )
            .optional()?)
        })
    }

    pub fn by_name(&self, name: &str) -> Result<Option<Profile>, StoreError> {
        self.db.with(|c| {
            Ok(c.query_row(
                &format!("SELECT {COLUMNS} FROM profiles WHERE name = ?"),
                [name],
                row_of,
            )
            .optional()?)
        })
    }

    /// The hub's default; a hub keeps one from its migration on.
    pub fn default_profile(&self) -> Result<Profile, ProfileError> {
        let found = self.db.with(|c| {
            Ok(c.query_row(
                &format!("SELECT {COLUMNS} FROM profiles WHERE is_default = 1"),
                [],
                row_of,
            )
            .optional()?)
        })?;
        found.ok_or_else(|| ProfileError::Refused("the hub has no default profile".into()))
    }

    /// The profiles a project allows, by name: the default first, then the ones it picked, by name.
    pub fn allowed(&self, r: &ProjectRef) -> Result<Vec<ProfileName>, StoreError> {
        self.db.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT p.name FROM profiles p WHERE p.is_default = 1 OR EXISTS (
                   SELECT 1 FROM project_profiles a
                   WHERE a.machine_id = ? AND a.project_id = ? AND a.profile_id = p.id)
                 ORDER BY p.is_default DESC, p.name",
            )?;
            Ok(stmt
                .query_map(
                    params![r.machine_id.as_str(), r.project_id.as_str()],
                    |row| Ok(ProfileName::unchecked(row.get::<_, String>(0)?)),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Replaces what the project allows besides the default. A name no profile has is refused, naming it.
    pub fn set_allowed(&self, r: &ProjectRef, names: &[ProfileName]) -> Result<(), ProfileError> {
        let mut ids = Vec::new();
        for name in names {
            let profile = self
                .by_name(name)?
                .ok_or_else(|| ProfileError::Refused(format!("no profile is named {name}")))?;
            if !profile.default {
                ids.push(profile.id.get());
            }
        }
        self.db.with(|c| {
            let tx = c.unchecked_transaction()?;
            tx.execute(
                "DELETE FROM project_profiles WHERE machine_id = ? AND project_id = ?",
                params![r.machine_id.as_str(), r.project_id.as_str()],
            )?;
            for id in &ids {
                tx.execute(
                    "INSERT OR IGNORE INTO project_profiles (machine_id, project_id, profile_id) VALUES (?, ?, ?)",
                    params![r.machine_id.as_str(), r.project_id.as_str(), id],
                )?;
            }
            tx.commit()?;
            Ok(())
        })?;
        Ok(())
    }

    /// Adds a profile; `edit` has every field but `fast`. A name taken is refused.
    pub fn create(&self, edit: &ProfileEdit, at: &str) -> Result<Profile, ProfileError> {
        let (Some(name), Some(model), Some(effort)) = (&edit.name, &edit.model, edit.effort) else {
            return Err(ProfileError::Refused(
                "a profile needs a name, a model and an effort".into(),
            ));
        };
        if self.by_name(name)?.is_some() {
            return Err(ProfileError::Refused(format!(
                "a profile is already named {name}"
            )));
        }
        let id = self.db.with(|c| {
            let tx = c.unchecked_transaction()?;
            if edit.default {
                tx.execute("UPDATE profiles SET is_default = 0 WHERE is_default = 1", [])?;
            }
            tx.execute(
                "INSERT INTO profiles (name, note, model, effort, fast, is_default, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![
                    name.as_str(),
                    edit.note.as_deref().unwrap_or_default(),
                    model.as_str(),
                    effort.as_str(),
                    edit.fast.unwrap_or(false),
                    edit.default,
                    at
                ],
            )?;
            let id = tx.last_insert_rowid();
            tx.commit()?;
            Ok(id)
        })?;
        self.get(ProfileId::unchecked(id))?
            .ok_or_else(|| ProfileError::Refused("the new profile was not read back".into()))
    }

    /// Changes the fields `edit` sets. A new model clears a refusal; `default` makes it the default. A name another
    /// profile has is refused.
    pub fn update(
        &self,
        id: ProfileId,
        edit: &ProfileEdit,
        at: &str,
    ) -> Result<Profile, ProfileError> {
        let Some(old) = self.get(id)? else {
            return Err(ProfileError::Refused(format!("no profile has id {id}")));
        };
        if let Some(name) = &edit.name
            && self.by_name(name)?.is_some_and(|p| p.id != id)
        {
            return Err(ProfileError::Refused(format!(
                "a profile is already named {name}"
            )));
        }
        let model = edit.model.clone().unwrap_or_else(|| old.model.clone());
        let refused = old.refused.clone().filter(|_| model == old.model);
        self.db.with(|c| {
            let tx = c.unchecked_transaction()?;
            if edit.default {
                tx.execute("UPDATE profiles SET is_default = 0 WHERE is_default = 1 AND id != ?", [id.get()])?;
            }
            tx.execute(
                "UPDATE profiles SET name = ?, note = ?, model = ?, effort = ?, fast = ?, is_default = ?, refused = ?,
                   set_at = ? WHERE id = ?",
                params![
                    edit.name.as_ref().unwrap_or(&old.name).as_str(),
                    edit.note.as_deref().unwrap_or(old.note.as_str()),
                    model.as_str(),
                    edit.effort.unwrap_or(old.effort).as_str(),
                    edit.fast.unwrap_or(old.fast),
                    edit.default || old.default,
                    refused,
                    at,
                    id.get()
                ],
            )?;
            tx.commit()?;
            Ok(())
        })?;
        self.get(id)?
            .ok_or_else(|| ProfileError::Refused(format!("no profile has id {id}")))
    }

    /// Removes a profile and every project's choice of it. The caller refuses the default and one in use.
    pub fn delete(&self, id: ProfileId) -> Result<(), StoreError> {
        self.db.with(|c| {
            let tx = c.unchecked_transaction()?;
            tx.execute(
                "DELETE FROM project_profiles WHERE profile_id = ?",
                [id.get()],
            )?;
            tx.execute(
                "DELETE FROM profiles WHERE id = ? AND is_default = 0",
                [id.get()],
            )?;
            tx.commit()?;
            Ok(())
        })
    }

    /// The tasks not yet ended that run on `name`, as ids.
    pub fn in_use(&self, name: &str) -> Result<Vec<String>, StoreError> {
        self.db.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT 'T' || n FROM tasks WHERE state IN ('queued', 'running', 'idle')
                   AND json_extract(data, '$.profile') = ? ORDER BY n",
            )?;
            Ok(stmt
                .query_map([name], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// claude refused `model` for a session launched at `launched_at`: every profile on it set before then is marked
    /// refused with `why`, once. Whether any was.
    pub fn refuse(&self, model: &str, launched_at: &str, why: &str) -> Result<bool, StoreError> {
        self.db.with(|c| {
            let n = c.execute(
                "UPDATE profiles SET refused = ? WHERE model = ? AND refused IS NULL AND set_at <= ?",
                params![why, model, launched_at],
            )?;
            Ok(n > 0)
        })
    }

    /// What a new agent of `name` is launched with; a name no profile has any more (renamed or deleted since its
    /// task started) runs on the default.
    pub fn chosen(&self, name: &str) -> Result<Chosen, ProfileError> {
        let default = self.default_profile()?;
        let profile = match self.by_name(name)? {
            Some(p) => p,
            None => default.clone(),
        };
        Ok(Chosen {
            model: profile.usable_model().cloned(),
            effort: profile.effort,
            fast: profile.fast && has_fast(profile.model.as_str()),
            helper_model: default.usable_model().cloned(),
            profile: profile.name,
        })
    }
}

/// The models a profile may pick: what the Models API lists on the hub's API key, asked of a node that holds it,
/// else fleetd's own list.
pub async fn models(hub: &Hub) -> (Vec<ProfileModel>, ModelSource) {
    let from_api = match api_models(hub).await {
        Ok(models) => models,
        Err(why) => {
            tracing::debug!("profiles: the model list is fleetd's own: {why}");
            Vec::new()
        }
    };
    let listed: Vec<ProfileModel> = from_api
        .into_iter()
        .filter_map(|m| {
            let id = ModelName::new(m.id).ok()?;
            Some(ProfileModel {
                fast: has_fast(id.as_str()),
                display_name: m.display_name,
                id,
            })
        })
        .collect();
    if !listed.is_empty() {
        return (listed, ModelSource::Api);
    }
    let builtin = BUILTIN_MODELS
        .iter()
        .map(|(id, name)| ProfileModel {
            id: ModelName::unchecked(*id),
            display_name: Some((*name).to_owned()),
            fast: has_fast(id),
        })
        .collect();
    (builtin, ModelSource::Builtin)
}

async fn api_models(hub: &Hub) -> Result<Vec<ApiModel>, String> {
    let api = hub
        .db
        .claude_accounts()
        .hub_api()
        .map_err(|e| e.to_string())?
        .ok_or("the hub has no API key")?;
    let machine = api
        .sealed_on
        .iter()
        .map(|s| &s.machine_id)
        .find(|m| hub.executors.is_connected(m) && hub.link.node_can(m, CAP_CLAUDE_MODELS))
        .ok_or("no machine holding the hub's API key is online")?;
    hub.executors
        .claude_models(machine)
        .await
        .map_err(|e| e.to_string())?
}

fn now(hub: &Hub) -> String {
    iso_ms(
        hub.clock
            .now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64,
    )
}

fn require_administrator(hub: &Hub, caller: &Caller) -> Result<(), ToolError> {
    administrator(hub, caller)?.map(|_| ()).ok_or_else(|| {
        error(
            ErrorCode::Forbidden,
            "Only the hub's owners and admins change task profiles.",
            "Ask an owner or admin; they change them on the app's Administration › Profiles page.",
        )
    })
}

fn unknown(id: ProfileId) -> ToolError {
    error(
        ErrorCode::NotFound,
        format!("No profile has id {id}."),
        "List them with profiles_list.",
    )
}

/// `model` is one the list offers, or the one the profile already runs on; fast mode only where the model has it.
async fn check_model(
    hub: &Hub,
    model: Option<&ModelName>,
    kept: Option<&ModelName>,
    fast: bool,
) -> Result<(), ToolError> {
    if let Some(model) = model.filter(|m| Some(*m) != kept) {
        let (offered, _) = models(hub).await;
        if !offered.iter().any(|m| &m.id == model) {
            let names: Vec<&str> = offered.iter().map(|m| m.id.as_str()).collect();
            return Err(error(
                ErrorCode::Invalid,
                format!("{model} is not among the models this hub offers."),
                format!("Pick one of: {}.", names.join(", ")),
            ));
        }
    }
    if let Some(model) = model.or(kept)
        && fast
        && !has_fast(model.as_str())
    {
        return Err(error(
            ErrorCode::Invalid,
            format!("{model} has no fast mode."),
            format!("Turn fast off, or pick one of: {}.", FAST_MODELS.join(", ")),
        ));
    }
    Ok(())
}

async fn list(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProfilesListInput,
) -> Result<ProfilesListOutput, ToolError> {
    let r = input.project_ref.as_ref();
    require(&caller, Role::Read, r.map(|r| &r.machine_id))?;
    if let Some(r) = r
        && hub.store.project_get(r)?.is_none()
    {
        return Err(unknown_project(r));
    }
    let store = hub.db.profiles();
    let profiles = store.list()?;
    let allowed = r.map(|r| store.allowed(r)).transpose()?;
    let (models, models_from) = models(&hub).await;
    Ok(ProfilesListOutput {
        profiles: List::unchecked(profiles.into_iter().take(PROFILES_MAX).collect()),
        allowed: allowed.map(List::unchecked),
        models: List::unchecked(models.into_iter().take(200).collect()),
        models_from,
        efforts: List::unchecked(Effort::ALL.to_vec()),
        next: None,
        truncated: None,
    })
}

async fn create(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProfileCreateInput,
) -> Result<ProfileCreateOutput, ToolError> {
    require_administrator(&hub, &caller)?;
    let store = hub.db.profiles();
    if store.list()?.len() >= PROFILES_MAX {
        return Err(error(
            ErrorCode::Invalid,
            format!("The hub already keeps {PROFILES_MAX} profiles."),
            "Delete one it no longer needs first.",
        ));
    }
    let fast = input.fast.unwrap_or(false);
    check_model(&hub, Some(&input.model), None, fast).await?;
    let edit = ProfileEdit {
        name: Some(input.name),
        note: Some(input.note.into_inner()),
        model: Some(input.model),
        effort: Some(input.effort),
        fast: Some(fast),
        default: input.default.unwrap_or(false),
    };
    let profile = store.create(&edit, &now(&hub))?;
    Ok(ProfileCreateOutput {
        next: Some(format!(
            "Projects allow {} once they pick it on their Agents page (project_set); new agents on it run {} at {}.",
            profile.name,
            profile.model,
            profile.effort.as_str()
        )),
        profile,
        truncated: None,
    })
}

async fn update(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProfileUpdateInput,
) -> Result<ProfileUpdateOutput, ToolError> {
    require_administrator(&hub, &caller)?;
    let store = hub.db.profiles();
    let Some(old) = store.get(input.id)? else {
        return Err(unknown(input.id));
    };
    if input.default == Some(false) && old.default {
        return Err(error(
            ErrorCode::Invalid,
            format!("{} is the default.", old.name),
            "Make another profile the default instead.",
        ));
    }
    let model = input.model.as_ref().unwrap_or(&old.model);
    // A model without fast mode turns it off unless the update asks for it.
    let fast =
        input.fast.unwrap_or(old.fast) && (input.fast == Some(true) || has_fast(model.as_str()));
    check_model(&hub, Some(model), Some(&old.model), fast).await?;
    let edit = ProfileEdit {
        name: input.name,
        note: input.note.map(Line::into_inner),
        model: input.model,
        effort: input.effort,
        fast: Some(fast),
        default: input.default == Some(true),
    };
    let profile = store.update(input.id, &edit, &now(&hub))?;
    let renamed = (profile.name != old.name).then(|| {
        format!(
            " Tasks that ran on {} keep that name in their history; a task of it that starts again runs on {}.",
            old.name, profile.name
        )
    });
    Ok(ProfileUpdateOutput {
        next: Some(format!(
            "New agents on {} run {} at {}{} from their next start; running ones keep theirs.{}",
            profile.name,
            profile.model,
            profile.effort.as_str(),
            if profile.fast { ", fast" } else { "" },
            renamed.unwrap_or_default()
        )),
        profile,
        truncated: None,
    })
}

async fn delete(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProfileDeleteInput,
) -> Result<ProfileDeleteOutput, ToolError> {
    require_administrator(&hub, &caller)?;
    let store = hub.db.profiles();
    let Some(profile) = store.get(input.id)? else {
        return Err(unknown(input.id));
    };
    if profile.default {
        return Err(error(
            ErrorCode::Invalid,
            format!(
                "{} is the default: leads, reviews and helper calls run on it.",
                profile.name
            ),
            "Make another profile the default first.",
        ));
    }
    let running = store.in_use(&profile.name)?;
    if !running.is_empty() {
        return Err(error(
            ErrorCode::Invalid,
            format!("{} is in use by {}.", profile.name, running.join(", ")),
            "Delete it once those tasks have ended, or stop them first.",
        ));
    }
    store.delete(input.id)?;
    Ok(ProfileDeleteOutput {
        ok: True,
        next: Some(format!(
            "{} is gone, and no project allows it any more.",
            profile.name
        )),
        truncated: None,
    })
}
