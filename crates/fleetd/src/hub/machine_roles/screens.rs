//! People's own screens (D239): `screen_open` and `screen_end`, and the line of people waiting for a full machine.
//!
//! A person's screen is a session the hub places itself, on the machine they picked, and hosted there as an agent's
//! screen on another machine is (calls.rs): the hub seals the start to the runner's box key (no secrets to scrub, a
//! relay key nobody dials), the runner reports it in the project's name under a thread of its own, and the hub hands
//! control to the person as soon as it is live. It is recorded as any screen is, and ends with `screen_end`, or after
//! [`IDLE_MS`] without the person's input.
//!
//! A Navi's browser runs on the Navi's own machine, on the profile it keeps (D221): the hub's own `session_host` frame
//! names the Navi (never the seal, which anyone can make), and the runner's node opens that profile for it. Only the Navi's owner reaches it (navi/owner.rs guards every tool).
//!
//! With a PR, an iOS or Android screen gets the PR's CI build first (builds.rs): the hub reads it, starts the screen,
//! sends the file to the screen's machine and runs `agent-device install` there, as an agent's node does for its screen
//! elsewhere (node/device/remote.rs): sealed with the relay key the hub sealed into the start, so only that machine
//! opens them. Only then is the screen the person's. A PR with no build is refused before anything starts; a build that
//! doesn't install ends the screen.
//!
//! People's screens take slots as any screen does. A full machine refuses, or takes the request in line
//! (`screen_waits`): each slot that frees there goes to the oldest person waiting, and agents' starts see the slots
//! people wait for as taken ([`super::Runner::held`]). An agent's running screen is never ended to make room.
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::Role;
use fleetd_contracts::browser::{
    BrowserCall, BrowserCallFrame, BrowserCallResult, BrowserControl, BrowserControlTo,
    BrowserSession, BrowserSessionId, BrowserSessionState, DeviceCall, DeviceDone,
    SCREEN_WAIT_MINUTES, ScreenPr, ScreenWait, SessionKind,
};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId};
use fleetd_contracts::machine_roles::SessionHost;
use fleetd_contracts::mcp::{
    ErrorCode, ScreenEndInput, ScreenEndOutput, ScreenOpenInput, ScreenOpenOutput,
};
use fleetd_contracts::people::{PersonId, PersonRef};
use fleetd_contracts::prim::{Count, NonEmpty};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use super::builds::{Build, Found};
use super::calls::{CALL_WAIT, DEVICE_WAIT, START_WAIT};
use super::{Place, Runner, end_place, insert_place, new_key, runners};
use crate::hub::api::{Caller, Hub, Registry, ToolError, is_human, require};
use crate::hub::store::{StoreError, iso_ms, now_ms};
use crate::node::device::remote as device;

/// A person's screen with no input from them this long ends, as an agent's does without its commands.
pub const IDLE_MS: i64 = 30 * 60_000;
/// How long a person's wait for a slot lasts.
const WAIT_MS: i64 = SCREEN_WAIT_MINUTES * 60_000;
/// How long a simulator's XCTest runner may take to start before a PR's build installs. With the start (`START_WAIT`)
/// and the download (`gh`'s 30 s) it stays inside the 5 minutes the desktop app waits for `screen_open`.
const INSTALL_WAIT: Duration = Duration::from_secs(150);
/// Between tries while the screen's machine holds a command back.
const INSTALL_RETRY: Duration = Duration::from_secs(3);

pub fn register(tools: &mut Registry) {
    tools.add("screen_open", screen_open);
    tools.add("screen_end", screen_end);
}

fn host_of(kind: SessionKind) -> SessionHost {
    match kind {
        SessionKind::Android => SessionHost::Android,
        SessionKind::Ios => SessionHost::Ios,
        SessionKind::LinuxDesktop => SessionHost::Desktop,
        SessionKind::Browser => SessionHost::Browser,
    }
}

fn kind_of(text: &str) -> SessionKind {
    serde_json::from_value(json!(text)).unwrap_or_default()
}

/// What a person's screen is called in the list, in their name, with the PR whose build it has.
fn purpose(kind: SessionKind, person: &PersonRef, pr: Option<&ScreenPr>) -> String {
    let what = match kind {
        SessionKind::Browser => "Browser",
        SessionKind::Android => "Android emulator",
        SessionKind::Ios => "iOS simulator",
        SessionKind::LinuxDesktop => "Linux desktop",
    };
    match pr {
        Some(pr) => format!("{what} opened by {}, with PR #{}", person.name, pr.number),
        None => format!("{what} opened by {}", person.name),
    }
}

