//! The hub's Claude configuration on cloud machines, with nobody pasting it again (D306). What the hub's own work runs
//! on (Settings › Hub accounts: the hub's API key and endpoint, else the hub owner's subscription) is sealed to each
//! cloud machine's box key by a machine that already holds it: the hub asks that node to seal its copy to the cloud
//! machine's key (`claude_account_reseal`), and relays the box to the cloud machine (`claude_account_secret`). The hub
//! still never holds a key, a token or a box: the box passes through it in memory once, as a box pasted in the app does,
//! and the hub keeps only each machine's fingerprint, as for any machine.
//!
//! [`bring`] runs in every catch-up ([`super::catch_up`]): at the cloud machine's first hello (its enroll), and at each
//! wake after. It first asks the cloud machine what it holds (a `claude_account_secret` that keeps its value and sets
//! the endpoint as it is now), so a cloud machine already current costs one call, an endpoint changed while it slept is
//! set, and a key replaced while it slept (the app could only seal the new one to the machines awake then) is resealed.
//! People's own subscriptions stay theirs: only the account the hub's own work runs on is resealed, never anyone else's.
use fleetd_contracts::claude_accounts::{
    ClaudeAccount, ClaudeEndpoint, ClaudeRunsOn, ClaudeSealedOn, ClaudeSecretSet,
};
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::node_link::{CAP_CLAUDE_ACCOUNTS, CAP_CLAUDE_RESEAL};
use fleetd_contracts::secrets::SecretFingerprint;

use crate::hub::api::Hub;
use crate::hub::claude_accounts::Whose;

/// What [`bring`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Brought {
    /// The hub's work runs on no account here (each machine's own login): nothing to bring.
    Nothing,
    /// The machine already held the account's current secret.
    Current(ClaudeAccount),
    /// Sealed to it by this machine, which holds the account.
    Resealed {
        account: ClaudeAccount,
        from: MachineId,
    },
}

/// The account the hub's own work runs on, its endpoint, and where it is held now.
fn hub_account(hub: &Hub) -> Result<Option<Held>, String> {
    let store = hub.db.claude_accounts();
    let setup = store.setup().map_err(|e| e.to_string())?;
    let ClaudeRunsOn::Account { account } = setup.runs_on(&Whose::Hub, None) else {
        return Ok(None);
    };
    let held = match &account {
        ClaudeAccount::Hub => setup
            .hub_api
            .map(|api| (api.endpoint, api.sealed_on))
            .unwrap_or_default(),
        ClaudeAccount::Person { person_id } => {
            let on = setup
                .subscriptions
                .get(person_id)
                .map(|s| s.sealed_on.clone());
            (None, on.unwrap_or_default())
        }
    };
    Ok(Some(Held {
        account,
        endpoint: held.0,
        sealed_on: held.1,
    }))
}

struct Held {
    account: ClaudeAccount,
    endpoint: Option<ClaudeEndpoint>,
    sealed_on: Vec<ClaudeSealedOn>,
}

/// Records that `machine_id` holds the account with `fingerprint`, on the account as it is now.
fn record(
    hub: &Hub,
    account: &ClaudeAccount,
    machine_id: &MachineId,
    fingerprint: SecretFingerprint,
) -> Result<(), String> {
    let put = |sealed_on: &mut Vec<ClaudeSealedOn>| {
        sealed_on.retain(|s| &s.machine_id != machine_id);
        sealed_on.push(ClaudeSealedOn {
            machine_id: machine_id.clone(),
            fingerprint: fingerprint.clone(),
        });
        sealed_on.sort_by(|a, b| a.machine_id.cmp(&b.machine_id));
    };
    let store = hub.db.claude_accounts();
    let done = match account {
        ClaudeAccount::Hub => match store.hub_api() {
            Ok(Some(mut api)) => {
                put(&mut api.sealed_on);
                store.put_hub_api(&api)
            }
            other => other.map(|_| ()),
        },
        ClaudeAccount::Person { person_id } => match store.subscription(person_id) {
            Ok(Some(mut s)) => {
                put(&mut s.sealed_on);
                store.put_subscription(person_id, &s)
            }
            other => other.map(|_| ()),
        },
    };
    done.map_err(|e| e.to_string())
}

fn ready(hub: &Hub, machine_id: &MachineId, cap: &str) -> bool {
    hub.executors.is_connected(machine_id) && hub.link.node_can(machine_id, cap)
}

/// Brings the account the hub's own work runs on to the cloud machine `machine_id`, sealed to its box key by a
/// machine that holds it. Why not, in one line, when no machine holding it is online, or the cloud machine can't take
/// it; the next wake tries again.
pub async fn bring(hub: &Hub, machine_id: &MachineId) -> Result<Brought, String> {
    let Some(held) = hub_account(hub)? else {
        return Ok(Brought::Nothing);
    };
    let Held {
        account,
        endpoint,
        sealed_on,
    } = held;
    // What the machines holding it hold now: they all hold one value, whose fingerprint the cloud machine must match.
    let Some(want) = sealed_on
        .iter()
        .find(|s| &s.machine_id != machine_id)
        .map(|s| s.fingerprint.clone())
    else {
        return Err("no other machine holds the hub's Claude account to seal it from".into());
    };
    if !ready(hub, machine_id, CAP_CLAUDE_ACCOUNTS) {
        return Err(format!("{machine_id}'s node takes no Claude account"));
    }
    let keep = ClaudeSecretSet {
        sealed: None,
        endpoint: endpoint.clone(),
    };
    // Held already (an error means it holds none): only the endpoint as it is now is set.
    if let Ok(Some(have)) = hub
        .executors
        .claude_account_secret(machine_id, account.clone(), Some(keep))
        .await
        && have == want
    {
        record(hub, &account, machine_id, have)?;
        return Ok(Brought::Current(account));
    }
    let to = hub
        .store
        .machine_get(machine_id)
        .map_err(|e| e.to_string())?
        .and_then(|m| m.box_pub_key)
        .ok_or_else(|| format!("{machine_id} has no box key to seal to"))?;
    let holders = sealed_on
        .iter()
        .filter(|s| &s.machine_id != machine_id && s.fingerprint == want)
        .map(|s| &s.machine_id)
        .filter(|m| ready(hub, m, CAP_CLAUDE_RESEAL));
    let mut problems = Vec::new();
    for from in holders {
        let sealed = match hub
            .executors
            .claude_account_reseal(from, account.clone(), to.clone())
            .await
        {
            Ok(Some(sealed)) => sealed,
            Ok(None) => {
                problems.push(format!("{from} holds it no more"));
                continue;
            }
            Err(e) => {
                problems.push(format!("{from}: {e}"));
                continue;
            }
        };
        let set = ClaudeSecretSet {
            sealed: Some(sealed),
            endpoint: endpoint.clone(),
        };
        match hub
            .executors
            .claude_account_secret(machine_id, account.clone(), Some(set))
            .await
        {
            Ok(Some(fingerprint)) if fingerprint == want => {
                record(hub, &account, machine_id, fingerprint)?;
                return Ok(Brought::Resealed {
                    account,
                    from: from.clone(),
                });
            }
            Ok(_) => {
                return Err(format!(
                    "{machine_id} kept another value than {from} sealed"
                ));
            }
            Err(e) => return Err(format!("{machine_id} didn't take it: {e}")),
        }
    }
    if problems.is_empty() {
        return Err("no machine holding the hub's Claude account is online to seal it".into());
    }
    Err(problems.join("; "))
}
