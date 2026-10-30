//! Machine roles (W46): what each machine is for (table `machine_roles`: agents, sessions or both, and its session
//! cap; no row means both, auto) and where each session an agent starts runs (table `session_places`).
//!
//! The agent's node hands each `session_start` to the hub (`session_route`, calls.rs), which places it ([`place`]):
//! on the agent's own machine when it hosts sessions, can run this kind and has a free session slot, else a plain
//! refusal that says why. A session placed on its agent's machine runs there as before.
//!
//! A session the agent's machine can't take goes to the online machine that can with the most free slots ([`remote_on`]
//! turns that off), and the agent drives it through the hub's relay (relay.rs). That machine's node hosts it under a key the hub mints, the agent's later session calls go to
//! it through the hub, and the runner reports the session in the agent's name ([`HostedCallers`]).
//!
//! Session slots are separate from agent slots: a machine's live sessions are its own agents' (`browser_sessions`)
//! and those it hosts for others, and each machine's cap is a person's setting or what it fits ([`auto_sessions`]).
pub mod calls;
pub mod relay;
pub mod screens;
pub mod tools;

#[cfg(test)]
mod screens_tests;
#[cfg(test)]
mod tests;

use std::sync::{Arc, Weak};

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId};
use fleetd_contracts::machine_roles::{
    HostChecks, HostKey, MachineRole, MachineRolesEntry, SessionHost,
};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::model::MachineStatus;
use fleetd_contracts::node_link::{CAP_SESSION_HOST, CAP_SESSION_SEAL, NodeLoad};
use fleetd_contracts::prim::{Count, Int, Line, List};
use fleetd_contracts::tasks::TaskId;
use rusqlite::{Connection, OptionalExtension, params};

use crate::hub::api::Hub;
use crate::hub::link::lead_calls::{CallerAgent, HostedCaller, HostedCallers};
use crate::hub::store::{StoreError, now_ms};

/// Memory to allow per session when sizing a machine's session cap: a browser or an emulator.
const MEM_PER_SESSION: i64 = 2 << 30;
/// The most sessions a machine is sized to on its own.
const AUTO_MAX: i64 = 16;
/// A machine's session cap until its node reports its figures.
const UNMEASURED: i64 = 2;
/// A start the hub placed counts against its machine's slots this long, until the session reports itself.
pub const START_MS: i64 = 120_000;

/// A machine's roles and session cap as a person set them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Roles {
    pub agents: bool,
    pub sessions: bool,
    /// None: auto.
    pub max_sessions: Option<i64>,
}

impl Default for Roles {
    fn default() -> Self {
        Self {
            agents: true,
            sessions: true,
            max_sessions: None,
        }
    }
}

impl Roles {
    pub fn list(&self) -> Vec<MachineRole> {
        let mut out = Vec::new();
        if self.agents {
            out.push(MachineRole::Agents);
        }
        if self.sessions {
            out.push(MachineRole::Sessions);
        }
        out
    }
}