/// The person `caller` is, as records name them. A key with no person acts as the hub's owner (navi/owner.rs), made
/// on a hub that has no people yet.
fn person_of(hub: &Hub, caller: &Caller) -> Result<PersonRef, ToolError> {
    if let Some(person) = &caller.person {
        return Ok(person.clone());
    }
    let now = now_ms(hub.clock.as_ref());
    let owner = hub
        .db
        .transaction(|c| crate::hub::people::ensure_owner_on(c, &caller.name, now))?;
    Ok(owner.as_ref())
}

/// The person who opened the session reporting under `thread` (its project's `machine`) themselves; None for an
/// agent's session.
pub fn opener(
    db: &crate::hub::store::HubDb,
    machine: &MachineId,
    thread: &ThreadId,
) -> Result<Option<PersonRef>, StoreError> {
    db.with(|c| {
        let person: Option<String> = c
            .query_row(
                "SELECT person_id FROM session_places WHERE origin_machine = ?1 AND origin_thread = ?2
                   AND person_id IS NOT NULL LIMIT 1",
                params![machine.as_str(), thread.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        let Some(person) = person else {
            return Ok(None);
        };
        let found = crate::hub::people::get_on(c, &person)?;
        Ok(Some(match found {
            Some(p) => p.as_ref(),
            None => PersonRef {
                person_id: PersonId::unchecked(&person),
                name: fleetd_contracts::people::PersonName::unchecked("A person"),
            },
        }))
    })
}

/// People waiting for a slot on `runner` now.
pub fn held_on(c: &Connection, runner: &MachineId, now: i64) -> Result<i64, StoreError> {
    Ok(c.query_row(
        "SELECT COUNT(*) FROM screen_waits WHERE runner_id = ?1 AND since_ms > ?2",
        params![runner.as_str(), now - WAIT_MS],
        |r| r.get(0),
    )?)
}

/// One row of `screen_waits`.
struct Wait {
    id: String,
    person: String,
    device: String,
    project: ProjectRef,
    runner: MachineId,
    kind: SessionKind,
    since_ms: i64,
    pr: Option<ScreenPr>,
}

const WAIT_COLUMNS: &str = "wait_id, person_id, device, machine_id, project_id, runner_id, kind, since_ms, pr_repo, pr_number";

fn wait_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<Wait> {
    Ok(Wait {
        id: r.get(0)?,
        person: r.get(1)?,
        device: r.get(2)?,
        project: ProjectRef {
            machine_id: MachineId::unchecked(r.get::<_, String>(3)?),
            project_id: ProjectId::unchecked(r.get::<_, String>(4)?),
        },
        runner: MachineId::unchecked(r.get::<_, String>(5)?),
        kind: kind_of(&r.get::<_, String>(6)?),
        since_ms: r.get(7)?,
        pr: match (r.get::<_, Option<String>>(8)?, r.get::<_, Option<i64>>(9)?) {
            (Some(repo), Some(number)) => {
                serde_json::from_value(json!({ "repo": repo, "number": number })).ok()
            }
            _ => None,
        },
    })
}

/// Every wait still in time, oldest first.
fn waits_on(c: &Connection, now: i64) -> Result<Vec<Wait>, StoreError> {
    let mut stmt = c.prepare(&format!(
        "SELECT {WAIT_COLUMNS} FROM screen_waits WHERE since_ms > ?1 ORDER BY since_ms, wait_id"
    ))?;
    let rows = stmt.query_map([now - WAIT_MS], wait_of)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn as_wait(w: &Wait, all: &[Wait]) -> ScreenWait {
    let ahead = all
        .iter()
        .take_while(|o| o.id != w.id)
        .filter(|o| o.runner == w.runner)
        .count();
    ScreenWait {
        wait_id: NonEmpty::unchecked(&w.id),
        project_ref: w.project.clone(),
        kind: w.kind,
        machine_id: w.runner.clone(),
        since: iso_ms(w.since_ms).into(),
        ahead: Count::unchecked(ahead as i64),
        pr: w.pr.clone(),
    }
}

/// The caller's own waits for a screen of project `r`, oldest first.
pub fn waits_of(hub: &Hub, caller: &Caller, r: &ProjectRef) -> Result<Vec<ScreenWait>, ToolError> {
    if !is_human(caller) {
        return Ok(Vec::new());
    }
    let me = person_of(hub, caller)?;
    let now = now_ms(hub.clock.as_ref());
    let all = hub.db.with(|c| waits_on(c, now))?;
    Ok(all
        .iter()
        .filter(|w| w.person == me.person_id.as_str() && &w.project == r)
        .map(|w| as_wait(w, &all))
        .collect())
}

/// Whether `r` is a Navi.
fn is_navi(hub: &Hub, r: &ProjectRef) -> Result<bool, StoreError> {
    hub.db
        .with(|c| Ok(crate::hub::navi::store::of(c, r)?.is_some()))
}

/// Why `runner` can't host a person's screen of `kind` at all, slots aside; None when it can.
fn unable(runner: &Runner, host: SessionHost) -> Option<String> {
    let name = &runner.name;
    if !runner.sessions {
        return Some(format!("{name} hosts no screens: its role is agents only."));
    }
    if !runner.online {
        return Some(format!("{name} is offline."));
    }
    if let Some(note) = &runner.others_note {
        return Some(format!("{name} can't host it yet. {note}"));
    }
    match runner.ready(host) {
        Some(true) => None,
        _ => {
            let why = runner
                .hosts
                .as_ref()
                .and_then(|hosts| hosts.iter().find(|h| h.host == host))
                .map_or_else(
                    || "it hasn't said what it can host".to_owned(),
                    |h| h.detail.to_string(),
                );
            Some(format!("{name} can't host {} screen: {why}.", host.noun()))
        }
    }
}

async fn screen_open(
    hub: Arc<Hub>,
    caller: Caller,
    input: ScreenOpenInput,
) -> Result<ScreenOpenOutput, ToolError> {
    let r = input.project_ref;
    if !is_human(&caller) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person's device opens a screen of its own; an agent opens one with session_start.",
        )
        .with_fix("Use the desktop app."));
    }
    // Whoever may use the project opens a screen for it; another person's Navi was refused before this (owner.rs).
    require(&caller, Role::Operate, Some(&r.machine_id))?;
    if hub.store.project_get(&r)?.is_none() {
        return Err(crate::hub::api::unknown_project(&r));
    }
    let runner_id = input.machine_id;
    require(&caller, Role::Read, Some(&runner_id))?;
    let navi = is_navi(&hub, &r)?;
    if navi && input.kind == SessionKind::Browser && runner_id != r.machine_id {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "A Navi's browser runs on its own machine, {}, where it keeps its sign-ins.",
                r.machine_id
            ),
        )
        .with_fix(format!("Open it on {}.", r.machine_id)));
    }
    let host = host_of(input.kind);
    let all = runners(&hub)?;
    let Some((runner, _, _)) = all.into_iter().find(|(m, _, _)| m.machine_id == runner_id) else {
        return Err(crate::hub::api::unknown_machine(&runner_id));
    };
    if let Some(why) = unable(&runner, host) {
        return Err(ToolError::new(ErrorCode::Failed, why)
            .with_fix("Pick a machine that can host it: machine_roles lists what each can."));
    }
    // A PR's build is there before anything starts or waits: a PR without one is refused now, plainly.
    let found = match &input.pr {
        Some(pr) => Some(find_build(&hub, &r, input.kind, pr).await?),
        None => None,
    };
    let person = person_of(&hub, &caller)?;
    let opener = Opener {
        person,
        device: caller.name.clone(),
    };
    let now = now_ms(hub.clock.as_ref());
    // A slot is free and nobody waits before this person: theirs now.
    let first = runner.held == 0 && runner.open() > 0;
    if first {
        let build = match (&input.pr, &found) {
            (Some(pr), Some(found)) => Some(fetch_build(&hub, input.kind, pr, found).await?),
            _ => None,
        };
        let sealed = sealed_for(&hub, &runner_id)?;
        let pr = input.pr.as_ref();
        let start = hub.db.transaction(|c| {
            prepare(
                c,
                &opener,
                &r,
                input.kind,
                &runner_id,
                sealed.clone(),
                navi,
                pr,
                now,
            )
        })?;
        let session = launch(&hub, start, build).await?;
        let installed = match &input.pr {
            Some(pr) => format!("PR #{}'s build is installed. ", pr.number),
            None => String::new(),
        };
        return Ok(ScreenOpenOutput {
            next: Some(format!(
                "{installed}You have control: send browser_input. End it with screen_end when you're done."
            )),
            session,
            waiting: None,
            truncated: None,
        });
    }
    let full = format!(
        "{} is full: {} of {} screens{}.",
        runner.name,
        runner.live,
        runner.max,
        match runner.held {
            0 => String::new(),
            n => format!(", {n} waiting"),
        }
    );
    if !input.wait {
        return Err(ToolError::new(ErrorCode::Failed, full).with_fix(
            "Call screen_open again with wait true to take its next free slot (ahead of agents), or pick another machine.",
        ));
    }
    let id = format!("W{}", &new_key().as_str()[1..]);
    hub.db.transaction(|c| {
        c.execute(
            "INSERT INTO screen_waits (wait_id, person_id, device, machine_id, project_id, runner_id, kind, since_ms,
               pr_repo, pr_number)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                opener.person.person_id.as_str(),
                opener.device,
                r.machine_id.as_str(),
                r.project_id.as_str(),
                runner_id.as_str(),
                input.kind.as_str(),
                now,
                input.pr.as_ref().map(|p| p.repo.as_str()),
                input.pr.as_ref().map(|p| p.number.get()),
            ],
        )?;
        Ok(())
    })?;
    let all = hub.db.with(|c| waits_on(c, now))?;
    let waiting = all.iter().find(|w| w.id == id).map(|w| as_wait(w, &all));
    Ok(ScreenOpenOutput {
        session: None,
        waiting,
        next: Some(format!(
            "{full} Your screen opens in its next free slot, ahead of agents' screens; screen_end with waitId gives up."
        )),
        truncated: None,
    })
}

