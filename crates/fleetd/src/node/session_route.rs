//! An agent's session tools, routed through the hub (machine roles, W46). A call for a session this node's broker
//! has live goes straight to it. Every other call, `session_start` first, goes to the hub (`session_route`), which
//! places the session: back here (the broker answers), or on another machine, whose answer comes back. A hub whose
//! welcome doesn't list `session_route` (an older one) leaves the session here as before; with one that does, the
//! hub's word is final: a refusal, a timeout or no hub at all is the agent's answer, never a session here that the hub
//! didn't place.
//!
//! A session placed elsewhere is driven through the hub's relay: this node's proxy pipes the agent's driver there
//! (node/relay.rs), and each finished command that drove it goes to the runner for its recording (`session_step`).
//!
//! The other side: a session the hub placed on this machine for an agent elsewhere comes in as `session_host` (the
//! node link), answered by the broker under the key the hub gave it ([`host_masker`]).
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::browser::{BrowserCall, BrowserCallFrame, BrowserResultFrame, SessionKind};
use fleetd_contracts::ids::ThreadId;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallFrame, LeadCallResult};
use fleetd_contracts::machine_roles::SessionHostResult;
use fleetd_contracts::machine_roles::{HostKey, SessionHost, SessionRouteCall, SessionStepCall};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::node_link::{HUB_CAP_SESSION_ROUTE, HubToNode};
use fleetd_contracts::prim::NonEmpty;
use fleetd_contracts::sessions::{ItemKind, ItemStatus, ThreadItem};
use serde_json::json;

use super::browser::{Broker, BrowserHandler, SessionHooks, drives_browser};
use super::device::{self, Devices};
use super::lead::{LeadRelay, MaskFor};
use super::mask::Masker;
use super::relay::{self, relay_url};

fn error_frame(id: &NonEmpty, error: McpToolError) -> BrowserResultFrame {
    serde_json::from_value(json!({ "id": id, "error": error })).expect("an error frame")
}

/// How long the node waits for the hub to place a session: past the hub's own wait for a runner's start and the
/// cancel of one that didn't answer (hub/machine_roles/calls.rs), so the hub always answers first.
pub const ROUTE_WAIT: Duration = Duration::from_secs(150);

/// A call for a session on this machine, of either kind (node/device's dispatch).
async fn local(router: &Router, thread: String, frame: BrowserCallFrame) -> BrowserResultFrame {
    router.here().handle(thread, frame).await
}

/// What routing an agent's session tools needs: this node's broker (none where browser sessions are off) and its
/// android sessions (none where they are off), its link to the hub, the hub's URL for relays, and the sessions'
/// secrets to mask steps with.
#[derive(Clone)]
pub struct Router {
    pub broker: Option<Arc<Broker>>,
    pub devices: Option<Arc<Devices>>,
    pub relay: LeadRelay,
    pub hub: String,
    pub mask_for: MaskFor,
}

impl Router {
    /// The sessions on this machine, both kinds.
    fn here(&self) -> device::Router {
        device::Router {
            browser: self.broker.clone(),
            devices: self.devices.clone(),
        }
    }
}

/// What a call's session runs on: an Android emulator for `session_start` with kind android, else a browser.
fn host_of(frame: &BrowserCallFrame) -> SessionHost {
    match &frame.call {
        BrowserCall::SessionStart(start) if start.kind == Some(SessionKind::Android) => {
            SessionHost::Android
        }
        _ => SessionHost::Browser,
    }
}

