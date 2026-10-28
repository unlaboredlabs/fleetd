//! The Claude account tools. The hub's: `claude_hub_api_set`, `claude_hub_api_remove` and `claude_settings_set`, for
//! an owner's or admin's device (the Administration page). A person's own: `claude_subscription_set`,
//! `claude_subscription_remove` and `claude_choice_set`, for their own devices. `claude_accounts_get` for everyone,
//! and `claude_account_test` for whoever may change the account it tries.
//!
//! A key or token comes sealed to each machine's box key; the hub relays each box to its node and records the
//! fingerprint it answers. The boxes are never stored, logged or returned, and no agent key reaches these tools.
use std::collections::BTreeSet;
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::claude_accounts::{
    ClaudeAccount, ClaudeEndpoint, ClaudeHubApi, ClaudeSeal, ClaudeSealedOn, ClaudeSecretSet,
    ClaudeSettings, ClaudeSubscription, ClaudeTest, ClaudeTestTarget, PersonClaude,
};
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::mcp::{
    ClaudeAccountTestInput, ClaudeAccountTestOutput, ClaudeAccountsGetInput,
    ClaudeAccountsGetOutput, ClaudeChoiceSetInput, ClaudeChoiceSetOutput, ClaudeHubApiRemoveInput,
    ClaudeHubApiRemoveOutput, ClaudeHubApiSetInput, ClaudeHubApiSetOutput, ClaudeSettingsSetInput,
    ClaudeSettingsSetOutput, ClaudeSubscriptionRemoveInput, ClaudeSubscriptionRemoveOutput,
    ClaudeSubscriptionSetInput, ClaudeSubscriptionSetOutput, ErrorCode,
};
use fleetd_contracts::node_link::CAP_CLAUDE_ACCOUNTS;
use fleetd_contracts::people::{Person, PersonId};
use fleetd_contracts::prim::True;

use super::Whose;
use crate::hub::api::{Caller, Hub, Registry, ToolError, error, is_human, offline, require};
use crate::hub::checks::now_ts;
use crate::hub::executor::tools::from_executor;
use crate::hub::people::tools::administrator;

pub fn register(tools: &mut Registry) {
    tools.add("claude_accounts_get", get);
    tools.add("claude_hub_api_set", hub_api_set);
    tools.add("claude_hub_api_remove", hub_api_remove);
    tools.add("claude_settings_set", settings_set);
    tools.add("claude_subscription_set", subscription_set);
    tools.add("claude_subscription_remove", subscription_remove);
    tools.add("claude_choice_set", choice_set);
    tools.add("claude_account_test", test);
}

const STARTED_NEXT: &str =
    "Agents started from now on run this way; a running agent keeps the account it started on.";

fn require_administrator(hub: &Hub, caller: &Caller) -> Result<Person, ToolError> {
    administrator(hub, caller)?.ok_or_else(|| {
        error(
            ErrorCode::Forbidden,
            "Only the hub's owners and admins set up the hub's Claude API configuration.",
            "Ask an owner or admin; they set it on the app's Administration page.",
        )
    })
}

/// The person behind a human key: only a person connects their own subscription or makes their choice.
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
            "Only a person connects their own Claude, from one of their own devices.",
            "Open Settings › Connections › Claude in the desktop app.",
        )
    })
}

fn person_view(hub: &Hub, person: &Person) -> Result<PersonClaude, ToolError> {
    Ok(hub.db.claude_accounts().setup()?.person(person))
}

/// The node can take the account's secret: online and new enough.
fn node_ready(hub: &Hub, m: &MachineId) -> Result<(), ToolError> {
    if !hub.executors.is_connected(m) {
        return Err(offline(m));
    }
    if !hub.link.node_can(m, CAP_CLAUDE_ACCOUNTS) {
        return Err(error(
            ErrorCode::Invalid,
            format!("{m}'s node is too old to run work on a Claude account."),
            format!("Update fleetd on {m} and restart its node."),
        ));
    }
    Ok(())
}

/// Machines that run agents and don't hold the account: none of its work runs there.
fn missing_on(hub: &Hub, held: &[ClaudeSealedOn]) -> Result<Vec<MachineId>, ToolError> {
    Ok(hub
        .store
        .machines_list()?
        .into_iter()
        .map(|m| m.machine_id)
        .filter(|m| !held.iter().any(|s| &s.machine_id == m))
        .collect())
}