async fn screen_end(
    hub: Arc<Hub>,
    caller: Caller,
    input: ScreenEndInput,
) -> Result<ScreenEndOutput, ToolError> {
    if !is_human(&caller) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person's device ends a person's screen.",
        )
        .with_fix("Use the desktop app."));
    }
    let me = person_of(&hub, &caller)?;
    if let Some(wait) = &input.wait_id {
        let gone = hub.db.transaction(|c| {
            Ok(c.execute(
                "DELETE FROM screen_waits WHERE wait_id = ?1 AND person_id = ?2",
                params![wait.as_str(), me.person_id.as_str()],
            )?)
        })?;
        if gone == 0 {
            return Err(ToolError::new(
                ErrorCode::NotFound,
                format!("You have no wait {wait}: its screen may have opened already."),
            ));
        }
        return Ok(ScreenEndOutput {
            session: None,
            next: Some("Your wait is given up.".into()),
            truncated: None,
        });
    }
    let Some(id) = &input.session_id else {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            "screen_end needs a sessionId or a waitId.",
        ));
    };
    let not_found = || {
        ToolError::new(ErrorCode::NotFound, format!("No screen {id} of yours."))
            .with_fix("Call browser_sessions for the project's screens.")
    };
    let session = crate::hub::browser::get(&hub.db, id)?.ok_or_else(not_found)?;
    if require(
        &caller,
        Role::Operate,
        Some(&session.project_ref.machine_id),
    )
    .is_err()
    {
        return Err(not_found());
    }
    let mine = session
        .opened_by
        .as_ref()
        .is_some_and(|p| p.person_id == me.person_id);
    if !mine {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            format!("Screen {id} isn't one you opened: its agent ends it."),
        ));
    }
    if session.state != BrowserSessionState::Live {
        return Ok(ScreenEndOutput {
            session: Some(session),
            next: Some("It has ended already.".into()),
            truncated: None,
        });
    }
    end(&hub, &session).await?;
    Ok(ScreenEndOutput {
        session: crate::hub::browser::get(&hub.db, id)?,
        next: Some("It closes on its machine; its recording goes to the hub.".into()),
        truncated: None,
    })
}

