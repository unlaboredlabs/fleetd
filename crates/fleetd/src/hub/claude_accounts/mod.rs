//! Which Claude account each agent runs on (teams step 8, D200; the wire types are `claude_accounts.rs`). The hub
//! keeps the hub's API configuration, each person's subscription and choice, and the hub-wide switch, with each
//! node's fingerprint and never a key or token (`claude_accounts`, `claude_choices`, `claude_settings`); the tools
//! are in tools.rs.
//!
//! At each launch the hub works out whose work it is ([`whose_for_task`], [`whose_for_lead`]) and what that runs on
//! ([`Setup::runs_on`]), sends the account in the launch and records it per thread (`thread_accounts`), which the
//! usage layer pauses by. The session keeps its account for its whole life: a lead never switches per turn.
#[cfg(test)]
mod tests;
pub mod tools;

use std::collections::BTreeMap;

use fleetd_contracts::claude_accounts::{
    CONNECT_REFUSAL, ClaudeAccount, ClaudeChoice, ClaudeHubApi, ClaudeRunsOn, ClaudeSettings,
    ClaudeSubscription, PersonClaude,
};
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::people::{HubRole, Person, PersonId};
use rusqlite::{OptionalExtension, params};

use crate::hub::store::{HubDb, StoreError};

const HUB: &str = "hub";
const MEMBERS_USE_HUB_API: &str = "members_use_hub_api";

/// Whose work a launch is, which decides its account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Whose {
    /// A project's lead, or work nobody started: the hub's API configuration, else the hub owner's subscription.
    Hub,
    /// An order a person started, or their Navi: their choice.
    Person(PersonId),
}

pub struct ClaudeAccountStore<'a> {
    db: &'a HubDb,
}

impl HubDb {
    pub fn claude_accounts(&self) -> ClaudeAccountStore<'_> {
        ClaudeAccountStore { db: self }
    }
}