async fn route(router: Arc<Router>, thread: String, frame: BrowserCallFrame) -> BrowserResultFrame {
    let broker = router.broker.as_ref();
    if router.here().live(&thread) || !router.relay.hub_can(HUB_CAP_SESSION_ROUTE) {
        return local(&router, thread, frame).await;
    }
    let mut named = frame.clone();
    named.thread_id = Some(ThreadId::unchecked(thread.clone()));
    let call = LeadCallFrame {
        id: NonEmpty::unchecked("session_route"),
        cwd: frame.cwd.clone(),
        call: LeadCall::SessionRoute(SessionRouteCall {
            host: host_of(&named),
            frame: named,
        }),
        thread_id: Some(ThreadId::unchecked(thread.clone())),
    };
    let ending = matches!(frame.call, BrowserCall::SessionEnd(_));
    let answer = router.relay.call_within(call, ROUTE_WAIT).await;
    match (answer.result, answer.error) {
        (Some(LeadCallResult::SessionRoute(routed)), _)
            if !routed.here && host_of(&frame) == SessionHost::Android =>
        {
            // agent-device drives an emulator over adb, which doesn't cross the hub's relay yet: end it there.
            let end: BrowserCallFrame = serde_json::from_value(json!({
                "id": "android-elsewhere", "cwd": frame.cwd, "call": { "op": "session_end" },
            }))
            .expect("a session_end frame");
            Box::pin(route(router.clone(), thread, end)).await;
            error_frame(
                &frame.id,
                McpToolError::new(
                    ErrorCode::Failed,
                    "The hub placed this Android session on another machine, and agent-device can't drive an \
                     emulator there from here yet.",
                )
                .with_fix("say so in your result: Android sessions run only on the agent's own machine for now"),
            )
        }
        (Some(LeadCallResult::SessionRoute(routed)), _) if !routed.here => {
            if ending {
                if let Some(broker) = broker {
                    broker.set_remote(&thread, None);
                }
            } else if let (Some(broker), Some(token)) = (broker, &routed.relay) {
                // The agent's driver reaches the session through the hub's relay, from this node's proxy.
                match relay_url(&router.hub, token.as_str()) {
                    Ok(url) => broker.set_remote(&thread, Some(url)),
                    Err(e) => tracing::warn!(error = %e, "session relay: no URL for it"),
                }
                // It drives it with agent-browser from here, which a machine that never ran a session lacks.
                if let Err(why) = broker.ensure_driver().await {
                    let end: BrowserCallFrame = serde_json::from_value(json!({
                        "id": "no-driver", "cwd": frame.cwd, "call": { "op": "session_end" },
                    }))
                    .expect("a session_end frame");
                    Box::pin(route(router.clone(), thread, end)).await;
                    return error_frame(
                        &frame.id,
                        McpToolError::new(
                            ErrorCode::Failed,
                            format!("This machine could not install agent-browser to drive the session: {why}."),
                        )
                        .with_fix("say so in your result: a person must set up agent-browser on this machine (fleetd docs: Browser sessions)"),
                    );
                }
            }
            match routed.answer {
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
            }
        }
        (Some(LeadCallResult::SessionRoute(_)), _) => local(&router, thread, frame).await,
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
pub fn routed(router: Arc<Router>) -> BrowserHandler {
    Arc::new(move |thread, frame| Box::pin(route(router.clone(), thread, frame)))
}

/// The most of a step's output that goes to the runner's action log.
const STEP_OUTPUT: usize = 64 * 1024;

/// The broker's session hooks, and a step of a session hosted on another machine handed to the hub for that machine's
/// recording: a line in its action log and the page after it in its trace, as a session here records them.
impl SessionHooks for Router {
    /// agent-browser's and agent-device's (node/device).
    fn env(&self, thread: &str, path: Option<&str>) -> Vec<(String, String)> {
        self.here().env(thread, path)
    }

    fn plugin_dirs(&self) -> Vec<std::path::PathBuf> {
        self.here().plugin_dirs()
    }

    /// What this node's broker filled into the agent's sessions here.
    // TODO(T534, sealed secrets): a session hosted on another machine fills there, so its values aren't masked in
    // this agent's reports yet. Remote placement is off by default (D163).
    fn filled_since(&self, thread: &str, known: usize) -> Option<crate::node::mask::Secrets> {
        self.broker
            .as_ref()
            .and_then(|b| SessionHooks::filled_since(b.as_ref(), thread, known))
    }

    /// The agent's claude exited: its session ends, here or on the machine hosting it.
    fn ended(&self, thread: &str) {
        if let Some(devices) = &self.devices {
            devices.ended(thread);
        }
        let Some(broker) = &self.broker else {
            return;
        };
        if broker.remote(thread).is_none() {
            broker.ended(thread);
            return;
        }
        let end: BrowserCallFrame = serde_json::from_value(json!({
            "id": "ended", "cwd": "/", "call": { "op": "session_end" },
        }))
        .expect("a session_end frame");
        let (router, thread) = (Arc::new(self.clone()), thread.to_owned());
        tokio::spawn(async move {
            if let Some(error) = route(router, thread, end).await.error {
                tracing::info!(error = %error.message, "hosted session not ended with its agent");
            }
        });
    }

    fn item(&self, thread: &str, item: &ThreadItem) {
        if let Some(devices) = &self.devices {
            devices.item(thread, item);
        }
        let Some(broker) = &self.broker else {
            return;
        };
        if broker.live(thread).is_some() || broker.remote(thread).is_none() {
            broker.item(thread, item);
            return;
        }
        let ItemKind::Command { command, .. } = &item.kind else {
            return;
        };
        if !matches!(item.status, ItemStatus::Completed | ItemStatus::Failed)
            || !drives_browser(command)
        {
            return;
        }
        let (relay, mask_for, thread, item) = (
            self.relay.clone(),
            self.mask_for.clone(),
            thread.to_owned(),
            item.clone(),
        );
        tokio::spawn(async move {
            let Some(item) = masked_step(&mask_for, &thread, item).await else {
                return;
            };
            let call = LeadCallFrame {
                id: NonEmpty::unchecked("session_step"),
                cwd: fleetd_contracts::tasks::AbsolutePath::unchecked("/"),
                call: LeadCall::SessionStep(SessionStepCall {
                    thread_id: ThreadId::unchecked(thread.clone()),
                    item: Box::new(item),
                }),
                thread_id: Some(ThreadId::unchecked(thread)),
            };
            if let Some(error) = relay.call(call).await.error {
                tracing::info!(error = %error.message, "session step not sent to its runner");
            }
        });
    }
}

/// The step with the agent's session's secrets masked and its output cut short; None when they can't be read, so it
/// never leaves unmasked.
async fn masked_step(mask_for: &MaskFor, thread: &str, mut item: ThreadItem) -> Option<ThreadItem> {
    if let ItemKind::Command {
        output: Some(output),
        ..
    } = &mut item.kind
        && output.len() > STEP_OUTPUT
    {
        let mut end = STEP_OUTPUT;
        while !output.is_char_boundary(end) {
            end -= 1;
        }
        output.truncate(end);
    }
    let (mask_for, thread) = (mask_for.clone(), thread.to_owned());
    let masker = tokio::task::spawn_blocking(move || mask_for(&thread))
        .await
        .ok()?
        .ok()?;
    let mut value = serde_json::to_value(&item).ok()?;
    masker.value(&mut value);
    serde_json::from_value(value).ok()
}

/// What the hub asks of this node for the sessions it hosts for agents on other machines, as the link hands it over:
/// a session call to answer under its key, a relay channel to connect (for as long as it stays open), or a step for
/// a session's recording. Only a session call has an answer to send back.
pub async fn host(
    broker: Option<Arc<Broker>>,
    sessions: Option<Arc<device::Router>>,
    hub: &str,
    frame: HubToNode,
) -> Option<SessionHostResult> {
    match (frame, broker) {
        // Either kind: the dispatch sends an android start to the emulators, the rest to the broker.
        (HubToNode::SessionHost(host), _) if sessions.is_some() => Some(SessionHostResult {
            id: host.id,
            frame: sessions
                .expect("checked")
                .handle(host.host_key.to_string(), host.frame)
                .await,
        }),
        (HubToNode::SessionHost(host), Some(broker)) => Some(SessionHostResult {
            id: host.id,
            frame: broker.handle(host.host_key.to_string(), host.frame).await,
        }),
        (HubToNode::SessionHost(host), None) => Some(SessionHostResult {
            id: host.id,
            frame: error_frame(
                &host.frame.id,
                McpToolError::new(ErrorCode::Invalid, "this machine hosts no sessions"),
            ),
        }),
        (HubToNode::RelayDial(dial), Some(broker)) => {
            relay::dial(hub, &broker, dial).await;
            None
        }
        (HubToNode::SessionStep(step), Some(broker)) => {
            broker.item(step.host_key.as_str(), &step.item);
            None
        }
        _ => None,
    }
}

/// Whether `session` is a key the hub gave this node for a session it hosts for an agent on another machine.
pub fn hosted(session: &str) -> bool {
    HostKey::new(session).is_ok()
}

/// A session hosted here for an agent on another machine has no secrets on this machine to scrub: its masker is
/// empty. None for every other session.
pub fn host_masker(session: &str) -> Option<Masker> {
    hosted(session).then(|| Masker::new(&[]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_node_waits_past_the_hub_and_its_cancel() {
        use crate::hub::machine_roles::calls::{CANCEL_WAIT, START_WAIT};
        assert!(ROUTE_WAIT >= START_WAIT + CANCEL_WAIT + Duration::from_secs(30));
    }

    fn router(relay: LeadRelay) -> Arc<Router> {
        Arc::new(Router {
            broker: None,
            devices: None,
            relay,
            hub: "http://devbox:4790".into(),
            mask_for: Arc::new(|_| Ok(Masker::new(&[]))),
        })
    }

    fn start() -> BrowserCallFrame {
        serde_json::from_value(json!({
            "id": "1", "cwd": "/work/app", "call": { "op": "session_start", "purpose": "Check the form" },
        }))
        .unwrap()
    }

    #[test]
    fn an_android_start_asks_the_hub_for_an_android_host() {
        let android: BrowserCallFrame = serde_json::from_value(json!({
            "id": "1", "cwd": "/work/app",
            "call": { "op": "session_start", "purpose": "Settings", "kind": "android" },
        }))
        .unwrap();
        assert_eq!(host_of(&android), SessionHost::Android);
        assert_eq!(host_of(&start()), SessionHost::Browser);
    }

    /// An older hub, which lists no `session_route`, never hears of it: the node answers as before.
    #[tokio::test]
    async fn an_older_hub_leaves_the_session_here() {
        let answer = route(router(LeadRelay::new()), "th-1".into(), start()).await;
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
        let answer = route(router(relay), "th-1".into(), start()).await;
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