pub fn roles_on(c: &Connection, m: &MachineId) -> Result<Roles, StoreError> {
    let row = c
        .query_row(
            "SELECT agents, sessions, max_sessions FROM machine_roles WHERE machine_id = ?1",
            [m.as_str()],
            |r| {
                Ok(Roles {
                    agents: r.get::<_, i64>(0)? != 0,
                    sessions: r.get::<_, i64>(1)? != 0,
                    max_sessions: r.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or_default())
}

pub fn set_roles(c: &Connection, m: &MachineId, roles: &Roles) -> Result<(), StoreError> {
    c.execute(
        "INSERT INTO machine_roles (machine_id, agents, sessions, max_sessions) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (machine_id) DO UPDATE SET agents = excluded.agents, sessions = excluded.sessions,
           max_sessions = excluded.max_sessions",
        params![
            m.as_str(),
            i64::from(roles.agents),
            i64::from(roles.sessions),
            roles.max_sessions
        ],
    )?;
    Ok(())
}

/// Whether the hub places sessions on other machines than their agents': on unless set off. The agent's node seals
/// the session's secrets and relay key to the runner first (calls.rs), so the runner scrubs its recording as for a
/// session of its own, and the relay (relay.rs) carries only what the two nodes encrypted.
pub fn remote_on(c: &Connection) -> Result<bool, StoreError> {
    let v: Option<i64> = c
        .query_row(
            "SELECT value FROM machine_roles_settings WHERE key = 'remote'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v != Some(0))
}

pub fn set_remote(c: &Connection, on: bool) -> Result<(), StoreError> {
    c.execute(
        "INSERT INTO machine_roles_settings (key, value) VALUES ('remote', ?1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [i64::from(on)],
    )?;
    Ok(())
}

/// What a machine fits in sessions at once, and why: one per two CPUs and about 2 GB of memory each, and never fewer
/// than its agents can open, one each, as they could before session caps (`agents`: its agent slots and leads).
pub fn auto_sessions(load: Option<&NodeLoad>, agents: i64) -> (i64, String) {
    let (fits, why) = match load {
        None => (UNMEASURED, "auto: not measured yet".to_owned()),
        Some(load) => {
            let cpus = load.cpus.get();
            let by_cpu = (cpus / 2).max(1);
            let by_mem = load
                .mem_total_bytes
                .map(|b| (b.get() / MEM_PER_SESSION).max(1));
            let fits = by_mem.map_or(by_cpu, |m| m.min(by_cpu)).min(AUTO_MAX);
            let why = match load.mem_total_bytes {
                Some(b) => format!("auto: {cpus} CPUs, {} GB", b.get() >> 30),
                None => format!("auto: {cpus} CPUs"),
            };
            (fits, why)
        }
    };
    if agents > fits {
        return (
            agents,
            format!("auto: one for each agent and lead it runs ({agents})"),
        );
    }
    (fits, why)
}

/// Whether the task `column` names (`T<n>`, or NULL for a lead's) has ended: done, failed or cancelled.
pub fn task_ended(column: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM tasks t WHERE t.n = CAST(substr({column}, 2) AS INTEGER)
           AND t.state IN ('done', 'failed', 'cancelled'))"
    )
}

/// The sessions live on `runner` now: its own agents' that run there, those it hosts for agents on other machines, and
/// the starts placed on it that have not reported yet. A session whose task ended counts for nothing, whatever its
/// row says: the hub ends it (`browser::end_outlived`), and one its node never reported ended can't fill a machine's
/// slots or hold up an update.
pub fn live_on(c: &Connection, runner: &MachineId, now: i64) -> Result<i64, StoreError> {
    let since = now - START_MS;
    // A hosted session reports itself under its agent's machine, before the hub knows its id from the runner's answer
    // too: it counts on the runner alone.
    let own: i64 = c.query_row(
        &format!(
            "SELECT COUNT(*) FROM browser_sessions b WHERE b.machine_id = ?1 AND b.state = 'live'
           AND NOT {}
           AND NOT EXISTS (SELECT 1 FROM session_places p WHERE p.hosted = 1
             AND (p.session_id = b.session_id
               OR (p.session_id IS NULL AND p.ended_ms IS NULL AND p.origin_machine = b.machine_id
                 AND p.origin_thread = json_extract(b.data, '$.threadId'))))",
            task_ended("json_extract(b.data, '$.taskId')")
        ),
        [runner.as_str()],
        |r| r.get(0),
    )?;
    let hosted: i64 = c.query_row(
        &format!(
            "SELECT COUNT(*) FROM session_places p WHERE p.runner_id = ?1 AND p.hosted = 1 AND p.ended_ms IS NULL
           AND NOT {}
           AND ((p.session_id IS NULL AND p.started_ms > ?2)
             OR (p.session_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM browser_sessions b WHERE b.session_id = p.session_id AND b.state != 'live')))",
            task_ended("p.task_id")
        ),
        params![runner.as_str(), since],
        |r| r.get(0),
    )?;
    // A start placed on its agent's own machine counts until that agent's session reports itself, live or past it.
    let starting: i64 = c.query_row(
        "SELECT COUNT(*) FROM session_places p WHERE p.runner_id = ?1 AND p.hosted = 0 AND p.started_ms > ?2
           AND NOT EXISTS (SELECT 1 FROM browser_sessions b WHERE b.machine_id = p.origin_machine
             AND b.started_ms >= p.started_ms - 5000 AND json_extract(b.data, '$.threadId') = p.origin_thread)",
        params![runner.as_str(), since],
        |r| r.get(0),
    )?;
    Ok(own + hosted + starting)
}

/// A machine as placement sees it.
#[derive(Clone, Debug)]
pub struct Runner {
    pub machine_id: MachineId,
    pub name: String,
    pub online: bool,
    pub sessions: bool,
    /// What its node reported; None: nothing yet (an older node, or no heartbeat since it linked).
    pub hosts: Option<HostChecks>,
    /// Its node hosts sessions for agents on other machines.
    pub hosts_others: bool,
    /// Why it doesn't, when it doesn't.
    pub others_note: Option<String>,
    pub live: i64,
    pub max: i64,
    /// People waiting for a slot here (screens.rs): the next ones free are theirs, before any agent's.
    pub held: i64,
}

impl Runner {
    fn ready(&self, host: SessionHost) -> Option<bool> {
        self.hosts
            .as_ref()
            .map(|hosts| hosts.iter().any(|h| h.host == host && h.ready))
    }

    /// It could host this kind for `origin`'s agents, slots aside.
    fn able(&self, host: SessionHost, origin: &MachineId) -> bool {
        if !self.sessions {
            return false;
        }
        if &self.machine_id == origin {
            // A node that reports nothing hosts a browser as it always did.
            return self.ready(host).unwrap_or(host == SessionHost::Browser);
        }
        self.hosts_others && self.ready(host) == Some(true)
    }

    /// Slots an agent's start may take: those no person waits for.
    fn free(&self) -> i64 {
        self.max - self.live - self.held
    }

    /// Slots a person's own screen may take.
    fn open(&self) -> i64 {
        self.max - self.live
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        one.to_owned()
    } else {
        many.to_owned()
    }
}

/// Where a session of `host` for an agent on `origin` runs: its own machine when it can, else (with `remote`) the
/// online machine that can with the most free slots (then by name), else a refusal that says why in plain words.
pub fn place(
    origin: &MachineId,
    host: SessionHost,
    runners: &[Runner],
    remote: bool,
) -> Result<MachineId, McpToolError> {
    let noun = host.noun();
    let own = runners.iter().find(|r| &r.machine_id == origin);
    if let Some(own) = own
        && own.able(host, origin)
        && own.free() > 0
    {
        return Ok(own.machine_id.clone());
    }
    if !remote {
        return Err(here_only(origin, host, own));
    }
    let able: Vec<&Runner> = runners
        .iter()
        .filter(|r| &r.machine_id != origin && r.able(host, origin))
        .collect();
    let online: Vec<&Runner> = able.iter().copied().filter(|r| r.online).collect();
    if let Some(best) = online
        .iter()
        .filter(|r| r.free() > 0)
        .max_by(|a, b| a.free().cmp(&b.free()).then(b.name.cmp(&a.name)))
    {
        return Ok(best.machine_id.clone());
    }
    let own_full = runners
        .iter()
        .find(|r| &r.machine_id == origin)
        .filter(|r| r.able(host, origin));
    let full: Vec<&Runner> = own_full.into_iter().chain(online.iter().copied()).collect();
    if !full.is_empty() {
        let each: Vec<String> = full
            .iter()
            .map(|r| match r.held {
                0 => format!("{} {} of {}", r.name, r.live, r.max),
                n => format!(
                    "{} {} of {}, {n} {} waiting for a slot",
                    r.name,
                    r.live,
                    r.max,
                    plural(n as usize, "person", "people")
                ),
            })
            .collect();
        return Err(McpToolError::new(
            ErrorCode::Failed,
            format!(
                "Every machine that can host {noun} session is full: {}.",
                each.join(", ")
            ),
        )
        .with_fix(
            "end a session you no longer need, or try again later; a hub admin can raise a machine's session cap in \
             Settings › Hub › Machines",
        ));
    }
    if !able.is_empty() {
        let names: Vec<&str> = able.iter().map(|r| r.name.as_str()).collect();
        return Err(McpToolError::new(
            ErrorCode::Failed,
            format!(
                "No machine online can host {noun} session: {} can, but {} offline.",
                names.join(", "),
                plural(names.len(), "is", "are")
            ),
        )
        .with_fix(
            "do without it and say so in your result, or try again once the machine is back",
        ));
    }
    Err(McpToolError::new(
        ErrorCode::Failed,
        format!(
            "No machine can host {noun} session: none has the sessions role and {noun} ready."
        ),
    )
    .with_fix(
        "do without it and say so in your result: a hub admin can turn sessions on for a machine that can host it \
         in Settings › Hub › Machines (fleetd machine set <id> --roles agents,sessions)",
    ))
}

/// Why the agent's own machine can't take the session, while sessions run only there.
fn here_only(origin: &MachineId, host: SessionHost, own: Option<&Runner>) -> McpToolError {
    let noun = host.noun();
    let name = own.map_or(origin.as_str(), |r| r.name.as_str());
    let settings =
        format!("Settings › Hub › Machines (fleetd machine set {origin} --roles agents,sessions)");
    match own {
        Some(r) if !r.sessions => McpToolError::new(
            ErrorCode::Failed,
            format!("{name} hosts no sessions: its role is agents only, and a session runs on its agent's own machine."),
        )
        .with_fix(format!(
            "do without it and say so in your result: a hub admin can turn sessions on for {name} in {settings}"
        )),
        Some(r) if r.able(host, origin) => McpToolError::new(
            ErrorCode::Failed,
            match r.held {
                0 => format!("{name}'s session slots are full: {} of {}.", r.live, r.max),
                n => format!(
                    "{name}'s session slots are full: {} of {}, and {n} {} waiting for the next.",
                    r.live,
                    r.max,
                    plural(n as usize, "person is", "people are")
                ),
            },
        )
        .with_fix(format!(
            "end a session you no longer need, or try again later; a hub admin can raise {name}'s session cap in \
             Settings › Hub › Machines"
        )),
        _ => {
            let why = own
                .and_then(|r| r.hosts.as_ref())
                .and_then(|hosts| hosts.iter().find(|h| h.host == host))
                .map_or_else(|| "it hasn't said what it can host".to_owned(), |h| h.detail.to_string());
            McpToolError::new(
                ErrorCode::Failed,
                format!("{name} can't host {noun} session: {why}."),
            )
            .with_fix("do without it and say so in your result: a person can set it up on this machine")
        }
    }
}

/// Every machine as placement and Hub › Machines' roles see it.
pub fn runners(hub: &Hub) -> Result<Vec<(Runner, Roles, String)>, StoreError> {
    let machines = hub.store.machines_list()?;
    let now = now_ms(hub.clock.as_ref());
    // Each agent slot and each project's lead could open a session before session caps. Read before the database's
    // own turn below, which these reads would wait on.
    let mut agents = Vec::with_capacity(machines.len());
    for m in &machines {
        let leads = hub.store.projects_shown(Some(&m.machine_id), None)?.len() as i64;
        agents.push(hub.slots.machine_cap(&m.machine_id) + leads);
    }
    hub.db.with(|c| {
        let mut out = Vec::new();
        for (m, agents) in machines.into_iter().zip(agents) {
            let roles = roles_on(c, &m.machine_id)?;
            let load = hub.link.load(&m.machine_id);
            let agents = if roles.agents { agents } else { 0 };
            let (auto, auto_why) = auto_sessions(load.as_ref(), agents);
            let others_note = if m.box_pub_key.is_none() {
                Some("It gave the hub no key to seal a screen's secrets to: it hosts only its own agents' screens until its node links again.".to_owned())
            } else if !(hub.link.node_can(&m.machine_id, CAP_SESSION_HOST)
                && hub.link.node_can(&m.machine_id, CAP_SESSION_SEAL))
            {
                Some(if m.status == MachineStatus::Offline {
                    "Offline: it hosts other machines' agents' screens once it is back.".to_owned()
                } else {
                    "Its fleetd is older: it hosts only its own agents' screens until it is updated.".to_owned()
                })
            } else {
                None
            };
            let (max, why) = match roles.max_sessions {
                Some(n) => (n, "set".to_owned()),
                None => (auto, auto_why),
            };
            out.push((
                Runner {
                    online: m.status != MachineStatus::Offline,
                    sessions: roles.sessions,
                    hosts: load.and_then(|l| l.hosts),
                    // It opens what an agent's node seals to it, with the key it gave the hub.
                    hosts_others: others_note.is_none(),
                    others_note,
                    live: live_on(c, &m.machine_id, now)?,
                    max,
                    held: screens::held_on(c, &m.machine_id, now)?,
                    name: m.name,
                    machine_id: m.machine_id,
                },
                roles,
                why,
            ));
        }
        Ok(out)
    })
}

pub fn entry(runner: Runner, roles: Roles, why: String) -> MachineRolesEntry {
    MachineRolesEntry {
        machine_id: runner.machine_id,
        name: runner.name,
        online: runner.online,
        roles: List::unchecked(roles.list()),
        max_sessions: Count::unchecked(runner.max.max(0)),
        max_sessions_set: roles.max_sessions.map(Int::unchecked),
        max_sessions_why: Line::unchecked(why),
        sessions_live: Count::unchecked(runner.live.max(0)),
        hosts: runner.hosts.unwrap_or_else(|| List::unchecked(Vec::new())),
        hosts_others: runner.hosts_others,
        hosts_others_note: runner
            .others_note
            .filter(|_| roles.sessions)
            .map(Line::unchecked),
        navi_sandbox: None,
        operates: None,
    }
}

/// A session the hub placed: on its agent's machine (`hosted` false), or hosted elsewhere under `key`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    pub key: HostKey,
    pub runner: MachineId,
    pub origin: ProjectRef,
    pub origin_thread: ThreadId,
    pub task_id: Option<TaskId>,
    pub hosted: bool,
    pub session_id: Option<String>,
}