impl ClaudeAccountStore<'_> {
    fn get<T: serde::de::DeserializeOwned>(&self, account: &str) -> Result<Option<T>, StoreError> {
        let data: Option<String> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT data FROM claude_accounts WHERE account = ?",
                [account],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
    }

    fn put<T: serde::Serialize>(&self, account: &str, value: &T) -> Result<(), StoreError> {
        let data = serde_json::to_string(value)?;
        self.db.with(|c| {
            c.execute(
                "INSERT INTO claude_accounts (account, data) VALUES (?, ?)
                 ON CONFLICT (account) DO UPDATE SET data = excluded.data",
                params![account, data],
            )?;
            Ok(())
        })
    }

    fn remove(&self, account: &str) -> Result<bool, StoreError> {
        self.db.with(|c| {
            Ok(c.execute("DELETE FROM claude_accounts WHERE account = ?", [account])? > 0)
        })
    }

    pub fn hub_api(&self) -> Result<Option<ClaudeHubApi>, StoreError> {
        self.get(HUB)
    }

    pub fn put_hub_api(&self, api: &ClaudeHubApi) -> Result<(), StoreError> {
        self.put(HUB, api)
    }

    pub fn remove_hub_api(&self) -> Result<bool, StoreError> {
        self.remove(HUB)
    }

    pub fn subscription(
        &self,
        person: &PersonId,
    ) -> Result<Option<ClaudeSubscription>, StoreError> {
        self.get(person.as_str())
    }

    pub fn put_subscription(
        &self,
        person: &PersonId,
        subscription: &ClaudeSubscription,
    ) -> Result<(), StoreError> {
        self.put(person.as_str(), subscription)
    }

    pub fn remove_subscription(&self, person: &PersonId) -> Result<bool, StoreError> {
        self.remove(person.as_str())
    }

    /// Every connected subscription, by person.
    pub fn subscriptions(&self) -> Result<BTreeMap<PersonId, ClaudeSubscription>, StoreError> {
        let rows: Vec<(String, String)> = self.db.with(|c| {
            let mut stmt =
                c.prepare_cached("SELECT account, data FROM claude_accounts WHERE account != ?")?;
            let rows = stmt
                .query_map([HUB], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, data)| {
                Some((PersonId::new(id).ok()?, serde_json::from_str(&data).ok()?))
            })
            .collect())
    }

    pub fn choice(&self, person: &PersonId) -> Result<Option<ClaudeChoice>, StoreError> {
        let text: Option<String> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT choice FROM claude_choices WHERE person_id = ?",
                [person.as_str()],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        Ok(text.and_then(|t| serde_json::from_value(serde_json::Value::String(t)).ok()))
    }

    pub fn set_choice(
        &self,
        person: &PersonId,
        choice: Option<ClaudeChoice>,
    ) -> Result<(), StoreError> {
        self.db.with(|c| {
            match choice {
                None => c.execute(
                    "DELETE FROM claude_choices WHERE person_id = ?",
                    [person.as_str()],
                )?,
                Some(choice) => c.execute(
                    "INSERT INTO claude_choices (person_id, choice) VALUES (?, ?)
                     ON CONFLICT (person_id) DO UPDATE SET choice = excluded.choice",
                    params![person.as_str(), choice_text(choice)],
                )?,
            };
            Ok(())
        })
    }

    fn choices(&self) -> Result<BTreeMap<PersonId, ClaudeChoice>, StoreError> {
        let rows: Vec<(String, String)> = self.db.with(|c| {
            let mut stmt = c.prepare_cached("SELECT person_id, choice FROM claude_choices")?;
            let rows = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, text)| {
                let choice = serde_json::from_value(serde_json::Value::String(text)).ok()?;
                Some((PersonId::new(id).ok()?, choice))
            })
            .collect())
    }

    /// The hub-wide switches; no row is the default.
    pub fn settings(&self) -> Result<ClaudeSettings, StoreError> {
        let saved: Option<i64> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT value FROM claude_settings WHERE key = ?",
                [MEMBERS_USE_HUB_API],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        Ok(ClaudeSettings {
            members_use_hub_api: saved.is_none_or(|v| v != 0),
        })
    }

    pub fn set_settings(&self, settings: ClaudeSettings) -> Result<(), StoreError> {
        self.db.with(|c| {
            c.execute(
                "INSERT INTO claude_settings (key, value) VALUES (?, ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![MEMBERS_USE_HUB_API, settings.members_use_hub_api as i64],
            )?;
            Ok(())
        })
    }

    /// The account a session was launched on; none for the machine's own login.
    pub fn thread_account(
        &self,
        machine_id: &str,
        thread_id: &str,
    ) -> Result<Option<ClaudeAccount>, StoreError> {
        let key: Option<String> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT account FROM thread_accounts WHERE machine_id = ? AND thread_id = ?",
                params![machine_id, thread_id],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        Ok(key.as_deref().and_then(ClaudeAccount::from_key))
    }

    pub fn set_thread_account(
        &self,
        machine_id: &MachineId,
        thread_id: &str,
        account: &ClaudeAccount,
    ) -> Result<(), StoreError> {
        self.db.with(|c| {
            c.execute(
                "INSERT INTO thread_accounts (machine_id, thread_id, account) VALUES (?, ?, ?)
                 ON CONFLICT (machine_id, thread_id) DO UPDATE SET account = excluded.account",
                params![machine_id.as_str(), thread_id, account.key()],
            )?;
            Ok(())
        })
    }

    /// Everything [`Setup::runs_on`] reads, as it is now.
    pub fn setup(&self) -> Result<Setup, StoreError> {
        let people = crate::hub::people::active(self.db)?;
        Ok(Setup {
            hub_api: self.hub_api()?,
            settings: self.settings()?,
            subscriptions: self.subscriptions()?,
            choices: self.choices()?,
            owner: people
                .iter()
                .find(|p| p.role == HubRole::Owner)
                .map(|p| p.person_id.clone()),
            roles: people.into_iter().map(|p| (p.person_id, p.role)).collect(),
        })
    }
}

fn choice_text(choice: ClaudeChoice) -> &'static str {
    match choice {
        ClaudeChoice::Subscription => "subscription",
        ClaudeChoice::HubApi => "hub_api",
    }
}

/// The hub's Claude setup at one moment: what a launch's account is decided from.
#[derive(Clone, Debug, Default)]
pub struct Setup {
    pub hub_api: Option<ClaudeHubApi>,
    pub settings: ClaudeSettings,
    pub subscriptions: BTreeMap<PersonId, ClaudeSubscription>,
    pub choices: BTreeMap<PersonId, ClaudeChoice>,
    /// The first owner still on the hub.
    pub owner: Option<PersonId>,
    /// Everyone on the hub, with their role.
    pub roles: BTreeMap<PersonId, HubRole>,
}

