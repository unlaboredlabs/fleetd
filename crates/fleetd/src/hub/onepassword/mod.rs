//! Each person's 1Password service account token (D235; the wire types are `onepassword.rs`). The tools,
//! `onepassword_get`, `onepassword_set`, `onepassword_remove`, `onepassword_test` and `onepassword_cards` (the Credit
//! Card items it reads, for a Navi's card picker), are a person's own, from their own devices. The token comes sealed to each machine's box key; the hub relays each box to its node and keeps only
//! the fingerprint it answers (`onepassword_tokens`), never a box or the token.
//!
//! At a launch the hub names the person whose work it is ([`for_task`], [`for_lead`]: the Claude accounts' rule, a
//! Navi's owner, else the order's starter) when they saved a token; the node gives their token to the session's
//! fill_credential when its project and order have no `OP_SERVICE_ACCOUNT_TOKEN` of their own.
#[cfg(test)]
mod tests;

use std::collections::BTreeSet;
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::claude_accounts::{ClaudeSeal, ClaudeSealedOn};
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::mcp::{
    ErrorCode, OnePasswordCardsInput, OnePasswordCardsOutput, OnePasswordGetInput,
    OnePasswordGetOutput, OnePasswordRemoveInput, OnePasswordRemoveOutput, OnePasswordSetInput,
    OnePasswordSetOutput, OnePasswordTestInput, OnePasswordTestOutput,
};
use fleetd_contracts::node_link::{CAP_ONEPASSWORD, CAP_ONEPASSWORD_CARDS};
use fleetd_contracts::onepassword::{OnePasswordTest, OnePasswordToken};
use fleetd_contracts::people::{Person, PersonId};
use fleetd_contracts::prim::True;
use rusqlite::{OptionalExtension, params};

use crate::hub::api::{Caller, Hub, Registry, ToolError, error, is_human, offline, require};
use crate::hub::checks::now_ts;
use crate::hub::claude_accounts::{Whose, whose_for_lead, whose_for_task};
use crate::hub::executor::tools::from_executor;
use crate::hub::store::{HubDb, StoreError};

pub fn register(tools: &mut Registry) {
    tools.add("onepassword_get", get);
    tools.add("onepassword_set", set);
    tools.add("onepassword_remove", remove);
    tools.add("onepassword_test", test);
    tools.add("onepassword_cards", cards);
}

/// The person's saved token, as the tools show it.
pub fn token(db: &HubDb, person: &PersonId) -> Result<Option<OnePasswordToken>, StoreError> {
    let data: Option<String> = db.with(|c| {
        Ok(c.query_row(
            "SELECT data FROM onepassword_tokens WHERE person_id = ?",
            [person.as_str()],
            |row| row.get(0),
        )
        .optional()?)
    })?;
    Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
}

pub fn put_token(
    db: &HubDb,
    person: &PersonId,
    token: &OnePasswordToken,
) -> Result<(), StoreError> {
    let data = serde_json::to_string(token)?;
    db.with(|c| {
        c.execute(
            "INSERT INTO onepassword_tokens (person_id, data) VALUES (?, ?)
             ON CONFLICT (person_id) DO UPDATE SET data = excluded.data",
            params![person.as_str(), data],
        )?;
        Ok(())
    })
}

fn remove_token(db: &HubDb, person: &PersonId) -> Result<(), StoreError> {
    db.with(|c| {
        c.execute(
            "DELETE FROM onepassword_tokens WHERE person_id = ?",
            [person.as_str()],
        )?;
        Ok(())
    })
}

/// `whose` work's person, when their token is held on `machine`: the launch names them, and the node gives their
/// token. A machine the hub no longer records as holding it (offline when the token was replaced or removed) may
/// still have an old one on disk: no launch there names the person, so it is never used.
fn theirs(db: &HubDb, whose: Whose, machine: &MachineId) -> Option<PersonId> {
    let Whose::Person(person) = whose else {
        return None;
    };
    let held = token(db, &person).ok().flatten()?;
    held.sealed_on
        .iter()
        .any(|s| &s.machine_id == machine)
        .then_some(person)
}

/// The person whose token a task of `order` in project `r`, launched on `machine`, falls back on: its Navi's owner,
/// else its order's starter. None for work nobody started, on a machine that doesn't hold their token, or when the
/// hub can't tell (the task then has only its project's token).
pub fn for_task(
    db: &HubDb,
    r: &ProjectRef,
    order: Option<&WorkstreamId>,
    machine: &MachineId,
) -> Option<PersonId> {
    let setup = db.claude_accounts().setup().ok()?;
    theirs(db, whose_for_task(db, &setup, r, order).ok()?, machine)
}

/// The person whose token the lead of project `r` falls back on: a Navi's owner, when its machine holds the token; a
/// project's lead has none.
pub fn for_lead(db: &HubDb, r: &ProjectRef) -> Option<PersonId> {
    let setup = db.claude_accounts().setup().ok()?;
    theirs(db, whose_for_lead(db, &setup, r).ok()?, &r.machine_id)
}