pub fn new_key() -> HostKey {
    let bytes: [u8; 16] = rand::random();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    HostKey::unchecked(format!("H{hex}"))
}

pub fn insert_place(c: &Connection, p: &Place, now: i64) -> Result<(), StoreError> {
    c.execute(
        "INSERT INTO session_places (place_id, runner_id, origin_machine, origin_thread, project_id, task_id, hosted,
           session_id, started_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            p.key.as_str(),
            p.runner.as_str(),
            p.origin.machine_id.as_str(),
            p.origin_thread.as_str(),
            p.origin.project_id.as_str(),
            p.task_id.as_ref().map(|t| t.as_str()),
            i64::from(p.hosted),
            p.session_id,
            now
        ],
    )?;
    Ok(())
}

fn place_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<Place> {
    Ok(Place {
        key: HostKey::unchecked(r.get::<_, String>(0)?),
        runner: MachineId::unchecked(r.get::<_, String>(1)?),
        origin: ProjectRef {
            machine_id: MachineId::unchecked(r.get::<_, String>(2)?),
            project_id: ProjectId::unchecked(r.get::<_, String>(4)?),
        },
        origin_thread: ThreadId::unchecked(r.get::<_, String>(3)?),
        task_id: r.get::<_, Option<String>>(5)?.map(TaskId::unchecked),
        hosted: r.get::<_, i64>(6)? != 0,
        session_id: r.get(7)?,
    })
}