/// The person a screen is for, and their device: its action log names their steps by it.
struct Opener {
    person: PersonRef,
    device: String,
}

/// A start the hub placed and holds a slot for, to send to its runner ([`launch`]).
struct Start {
    place: Place,
    kind: SessionKind,
    frame: BrowserCallFrame,
    sealed: Sealed,
    /// A Navi's browser: the Navi whose kept profile it runs on, said in the hub's frame.
    navi: Option<ProjectId>,
    by: String,
}

/// A person's start as sealed to its runner, and the relay key in it, which seals the hub's install steps (a PR's build).
#[derive(Clone)]
struct Sealed {
    sealed: NonEmpty,
    relay_key: zeroize::Zeroizing<[u8; 32]>,
}

/// What the hub seals to the runner for a person's screen, as an agent's node seals its own (node/session_route.rs
/// `Seal`): no secrets, and a relay key. A Navi's browser names its Navi in the hub's frame, never here.
fn seal(to: &str) -> Result<Sealed, String> {
    let relay_key = zeroize::Zeroizing::new(rand::random::<[u8; 32]>());
    let plain = json!({ "secrets": [], "relayKey": B64.encode(*relay_key) });
    let public: [u8; 32] = B64
        .decode(to)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("its key is not 32 bytes of base64")?;
    let sealed = crypto_box::PublicKey::from(public)
        .seal(&mut crypto_box::aead::OsRng, plain.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(Sealed {
        sealed: NonEmpty::unchecked(B64.encode(sealed)),
        relay_key,
    })
}

/// The seal for a person's screen on `runner`, to its box key. Read before any transaction: the store shares the
/// database's connection.
fn sealed_for(hub: &Hub, runner: &MachineId) -> Result<Sealed, ToolError> {
    let box_key = hub
        .store
        .machine_get(runner)?
        .and_then(|m| m.box_pub_key)
        .map(|k| k.to_string())
        .unwrap_or_default();
    seal(&box_key).map_err(|e| {
        ToolError::new(
            ErrorCode::Failed,
            format!("{runner} has no key to seal a screen to: {e}."),
        )
    })
}

/// Places a person's screen on `runner` and holds its slot: from here it counts there, as a start does.
#[allow(clippy::too_many_arguments)]
fn prepare(
    c: &Connection,
    opener: &Opener,
    r: &ProjectRef,
    kind: SessionKind,
    runner: &MachineId,
    sealed: Sealed,
    navi: bool,
    pr: Option<&ScreenPr>,
    now: i64,
) -> Result<Start, StoreError> {
    let key = new_key();
    let place = Place {
        origin_thread: ThreadId::unchecked(format!("screen-{}", &key.as_str()[1..])),
        key,
        runner: runner.clone(),
        origin: r.clone(),
        task_id: None,
        hosted: true,
        session_id: None,
    };
    insert_place(c, &place, now)?;
    c.execute(
        "UPDATE session_places SET person_id = ?2 WHERE place_id = ?1",
        params![place.key.as_str(), opener.person.person_id.as_str()],
    )?;
    let frame = serde_json::from_value(json!({
        "id": "open", "cwd": "/",
        "call": { "op": "session_start", "purpose": purpose(kind, &opener.person, pr), "kind": kind },
    }))
    .expect("a session_start frame");
    Ok(Start {
        place,
        kind,
        frame,
        sealed,
        navi: (navi && kind == SessionKind::Browser).then(|| r.project_id.clone()),
        by: format!("human:{}", opener.device),
    })
}

/// Starts a placed screen on its runner, installs the PR's build in it when there is one, and hands its control to the
/// person. A start that fails frees its slot; a build that doesn't install ends the screen.
async fn launch(
    hub: &Arc<Hub>,
    start: Start,
    build: Option<(ScreenPr, Build)>,
) -> Result<Option<BrowserSession>, ToolError> {
    let place = &start.place;
    let answer = hub
        .node_commands
        .host_navi_session(
            &place.runner,
            &place.key,
            &start.frame,
            Some(&start.sealed.sealed),
            start.navi.as_ref(),
            START_WAIT,
        )
        .await;
    let id = match &answer {
        Ok(frame) => match &frame.result {
            Some(BrowserCallResult::SessionStart(s)) => Some(s.session_id.clone()),
            _ => None,
        },
        Err(_) => None,
    };
    let Some(id) = id else {
        super::calls::cancel(hub, place).await;
        let why = match answer {
            Ok(frame) => frame
                .error
                .map_or_else(|| "it answered something else".to_owned(), |e| e.message),
            Err(e) => e.to_string(),
        };
        return Err(ToolError::new(
            ErrorCode::Failed,
            format!("The screen didn't start on {}: {why}", place.runner),
        )
        .with_fix("Try again, or pick another machine."));
    };
    hub.db.transaction(|c| {
        c.execute(
            "UPDATE session_places SET session_id = ?2 WHERE place_id = ?1",
            params![place.key.as_str(), id.as_str()],
        )?;
        Ok(())
    })?;
    tracing::info!(runner = %place.runner, session = %id, "a person's screen started");
    // The build goes in while the screen is still fleetd's: a person's control holds agent-device back.
    if let Some((pr, build)) = &build
        && let Err(why) = install(hub, &start, build).await
    {
        tracing::warn!(session = %id, pr = pr.number.get(), error = %why, "a PR's build didn't install");
        match crate::hub::browser::get(&hub.db, &id)? {
            Some(session) => {
                if let Err(e) = end(hub, &session).await {
                    tracing::warn!(session = %id, error = %e.message, "a screen whose build didn't install not ended");
                }
            }
            None => super::calls::cancel(hub, place).await,
        }
        return Err(ToolError::new(
            ErrorCode::Failed,
            format!(
                "PR #{}'s build didn't install, so the screen was closed: {why}",
                pr.number
            ),
        )
        .with_fix("Try again, or open the screen without a PR."));
    }
    // Theirs from the start: the runner reported it live before it answered, so the hub has it.
    if let Some(session) = crate::hub::browser::get(&hub.db, &id)?
        && let Err(e) = crate::hub::browser::tools::change_control(
            hub,
            &session,
            &place.runner,
            BrowserControlTo::Human,
            BrowserControl::Human,
            start.by.clone(),
        )
        .await
    {
        tracing::warn!(session = %id, error = %e.message, "a person's screen started without their control");
    }
    Ok(crate::hub::browser::get(&hub.db, &id)?)
}

/// Finds PR `pr`'s build for a `kind` screen of project `r`: a PR of one of the project's repos, with a CI build there.
async fn find_build(
    hub: &Hub,
    r: &ProjectRef,
    kind: SessionKind,
    pr: &ScreenPr,
) -> Result<Found, ToolError> {
    if !matches!(kind, SessionKind::Ios | SessionKind::Android) {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            "A PR's build goes into an iOS or Android screen.",
        )
        .with_fix("Pick iOS or Android, or leave the PR out."));
    }
    let repos = project_repos(hub, r);
    if !repos
        .iter()
        .any(|repo| repo.eq_ignore_ascii_case(pr.repo.as_str()))
    {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("{} isn't a repository of this project.", pr.repo),
        )
        .with_fix("Pick a PR from pr_list for this project."));
    }
    hub.builds
        .find(pr.repo.as_str(), pr.number.get(), kind)
        .await
        .map_err(|why| {
            ToolError::new(ErrorCode::Failed, why)
                .with_fix("Pick another PR, or open the screen without one.")
        })
}

