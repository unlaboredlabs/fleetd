//! `session_route`: an agent's session tool call, which its node hands to the hub. A `session_start` is placed; one
//! placed on the agent's own machine goes back to its node to answer (`here`), one placed elsewhere goes to the
//! runner's node, as do the agent's later calls for that session. The node never lets a process in the session send
//! it itself (node/lead.rs).
use std::sync::{Arc, Weak};
use std::time::Duration;

use fleetd_contracts::browser::{
    BrowserCall, BrowserCallFrame, BrowserCallResult, BrowserResultFrame,
};
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::machine_roles::{
    SessionRouteCall, SessionRouteResult, SessionStepCall, SessionStepFrame, SessionStepResult,
};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::node_link::{CAP_SESSION_SEAL, HubToNode};
use fleetd_contracts::prim::NonEmpty;

use super::{
    Place, drop_place, end_place, insert_place, new_key, open_hosted, place, remote_on, runners,
};
use crate::hub::api::Hub;
use crate::hub::link::lead_calls::{CallerAgent, LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};
use crate::hub::store::{StoreError, now_ms};

pub const OPS: [&str; 2] = ["session_route", "session_step"];

/// How long a start on another machine may take: its pool may have to launch a browser or boot a device. With its
/// cancel, well inside the agent's node's wait for `session_route` (node/session_route.rs `ROUTE_WAIT`), so the hub
/// always answers before the node gives up.
pub const START_WAIT: Duration = Duration::from_secs(90);
/// Every other call.
pub const CALL_WAIT: Duration = Duration::from_secs(45);
/// How long the hub gives a runner to end a start nobody will use.
pub const CANCEL_WAIT: Duration = Duration::from_secs(15);

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                match call {
                    LeadCall::SessionRoute(call) => route(hub, &caller, call).await,
                    LeadCall::SessionStep(call) => step(&hub, &caller, call),
                    other => Err(McpToolError::new(
                        ErrorCode::Invalid,
                        format!("{} is not a session route.", op_of(&other)),
                    )),
                }
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    for op in OPS {
        calls.register(op, handler.clone());
    }
}

fn failed(e: StoreError) -> McpToolError {
    tracing::error!(error = %e, "machine roles store");
    McpToolError::new(ErrorCode::Failed, "The hub failed to answer that request.")
}

fn here(machine: &MachineId) -> LeadCallResult {
    LeadCallResult::SessionRoute(SessionRouteResult {
        runner: machine.clone(),
        here: true,
        answer: None,
        relay: None,
        seal_to: None,
    })
}

fn relayed(runner: &MachineId, answer: BrowserResultFrame) -> LeadCallResult {
    LeadCallResult::SessionRoute(SessionRouteResult {
        runner: runner.clone(),
        here: false,
        answer: Some(answer),
        relay: None,
        seal_to: None,
    })
}

