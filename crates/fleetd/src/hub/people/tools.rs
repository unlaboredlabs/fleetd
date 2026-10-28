//! The app's people tools: people_list for everyone; invite_create, invite_revoke, person_set and person_remove for
//! an owner's or admin's device; device_revoke for a person's own devices, or anyone's for an owner or admin.
use std::sync::Arc;

use fleetd_contracts::auth::{KeyKind, Role};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::mcp::{
    DeviceRevokeInput, DeviceRevokeOutput, ErrorCode, InviteCreateInput, InviteCreateOutput,
    InviteRevokeInput, InviteRevokeOutput, PeopleListInput, PeopleListOutput, PersonRemoveInput,
    PersonRemoveOutput, PersonSetInput, PersonSetOutput,
};
use fleetd_contracts::people::{HubRole, PeopleChange, PeopleChangedData, Person, PersonRef};
use fleetd_contracts::prim::{Count, List};

use super::People;
use crate::clock::Clock;
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows_everywhere, error, is_human};
use crate::hub::pair::PairCodes;
use crate::hub::store::{EventLog, NewEvent, iso_ms, now_ms};

pub fn register(tools: &mut Registry) {
    tools.add("people_list", people_list);
    tools.add("invite_create", invite_create);
    tools.add("invite_revoke", invite_revoke);
    tools.add("person_set", person_set);
    tools.add("person_remove", person_remove);
    tools.add("device_revoke", device_revoke);
}

fn people(hub: &Hub) -> People {
    People::new(hub.db.clone(), hub.clock.clone())
}

/// The caller's person, when it is an owner's or admin's device that may administer the hub: a human key of theirs
/// with Admin on every machine.
pub(crate) fn administrator(hub: &Hub, caller: &Caller) -> Result<Option<Person>, ToolError> {
    let Some(me) = caller.person.as_ref().filter(|_| is_human(caller)) else {
        return Ok(None);
    };
    let person = people(hub).get(&me.person_id)?;
    Ok(person.filter(|p| p.role.administers() && allows_everywhere(caller, Role::Admin)))
}

fn require_administrator(hub: &Hub, caller: &Caller) -> Result<Person, ToolError> {
    administrator(hub, caller)?.ok_or_else(|| {
        error(
            ErrorCode::Forbidden,
            "Only the hub's owners and admins invite people, change roles and remove people.",
            "Ask an owner or admin of the hub, on the app's Administration page or with `fleetd invite` on the hub.",
        )
    })
}

fn unknown_person(id: &str) -> ToolError {
    error(
        ErrorCode::NotFound,
        format!("No person {id} on this hub."),
        "Call people_list to see the hub's people.",
    )
}

/// `people.changed` about `person`, by `by`.
pub fn change(
    change: PeopleChange,
    person: &PersonRef,
    by: Option<&PersonRef>,
) -> PeopleChangedData {
    PeopleChangedData {
        change,
        person: person.clone(),
        by: by.cloned(),
        invite_id: None,
        key_id: None,
    }
}

/// Appends `people.changed` to the hub's log. A failure to record it is logged, never the call's.
pub fn announce(events: &EventLog, clock: &dyn Clock, data: PeopleChangedData, summary: String) {
    let appended = serde_json::to_value(data)
        .map_err(crate::hub::store::StoreError::from)
        .and_then(|data| {
            events.append(NewEvent {
                at: iso_ms(now_ms(clock)).into(),
                r#type: HubEventType::PeopleChanged,
                machine_id: None,
                project_id: None,
                thread_id: None,
                summary,
                data: Some(data),
                attention: None,
            })
        });
    if let Err(error) = appended {
        tracing::warn!("people.changed event not recorded: {error}");
    }
}

async fn people_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: PeopleListInput,
) -> Result<PeopleListOutput, ToolError> {
    let admin = administrator(&hub, &caller)?.is_some();
    let list = people(&hub).list(input.include_removed == Some(true))?;
    let me = caller
        .person
        .as_ref()
        .filter(|_| is_human(&caller))
        .map(|p| p.person_id.clone());
    let devices: Vec<_> = hub
        .auth
        .list()?
        .into_iter()
        .filter(|key| key.kind == Some(KeyKind::Human) && key.revoked_at.is_none())
        .filter(|key| {
            admin || me.is_some() && key.person.as_ref().map(|p| &p.person_id) == me.as_ref()
        })
        .collect();
    let invites = if admin {
        PairCodes::new(hub.db.clone(), hub.clock.clone()).invites(false)?
    } else {
        Vec::new()
    };
    Ok(PeopleListOutput {
        people: List::unchecked(list),
        devices: List::unchecked(devices),
        invites: List::unchecked(invites),
        me,
        next: None,
        truncated: None,
    })
}

/// What an admin may hand out: an owner gives any role; an admin, admin or member.
fn may_grant(by: &Person, role: HubRole) -> Result<(), ToolError> {
    if role == HubRole::Owner && by.role != HubRole::Owner {
        return Err(error(
            ErrorCode::Forbidden,
            "Only an owner makes someone an owner.",
            "Pick admin or member, or ask an owner.",
        ));
    }
    Ok(())
}