/// Reads the build [`find_build`] found.
async fn fetch_build(
    hub: &Hub,
    kind: SessionKind,
    pr: &ScreenPr,
    found: &Found,
) -> Result<(ScreenPr, Build), ToolError> {
    let build = hub
        .builds
        .fetch(pr.repo.as_str(), pr.number.get(), kind, found)
        .await
        .map_err(|why| {
            ToolError::new(ErrorCode::Failed, why)
                .with_fix("Try again, or open the screen without a PR.")
        })?;
    Ok((pr.clone(), build))
}

/// The GitHub repositories (`owner/name`) of project `r`: its own and attached repos, and those whose PRs it lands.
fn project_repos(hub: &Hub, r: &ProjectRef) -> Vec<String> {
    let mut repos: Vec<String> = hub
        .repos
        .repos_of(r)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|repo| {
            Some(
                repo.repo_key?
                    .as_str()
                    .strip_prefix("github.com/")?
                    .to_owned(),
            )
        })
        .collect();
    let changes = crate::hub::prs::project_changes(hub, r);
    repos.extend(
        crate::hub::prs::project_repos(hub, r, &changes)
            .into_iter()
            .map(|repo| repo.as_str().to_owned()),
    );
    repos
}

/// The hub's own sealed device steps for a person's screen: each under the relay key it sealed into the start, counted
/// up from 1, as the agent's node counts its own (node/session_route.rs `device_step`).
struct Steps<'a> {
    hub: &'a Hub,
    place: &'a Place,
    key: &'a [u8; 32],
    count: u64,
}

