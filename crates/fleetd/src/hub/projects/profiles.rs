//! The model and effort behind each task profile (Settings › Agents, and each project's settings): `profiles_get`,
//! `profiles_set`, and the `profile_settings` rows they keep, one per scope and profile. The fleet's row has an empty
//! machine and project; a project's overrides it field by field. What no row sets runs on the runner's own.
//!
//! The executor reads [`ProfileStore::chosen`] at each launch. When claude refuses a chosen model, the node runs the
//! session on its profile's own model and says so on the session; the executor then marks every setting of that
//! model refused ([`ProfileStore::refuse`]), and new agents run as if it were unset until a person sets it again.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::effort::{
    Effort, ModelName, ProfileRun, ProfileRuns, ProfileSetting, ProfileSettings, TaskProfile,
};
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{
    ProfilesGetInput, ProfilesGetOutput, ProfilesSetInput, ProfilesSetOutput, ProfilesView,
};
use fleetd_contracts::sessions::RunnerKind;
use rusqlite::params;

use crate::hub::api::{
    Caller, Hub, Registry, ToolError, allows_everywhere, refused, require, unknown_project,
};
use crate::hub::store::{HubDb, StoreError, iso_ms};
use crate::hub::tasks::resolve::resolve_setting;
use crate::node::runner::guide;

pub fn register(tools: &mut Registry) {
    tools.add("profiles_get", get);
    tools.add("profiles_set", set);
}

/// What a launch of one profile sends the node: the settings' model and effort, each absent where none chose one,
/// and the high profile's model for claude's helper calls.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Chosen {
    pub model: Option<ModelName>,
    pub effort: Option<Effort>,
    pub helper_model: Option<ModelName>,
}

pub struct ProfileStore<'a> {
    db: &'a HubDb,
}

impl HubDb {
    pub fn profile_settings(&self) -> ProfileStore<'_> {
        ProfileStore { db: self }
    }
}

/// The row key of a scope: the fleet's is empty.
fn key(r: Option<&ProjectRef>) -> (&str, &str) {
    r.map_or(("", ""), |r| (r.machine_id.as_str(), r.project_id.as_str()))
}

impl ProfileStore<'_> {
    /// Both profiles' settings at a scope: the fleet's without a project.
    pub fn get(&self, r: Option<&ProjectRef>) -> Result<ProfileSettings, StoreError> {
        let (machine, project) = key(r);
        self.db.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT profile, model, effort, refused FROM profile_settings
                 WHERE machine_id = ? AND project_id = ?",
            )?;
            let rows = stmt
                .query_map(params![machine, project], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut settings = ProfileSettings::default();
            for (profile, model, effort, refused) in rows {
                let setting = ProfileSetting {
                    model: model.map(ModelName::unchecked),
                    effort: effort.as_deref().and_then(Effort::parse),
                    refused,
                };
                match profile.as_str() {
                    "high" => settings.high = setting,
                    "medium" => settings.medium = setting,
                    _ => {}
                }
            }
            Ok(settings)
        })
    }

    /// Replaces one profile's setting at a scope; an empty one deletes the row. Its refusal stays only when `setting`
    /// passes it back as read, with the same model (an effort changed alone); setting the model again clears it.
    pub fn set(
        &self,
        r: Option<&ProjectRef>,
        profile: TaskProfile,
        setting: &ProfileSetting,
        at: &str,
    ) -> Result<(), StoreError> {
        let stored = self.get(r)?.get(profile).clone();
        let kept = setting
            .refused
            .as_ref()
            .filter(|_| stored.refused == setting.refused && stored.model == setting.model);
        let (machine, project) = key(r);
        self.db.with(|c| {
            if setting.is_empty() {
                c.execute(
                    "DELETE FROM profile_settings WHERE machine_id = ? AND project_id = ? AND profile = ?",
                    params![machine, project, profile.as_str()],
                )?;
            } else {
                c.execute(
                    "INSERT OR REPLACE INTO profile_settings
                       (machine_id, project_id, profile, model, effort, refused, set_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)",
                    params![
                        machine,
                        project,
                        profile.as_str(),
                        setting.model.as_ref().map(ModelName::as_str),
                        setting.effort.map(Effort::as_str),
                        kept,
                        at,
                    ],
                )?;
            }
            Ok(())
        })
    }

    /// claude refused `model` for a session launched at `launched_at`: every setting of it made before then is
    /// marked refused with `why`, once. Whether any was.
    pub fn refuse(&self, model: &str, launched_at: &str, why: &str) -> Result<bool, StoreError> {
        self.db.with(|c| {
            let n = c.execute(
                "UPDATE profile_settings SET refused = ?
                 WHERE model = ? AND refused IS NULL AND set_at <= ?",
                params![why, model, launched_at],
            )?;
            Ok(n > 0)
        })
    }

    /// What a new agent of `profile` in the project is launched with.
    pub fn chosen(&self, r: &ProjectRef, profile: TaskProfile) -> Result<Chosen, StoreError> {
        let (fleet, project) = (self.get(None)?, self.get(Some(r))?);
        let (model, effort) = resolve_setting(project.get(profile), fleet.get(profile));
        let (helper_model, _) = resolve_setting(&project.high, &fleet.high);
        Ok(Chosen {
            model,
            effort,
            helper_model,
        })
    }
}