/// One way some work could run, and whether it is there.
struct Way {
    account: ClaudeAccount,
    /// The machines whose node holds its secret; none when it isn't set up.
    held: Option<Vec<MachineId>>,
    /// Set up but not this person's to use: why.
    barred: Option<&'static str>,
}

impl Setup {
    /// Anything at all is set up: else every machine runs on its own `claude login`, as before step 8.
    pub fn configured(&self) -> bool {
        self.hub_api.is_some() || !self.subscriptions.is_empty()
    }

    fn hub_held(&self) -> Option<Vec<MachineId>> {
        self.hub_api
            .as_ref()
            .map(|a| a.sealed_on.iter().map(|s| s.machine_id.clone()).collect())
    }

    fn subscription_held(&self, person: &PersonId) -> Option<Vec<MachineId>> {
        self.subscriptions
            .get(person)
            .map(|s| s.sealed_on.iter().map(|s| s.machine_id.clone()).collect())
    }

    /// The hub's API is the person's to use: it is set up, and they administer the hub or members may use it.
    pub fn may_use_hub_api(&self, person: &PersonId) -> bool {
        self.hub_api.is_some()
            && (self.settings.members_use_hub_api
                || self.roles.get(person).is_some_and(|r| r.administers()))
    }

    /// What `whose` work runs on, on `machine` (`None`: on any machine holding it): the first of its ways, in order,
    /// that is set up, theirs to use and held on the machine. One set up but on no such machine refuses the work
    /// there rather than run it on the machine's own login. A person's ways are their own subscription and the hub's
    /// API, in the order of their choice (only the one they chose, when they chose); the hub's are its API, then the
    /// owner's subscription. Nobody else's subscription is ever among them.
    pub fn runs_on(&self, whose: &Whose, machine: Option<&MachineId>) -> ClaudeRunsOn {
        if !self.configured() {
            return ClaudeRunsOn::MachineLogin;
        }
        let hub = Way {
            account: ClaudeAccount::Hub,
            held: self.hub_held(),
            barred: None,
        };
        let ways = match whose {
            Whose::Hub => {
                let mut ways = vec![hub];
                if let Some(owner) = &self.owner {
                    ways.push(Way {
                        account: ClaudeAccount::Person {
                            person_id: owner.clone(),
                        },
                        held: self.subscription_held(owner),
                        barred: None,
                    });
                }
                ways
            }
            Whose::Person(person) => {
                let own = Way {
                    account: ClaudeAccount::Person {
                        person_id: person.clone(),
                    },
                    held: self.subscription_held(person),
                    barred: None,
                };
                let hub = Way {
                    barred: (self.hub_api.is_some() && !self.may_use_hub_api(person))
                        .then_some("members may not use the hub's API on this hub"),
                    ..hub
                };
                match self.choices.get(person) {
                    Some(ClaudeChoice::Subscription) => vec![own],
                    Some(ClaudeChoice::HubApi) => vec![hub],
                    None => vec![own, hub],
                }
            }
        };
        let usable: Vec<(&Way, &Vec<MachineId>)> = ways
            .iter()
            .filter(|w| w.barred.is_none())
            .filter_map(|w| Some((w, w.held.as_ref()?)))
            .collect();
        let on_machine = usable
            .iter()
            .find(|(_, held)| machine.map_or(!held.is_empty(), |m| held.contains(m)));
        if let Some((way, _)) = on_machine {
            return ClaudeRunsOn::Account {
                account: way.account.clone(),
            };
        }
        // Set up, but not on this machine: refused there, never run on the machine's own login instead.
        if let Some((way, _)) = usable.first() {
            let (place, when) = match machine {
                Some(m) => (format!("on {m}"), format!("while {m} is online")),
                None => (
                    "on any machine".to_owned(),
                    "while the machines are online".to_owned(),
                ),
            };
            return ClaudeRunsOn::Refused {
                message: format!("{} isn't {place}.", account_text(&way.account)),
                fix: format!("{} again {when}.", connect_text(&way.account)),
            };
        }
        match whose {
            // Only members' subscriptions are set up: projects' leads keep the machines' own login.
            Whose::Hub => ClaudeRunsOn::MachineLogin,
            Whose::Person(person) => ClaudeRunsOn::Refused {
                message: CONNECT_REFUSAL.to_owned(),
                fix: self.connect_fix(person),
            },
        }
    }