/// Puts `account`'s secret on the machines: each of `seals`, or with none the value each machine in `before`
/// already holds, with `endpoint` as it is now. Every other machine in `before` forgets it. Returns the machines
/// holding it now and, for each that doesn't, why.
async fn relay(
    hub: &Hub,
    account: &ClaudeAccount,
    seals: &[ClaudeSeal],
    endpoint: Option<&ClaudeEndpoint>,
    before: &[ClaudeSealedOn],
) -> (Vec<ClaudeSealedOn>, Vec<String>) {
    let mut held = Vec::new();
    let mut problems = Vec::new();
    let sends: Vec<(MachineId, ClaudeSecretSet)> = if seals.is_empty() {
        before
            .iter()
            .map(|s| {
                let set = ClaudeSecretSet {
                    sealed: None,
                    endpoint: endpoint.cloned(),
                };
                (s.machine_id.clone(), set)
            })
            .collect()
    } else {
        seals
            .iter()
            .map(|s| {
                let set = ClaudeSecretSet {
                    sealed: Some(s.sealed.clone()),
                    endpoint: endpoint.cloned(),
                };
                (s.machine_id.clone(), set)
            })
            .collect()
    };
    for (m, set) in sends {
        if let Err(e) = node_ready(hub, &m) {
            problems.push(e.message);
            continue;
        }
        match hub
            .executors
            .claude_account_secret(&m, account.clone(), Some(set))
            .await
            .map_err(from_executor)
        {
            Ok(Some(fingerprint)) => held.push(ClaudeSealedOn {
                machine_id: m,
                fingerprint,
            }),
            Ok(None) => problems.push(format!("{m} kept nothing.")),
            Err(e) => problems.push(format!("{m}: {}", e.message)),
        }
    }
    let now: BTreeSet<&MachineId> = held.iter().map(|s| &s.machine_id).collect();
    let stale: Vec<MachineId> = before
        .iter()
        .map(|s| s.machine_id.clone())
        .filter(|m| !now.contains(m))
        .collect();
    forget(hub, account, &stale).await;
    held.sort_by(|a, b| a.machine_id.cmp(&b.machine_id));
    (held, problems)
}

/// Each online node of `machines` forgets the account's secret. One offline keeps it unused: the hub runs nothing
/// on the account there, as it no longer records the machine as holding it.
async fn forget(hub: &Hub, account: &ClaudeAccount, machines: &[MachineId]) {
    for m in machines {
        if node_ready(hub, m).is_err() {
            continue;
        }
        if let Err(e) = hub
            .executors
            .claude_account_secret(m, account.clone(), None)
            .await
        {
            tracing::warn!(machine_id = %m, account = account.key(), "Claude account not forgotten: {e}");
        }
    }
}

/// None of the machines took it.
fn none_took(problems: &[String]) -> ToolError {
    error(
        ErrorCode::Failed,
        format!("No machine took it. {}", problems.join(" ")),
        "Seal it to the machines while they are online, then save again.",
    )
}

/// Forgets a removed person's subscription everywhere (`person_remove`): nobody's work runs on it again.
pub async fn forget_person(hub: &Hub, person: &PersonId) {
    let store = hub.db.claude_accounts();
    let held = match store.subscription(person) {
        Ok(Some(s)) => s.sealed_on,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(%person, "a removed person's subscription not read: {e}");
            return;
        }
    };
    let account = ClaudeAccount::Person {
        person_id: person.clone(),
    };
    let machines: Vec<MachineId> = held.into_iter().map(|s| s.machine_id).collect();
    forget(hub, &account, &machines).await;
    if let Err(e) = store
        .remove_subscription(person)
        .and_then(|_| store.set_choice(person, None))
    {
        tracing::warn!(%person, "a removed person's subscription not removed: {e}");
    }
}

async fn get(
    hub: Arc<Hub>,
    caller: Caller,
    _input: ClaudeAccountsGetInput,
) -> Result<ClaudeAccountsGetOutput, ToolError> {
    require(&caller, Role::Read, None)?;
    let setup = hub.db.claude_accounts().setup()?;
    let admin = administrator(&hub, &caller)?.is_some();
    let me = me(&hub, &caller).ok().map(|p| setup.person(&p));
    let people = if admin {
        crate::hub::people::active(&hub.db)?
            .iter()
            .map(|p| setup.person(p))
            .collect()
    } else {
        Vec::new()
    };
    Ok(ClaudeAccountsGetOutput {
        leads_run_on: setup.runs_on(&Whose::Hub, None),
        hub_api: setup.hub_api,
        settings: setup.settings,
        me,
        people,
        next: None,
        truncated: None,
    })
}