impl Steps<'_> {
    async fn send(&mut self, call: DeviceCall, wait: Duration) -> Result<DeviceDone, String> {
        self.count += 1;
        let count = self.count;
        let frame = BrowserCallFrame {
            id: NonEmpty::unchecked(format!("install-{count}")),
            cwd: serde_json::from_value(json!("/")).expect("a path"),
            call: BrowserCall::Device(device::seal_call(self.key, count, &call)),
            thread_id: None,
        };
        let answer = self
            .hub
            .node_commands
            .host_session(&self.place.runner, &self.place.key, &frame, None, wait)
            .await
            .map_err(|e| e.to_string())?;
        match (answer.result, answer.error) {
            (Some(BrowserCallResult::Device(done)), _) => device::open_done(self.key, count, done)
                .ok_or_else(|| "its answer didn't open with the screen's key".to_owned()),
            (_, Some(e)) => Err(e.message),
            _ => Err("its machine answered something else".to_owned()),
        }
    }

    /// An agent-device command on the screen's machine: its exit code and output.
    async fn run(&mut self, args: Vec<String>) -> Result<(i32, String), String> {
        match self.send(DeviceCall::Run { args }, DEVICE_WAIT).await? {
            DeviceDone::Run {
                exit_code,
                stdout,
                stderr,
                ..
            } => Ok((exit_code, format!("{stdout}{stderr}"))),
            _ => Err("its machine answered the command with another step's answer".to_owned()),
        }
    }
}

