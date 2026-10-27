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
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use fleetd_contracts::browser::{
    BrowserCall, BrowserCallFrame, BrowserCallResult, BrowserResultFrame, BrowserSessionState,
    SessionKind,
};
use fleetd_contracts::ids::ThreadId;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallFrame, LeadCallResult};
use fleetd_contracts::machine_roles::SessionHostResult;
use fleetd_contracts::machine_roles::{
    HostKey, SealedForRunner, SessionHost, SessionRouteCall, SessionRouteResult, SessionStepCall,
};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::node_link::{HUB_CAP_SESSION_ROUTE, HubToNode};
use fleetd_contracts::prim::{NonEmpty, Text};
use fleetd_contracts::secrets::BoxPublicKey;
use fleetd_contracts::sessions::{ItemKind, ItemStatus, ThreadItem};
use serde_json::json;

use super::browser::credentials;
use super::browser::onepassword::{Credential, TOKEN_ENV};
use super::browser::upload::{HubCalls, HubFuture};
use super::browser::{Broker, BrowserHandler, SecretsFor, SessionHooks, drives_browser};
use super::desktop::Desktops;
use super::device::{self, Devices};
use super::identity::NodeBoxKey;
use super::lead::{LeadRelay, MaskFor};
use super::mask::{Masker, Secrets};
use super::relay::{self, Remote, relay_url};

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

/// What routing an agent's session tools needs: this node's broker (none where browser sessions are off), its android,
/// iOS and desktop sessions (none where they are off), its link to the hub, the hub's URL for relays, the sessions'
/// secrets (to seal to the machine that hosts one elsewhere, and to mask its steps with), and the values this node read
/// from 1Password for its agents' sessions hosted elsewhere.
#[derive(Clone)]
pub struct Router {
    pub broker: Option<Arc<Broker>>,
    pub devices: Option<Arc<Devices>>,
    pub ios: Option<Arc<device::ios::Simulators>>,
    pub desktops: Option<Arc<Desktops>>,
    pub relay: LeadRelay,
    pub hub: String,
    pub secrets_for: SecretsFor,
    pub mask_for: MaskFor,
    pub filled_elsewhere: FilledElsewhere,
    /// The id of each agent session's browser hosted on another machine, as its start answered.
    pub hosted_ids: HostedIds,
}

/// Agent session -> the id of its browser hosted elsewhere.
pub type HostedIds = Arc<Mutex<HashMap<String, String>>>;

impl Router {
    /// Ends the agent session's browser hosted on another machine, through the hub, as its `session_end` would.
    fn end_hosted(&self, thread: &str) {
        let end: BrowserCallFrame = serde_json::from_value(json!({
            "id": "ended", "cwd": "/", "call": { "op": "session_end" },
        }))
        .expect("a session_end frame");
        let (router, thread) = (Arc::new(self.clone()), thread.to_owned());
        tokio::spawn(async move {
            if let Some(error) = route(router, thread, end).await.error {
                tracing::info!(error = %error.message, "hosted session not ended");
            }
        });
    }

    /// The sessions on this machine, every kind.
    fn here(&self) -> device::Router {
        device::Router {
            browser: self.broker.clone(),
            devices: self.devices.clone(),
            ios: self.ios.clone(),
            desktops: self.desktops.clone(),
            // Session calls only; live view goes through the link's own router.
            live: Default::default(),
        }
    }
}

/// What a call's session runs on: an Android emulator, an iOS simulator or a Linux desktop for `session_start` of that
/// kind or for the `desktop` tool, else a browser.
fn host_of(frame: &BrowserCallFrame) -> SessionHost {
    match &frame.call {
        BrowserCall::SessionStart(start) => match start.kind.unwrap_or_default() {
            SessionKind::Android => SessionHost::Android,
            SessionKind::Ios => SessionHost::Ios,
            SessionKind::LinuxDesktop => SessionHost::Desktop,
            SessionKind::Browser => SessionHost::Browser,
        },
        BrowserCall::Desktop(_) => SessionHost::Desktop,
        _ => SessionHost::Browser,
    }
}

/// The values this node read from 1Password for its agents' sessions hosted on other machines (and sealed to the
/// runner to fill), by agent session: they are masked in what the agent's session reports, as a fill here is, until
/// its claude exits.
#[derive(Clone, Default)]
pub struct FilledElsewhere(Arc<Mutex<HashMap<String, Filled>>>);