async fn invite_create(
    hub: Arc<Hub>,
    caller: Caller,
    input: InviteCreateInput,
) -> Result<InviteCreateOutput, ToolError> {
    let by = require_administrator(&hub, &caller)?;
    let store = people(&hub);
    let (person, new) = match &input.person_id {
        // The contract refuses a name or role with personId, and a new person without a name.
        Some(id) => {
            let person = store
                .get(id)?
                .filter(|p| p.removed_at.is_none())
                .ok_or_else(|| unknown_person(id))?;
            if person.role == HubRole::Owner && by.role != HubRole::Owner {
                return Err(error(
                    ErrorCode::Forbidden,
                    "Only an owner pairs a device for an owner.",
                    "Ask an owner to invite their device.",
                ));
            }
            (person, false)
        }
        None => {
            let role = input.role.unwrap_or(HubRole::Member);
            may_grant(&by, role)?;
            let name = input
                .name
                .as_deref()
                .and_then(super::clean_name)
                .ok_or_else(|| {
                    error(
                        ErrorCode::Invalid,
                        "A new person needs a name.",
                        "Give the person's name.",
                    )
                })?;
            (store.create(&name, role)?, true)
        }
    };
    let (minted, invite) = PairCodes::new(hub.db.clone(), hub.clock.clone())
        .create_invite(&person, Some(&by.person_id))?;
    let hub_url = hub.config.url();
    let link = crate::cli::pair::deep_link(&hub_url, &minted.code);
    let summary = if new {
        format!(
            "{} invited {} as {}",
            by.name,
            person.name,
            person.role.as_str()
        )
    } else {
        format!("{} invited another device of {}", by.name, person.name)
    };
    announce(
        &hub.events,
        hub.clock.as_ref(),
        PeopleChangedData {
            invite_id: Some(invite.invite_id.clone()),
            ..change(PeopleChange::Invited, &person.as_ref(), Some(&by.as_ref()))
        },
        summary,
    );
    Ok(InviteCreateOutput {
        invite,
        code: minted.code,
        link,
        hub_url,
        next: Some(format!(
            "Send the link or the code to {}: it works once, until {}.",
            person.name, minted.expires_at
        )),
        truncated: None,
    })
}

async fn invite_revoke(
    hub: Arc<Hub>,
    caller: Caller,
    input: InviteRevokeInput,
) -> Result<InviteRevokeOutput, ToolError> {
    let by = require_administrator(&hub, &caller)?;
    let codes = PairCodes::new(hub.db.clone(), hub.clock.clone());
    let (invite, revoked) = codes.revoke_invite(&input.invite_id)?.ok_or_else(|| {
        error(
            ErrorCode::NotFound,
            format!("No invite {}.", input.invite_id),
            "Call people_list to see the open invites.",
        )
    })?;
    // Revoking it again changes nothing and says nothing.
    if revoked {
        // Someone invited by it who never joined goes with it.
        let store = people(&hub);
        let joined =
            hub.auth.list()?.iter().any(|key| {
                key.person.as_ref().map(|p| &p.person_id) == Some(&invite.person.person_id)
            });
        if !joined
            && store
                .get(&invite.person.person_id)?
                .is_some_and(|p| p.removed_at.is_none() && p.role != HubRole::Owner)
        {
            store.remove(&invite.person.person_id)?;
        }
        announce(
            &hub.events,
            hub.clock.as_ref(),
            PeopleChangedData {
                invite_id: Some(invite.invite_id.clone()),
                ..change(
                    PeopleChange::InviteRevoked,
                    &invite.person,
                    Some(&by.as_ref()),
                )
            },
            format!("{} revoked the invite for {}", by.name, invite.person.name),
        );
    }
    Ok(InviteRevokeOutput {
        invite,
        next: None,
        truncated: None,
    })
}