/// The person behind a human key: only a person keeps a token of their own.
fn me(hub: &Hub, caller: &Caller) -> Result<Person, ToolError> {
    let person = match caller.person.as_ref().filter(|_| is_human(caller)) {
        Some(p) => crate::hub::people::People::new(hub.db.clone(), hub.clock.clone())
            .get(&p.person_id)?
            .filter(|p| p.removed_at.is_none()),
        None => None,
    };
    person.ok_or_else(|| {
        error(
            ErrorCode::Forbidden,
            "Only a person keeps a 1Password token, from one of their own devices.",
            "Pair the app as yourself, then open Settings › Your accounts › 1Password.",
        )
    })
}

/// The node can take the token: online and new enough.
fn node_ready(hub: &Hub, m: &MachineId) -> Result<(), ToolError> {
    if !hub.executors.is_connected(m) {
        return Err(offline(m));
    }
    if !hub.link.node_can(m, CAP_ONEPASSWORD) {
        return Err(error(
            ErrorCode::Invalid,
            format!("{m}'s node is too old to keep a 1Password token."),
            format!("Update fleetd on {m} and restart its node."),
        ));
    }
    Ok(())
}

/// Each online node of `machines` forgets the person's token. One offline keeps it unused: the hub names the person
/// to no launch there, as it no longer records the machine as holding it.
async fn forget(hub: &Hub, person: &PersonId, machines: &[MachineId]) {
    for m in machines {
        if node_ready(hub, m).is_err() {
            continue;
        }
        if let Err(e) = hub
            .executors
            .onepassword_token(m, person.clone(), None)
            .await
        {
            tracing::warn!(machine_id = %m, %person, "1Password token not forgotten: {e}");
        }
    }
}

/// Forgets a removed person's token everywhere (`person_remove`).
pub async fn forget_person(hub: &Hub, person: &PersonId) {
    let held = match token(&hub.db, person) {
        Ok(Some(t)) => t.sealed_on,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(%person, "a removed person's 1Password token not read: {e}");
            return;
        }
    };
    let machines: Vec<MachineId> = held.into_iter().map(|s| s.machine_id).collect();
    forget(hub, person, &machines).await;
    if let Err(e) = remove_token(&hub.db, person) {
        tracing::warn!(%person, "a removed person's 1Password token not removed: {e}");
    }
}

async fn get(
    hub: Arc<Hub>,
    caller: Caller,
    _input: OnePasswordGetInput,
) -> Result<OnePasswordGetOutput, ToolError> {
    require(&caller, Role::Read, None)?;
    let person = me(&hub, &caller)?;
    Ok(OnePasswordGetOutput {
        token: token(&hub.db, &person.person_id)?,
        next: None,
        truncated: None,
    })
}

async fn set(
    hub: Arc<Hub>,
    caller: Caller,
    input: OnePasswordSetInput,
) -> Result<OnePasswordSetOutput, ToolError> {
    let person = me(&hub, &caller)?;
    let id = &person.person_id;
    let before: Vec<MachineId> = token(&hub.db, id)?
        .map(|t| t.sealed_on.into_iter().map(|s| s.machine_id).collect())
        .unwrap_or_default();
    let mut held = Vec::new();
    let mut problems = Vec::new();
    for ClaudeSeal { machine_id, sealed } in input.sealed.iter().cloned() {
        if let Err(e) = node_ready(&hub, &machine_id) {
            problems.push(e.message);
            continue;
        }
        match hub
            .executors
            .onepassword_token(&machine_id, id.clone(), Some(sealed))
            .await
            .map_err(from_executor)
        {
            Ok(Some(fingerprint)) => held.push(ClaudeSealedOn {
                machine_id,
                fingerprint,
            }),
            Ok(None) => problems.push(format!("{machine_id} kept nothing.")),
            Err(e) => problems.push(format!("{machine_id}: {}", e.message)),
        }
    }
    let now: BTreeSet<&MachineId> = held.iter().map(|s| &s.machine_id).collect();
    let stale: Vec<MachineId> = before.into_iter().filter(|m| !now.contains(m)).collect();
    forget(&hub, id, &stale).await;
    if held.is_empty() {
        return Err(error(
            ErrorCode::Failed,
            format!("No machine took it. {}", problems.join(" ")),
            "Save it again while the machines are online.",
        ));
    }
    held.sort_by(|a, b| a.machine_id.cmp(&b.machine_id));
    let saved = OnePasswordToken {
        sealed_on: held,
        saved_at: now_ts(hub.clock.as_ref()),
        last_test: None,
    };
    put_token(&hub.db, id, &saved)?;
    let missing_on: Vec<MachineId> = hub
        .store
        .machines_list()?
        .into_iter()
        .map(|m| m.machine_id)
        .filter(|m| !saved.sealed_on.iter().any(|s| &s.machine_id == m))
        .collect();
    let mut next = "Agents started from now on in your orders and your Navi fill logins with it, unless their project \
                    has its own OP_SERVICE_ACCOUNT_TOKEN. Press Test to list the vaults it reads."
        .to_owned();
    if !problems.is_empty() {
        next = format!("{next} {}", problems.join(" "));
    }
    Ok(OnePasswordSetOutput {
        token: saved,
        missing_on,
        next: Some(next),
        truncated: None,
    })
}