/// Each value filled, under the reference it came from.
type Filled = Vec<(String, String)>;

impl FilledElsewhere {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Filled>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn get(&self, thread: &str) -> Filled {
        self.lock().get(thread).cloned().unwrap_or_default()
    }
}

/// `plain`, sealed to `to` (a raw X25519 key), base64.
fn seal_to(to: &[u8; 32], plain: &[u8]) -> Option<String> {
    crypto_box::PublicKey::from(*to)
        .seal(&mut crypto_box::aead::OsRng, plain)
        .ok()
        .map(|sealed| B64.encode(sealed))
}

/// What the agent's node seals to the machine that will host its session: the session's secrets, to scrub its
/// recording with (never its 1Password token: the agent's node reads 1Password itself), and the key the two nodes
/// encrypt its relay with.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Seal {
    secrets: Vec<(String, String)>,
    relay_key: String,
}

/// A value the agent's node read from its 1Password for a `fill_credential` of a session hosted elsewhere, sealed to
/// the runner, which fills it into the item's own sites only and wipes it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fill {
    value: String,
    urls: Vec<String>,
}

impl Drop for Fill {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

impl Drop for Seal {
    fn drop(&mut self) {
        for (_, value) in &mut self.secrets {
            value.zeroize();
        }
        self.relay_key.zeroize();
    }
}

/// The session's secrets and a new relay key, sealed to `to` (the runner's box key), base64.
async fn seal_for(
    router: &Router,
    thread: &str,
    to: &BoxPublicKey,
    relay_key: &[u8; 32],
) -> Result<String, String> {
    let (secrets_for, session) = (router.secrets_for.clone(), thread.to_owned());
    let secrets = tokio::task::spawn_blocking(move || secrets_for(&session))
        .await
        .map_err(|e| e.to_string())??;
    let seal = Seal {
        secrets: secrets
            .0
            .iter()
            .filter(|(name, _)| name != TOKEN_ENV)
            .cloned()
            .collect(),
        relay_key: B64.encode(relay_key),
    };
    let plain = zeroize::Zeroizing::new(serde_json::to_vec(&seal).map_err(|e| e.to_string())?);
    let public: [u8; 32] = B64
        .decode(to.as_str())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("the runner's key is not 32 bytes of base64")?;
    let sealed = crypto_box::PublicKey::from(public)
        .seal(&mut crypto_box::aead::OsRng, &plain)
        .map_err(|e| e.to_string())?;
    Ok(B64.encode(sealed))
}

/// One `session_route` call to the hub.
async fn ask(
    router: &Router,
    thread: &str,
    frame: &BrowserCallFrame,
    sealed: Option<SealedForRunner>,
) -> Result<SessionRouteResult, McpToolError> {
    let mut named = frame.clone();
    named.thread_id = Some(ThreadId::unchecked(thread));
    let call = LeadCallFrame {
        id: NonEmpty::unchecked("session_route"),
        cwd: frame.cwd.clone(),
        call: LeadCall::SessionRoute(SessionRouteCall {
            frame: named,
            host: host_of(frame),
            sealed,
        }),
        thread_id: Some(ThreadId::unchecked(thread)),
    };
    let answer = router.relay.call_within(call, ROUTE_WAIT).await;
    match (answer.result, answer.error) {
        (Some(LeadCallResult::SessionRoute(routed)), _) => Ok(routed),
        (_, Some(error)) => Err(error),
        (Some(_), None) => Err(McpToolError::new(
            ErrorCode::Failed,
            "the hub answered session_route with another call's result",
        )),
        (None, None) => unreachable!("a result frame has a result or an error"),
    }
}

async fn route(router: Arc<Router>, thread: String, frame: BrowserCallFrame) -> BrowserResultFrame {
    if router.here().live(&thread) || !router.relay.hub_can(HUB_CAP_SESSION_ROUTE) {
        return local(&router, thread, frame).await;
    }
    let device = matches!(host_of(&frame), SessionHost::Android | SessionHost::Ios);
    // Browser sessions off here: no proxy to drive one through, wherever it would run. An Android or iOS start goes
    // to the hub, which may place it here.
    let broker = match router.broker.as_ref() {
        Some(broker) => broker,
        None if device => return device_start(&router, thread, frame).await,
        None => return local(&router, thread, frame).await,
    };
    if device {
        return device_start(&router, thread, frame).await;
    }
    let ending = matches!(frame.call, BrowserCall::SessionEnd(_));
    let starting = matches!(frame.call, BrowserCall::SessionStart(_));
    // A fill of a session hosted elsewhere: read here, with this machine's token, and only the value goes, sealed.
    let fill = match (&frame.call, broker.remote(&thread)) {
        (BrowserCall::FillCredential(call), Some(remote)) => {
            match sealed_fill(&router, broker, &thread, call.reference.as_str(), &remote).await {
                Ok(sealed) => Some(sealed),
                Err(error) => return error_frame(&frame.id, error),
            }
        }
        _ => None,
    };
    let (routed, relay_key) = match ask(&router, &thread, &frame, fill).await {
        // Placed on another machine, which needs the session's secrets and relay key first: sealed to it.
        Ok(SessionRouteResult {
            here: false,
            answer: None,
            seal_to: Some(to),
            runner,
            ..
        }) => {
            let key = super::relay::new_key();
            let data = match seal_for(&router, &thread, &to, &key).await {
                Ok(data) => data,
                Err(why) => {
                    return error_frame(
                        &frame.id,
                        McpToolError::new(
                            ErrorCode::Failed,
                            format!("The node could not seal this session's secrets for {runner} ({why})."),
                        )
                        .with_fix("try again; if it keeps failing, check the node's log"),
                    );
                }
            };
            let sealed = SealedForRunner {
                runner,
                data_b64: NonEmpty::unchecked(data),
            };
            let runner_key: Option<[u8; 32]> =
                B64.decode(to.as_str()).ok().and_then(|k| k.try_into().ok());
            match ask(&router, &thread, &frame, Some(sealed.clone())).await {
                Ok(routed) => (routed, runner_key.map(|r| (key, sealed.runner, r))),
                Err(error) => return error_frame(&frame.id, error),
            }
        }
        Ok(routed) => (routed, None),
        Err(error) => return error_frame(&frame.id, error),
    };
    if routed.here {
        return local(&router, thread, frame).await;
    }
    if ending {
        broker.set_remote(&thread, None);
        broker.forget_remote_vault(&thread);
        router
            .hosted_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&thread);
    } else if let (Some(token), Some((key, runner, runner_key))) = (&routed.relay, relay_key) {
        // The agent's driver reaches the session through the hub's relay, from this node's proxy.
        match relay_url(&router.hub, token.as_str()) {
            Ok(url) => broker.set_remote(
                &thread,
                Some(Remote {
                    url,
                    key,
                    runner,
                    runner_key,
                }),
            ),
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
            // The agent's own address for it, as its AGENT_BROWSER_CDP names it: never the runner's.
            if starting && let Some(BrowserCallResult::SessionStart(started)) = &mut answer.result {
                if broker.remote(&thread).is_some() {
                    router
                        .hosted_ids
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .insert(thread.clone(), started.session_id.to_string());
                }
                if let Some(cdp) = broker.cdp_url(&thread) {
                    started.cdp = Some(Text::unchecked(cdp));
                }
            }
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

/// A `fill_credential` of a session hosted on `remote`'s runner: the reference read from this machine's 1Password and
/// the value sealed to the runner alone. The value is masked in this agent's reports from now on, as a fill here is.
async fn sealed_fill(
    router: &Router,
    broker: &Broker,
    thread: &str,
    reference: &str,
    remote: &Remote,
) -> Result<SealedForRunner, McpToolError> {
    let credential = broker.resolve_credential(thread, reference).await?;
    let fill = Fill {
        value: credential.value.to_string(),
        urls: credential.urls.clone(),
    };
    let plain = zeroize::Zeroizing::new(serde_json::to_vec(&fill).map_err(|e| {
        McpToolError::new(ErrorCode::Failed, format!("the fill was not sealed: {e}"))
    })?);
    let data = seal_to(&remote.runner_key, &plain).ok_or_else(|| {
        McpToolError::new(ErrorCode::Failed, "the fill was not sealed to its runner")
    })?;
    {
        let mut filled = router.filled_elsewhere.lock();
        let values = filled.entry(thread.to_owned()).or_default();
        if !values.iter().any(|(_, v)| *v == fill.value) {
            values.push((reference.to_owned(), fill.value.clone()));
        }
    }
    Ok(SealedForRunner {
        runner: remote.runner.clone(),
        data_b64: NonEmpty::unchecked(data),
    })
}

/// An Android or iOS `session_start`: on this machine when the hub places it here. agent-device drives an emulator
/// over adb and a simulator over simctl and its XCTest runner, neither of which crosses the hub's relay yet, so one the
/// hub would place elsewhere is refused before anything starts there (nothing is sealed for it).
async fn device_start(
    router: &Arc<Router>,
    thread: String,
    frame: BrowserCallFrame,
) -> BrowserResultFrame {
    let (kind, device) = match host_of(&frame) {
        SessionHost::Ios => ("iOS", "a simulator"),
        _ => ("Android", "an emulator"),
    };
    let elsewhere = |frame: &BrowserCallFrame| {
        error_frame(
            &frame.id,
            McpToolError::new(
                ErrorCode::Failed,
                format!(
                    "The hub placed this {kind} session on another machine, and agent-device can't drive {device} \
                     there from here yet."
                ),
            )
            .with_fix(format!(
                "say so in your result: {kind} sessions run only on the agent's own machine for now"
            )),
        )
    };
    match ask(router, &thread, &frame, None).await {
        Ok(routed) if routed.here => local(router, thread, frame).await,
        // Placed elsewhere and already started there (a hub that doesn't ask for a seal first): end it there.
        Ok(routed) if routed.answer.is_some() => {
            let end: BrowserCallFrame = serde_json::from_value(json!({
                "id": "device-elsewhere", "cwd": frame.cwd, "call": { "op": "session_end" },
            }))
            .expect("a session_end frame");
            let _ = ask(router, &thread, &end, None).await;
            elsewhere(&frame)
        }
        Ok(_) => elsewhere(&frame),
        Err(error) => error_frame(&frame.id, error),
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

    /// What this node's broker filled into the agent's sessions here, and what runners filled into its sessions hosted
    /// there (sealed back to this node with their answers).
    fn filled_since(&self, thread: &str, known: usize) -> Option<crate::node::mask::Secrets> {
        let mut all = self
            .broker
            .as_ref()
            .and_then(|b| SessionHooks::filled_since(b.as_ref(), thread, 0))
            .map(|s| s.0.clone())
            .unwrap_or_default();
        for (name, value) in self.filled_elsewhere.get(thread) {
            if !all.iter().any(|(_, v)| *v == value) {
                all.push((name, value));
            }
        }
        (all.len() > known).then(|| crate::node::mask::Secrets(all))
    }

    /// The agent's claude exited: its session ends, here or on the machine hosting it.
    fn ended(&self, thread: &str) {
        self.filled_elsewhere.lock().remove(thread);
        if let Some(devices) = &self.devices {
            devices.ended(thread);
        }
        if let Some(ios) = &self.ios {
            ios.ended(thread);
        }
        if let Some(desktops) = &self.desktops {
            desktops.ended(thread);
        }
        let Some(broker) = &self.broker else {
            return;
        };
        broker.forget_remote_vault(thread);
        if broker.remote(thread).is_none() {
            broker.ended(thread);
            return;
        }
        self.end_hosted(thread);
    }

    /// Its screen here if it is `session`; else its browser hosted elsewhere, if that is `session`.
    fn screen_ended(&self, thread: &str, session: &str) {
        if self.here().end_screen(thread, session) {
            return;
        }
        let hosted = self
            .hosted_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(thread)
            .is_some_and(|id| id == session);
        if hosted {
            self.end_hosted(thread);
        }
    }

    fn item(&self, thread: &str, item: &ThreadItem) {
        if let Some(devices) = &self.devices {
            devices.item(thread, item);
        }
        if let Some(ios) = &self.ios {
            ios.item(thread, item);
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

/// The sessions this node hosts for agents on other machines: what each agent's node sealed to it. A session's
/// secrets are kept only until its broker read them at the start (never a 1Password token: a fill comes with its value,
/// read and sealed by the agent's node); its relay key until it ends.
#[derive(Clone, Default)]
pub struct Hosted(Arc<Mutex<HashMap<String, HostedSession>>>);

struct HostedSession {
    secrets: Option<Secrets>,
    relay_key: zeroize::Zeroizing<[u8; 32]>,
}

impl Hosted {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, HostedSession>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The secrets a session's agent's node sealed to this node, for its broker to scrub its recording with.
    pub fn secrets(&self, key: &str) -> Secrets {
        Secrets(
            self.lock()
                .get(key)
                .and_then(|h| h.secrets.as_ref())
                .map(|s| s.0.clone())
                .unwrap_or_default(),
        )
    }

    /// `fallback` for this node's own sessions, and for a host key (a browser, an emulator or a desktop hosted here for
    /// an agent on another machine) the secrets its agent's node sealed to this one.
    pub fn secrets_for(&self, fallback: SecretsFor) -> SecretsFor {
        let hosted = self.clone();
        Arc::new(move |session| {
            if self::hosted(session) {
                return Ok(hosted.secrets(session));
            }
            fallback(session)
        })
    }

    /// The broker's calls to the hub, watched: once a hosted session reports itself ended (however it ended: its
    /// agent, idle, a person, the app), this node forgets what was sealed to it for it, its relay key with it.
    pub fn watch(&self, inner: Arc<dyn HubCalls>) -> Arc<dyn HubCalls> {
        Arc::new(Watched {
            inner,
            hosted: self.clone(),
        })
    }

    /// Whether it still holds anything for the hosted session `key`.
    #[cfg(test)]
    pub fn holds(&self, key: &str) -> bool {
        self.lock().contains_key(key)
    }

    fn relay_key(&self, key: &str) -> Option<zeroize::Zeroizing<[u8; 32]>> {
        self.lock().get(key).map(|h| h.relay_key.clone())
    }
}

struct Watched {
    inner: Arc<dyn HubCalls>,
    hosted: Hosted,
}

impl HubCalls for Watched {
    fn call(&self, thread: &str, cwd: &str, call: LeadCall) -> HubFuture {
        if let LeadCall::BrowserSession(report) = &call
            && report.state != BrowserSessionState::Live
            && self::hosted(thread)
        {
            self.hosted.lock().remove(thread);
        }
        self.inner.call(thread, cwd, call)
    }
}

/// What the hub asks of this node for the sessions it hosts for agents on other machines, as the link hands it over:
/// a session call to answer under its key (a start opens what its agent's node sealed to this node first), a relay
/// channel to connect (for as long as it stays open), or a step for a session's recording. Only a session call has an
/// answer to send back.
pub async fn host(
    broker: Option<Arc<Broker>>,
    sessions: Option<Arc<device::Router>>,
    hub: &str,
    frame: HubToNode,
    hosted: &Hosted,
    box_key: Option<&NodeBoxKey>,
) -> Option<SessionHostResult> {
    let refuse = |id: &NonEmpty, message: &str| {
        error_frame(id, McpToolError::new(ErrorCode::Invalid, message))
    };
    match (frame, broker) {
        (HubToNode::SessionHost(host), broker) if broker.is_some() || sessions.is_some() => {
            let key = host.host_key.to_string();
            let call = host.frame.call.op();
            if call == "session_start" {
                let opened = host
                    .sealed
                    .as_ref()
                    .and_then(|sealed| B64.decode(sealed.as_str()).ok())
                    .and_then(|sealed| box_key?.open(&sealed))
                    .and_then(|plain| serde_json::from_slice::<Seal>(&plain).ok());
                let Some(seal) = opened else {
                    return Some(SessionHostResult {
                        id: host.id,
                        frame: refuse(
                            &host.frame.id,
                            "this machine could not open the session's sealed secrets, so it hosts nothing it can't scrub",
                        ),
                    });
                };
                let relay_key: Option<[u8; 32]> = B64
                    .decode(&seal.relay_key)
                    .ok()
                    .and_then(|k| k.try_into().ok());
                let Some(relay_key) = relay_key else {
                    return Some(SessionHostResult {
                        id: host.id,
                        frame: refuse(
                            &host.frame.id,
                            "the session's sealed relay key is not 32 bytes",
                        ),
                    });
                };
                hosted.lock().insert(
                    key.clone(),
                    HostedSession {
                        secrets: Some(Secrets(seal.secrets.clone())),
                        relay_key: zeroize::Zeroizing::new(relay_key),
                    },
                );
            }
            // A fill comes with the value the agent's node read, sealed to this node: filled under #552's checks (the
            // item's own sites, reads sealed after it) and wiped.
            let given = match &host.frame.call {
                BrowserCall::FillCredential(_) => host
                    .sealed
                    .as_ref()
                    .and_then(|sealed| B64.decode(sealed.as_str()).ok())
                    .and_then(|sealed| box_key?.open(&sealed))
                    .and_then(|plain| serde_json::from_slice::<Fill>(&plain).ok()),
                _ => None,
            };
            let frame = match (host.frame.call.clone(), given, &broker) {
                (BrowserCall::FillCredential(call), Some(fill), Some(broker)) => {
                    let credential = Credential {
                        value: zeroize::Zeroizing::new(fill.value.clone()),
                        urls: fill.urls.clone(),
                    };
                    let id = host.frame.id.clone();
                    match credentials::fill_from(broker, &key, call, Some(credential)).await {
                        Ok(result) => serde_json::from_value(json!({ "id": id, "result": result }))
                            .expect("a result frame"),
                        Err(error) => error_frame(&id, error),
                    }
                }
                // Any kind: the dispatch sends an android start to the emulators, an ios one to the simulators, the
                // rest to the broker.
                _ => match (&sessions, &broker) {
                    (Some(sessions), _) => sessions.handle(key.clone(), host.frame).await,
                    (None, Some(broker)) => broker.handle(key.clone(), host.frame).await,
                    (None, None) => unreachable!("checked: one of them is here"),
                },
            };
            match call {
                // The broker read them at the start: they leave this node's memory now.
                "session_start" if frame.result.is_some() => {
                    if let Some(h) = hosted.lock().get_mut(&key) {
                        h.secrets = None;
                    }
                }
                "session_start" | "session_end" => {
                    hosted.lock().remove(&key);
                }
                _ => {}
            }
            Some(SessionHostResult { id: host.id, frame })
        }
        (HubToNode::SessionHost(host), None) => Some(SessionHostResult {
            id: host.id,
            frame: refuse(&host.frame.id, "this machine hosts no sessions"),
        }),
        (HubToNode::RelayDial(dial), Some(broker)) => {
            let key = hosted.relay_key(dial.host_key.as_str())?;
            relay::dial(hub, &broker, dial, &key).await;
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

    struct NoHub;

    impl super::super::browser::upload::HubCalls for NoHub {
        fn call(&self, _: &str, _: &str, _: LeadCall) -> super::super::browser::upload::HubFuture {
            Box::pin(async { Err(McpToolError::new(ErrorCode::MachineOffline, "no hub")) })
        }
    }

    fn router(relay: LeadRelay, broker: Option<Arc<Broker>>) -> Arc<Router> {
        Arc::new(Router {
            broker,
            devices: None,
            ios: None,
            desktops: None,
            relay,
            hub: "http://devbox:4790".into(),
            secrets_for: Arc::new(|_| Ok(Secrets(Vec::new()))),
            mask_for: Arc::new(|_| Ok(Masker::new(&[]))),
            filled_elsewhere: FilledElsewhere::default(),
            hosted_ids: Default::default(),
        })
    }

    /// A broker with no browser, as on a machine that never ran a session.
    async fn broker(home: &std::path::Path) -> Arc<Broker> {
        Broker::open(
            home,
            super::super::browser::BrowserConfig::default(),
            Arc::new(NoHub),
            Arc::new(|_| Ok(Secrets(Vec::new()))),
        )
        .await
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
        let ios: BrowserCallFrame = serde_json::from_value(json!({
            "id": "1", "cwd": "/w", "threadId": "t1",
            "call": { "op": "session_start", "purpose": "Settings", "kind": "ios" },
        }))
        .unwrap();
        assert_eq!(host_of(&ios), SessionHost::Ios);
        let mut desktop = start();
        if let BrowserCall::SessionStart(call) = &mut desktop.call {
            call.kind = Some(SessionKind::LinuxDesktop);
        }
        assert_eq!(host_of(&desktop), SessionHost::Desktop);
        assert_eq!(host_of(&start()), SessionHost::Browser);
    }

    /// Browser sessions off here: no proxy for the agent to drive one through, so the hub isn't even asked.
    #[tokio::test]
    async fn a_machine_with_browser_sessions_off_refuses_before_asking_the_hub() {
        let relay = LeadRelay::new();
        relay.set_hub_caps(vec![HUB_CAP_SESSION_ROUTE.to_owned()]);
        let answer = route(router(relay, None), "th-1".into(), start()).await;
        assert_eq!(
            answer.error.unwrap().message,
            "this machine runs no browser sessions"
        );
    }

    /// An older hub, which lists no `session_route`, never hears of it: the node answers as before.
    #[tokio::test]
    async fn an_older_hub_leaves_the_session_here() {
        let home = tempfile::tempdir().unwrap();
        let answer = route(
            router(LeadRelay::new(), Some(broker(home.path()).await)),
            "th-1".into(),
            start(),
        )
        .await;
        let message = answer.error.unwrap().message;
        assert!(
            message.contains("browser"),
            "the broker's own answer: {message}"
        );
    }

    /// A hub that places sessions has the last word: with no answer from it, no session starts here.
    #[tokio::test(start_paused = true)]
    async fn no_answer_from_a_hub_that_places_sessions_starts_nothing_here() {
        let home = tempfile::tempdir().unwrap();
        let relay = LeadRelay::new();
        relay.set_hub_caps(vec![HUB_CAP_SESSION_ROUTE.to_owned()]);
        let answer = route(
            router(relay, Some(broker(home.path()).await)),
            "th-1".into(),
            start(),
        )
        .await;
        let error = answer.error.unwrap();
        assert_eq!(error.code, ErrorCode::MachineOffline, "{}", error.message);
    }

    /// However a hosted session ends on this machine, its report of it makes this node forget its relay key.
    #[tokio::test]
    async fn a_hosted_session_that_ended_here_is_forgotten() {
        let hosted = Hosted::default();
        let key = "H0123456789abcdef0123456789abcdef";
        hosted.lock().insert(
            key.to_owned(),
            HostedSession {
                secrets: None,
                relay_key: zeroize::Zeroizing::new([7; 32]),
            },
        );
        let calls = hosted.watch(Arc::new(NoHub));
        let report = |state: &str| -> LeadCall {
            serde_json::from_value(json!({
                "op": "browser_session", "sessionId": "B0123456789abcdef0123456789abcdef", "threadId": key,
                "purpose": "Check the form", "state": state, "startedAt": "2026-10-26T10:00:00.000Z",
            }))
            .unwrap()
        };
        let _ = calls.call(key, "/", report("live")).await;
        assert!(hosted.relay_key(key).is_some(), "live: kept");
        // Ended by itself (idle): it uploads its recording, and the key goes.
        let _ = calls.call(key, "/", report("uploading")).await;
        assert!(hosted.relay_key(key).is_none());
    }

    /// A host key reads what its agent's node sealed to this one, whatever the session is (a browser, an emulator, a
    /// desktop); every other session reads its own.
    #[test]
    fn a_host_key_reads_the_secrets_sealed_to_this_node() {
        let hosted = Hosted::default();
        let key = "H0123456789abcdef0123456789abcdef";
        hosted.lock().insert(
            key.to_owned(),
            HostedSession {
                secrets: Some(Secrets(vec![("SHOP_PASSWORD".into(), "hunter2".into())])),
                relay_key: zeroize::Zeroizing::new([7; 32]),
            },
        );
        let secrets_for =
            hosted.secrets_for(Arc::new(|_| Err("no session th-1 on this machine".into())));
        assert_eq!(
            secrets_for(key).unwrap().0,
            vec![("SHOP_PASSWORD".to_owned(), "hunter2".to_owned())]
        );
        assert!(
            secrets_for("th-1").is_err(),
            "its own sessions read as before"
        );
        // A host key nothing was sealed for reads none, rather than failing the start.
        assert!(
            secrets_for("H00000000000000000000000000000000")
                .unwrap()
                .0
                .is_empty()
        );
    }

    #[test]
    fn only_a_hosted_key_gets_the_empty_masker() {
        assert!(host_masker("H0123456789abcdef0123456789abcdef").is_some());
        assert!(host_masker("019a2b3c-0000-7000-8000-000000000000").is_none());
        assert!(host_masker("Hello").is_none());
    }
}