const PLACE_COLUMNS: &str =
    "place_id, runner_id, origin_machine, origin_thread, project_id, task_id, hosted, session_id";

/// The open session an agent's session hosts on another machine, if any: not ended through the hub, not reported over
/// by its runner (an idle session it ended), and not a start that never finished.
pub fn open_hosted(
    c: &Connection,
    origin: &MachineId,
    thread: &ThreadId,
    now: i64,
) -> Result<Option<Place>, StoreError> {
    Ok(c.query_row(
        &format!(
            "SELECT {PLACE_COLUMNS} FROM session_places p WHERE origin_machine = ?1 AND origin_thread = ?2
               AND hosted = 1 AND ended_ms IS NULL
               AND (session_id IS NOT NULL OR started_ms > ?3)
               AND NOT EXISTS (SELECT 1 FROM browser_sessions b WHERE b.session_id = p.session_id AND b.state != 'live')
             ORDER BY started_ms DESC LIMIT 1"
        ),
        params![origin.as_str(), thread.as_str(), now - START_MS],
        place_of,
    )
    .optional()?)
}

/// A hosted session by its key.
pub fn hosted(c: &Connection, key: &str) -> Result<Option<Place>, StoreError> {
    Ok(c.query_row(
        &format!("SELECT {PLACE_COLUMNS} FROM session_places WHERE place_id = ?1 AND hosted = 1"),
        [key],
        place_of,
    )
    .optional()?)
}