    /// What someone with no way to run does, in their own settings.
    fn connect_fix(&self, person: &PersonId) -> String {
        let subscribe = "connect your subscription in Settings › Your accounts › Claude (paste the token `claude setup-token` prints)";
        match self.choices.get(person) {
            Some(ClaudeChoice::HubApi) if self.hub_api.is_none() => format!(
                "The hub has no API key yet: {subscribe}, or ask an admin to add one on the Hub pages of the app's Settings."
            ),
            Some(ClaudeChoice::HubApi) => format!(
                "Members may not use the hub's API on this hub: {subscribe}, or ask an admin."
            ),
            _ if self.hub_api.is_some() && !self.may_use_hub_api(person) => {
                format!("Members may not use the hub's API on this hub: {subscribe}.")
            }
            _ => format!("Open Settings › Your accounts › Claude and {subscribe}."),
        }
    }

    /// A person's setup as the tools show it.
    pub fn person(&self, person: &Person) -> PersonClaude {
        let id = &person.person_id;
        PersonClaude {
            person: person.as_ref(),
            choice: self.choices.get(id).copied(),
            subscription: self.subscriptions.get(id).cloned(),
            may_use_hub_api: self.may_use_hub_api(id),
            runs_on: self.runs_on(&Whose::Person(id.clone()), None),
        }
    }
}

/// "The hub's API key", "Your subscription": what a refusal names.
fn account_text(account: &ClaudeAccount) -> &'static str {
    match account {
        ClaudeAccount::Hub => "The hub's API key",
        ClaudeAccount::Person { .. } => "The Claude subscription this runs on",
    }
}

fn connect_text(account: &ClaudeAccount) -> &'static str {
    match account {
        ClaudeAccount::Hub => "Save the hub's API key on the Hub pages of the app's Settings",
        ClaudeAccount::Person { .. } => {
            "Connect the subscription in Settings › Your accounts › Claude"
        }
    }
}

/// The person behind a Navi: whoever's key made it, else the hub's owner (a Navi from before people was theirs).
fn navi_owner(
    db: &HubDb,
    r: &ProjectRef,
    owner: Option<&PersonId>,
) -> Result<Option<PersonId>, StoreError> {
    let person: Option<Option<String>> = db.with(|c| {
        Ok(c.query_row(
            "SELECT k.person_id FROM assistants a LEFT JOIN agent_keys k ON k.key_id = a.created_by_key
             WHERE a.machine_id = ? AND a.project_id = ?",
            params![r.machine_id.as_str(), r.project_id.as_str()],
            |row| row.get(0),
        )
        .optional()?)
    })?;
    Ok(match person {
        None => None,
        Some(Some(id)) => PersonId::new(id).ok().or_else(|| owner.cloned()),
        Some(None) => owner.cloned(),
    })
}

/// Whose work a task of `order` in project `r` is: a Navi's owner's in a Navi, else the person who started the
/// order, else nobody's (automations, train fixes: the hub's). A person since removed counts as nobody.
pub fn whose_for_task(
    db: &HubDb,
    setup: &Setup,
    r: &ProjectRef,
    order: Option<&WorkstreamId>,
) -> Result<Whose, StoreError> {
    if let Some(person) = navi_owner(db, r, setup.owner.as_ref())? {
        return Ok(Whose::Person(person));
    }
    let started = match order {
        Some(id) => db
            .with(|c| crate::hub::leads::records::read_workstream(c, id))?
            .and_then(|w| w.started_by),
        None => None,
    };
    Ok(match started {
        Some(p) if setup.roles.contains_key(&p.person_id) => Whose::Person(p.person_id),
        _ => Whose::Hub,
    })
}

/// Whose work a lead is: a Navi's lead its owner's, a project's lead the hub's, whoever writes to it.
pub fn whose_for_lead(db: &HubDb, setup: &Setup, r: &ProjectRef) -> Result<Whose, StoreError> {
    Ok(match navi_owner(db, r, setup.owner.as_ref())? {
        Some(person) => Whose::Person(person),
        None => Whose::Hub,
    })
}

/// Why a launch can't run, and what to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub message: String,
    pub fix: String,
}

impl Refusal {
    fn unread(error: StoreError) -> Self {
        Refusal {
            message: format!("The hub could not read its Claude accounts: {error}."),
            fix: "Try again; if it keeps failing, run fleetd doctor on the hub.".to_owned(),
        }
    }
}