/// Sends a PR's build to the screen's machine and installs it there with `agent-device install`. A command held back
/// (exit 75: a simulator's XCTest runner still starting) is tried again: on iOS a bare `agent-device` waits out the
/// start first, so the build goes once.
async fn install(hub: &Hub, start: &Start, build: &Build) -> Result<(), String> {
    let mut steps = Steps {
        hub,
        place: &start.place,
        key: &start.sealed.relay_key,
        count: 0,
    };
    let until = Instant::now() + INSTALL_WAIT;
    let held = |code: i32| code == 75 && Instant::now() < until;
    loop {
        if start.kind == SessionKind::Ios {
            loop {
                let (code, _) = steps.run(Vec::new()).await?;
                if !held(code) {
                    break;
                }
                tokio::time::sleep(INSTALL_RETRY).await;
            }
        }
        let mut offset = 0u64;
        for piece in build.bytes.chunks(device::PIECE) {
            let put = DeviceCall::Put {
                name: build.name.clone(),
                offset,
                data_b64: B64.encode(piece),
            };
            steps.send(put, CALL_WAIT).await?;
            offset += piece.len() as u64;
        }
        let (code, out) = steps
            .run(vec!["install".into(), format!("in/{}", build.name)])
            .await?;
        if code == 0 {
            return Ok(());
        }
        if !held(code) {
            let out = out.trim();
            return Err(if out.is_empty() {
                format!("agent-device install exited with {code}")
            } else {
                crate::hub::api::clip(out, 300)
            });
        }
        tokio::time::sleep(INSTALL_RETRY).await;
    }
}

/// Ends a person's live screen on its runner, and frees its slot.
async fn end(hub: &Hub, session: &BrowserSession) -> Result<(), ToolError> {
    let id = session.session_id.as_str();
    let place = hub.db.with(|c| {
        Ok(c.query_row(
            &format!(
                "SELECT {} FROM session_places WHERE session_id = ?1 AND hosted = 1 AND person_id IS NOT NULL
                 ORDER BY started_ms DESC LIMIT 1",
                super::PLACE_COLUMNS
            ),
            [id],
            super::place_of,
        )
        .optional()?)
    })?;
    let Some(place) = place else {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!("Screen {id} wasn't opened by a person."),
        ));
    };
    let frame: BrowserCallFrame = serde_json::from_value(json!({
        "id": "end", "cwd": "/", "call": { "op": "session_end" },
    }))
    .expect("a session_end frame");
    let answer = hub
        .node_commands
        .host_session(&place.runner, &place.key, &frame, None, CALL_WAIT)
        .await;
    let gone = match &answer {
        Ok(frame) => {
            frame.result.is_some()
                || frame
                    .error
                    .as_ref()
                    .is_some_and(|e| e.code == fleetd_contracts::mcp::ErrorCode::NotFound)
        }
        Err(_) => false,
    };
    if !gone {
        let why = match answer {
            Ok(frame) => frame.error.map_or_else(String::new, |e| e.message),
            Err(e) => e.to_string(),
        };
        return Err(ToolError::new(
            ErrorCode::Failed,
            format!("{} didn't end screen {id}: {why}", place.runner),
        )
        .with_fix("Try again; it ends by itself after 30 minutes without your input."));
    }
    let now = now_ms(hub.clock.as_ref());
    hub.db.transaction(|c| end_place(c, &place.key, now))?;
    hub.link
        .browser_live
        .forget_input(&BrowserSessionId::unchecked(id));
    Ok(())
}

