//! An agent's session tools, routed through the hub (machine roles, W46). A call for a session this node's broker
//! has live goes straight to it. Every other call, `session_start` first, goes to the hub (`session_route`), which
//! places the session: back here (the broker answers), or on another machine, whose answer comes back. A hub whose
//! welcome doesn't list `session_route` (an older one) leaves the session here as before; with one that does, the
//! hub's word is final: a refusal, a timeout or no hub at all is the agent's answer, never a session here that the hub
//! didn't place.
//!
//! The other side: a session the hub placed on this machine for an agent elsewhere comes in as `session_host` (the
//! node link), answered by the broker under the key the hub gave it ([`host_masker`]).
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::browser::{BrowserCallFrame, BrowserResultFrame};
use fleetd_contracts::ids::ThreadId;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallFrame, LeadCallResult};
use fleetd_contracts::machine_roles::{HostKey, SessionHost, SessionRouteCall};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::node_link::HUB_CAP_SESSION_ROUTE;
use fleetd_contracts::prim::NonEmpty;
use serde_json::json;

use super::browser::{Broker, BrowserHandler};
use super::lead::LeadRelay;
use super::mask::Masker;

fn error_frame(id: &NonEmpty, error: McpToolError) -> BrowserResultFrame {
    serde_json::from_value(json!({ "id": id, "error": error })).expect("an error frame")
}

/// How long the node waits for the hub to place a session: past the hub's own wait for a runner's start and the
/// cancel of one that didn't answer (hub/machine_roles/calls.rs), so the hub always answers first.
pub const ROUTE_WAIT: Duration = Duration::from_secs(150);

async fn local(
    broker: Option<&Arc<Broker>>,
    thread: String,
    frame: BrowserCallFrame,
) -> BrowserResultFrame {
    match broker {
        Some(broker) => broker.handle(thread, frame).await,
        None => error_frame(
            &frame.id,
            McpToolError::new(ErrorCode::Invalid, "this machine runs no browser sessions")
                .with_fix("do without a browser and say so in your result"),
        ),
    }
}

async fn route(
    broker: Option<Arc<Broker>>,
    relay: LeadRelay,
    thread: String,
    frame: BrowserCallFrame,
) -> BrowserResultFrame {
    if broker.as_ref().is_some_and(|b| b.live(&thread).is_some())
        || !relay.hub_can(HUB_CAP_SESSION_ROUTE)
    {
        return local(broker.as_ref(), thread, frame).await;
    }
    let mut named = frame.clone();
    named.thread_id = Some(ThreadId::unchecked(thread.clone()));
    let call = LeadCallFrame {
        id: NonEmpty::unchecked("session_route"),
        cwd: frame.cwd.clone(),
        call: LeadCall::SessionRoute(SessionRouteCall {
            frame: named,
            host: SessionHost::Browser,
        }),
        thread_id: Some(ThreadId::unchecked(thread.clone())),
    };
    let answer = relay.call_within(call, ROUTE_WAIT).await;
    match (answer.result, answer.error) {
        (Some(LeadCallResult::SessionRoute(routed)), _) if !routed.here => match routed.answer {
            Some(mut answer) => {
                answer.id = frame.id;
                answer
            }
            None => error_frame(
                &frame.id,
                McpToolError::new(
                    ErrorCode::Failed,
                    "the hub placed the session but sent no answer",
                )
                .with_fix("try again"),
            ),
        },
        (Some(LeadCallResult::SessionRoute(_)), _) => local(broker.as_ref(), thread, frame).await,
        (_, Some(error)) => error_frame(&frame.id, error),
        (Some(_), None) => error_frame(
            &frame.id,
            McpToolError::new(
                ErrorCode::Failed,
                "the hub answered session_route with another call's result",
            ),
        ),
        (None, None) => unreachable!("a result frame has a result or an error"),
    }
}

/// The lead socket's handler for an agent's session tools.
pub fn routed(broker: Option<Arc<Broker>>, relay: LeadRelay) -> BrowserHandler {
    Arc::new(move |thread, frame| {
        let (broker, relay) = (broker.clone(), relay.clone());
        Box::pin(route(broker, relay, thread, frame))
    })
}

/// A session hosted here for an agent on another machine has no secrets on this machine to scrub: its masker is
/// empty. None for every other session.
pub fn host_masker(session: &str) -> Option<Masker> {
    HostKey::new(session).is_ok().then(|| Masker::new(&[]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_node_waits_past_the_hub_and_its_cancel() {
        use crate::hub::machine_roles::calls::{CANCEL_WAIT, START_WAIT};
        assert!(ROUTE_WAIT >= START_WAIT + CANCEL_WAIT + Duration::from_secs(30));
    }

    fn start() -> BrowserCallFrame {
        serde_json::from_value(json!({
            "id": "1", "cwd": "/work/app", "call": { "op": "session_start", "purpose": "Check the form" },
        }))
        .unwrap()
    }

    /// An older hub, which lists no `session_route`, never hears of it: the node answers as before.
    #[tokio::test]
    async fn an_older_hub_leaves_the_session_here() {
        let relay = LeadRelay::new();
        let answer = route(None, relay, "th-1".into(), start()).await;
        assert_eq!(
            answer.error.unwrap().message,
            "this machine runs no browser sessions"
        );
    }

    /// A hub that places sessions has the last word: with no answer from it, no session starts here.
    #[tokio::test(start_paused = true)]
    async fn no_answer_from_a_hub_that_places_sessions_starts_nothing_here() {
        let relay = LeadRelay::new();
        relay.set_hub_caps(vec![HUB_CAP_SESSION_ROUTE.to_owned()]);
        let answer = route(None, relay, "th-1".into(), start()).await;
        let error = answer.error.unwrap();
        assert_eq!(error.code, ErrorCode::MachineOffline, "{}", error.message);
    }

    #[test]
    fn only_a_hosted_key_gets_the_empty_masker() {
        assert!(host_masker("H0123456789abcdef0123456789abcdef").is_some());
        assert!(host_masker("019a2b3c-0000-7000-8000-000000000000").is_none());
        assert!(host_masker("Hello").is_none());
    }
}