async fn remove(
    hub: Arc<Hub>,
    caller: Caller,
    _input: OnePasswordRemoveInput,
) -> Result<OnePasswordRemoveOutput, ToolError> {
    let person = me(&hub, &caller)?;
    forget_person(&hub, &person.person_id).await;
    Ok(OnePasswordRemoveOutput {
        ok: True,
        next: Some(
            "Each machine forgot it. Agents started from now on fill logins only with their project's own \
             OP_SERVICE_ACCOUNT_TOKEN."
                .into(),
        ),
        truncated: None,
    })
}

/// The machine a person's token is tested or read on: the one asked for, which must hold it, else the first online.
fn holding(
    hub: &Hub,
    held: &[ClaudeSealedOn],
    asked: Option<&MachineId>,
) -> Result<MachineId, ToolError> {
    let machine_id = match asked {
        Some(m) if held.iter().any(|s| &s.machine_id == m) => m.clone(),
        Some(m) => {
            return Err(error(
                ErrorCode::Invalid,
                format!("{m} doesn't hold it."),
                format!("Save it again while {m} is online."),
            ));
        }
        None => held
            .iter()
            .map(|s| s.machine_id.clone())
            .find(|m| node_ready(hub, m).is_ok())
            .ok_or_else(|| {
                error(
                    ErrorCode::MachineOffline,
                    "No machine holding it is online to read it on.",
                    "Start a node, then try again.",
                )
            })?,
    };
    node_ready(hub, &machine_id)?;
    Ok(machine_id)
}

/// The Credit Card items the caller's token reads, listed on a machine holding it: never a card's details.
async fn cards(
    hub: Arc<Hub>,
    caller: Caller,
    input: OnePasswordCardsInput,
) -> Result<OnePasswordCardsOutput, ToolError> {
    let person = me(&hub, &caller)?;
    let id = &person.person_id;
    let held = token(&hub.db, id)?
        .ok_or_else(|| {
            error(
                ErrorCode::NotFound,
                "You have no 1Password token saved.",
                "Paste a service account token in Settings › You › 1Password first.",
            )
        })?
        .sealed_on;
    let machine_id = holding(&hub, &held, input.machine_id.as_ref())?;
    if !hub.link.node_can(&machine_id, CAP_ONEPASSWORD_CARDS) {
        return Err(error(
            ErrorCode::Invalid,
            format!("{machine_id}'s node is too old to list 1Password cards."),
            format!("Update fleetd on {machine_id} and restart its node."),
        ));
    }
    let listed = hub
        .executors
        .onepassword_cards(&machine_id, id.clone())
        .await
        .map_err(from_executor)?;
    let (cards, error) = match listed {
        Ok(cards) => (cards, None),
        Err(why) => (Vec::new(), Some(why)),
    };
    let next = match (&error, cards.is_empty()) {
        (Some(_), _) => Some("Check the token in Settings › You › 1Password, then try again.".to_owned()),
        (None, true) => Some(
            "This token reads no Credit Card item: add the card to a vault it reads in 1Password, then try again."
                .to_owned(),
        ),
        (None, false) => None,
    };
    Ok(OnePasswordCardsOutput {
        machine_id,
        cards,
        error,
        next,
        truncated: None,
    })
}

async fn test(
    hub: Arc<Hub>,
    caller: Caller,
    input: OnePasswordTestInput,
) -> Result<OnePasswordTestOutput, ToolError> {
    let person = me(&hub, &caller)?;
    let id = &person.person_id;
    let held = token(&hub.db, id)?
        .ok_or_else(|| {
            error(
                ErrorCode::NotFound,
                "You have no 1Password token saved.",
                "Paste a service account token, then test it.",
            )
        })?
        .sealed_on;
    let machine_id = holding(&hub, &held, input.machine_id.as_ref())?;
    let listed = hub
        .executors
        .onepassword_test(&machine_id, id.clone())
        .await
        .map_err(from_executor)?;
    let tried = OnePasswordTest {
        at: now_ts(hub.clock.as_ref()),
        machine_id,
        ok: listed.is_ok(),
        error: listed.as_ref().err().cloned(),
        vaults: listed.unwrap_or_default(),
    };
    // Recorded on the token as it is now; one replaced or removed meanwhile keeps its own.
    if let Some(saved) = token(&hub.db, id)? {
        put_token(
            &hub.db,
            id,
            &OnePasswordToken {
                last_test: Some(tried.clone()),
                ..saved
            },
        )?;
    }
    let next = (!tried.ok).then(|| {
        "Check the token in 1Password (Developer › Service accounts), then paste it again."
            .to_owned()
    });
    Ok(OnePasswordTestOutput {
        test: tried,
        next,
        truncated: None,
    })
}