/// Gives each slot free on a machine to the oldest person waiting for it, and drops waits past their time. Each start
/// holds its slot before the next is counted, then runs on its own.
pub fn serve_waits(hub: &Arc<Hub>) -> Result<usize, StoreError> {
    let now = now_ms(hub.clock.as_ref());
    hub.db.transaction(|c| {
        c.execute(
            "DELETE FROM screen_waits WHERE since_ms <= ?1",
            [now - WAIT_MS],
        )?;
        Ok(())
    })?;
    let waits = hub.db.with(|c| waits_on(c, now))?;
    if waits.is_empty() {
        return Ok(0);
    }
    let all = runners(hub)?;
    let mut served = 0;
    let mut taken: std::collections::HashMap<MachineId, i64> = Default::default();
    for w in waits {
        let Some((runner, _, _)) = all.iter().find(|(r, _, _)| r.machine_id == w.runner) else {
            continue;
        };
        let used = taken.entry(w.runner.clone()).or_default();
        if runner.open() - *used <= 0 {
            continue;
        }
        let person = hub
            .db
            .with(|c| crate::hub::people::get_on(c, &w.person))?
            .map(|p| p.as_ref());
        let Some(person) = person else {
            hub.db.transaction(|c| {
                c.execute("DELETE FROM screen_waits WHERE wait_id = ?1", [&w.id])?;
                Ok(())
            })?;
            continue;
        };
        let opener = Opener {
            person,
            device: w.device.clone(),
        };
        let navi = is_navi(hub, &w.project)?;
        let sealed = match sealed_for(hub, &w.runner) {
            Ok(sealed) => Some(sealed),
            Err(e) => {
                tracing::warn!(error = %e.message, "a waiting person's screen can't be sealed; given up");
                None
            }
        };
        let start = hub.db.transaction(|c| {
            if c.execute("DELETE FROM screen_waits WHERE wait_id = ?1", [&w.id])? == 0 {
                return Ok(None);
            }
            Ok(match sealed {
                Some(sealed) => Some(prepare(
                    c,
                    &opener,
                    &w.project,
                    w.kind,
                    &w.runner,
                    sealed,
                    navi,
                    w.pr.as_ref(),
                    now,
                )?),
                None => None,
            })
        })?;
        let Some(start) = start else {
            continue;
        };
        *used += 1;
        served += 1;
        let (hub, project, pr) = (hub.clone(), w.project.clone(), w.pr.clone());
        tokio::spawn(async move {
            // The PR's build is read now, its slot held meanwhile: one that is gone since frees it.
            let build = match &pr {
                Some(pr) => match find_build(&hub, &project, start.kind, pr).await {
                    Ok(found) => fetch_build(&hub, start.kind, pr, &found).await.map(Some),
                    Err(e) => Err(e),
                },
                None => Ok(None),
            };
            let started = match build {
                Ok(build) => launch(&hub, start, build).await.map(|_| ()),
                Err(e) => {
                    super::calls::cancel(&hub, &start.place).await;
                    Err(e)
                }
            };
            if let Err(e) = started {
                tracing::warn!(error = %e.message, "a waiting person's screen didn't start");
            }
        });
    }
    Ok(served)
}

/// People's live screens with no input from them for [`IDLE_MS`] (or since they started, or since the hub did).
fn idle(hub: &Hub, since_hub: i64) -> Result<Vec<BrowserSession>, StoreError> {
    let now = now_ms(hub.clock.as_ref());
    let rows: Vec<(String, i64)> = hub.db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT p.session_id, p.started_ms FROM session_places p JOIN browser_sessions b
               ON b.session_id = p.session_id
             WHERE p.person_id IS NOT NULL AND p.hosted = 1 AND p.ended_ms IS NULL AND b.state = 'live'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    })?;
    let mut out = Vec::new();
    for (id, started) in rows {
        let id = BrowserSessionId::unchecked(&id);
        let last = hub
            .link
            .browser_live
            .last_input(&id)
            .unwrap_or(0)
            .max(started)
            .max(since_hub);
        if now - last >= IDLE_MS
            && let Some(s) = crate::hub::browser::get(&hub.db, &id)?
        {
            out.push(s);
        }
    }
    Ok(out)
}

/// Ends people's screens idle for [`IDLE_MS`]; returns how many it ended.
pub async fn end_idle(hub: &Hub, since_hub: i64) -> usize {
    let sessions = match idle(hub, since_hub) {
        Ok(sessions) => sessions,
        Err(e) => {
            tracing::warn!(error = %e, "people's idle screens not read");
            return 0;
        }
    };
    let mut ended = 0;
    for s in sessions {
        tracing::info!(session = %s.session_id, "a person's screen idle; ending it");
        match end(hub, &s).await {
            Ok(()) => ended += 1,
            Err(e) => {
                tracing::warn!(session = %s.session_id, error = %e.message, "idle screen not ended")
            }
        }
    }
    ended
}

/// Serves the waits whenever anything changes (a screen's end is an event) and each minute, and ends people's idle
/// screens each minute, until the hub stops.
pub async fn run(hub: Arc<Hub>) {
    let since_hub = now_ms(hub.clock.as_ref());
    let mut head = hub.events.subscribe();
    let mut checked = i64::MIN;
    loop {
        head.borrow_and_update();
        if let Err(e) = serve_waits(&hub) {
            tracing::warn!(error = %e, "people's waits for screens not served");
        }
        let now = now_ms(hub.clock.as_ref());
        if now.saturating_sub(checked) >= 60_000 {
            checked = now;
            end_idle(&hub, since_hub).await;
        }
        tokio::select! {
            () = hub.shutdown.wait() => return,
            changed = head.changed() => if changed.is_err() { return },
            () = hub.clock.sleep(Duration::from_secs(60)) => {}
        }
    }
}