async fn hub_api_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: ClaudeHubApiSetInput,
) -> Result<ClaudeHubApiSetOutput, ToolError> {
    let by = require_administrator(&hub, &caller)?;
    let store = hub.db.claude_accounts();
    let before = store.hub_api()?;
    if input.sealed.is_empty() && before.is_none() {
        return Err(error(
            ErrorCode::Invalid,
            "The hub has no API key to keep.",
            "Paste the key: the app seals it to each machine.",
        ));
    }
    let before_on = before
        .as_ref()
        .map(|b| b.sealed_on.clone())
        .unwrap_or_default();
    let (held, problems) = relay(
        &hub,
        &ClaudeAccount::Hub,
        &input.sealed,
        input.endpoint.as_ref(),
        &before_on,
    )
    .await;
    if held.is_empty() {
        return Err(none_took(&problems));
    }
    // A new key or endpoint was never tried.
    let api = ClaudeHubApi {
        endpoint: input.endpoint.clone(),
        sealed_on: held,
        updated_at: now_ts(hub.clock.as_ref()),
        updated_by: Some(by.as_ref()),
        last_test: None,
    };
    store.put_hub_api(&api)?;
    let missing_on = missing_on(&hub, &api.sealed_on)?;
    let mut next = format!("{STARTED_NEXT} Press Test to try it with one tiny claude call.");
    if !problems.is_empty() {
        next = format!("{next} {}", problems.join(" "));
    }
    Ok(ClaudeHubApiSetOutput {
        hub_api: api,
        missing_on,
        next: Some(next),
        truncated: None,
    })
}

async fn hub_api_remove(
    hub: Arc<Hub>,
    caller: Caller,
    _input: ClaudeHubApiRemoveInput,
) -> Result<ClaudeHubApiRemoveOutput, ToolError> {
    require_administrator(&hub, &caller)?;
    let store = hub.db.claude_accounts();
    if let Some(before) = store.hub_api()? {
        store.remove_hub_api()?;
        let machines: Vec<MachineId> = before.sealed_on.into_iter().map(|s| s.machine_id).collect();
        forget(&hub, &ClaudeAccount::Hub, &machines).await;
    }
    Ok(ClaudeHubApiRemoveOutput {
        ok: True,
        next: Some(
            "Leads and work nobody started run on the hub owner's subscription from their next start, else each \
             machine's own login; people who used the hub's API connect their own subscription."
                .into(),
        ),
        truncated: None,
    })
}

async fn settings_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: ClaudeSettingsSetInput,
) -> Result<ClaudeSettingsSetOutput, ToolError> {
    require_administrator(&hub, &caller)?;
    let store = hub.db.claude_accounts();
    store.set_settings(ClaudeSettings {
        members_use_hub_api: input.members_use_hub_api,
    })?;
    Ok(ClaudeSettingsSetOutput {
        settings: store.settings()?,
        next: Some(STARTED_NEXT.into()),
        truncated: None,
    })
}

async fn subscription_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: ClaudeSubscriptionSetInput,
) -> Result<ClaudeSubscriptionSetOutput, ToolError> {
    let person = me(&hub, &caller)?;
    let store = hub.db.claude_accounts();
    let account = ClaudeAccount::Person {
        person_id: person.person_id.clone(),
    };
    let before_on = store
        .subscription(&person.person_id)?
        .map(|s| s.sealed_on)
        .unwrap_or_default();
    let (held, problems) = relay(&hub, &account, &input.sealed, None, &before_on).await;
    if held.is_empty() {
        return Err(none_took(&problems));
    }
    let subscription = ClaudeSubscription {
        sealed_on: held,
        connected_at: now_ts(hub.clock.as_ref()),
        last_test: None,
    };
    store.put_subscription(&person.person_id, &subscription)?;
    let missing_on = missing_on(&hub, &subscription.sealed_on)?;
    let mut next = format!("{STARTED_NEXT} Press Test to try it with one tiny claude call.");
    if !problems.is_empty() {
        next = format!("{next} {}", problems.join(" "));
    }
    Ok(ClaudeSubscriptionSetOutput {
        me: person_view(&hub, &person)?,
        missing_on,
        next: Some(next),
        truncated: None,
    })
}