/// The machine that hosts session `session_id` for an agent on another one; None for a session on its agent's own
/// machine. Its row says the agent's machine, so live view and takeover ask this first.
pub fn runner_of(c: &Connection, session_id: &str) -> Result<Option<MachineId>, StoreError> {
    Ok(c.query_row(
        "SELECT runner_id FROM session_places WHERE session_id = ?1 AND hosted = 1
           ORDER BY started_ms DESC LIMIT 1",
        [session_id],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(MachineId::unchecked))
}

/// A hosted start that answered: its session, and the SHA-256 of its relay token.
pub fn set_session(
    c: &Connection,
    key: &HostKey,
    session_id: &str,
    relay_hash: &str,
) -> Result<(), StoreError> {
    c.execute(
        "UPDATE session_places SET session_id = ?2, relay_hash = ?3 WHERE place_id = ?1",
        params![key.as_str(), session_id, relay_hash],
    )?;
    Ok(())
}

/// The open hosted session whose relay token hashes to `relay_hash`.
pub fn place_by_relay(c: &Connection, relay_hash: &str) -> Result<Option<Place>, StoreError> {
    Ok(c.query_row(
        &format!(
            "SELECT {PLACE_COLUMNS} FROM session_places p WHERE relay_hash = ?1 AND hosted = 1 AND ended_ms IS NULL
               AND session_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM browser_sessions b WHERE b.session_id = p.session_id AND b.state != 'live')"
        ),
        [relay_hash],
        place_of,
    )
    .optional()?)
}