/// The runner's own for each profile.
fn defaults() -> ProfileRuns {
    let own = |p| {
        let m = guide(RunnerKind::Claude).profile(p);
        ProfileRun {
            model: m.model.to_owned(),
            effort: m.effort,
        }
    };
    ProfileRuns {
        high: own(TaskProfile::High),
        medium: own(TaskProfile::Medium),
    }
}

fn view(hub: &Hub, r: Option<&ProjectRef>) -> Result<ProfilesView, ToolError> {
    let fleet = hub.db.profile_settings().get(None)?;
    let project = r
        .map(|r| hub.db.profile_settings().get(Some(r)))
        .transpose()?;
    let defaults = defaults();
    let none = ProfileSettings::default();
    let over = project.as_ref().unwrap_or(&none);
    let run = |p: TaskProfile, own: &ProfileRun| {
        let (model, effort) = resolve_setting(over.get(p), fleet.get(p));
        ProfileRun {
            model: model.map_or_else(|| own.model.clone(), ModelName::into_inner),
            effort: effort.unwrap_or(own.effort),
        }
    };
    let runs = ProfileRuns {
        high: run(TaskProfile::High, &defaults.high),
        medium: run(TaskProfile::Medium, &defaults.medium),
    };
    Ok(ProfilesView {
        fleet,
        project,
        runs,
        defaults,
    })
}

async fn get(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProfilesGetInput,
) -> Result<ProfilesGetOutput, ToolError> {
    let r = input.project_ref.as_ref();
    require(&caller, Role::Read, r.map(|r| &r.machine_id))?;
    if let Some(r) = r
        && hub.store.project_get(r)?.is_none()
    {
        return Err(unknown_project(r));
    }
    Ok(ProfilesGetOutput {
        view: view(&hub, r)?,
        next: None,
        truncated: None,
    })
}

async fn set(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProfilesSetInput,
) -> Result<ProfilesSetOutput, ToolError> {
    let r = input.project_ref.as_ref();
    match r {
        Some(r) => {
            require(&caller, Role::Operate, Some(&r.machine_id))?;
            if hub.store.project_get(r)?.is_none() {
                return Err(unknown_project(r));
            }
        }
        // Every project's agents follow the fleet's, as with the fleet cap.
        None if !allows_everywhere(&caller, Role::Admin) => {
            return Err(refused(&caller, Role::Admin, None));
        }
        None => {}
    }
    let at = iso_ms(
        hub.clock
            .now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64,
    );
    let store = hub.db.profile_settings();
    for (profile, setting) in [
        (TaskProfile::High, &input.high),
        (TaskProfile::Medium, &input.medium),
    ] {
        if let Some(setting) = setting {
            store.set(r, profile, setting, &at)?;
        }
    }
    let view = view(&hub, r)?;
    let who = if r.is_some() {
        "the project's"
    } else {
        "every project's"
    };
    Ok(ProfilesSetOutput {
        next: Some(format!(
            "New agents of {who} profiles run on this from their next start: high on {} at {}, medium on {} at {}. \
             Running agents keep what they started on. If claude refuses a model, agents run on the profile's own \
             and the setting says so.",
            view.runs.high.model,
            view.runs.high.effort.as_str(),
            view.runs.medium.model,
            view.runs.medium.effort.as_str(),
        )),
        view,
        truncated: None,
    })
}