async fn subscription_remove(
    hub: Arc<Hub>,
    caller: Caller,
    _input: ClaudeSubscriptionRemoveInput,
) -> Result<ClaudeSubscriptionRemoveOutput, ToolError> {
    let person = me(&hub, &caller)?;
    let store = hub.db.claude_accounts();
    if let Some(before) = store.subscription(&person.person_id)? {
        store.remove_subscription(&person.person_id)?;
        let account = ClaudeAccount::Person {
            person_id: person.person_id.clone(),
        };
        let machines: Vec<MachineId> = before.sealed_on.into_iter().map(|s| s.machine_id).collect();
        forget(&hub, &account, &machines).await;
    }
    Ok(ClaudeSubscriptionRemoveOutput {
        me: person_view(&hub, &person)?,
        next: Some(STARTED_NEXT.into()),
        truncated: None,
    })
}

async fn choice_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: ClaudeChoiceSetInput,
) -> Result<ClaudeChoiceSetOutput, ToolError> {
    let person = me(&hub, &caller)?;
    hub.db
        .claude_accounts()
        .set_choice(&person.person_id, input.choice)?;
    Ok(ClaudeChoiceSetOutput {
        me: person_view(&hub, &person)?,
        next: Some(STARTED_NEXT.into()),
        truncated: None,
    })
}

async fn test(
    hub: Arc<Hub>,
    caller: Caller,
    input: ClaudeAccountTestInput,
) -> Result<ClaudeAccountTestOutput, ToolError> {
    let store = hub.db.claude_accounts();
    let (account, held) = match input.account {
        ClaudeTestTarget::HubApi => {
            require_administrator(&hub, &caller)?;
            let api = store.hub_api()?.ok_or_else(|| {
                error(
                    ErrorCode::NotFound,
                    "The hub has no API key.",
                    "Save one first with claude_hub_api_set.",
                )
            })?;
            (ClaudeAccount::Hub, api.sealed_on)
        }
        ClaudeTestTarget::Mine => {
            let person = me(&hub, &caller)?;
            let subscription = store.subscription(&person.person_id)?.ok_or_else(|| {
                error(
                    ErrorCode::NotFound,
                    "You have no subscription connected.",
                    "Paste the token `claude setup-token` prints, then test it.",
                )
            })?;
            let account = ClaudeAccount::Person {
                person_id: person.person_id,
            };
            (account, subscription.sealed_on)
        }
    };
    let machine_id = match &input.machine_id {
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
            .find(|m| node_ready(&hub, m).is_ok())
            .ok_or_else(|| {
                error(
                    ErrorCode::MachineOffline,
                    "No machine holding it is online to test it on.",
                    "Start a node, then test again.",
                )
            })?,
    };
    node_ready(&hub, &machine_id)?;
    let (ok, said) = hub
        .executors
        .claude_account_test(&machine_id, account.clone())
        .await
        .map_err(from_executor)?;
    let tried = ClaudeTest {
        at: now_ts(hub.clock.as_ref()),
        machine_id,
        ok,
        error: said.filter(|_| !ok),
    };
    // Recorded on the account as it is now; one replaced or removed meanwhile keeps its own.
    match &account {
        ClaudeAccount::Hub => {
            if let Some(api) = store.hub_api()? {
                store.put_hub_api(&ClaudeHubApi {
                    last_test: Some(tried.clone()),
                    ..api
                })?;
            }
        }
        ClaudeAccount::Person { person_id } => {
            if let Some(s) = store.subscription(person_id)? {
                store.put_subscription(
                    person_id,
                    &ClaudeSubscription {
                        last_test: Some(tried.clone()),
                        ..s
                    },
                )?;
            }
        }
    }
    let next = (!tried.ok).then(|| match account {
        ClaudeAccount::Hub => "Check the key and endpoint, then save them again.".to_owned(),
        ClaudeAccount::Person { .. } => {
            "Run `claude setup-token` again and paste the new token.".to_owned()
        }
    });
    Ok(ClaudeAccountTestOutput {
        test: tried,
        next,
        truncated: None,
    })
}