/// What `whose` work launched on `machine` runs on: `None` for the machine's own login. Refused when nothing it may
/// use is on the machine, or when the node is too old to run an account (it would run the work on its own login).
pub fn launch_account(
    setup: &Setup,
    whose: &Whose,
    machine: &MachineId,
    node_can: impl FnOnce() -> bool,
) -> Result<Option<ClaudeAccount>, Refusal> {
    match setup.runs_on(whose, Some(machine)) {
        ClaudeRunsOn::MachineLogin => Ok(None),
        ClaudeRunsOn::Refused { message, fix } => Err(Refusal { message, fix }),
        ClaudeRunsOn::Account { .. } if !node_can() => Err(Refusal {
            message: format!("{machine}'s node is too old to run work on a Claude account."),
            fix: format!("Run fleetd update on {machine}."),
        }),
        ClaudeRunsOn::Account { account } => Ok(Some(account)),
    }
}

/// [`launch_account`] for a task of `order` in project `r` on `machine`.
pub fn for_task(
    db: &HubDb,
    link: &crate::hub::link::NodeLinkServer,
    r: &ProjectRef,
    order: Option<&WorkstreamId>,
    machine: &MachineId,
) -> Result<Option<ClaudeAccount>, Refusal> {
    let setup = db.claude_accounts().setup().map_err(Refusal::unread)?;
    let whose = whose_for_task(db, &setup, r, order).map_err(Refusal::unread)?;
    launch_account(&setup, &whose, machine, || node_can(link, machine))
}

/// [`launch_account`] for the lead of project `r` on its machine.
pub fn for_lead(
    db: &HubDb,
    link: &crate::hub::link::NodeLinkServer,
    r: &ProjectRef,
) -> Result<Option<ClaudeAccount>, Refusal> {
    let setup = db.claude_accounts().setup().map_err(Refusal::unread)?;
    let whose = whose_for_lead(db, &setup, r).map_err(Refusal::unread)?;
    launch_account(&setup, &whose, &r.machine_id, || {
        node_can(link, &r.machine_id)
    })
}

/// [`launch_account`] for work nobody started (the nightly memory refresh) on `machine`.
pub fn for_hub(
    db: &HubDb,
    link: &crate::hub::link::NodeLinkServer,
    machine: &MachineId,
) -> Result<Option<ClaudeAccount>, Refusal> {
    let setup = db.claude_accounts().setup().map_err(Refusal::unread)?;
    launch_account(&setup, &Whose::Hub, machine, || node_can(link, machine))
}

/// The refusal an order of `order` would meet anywhere, before any agent is spawned for it: `Some` when its person
/// has nothing to run on ("Connect your Claude to start this order").
pub fn order_refusal(db: &HubDb, r: &ProjectRef, order: &WorkstreamId) -> Option<Refusal> {
    let setup = match db.claude_accounts().setup() {
        Ok(setup) => setup,
        Err(error) => return Some(Refusal::unread(error)),
    };
    let whose = match whose_for_task(db, &setup, r, Some(order)) {
        Ok(whose) => whose,
        Err(error) => return Some(Refusal::unread(error)),
    };
    match setup.runs_on(&whose, None) {
        ClaudeRunsOn::Refused { message, fix } => Some(Refusal { message, fix }),
        _ => None,
    }
}

fn node_can(link: &crate::hub::link::NodeLinkServer, machine: &MachineId) -> bool {
    link.node_can(machine, fleetd_contracts::node_link::CAP_CLAUDE_ACCOUNTS)
}

/// The key of the account a task of `order` would run on, on `machine`: whose usage pause holds it. None for the
/// machine's own login, or when it can't be told (its launch then decides).
pub fn task_account_key(
    db: &HubDb,
    r: &ProjectRef,
    order: Option<&WorkstreamId>,
    machine: &MachineId,
) -> Option<String> {
    let setup = db.claude_accounts().setup().ok()?;
    let whose = whose_for_task(db, &setup, r, order).ok()?;
    account_key(setup.runs_on(&whose, Some(machine)))
}

/// The key of the account the lead of project `r` runs on: whose usage pause holds its turns.
pub fn lead_account_key(db: &HubDb, r: &ProjectRef) -> Option<String> {
    let setup = db.claude_accounts().setup().ok()?;
    let whose = whose_for_lead(db, &setup, r).ok()?;
    account_key(setup.runs_on(&whose, Some(&r.machine_id)))
}

fn account_key(runs_on: ClaudeRunsOn) -> Option<String> {
    match runs_on {
        ClaudeRunsOn::Account { account } => Some(account.key().to_owned()),
        _ => None,
    }
}