pub async fn route(
    hub: Arc<Hub>,
    caller: &LeadCaller,
    call: SessionRouteCall,
) -> Result<LeadCallResult, McpToolError> {
    let task_id = match &caller.agent {
        CallerAgent::Person => {
            return Err(McpToolError::new(
                ErrorCode::Forbidden,
                "A session belongs to an agent's session, and this call comes from none.",
            ));
        }
        CallerAgent::Lead | CallerAgent::Preview(_) | CallerAgent::EndedPreview(_) => None,
        CallerAgent::Task(t) => Some(t.clone()),
    };
    let Some(thread) = call.frame.thread_id.clone() else {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            "frame.threadId: the agent's session the call is for.",
        ));
    };
    let origin = caller.project_ref.machine_id.clone();
    let now = now_ms(hub.clock.as_ref());
    let open = hub
        .db
        .with(|c| open_hosted(c, &origin, &thread, now))
        .map_err(failed)?;
    if !matches!(call.frame.call, BrowserCall::SessionStart(_)) {
        let Some(open) = open else {
            // Not one the hub placed elsewhere: the agent's own node has it, or nobody does.
            return Ok(here(&origin));
        };
        let ending = matches!(call.frame.call, BrowserCall::SessionEnd(_));
        // A fill carries the value the agent's node read, sealed to this session's runner: passed on as it is.
        let sealed = call
            .sealed
            .filter(|s| s.runner == open.runner)
            .map(|s| s.data_b64);
        let answer = forward(&hub, &open, call.frame, sealed, CALL_WAIT).await;
        // Ended, or no longer there to end: a runner gone offline took its session with it.
        let gone = match &answer {
            Ok(frame) => {
                frame.result.is_some()
                    || frame
                        .error
                        .as_ref()
                        .is_some_and(|e| e.code == ErrorCode::NotFound)
            }
            Err(_) => true,
        };
        if ending && gone {
            hub.db
                .transaction(|c| end_place(c, &open.key, now))
                .map_err(failed)?;
        }
        return answer.map(|frame| relayed(&open.runner, frame));
    }
    if let Some(open) = open {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            format!(
                "Your browser session {} is open on {}.",
                open.session_id.as_deref().unwrap_or("(starting)"),
                open.runner
            ),
        )
        .with_fix("use it, or end it with session_end before starting another"));
    }
    let all: Vec<_> = runners(&hub)
        .map_err(failed)?
        .into_iter()
        .map(|(r, _, _)| r)
        .collect();
    // Across machines only from an agent's node that seals its session's secrets to the runner.
    let remote =
        hub.db.with(remote_on).map_err(failed)? && hub.link.node_can(&origin, CAP_SESSION_SEAL);
    let runner = match &call.sealed {
        // The second step: the runner the first named, if it can still take the session.
        Some(sealed) => {
            let ready = all
                .iter()
                .find(|r| r.machine_id == sealed.runner)
                .filter(|r| {
                    remote
                        && r.machine_id != origin
                        && r.online
                        && r.able(call.host, &origin)
                        && r.free() > 0
                });
            if ready.is_none() {
                return Err(McpToolError::new(
                    ErrorCode::Failed,
                    format!("{} can't take this session any more.", sealed.runner),
                )
                .with_fix("call session_start again"));
            }
            sealed.runner.clone()
        }
        None => place(&origin, call.host, &all, remote)?,
    };
    if runner != origin && call.sealed.is_none() {
        // The first step: nothing starts until the agent's node seals the session's secrets to the runner.
        let key = hub
            .store
            .machine_get(&runner)
            .map_err(failed)?
            .and_then(|m| m.box_pub_key)
            .ok_or_else(|| {
                McpToolError::new(
                    ErrorCode::Failed,
                    format!("{runner} has no key to seal to."),
                )
            })?;
        return Ok(LeadCallResult::SessionRoute(SessionRouteResult {
            runner,
            here: false,
            answer: None,
            relay: None,
            seal_to: Some(key),
        }));
    }
    let sealed = call.sealed.map(|s| s.data_b64);
    let placed = Place {
        key: new_key(),
        hosted: runner != origin,
        runner,
        origin: caller.project_ref.clone(),
        origin_thread: thread,
        task_id,
        session_id: None,
    };
    hub.db
        .transaction(|c| insert_place(c, &placed, now))
        .map_err(failed)?;
    if !placed.hosted {
        return Ok(here(&origin));
    }
    // Until it answers, a start dropped with this call (the hub stopping) is ended on the runner rather than left there.
    let mut starting = Starting {
        hub: hub.clone(),
        place: Some(placed.clone()),
    };
    let answer = forward(&hub, &placed, call.frame, sealed, START_WAIT).await;
    let started = match &answer {
        Ok(BrowserResultFrame {
            result: Some(BrowserCallResult::SessionStart(s)),
            ..
        }) => Some(s.session_id.to_string()),
        _ => None,
    };
    let Some(id) = started else {
        // Refused, or no answer in time: a start that lands later is ended, and holds no slot meanwhile.
        starting.place = None;
        cancel(&hub, &placed).await;
        return answer.map(|frame| relayed(&placed.runner, frame));
    };
    // The agent's node's side of the session's relay: the hub keeps only its hash.
    let token = super::relay::new_token();
    let hashed = super::relay::hash(token.as_str());
    hub.db
        .transaction(|c| super::set_session(c, &placed.key, &id, &hashed))
        .map_err(failed)?;
    starting.place = None;
    if !hub.node_commands.linked(&origin) {
        // Nobody is left to hear of it: the agent's node dropped off while it started.
        cancel(&hub, &placed).await;
        return Err(McpToolError::new(
            ErrorCode::Failed,
            format!(
                "{origin}'s node went away while the session started on {}.",
                placed.runner
            ),
        ));
    }
    tracing::info!(runner = %placed.runner, origin = %origin, "session placed on another machine");
    answer.map(|frame| match relayed(&placed.runner, frame) {
        LeadCallResult::SessionRoute(mut routed) => {
            routed.relay = Some(token);
            LeadCallResult::SessionRoute(routed)
        }
        other => other,
    })
}