pub fn end_place(c: &Connection, key: &HostKey, now: i64) -> Result<(), StoreError> {
    c.execute(
        "UPDATE session_places SET ended_ms = ?2 WHERE place_id = ?1 AND ended_ms IS NULL",
        params![key.as_str(), now],
    )?;
    Ok(())
}

pub fn drop_place(c: &Connection, key: &HostKey) -> Result<(), StoreError> {
    c.execute(
        "DELETE FROM session_places WHERE place_id = ?1",
        [key.as_str()],
    )?;
    Ok(())
}

/// How long a hosted session's place outlives its end: its runner may still be uploading its recording, in the
/// agent's name.
const KEEP_HOSTED_MS: i64 = 7 * 86_400_000;

/// Drops places nobody needs: starts on the agent's own machine once they stopped counting, starts that never
/// answered, and hosted sessions a week after they ended or their recording landed. Returns how many.
pub fn prune(c: &Connection, now: i64) -> Result<usize, StoreError> {
    let starts = now - START_MS;
    let week = now - KEEP_HOSTED_MS;
    Ok(c.execute(
        "DELETE FROM session_places WHERE
           (hosted = 0 AND started_ms <= ?1)
           OR (hosted = 1 AND session_id IS NULL AND started_ms <= ?1)
           OR (hosted = 1 AND ended_ms IS NOT NULL AND ended_ms <= ?2)
           OR (hosted = 1 AND started_ms <= ?2 AND EXISTS (SELECT 1 FROM browser_sessions b
                 WHERE b.session_id = session_places.session_id AND b.state IN ('recorded', 'lost', 'expired')))",
        params![starts, week],
    )?)
}

/// The hourly prune, until the hub stops.
pub async fn run_prune(hub: Arc<Hub>) {
    loop {
        let now = now_ms(hub.clock.as_ref());
        if let Err(e) = hub.db.transaction(|c| prune(c, now)) {
            tracing::warn!(error = %e, "session places not pruned");
        }
        hub.clock.sleep(std::time::Duration::from_secs(3600)).await;
    }
}

/// The runner's calls for a session it hosts, in the name of the agent it hosts it for.
struct Callers(Weak<Hub>);

impl HostedCallers for Callers {
    fn caller_of(&self, runner: &MachineId, thread: &ThreadId) -> Option<HostedCaller> {
        let hub = self.0.upgrade()?;
        if !thread.as_str().starts_with('H') {
            return None;
        }
        let place = hub.db.with(|c| hosted(c, thread.as_str())).ok().flatten()?;
        (&place.runner == runner).then(|| HostedCaller {
            agent: place.task_id.map_or(CallerAgent::Lead, CallerAgent::Task),
            project_ref: place.origin,
            thread_id: place.origin_thread,
        })
    }
}

pub fn wire(hub: &Arc<Hub>) {
    hub.lead_calls
        .set_hosts(Arc::new(Callers(Arc::downgrade(hub))));
    calls::register_lead_calls(hub);
}