async fn person_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: PersonSetInput,
) -> Result<PersonSetOutput, ToolError> {
    let by = require_administrator(&hub, &caller)?;
    let store = people(&hub);
    let id = input.person_id.as_str();
    let person = store
        .get(&input.person_id)?
        .filter(|p| p.removed_at.is_none())
        .ok_or_else(|| unknown_person(id))?;
    let name = match &input.name {
        Some(name) => Some(super::clean_name(name).ok_or_else(|| {
            error(
                ErrorCode::Invalid,
                "The name is empty.",
                "Give the person's name.",
            )
        })?),
        None => None,
    };
    let role = input.role.filter(|r| *r != person.role);
    if let Some(role) = role {
        if person.role == HubRole::Owner && by.role != HubRole::Owner {
            return Err(error(
                ErrorCode::Forbidden,
                "Only an owner changes an owner's role.",
                "Ask an owner.",
            ));
        }
        may_grant(&by, role)?;
        if person.role == HubRole::Owner && store.owners()? <= 1 {
            return Err(error(
                ErrorCode::Invalid,
                format!("{} is the hub's only owner.", person.name),
                "Make someone else an owner first.",
            ));
        }
    }
    let after = store
        .set(&input.person_id, name.as_ref(), role)?
        .ok_or_else(|| unknown_person(id))?;
    if let Some(role) = role {
        announce(
            &hub.events,
            hub.clock.as_ref(),
            change(
                PeopleChange::RoleChanged,
                &after.as_ref(),
                Some(&by.as_ref()),
            ),
            format!("{} made {} {}", by.name, after.name, role.as_str()),
        );
    }
    if after.name != person.name {
        announce(
            &hub.events,
            hub.clock.as_ref(),
            change(PeopleChange::Renamed, &after.as_ref(), Some(&by.as_ref())),
            format!("{} renamed {} to {}", by.name, person.name, after.name),
        );
    }
    Ok(PersonSetOutput {
        person: after,
        next: None,
        truncated: None,
    })
}

async fn person_remove(
    hub: Arc<Hub>,
    caller: Caller,
    input: PersonRemoveInput,
) -> Result<PersonRemoveOutput, ToolError> {
    let by = require_administrator(&hub, &caller)?;
    let store = people(&hub);
    let id = input.person_id.as_str();
    let person = store
        .get(&input.person_id)?
        .filter(|p| p.removed_at.is_none())
        .ok_or_else(|| unknown_person(id))?;
    if person.role == HubRole::Owner {
        if by.role != HubRole::Owner {
            return Err(error(
                ErrorCode::Forbidden,
                "Only an owner removes an owner.",
                "Ask an owner.",
            ));
        }
        if store.owners()? <= 1 {
            return Err(error(
                ErrorCode::Invalid,
                format!("{} is the hub's only owner.", person.name),
                "Make someone else an owner first.",
            ));
        }
    }
    let (person, revoked) = store
        .remove(&input.person_id)?
        .ok_or_else(|| unknown_person(id))?;
    // Their Claude subscription goes with them: nobody's work runs on it again.
    crate::hub::claude_accounts::tools::forget_person(&hub, &person.person_id).await;
    // So does their GitHub connection: revoked at GitHub, and gone from their orders' agents.
    crate::hub::github_app::sessions::forget_person(&hub, &person.person_id).await;
    announce(
        &hub.events,
        hub.clock.as_ref(),
        change(PeopleChange::Removed, &person.as_ref(), Some(&by.as_ref())),
        format!("{} removed {} from the hub", by.name, person.name),
    );
    Ok(PersonRemoveOutput {
        person,
        revoked: Count::unchecked(revoked as i64),
        next: None,
        truncated: None,
    })
}

async fn device_revoke(
    hub: Arc<Hub>,
    caller: Caller,
    input: DeviceRevokeInput,
) -> Result<DeviceRevokeOutput, ToolError> {
    let not_found = || {
        error(
            ErrorCode::NotFound,
            format!("No device {}.", input.key_id),
            "Call people_list to see the devices you may sign out.",
        )
    };
    let device = hub
        .auth
        .list()?
        .into_iter()
        .find(|key| key.key_id == input.key_id && key.kind == Some(KeyKind::Human))
        .ok_or_else(not_found)?;
    let own = is_human(&caller)
        && caller.person.is_some()
        && device.person.as_ref().map(|p| &p.person_id)
            == caller.person.as_ref().map(|p| &p.person_id);
    let admin = administrator(&hub, &caller)?;
    if !own && admin.is_none() {
        return Err(not_found());
    }
    // As with changing or removing an owner: only an owner signs out an owner's device.
    if !own && admin.as_ref().is_some_and(|a| a.role != HubRole::Owner) {
        let owners = match &device.person {
            Some(person) => people(&hub)
                .get(&person.person_id)?
                .is_some_and(|p| p.role == HubRole::Owner),
            None => false,
        };
        if owners {
            return Err(error(
                ErrorCode::Forbidden,
                "Only an owner signs out an owner's device.",
                "Ask an owner.",
            ));
        }
    }
    hub.auth.revoke(device.key_id.as_str()).map_err(|e| {
        tracing::error!(error = %e, "device revoke");
        crate::hub::api::internal_error()
    })?;
    if let Some(person) = &device.person {
        let by = admin.map(|p| p.as_ref()).or_else(|| caller.person.clone());
        announce(
            &hub.events,
            hub.clock.as_ref(),
            PeopleChangedData {
                key_id: Some(device.key_id.to_string()),
                ..change(PeopleChange::DeviceRevoked, person, by.as_ref())
            },
            format!("{} of {} was signed out", device.name, person.name),
        );
    }
    let device = hub
        .auth
        .list()?
        .into_iter()
        .find(|key| key.key_id == input.key_id)
        .ok_or_else(not_found)?;
    Ok(DeviceRevokeOutput {
        device,
        next: None,
        truncated: None,
    })
}