/// `session_step`: a command of the agent's that drove its session hosted elsewhere, for the runner's recording.
fn step(
    hub: &Hub,
    caller: &LeadCaller,
    call: SessionStepCall,
) -> Result<LeadCallResult, McpToolError> {
    if caller.agent == CallerAgent::Person {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            "A session belongs to an agent's session, and this call comes from none.",
        ));
    }
    let origin = &caller.project_ref.machine_id;
    let now = now_ms(hub.clock.as_ref());
    let open = hub
        .db
        .with(|c| open_hosted(c, origin, &call.thread_id, now))
        .map_err(failed)?;
    let forwarded = open.is_some_and(|open| {
        let frame = HubToNode::SessionStep(SessionStepFrame {
            host_key: open.key,
            item: *call.item,
        });
        hub.node_commands.send(&open.runner, frame).is_ok()
    });
    Ok(LeadCallResult::SessionStep(SessionStepResult { forwarded }))
}

/// A start on another machine still waiting for its answer; dropped unanswered, it is cancelled.
struct Starting {
    hub: Arc<Hub>,
    place: Option<Place>,
}

impl Drop for Starting {
    fn drop(&mut self) {
        let Some(place) = self.place.take() else {
            return;
        };
        let hub = self.hub.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move { cancel(&hub, &place).await });
        }
    }
}

/// Ends a start on its runner, best effort, and frees its slot: a session nobody will drive.
async fn cancel(hub: &Hub, place: &Place) {
    let end: BrowserCallFrame = serde_json::from_value(serde_json::json!({
        "id": "cancel", "cwd": "/", "call": { "op": "session_end" },
    }))
    .expect("a session_end frame");
    if let Err(e) = hub
        .node_commands
        .host_session(&place.runner, &place.key, &end, None, CANCEL_WAIT)
        .await
    {
        tracing::warn!(runner = %place.runner, error = %e, "cancelled session start not ended on its runner");
    }
    if let Err(e) = hub.db.transaction(|c| drop_place(c, &place.key)) {
        tracing::warn!(error = %e, "cancelled session start not dropped");
    }
}

/// Sends the call to the runner's node, for the session it hosts under the place's key.
async fn forward(
    hub: &Hub,
    place: &Place,
    mut frame: BrowserCallFrame,
    sealed: Option<NonEmpty>,
    wait: Duration,
) -> Result<BrowserResultFrame, McpToolError> {
    // The runner knows the session by its key alone.
    frame.thread_id = None;
    hub.node_commands
        .host_session(&place.runner, &place.key, &frame, sealed.as_ref(), wait)
        .await
        .map_err(|e| {
            McpToolError::new(
                ErrorCode::Failed,
                format!("{}, where this session runs, did not answer: {e}.", place.runner),
            )
            .with_fix("try again shortly; if it keeps failing, do without the session and say so in your result")
        })
}
