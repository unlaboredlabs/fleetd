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
//! An iOS screen placed elsewhere is driven by its agent's agent-device commands instead, each sent through the hub to
//! the runner, sealed with the session's relay key (node/device/remote.rs).
//!
//! The other side: a session the hub placed on this machine for an agent elsewhere comes in as `session_host` (the
//! node link), answered by the broker under the key the hub gave it ([`host_masker`]).
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use fleetd_contracts::browser::{
    BrowserCall, BrowserCallFrame, BrowserCallResult, BrowserResultFrame, BrowserSessionState,
    DeviceCall, DeviceDone, DeviceFile, SessionKind,
};
use fleetd_contracts::ids::{MachineId, ThreadId};
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
use super::desktop::{Desktops, WorktreeFor};
use super::device::remote::{self as remote_device, Remote as RemoteDevice, Remotes};
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
    /// The node's home: an agent's forwarding agent-device goes there.
    pub home: PathBuf,
    /// Each agent session's worktree: the files its commands for an iOS screen elsewhere read and write stay in it.
    pub worktree_of: WorktreeFor,
    /// The agent sessions whose iOS screen runs on another machine.
    pub remotes: Remotes,
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

    /// The agent session's iOS screen on another machine is gone: so is its forwarding agent-device.
    fn forget_device(&self, thread: &str) {
        self.remotes.lock().remove(thread);
        remote_device::remove_forwarder(&self.home, thread);
    }

    /// Ends the agent session's iOS screen on another machine, through the hub, as its `session_end` would.
    fn end_device(&self, thread: &str) {
        let end: BrowserCallFrame = serde_json::from_value(json!({
            "id": "ended", "cwd": "/", "call": { "op": "session_end" },
        }))
        .expect("a session_end frame");
        let (router, thread) = (Arc::new(self.clone()), thread.to_owned());
        tokio::spawn(async move {
            if let Some(error) = route(router, thread, end).await.error {
                tracing::info!(error = %error.message, "iOS screen elsewhere not ended");
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
    if router.remotes.has(&thread) {
        return device_elsewhere(&router, thread, frame).await;
    }
    if let BrowserCall::Device(_) = &frame.call {
        return error_frame(
            &frame.id,
            McpToolError::new(
                ErrorCode::NotFound,
                "No iOS screen of yours runs on another machine.",
            )
            .with_fix("start one with session_start kind ios"),
        );
    }
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
    // A Navi's runs here: another machine has neither its profile nor its folder to fence it in.
    if broker.is_navi(&thread) {
        return local(&router, thread, frame).await;
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

/// An Android or iOS `session_start`: on this machine when the hub places it here. An iOS one placed elsewhere starts
/// there once the session's secrets and relay key are sealed to the runner, and the agent's agent-device commands
/// follow it ([`device_elsewhere`]). agent-device drives an emulator over adb, which crosses no machine yet, so an
/// Android one the hub would place elsewhere is refused before anything starts there (nothing is sealed for it).
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
        Ok(SessionRouteResult {
            answer: None,
            seal_to: Some(to),
            runner,
            ..
        }) if kind == "iOS" => ios_start(router, thread, frame, &to, runner).await,
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

/// An iOS `session_start` placed on `runner`: started there with the session's secrets and a relay key sealed to it,
/// and a forwarding agent-device first on the agent's PATH from now on.
async fn ios_start(
    router: &Arc<Router>,
    thread: String,
    frame: BrowserCallFrame,
    to: &BoxPublicKey,
    runner: MachineId,
) -> BrowserResultFrame {
    let key = super::relay::new_key();
    let data = match seal_for(router, &thread, to, &key).await {
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
        runner: runner.clone(),
        data_b64: NonEmpty::unchecked(data),
    };
    let routed = match ask(router, &thread, &frame, Some(sealed)).await {
        Ok(routed) => routed,
        Err(error) => return error_frame(&frame.id, error),
    };
    if routed.here {
        return local(router, thread, frame).await;
    }
    let Some(mut answer) = routed.answer else {
        return error_frame(
            &frame.id,
            McpToolError::new(
                ErrorCode::Failed,
                "the hub placed the session but sent no answer",
            )
            .with_fix("try again"),
        );
    };
    answer.id = frame.id.clone();
    let Some(BrowserCallResult::SessionStart(started)) = &answer.result else {
        return answer;
    };
    let exe = super::sessions::self_command();
    if let Err(e) = remote_device::install_forwarder(&router.home, &thread, &exe) {
        let end: BrowserCallFrame = serde_json::from_value(json!({
            "id": "no-forwarder", "cwd": frame.cwd, "call": { "op": "session_end" },
        }))
        .expect("a session_end frame");
        let _ = ask(router, &thread, &end, None).await;
        return error_frame(
            &frame.id,
            McpToolError::new(
                ErrorCode::Failed,
                format!("The node could not put agent-device on your PATH for the screen on {runner}: {e}."),
            )
            .with_fix("try session_start again; if it keeps failing, say so in your result"),
        );
    }
    router.remotes.lock().insert(
        thread,
        RemoteDevice::new(started.session_id.to_string(), key),
    );
    answer
}

/// A call of an agent whose iOS screen runs on another machine: its agent-device commands run there ([`run_elsewhere`]),
/// and its other session calls go there too. Whatever ends the screen there takes its forwarding agent-device away
/// here.
async fn device_elsewhere(
    router: &Arc<Router>,
    thread: String,
    frame: BrowserCallFrame,
) -> BrowserResultFrame {
    let id = frame.id.clone();
    let answered = |outcome: Result<BrowserResultFrame, McpToolError>| match outcome {
        Ok(mut answer) => {
            answer.id = id.clone();
            answer
        }
        Err(error) => error_frame(&id, error),
    };
    match &frame.call {
        BrowserCall::Device(DeviceCall::Run { args }) => {
            let args = args.clone();
            match run_elsewhere(router, &thread, &frame, &args).await {
                Ok(done) => serde_json::from_value(json!({
                    "id": id, "result": BrowserCallResult::Device(done),
                }))
                .expect("a result frame"),
                Err(error) => error_frame(&id, error),
            }
        }
        BrowserCall::Device(_) => error_frame(
            &id,
            McpToolError::new(
                ErrorCode::Forbidden,
                "A screen's files are the node's to send: run agent-device with them instead.",
            ),
        ),
        BrowserCall::SessionEnd(_) => {
            let answer = forward_device(router, &thread, frame.clone()).await;
            router.forget_device(&thread);
            answered(answer)
        }
        _ => answered(forward_device(router, &thread, frame.clone()).await),
    }
}

/// One call for the agent's iOS screen on another machine, through the hub. One the hub no longer has anywhere ended
/// there (idle, a person, its machine gone).
async fn forward_device(
    router: &Router,
    thread: &str,
    frame: BrowserCallFrame,
) -> Result<BrowserResultFrame, McpToolError> {
    let routed = ask(router, thread, &frame, None).await?;
    if routed.here {
        router.forget_device(thread);
        return Err(McpToolError::new(
            ErrorCode::NotFound,
            "Your iOS screen on another machine has ended.",
        )
        .with_fix("start another with session_start kind ios if you still need one"));
    }
    routed.answer.ok_or_else(|| {
        McpToolError::new(ErrorCode::Failed, "the hub sent no answer for the screen")
            .with_fix("try again")
    })
}

/// One sealed step of an agent-device command for the screen on another machine.
async fn device_step(
    router: &Router,
    thread: &str,
    frame: &BrowserCallFrame,
    call: DeviceCall,
) -> Result<DeviceDone, McpToolError> {
    let (key, count) = {
        let mut remotes = router.remotes.lock();
        let remote = remotes.get_mut(thread).ok_or_else(|| {
            McpToolError::new(
                ErrorCode::NotFound,
                "Your iOS screen on another machine has ended.",
            )
        })?;
        remote.count += 1;
        (remote.relay_key.clone(), remote.count)
    };
    let mut step = frame.clone();
    step.call = BrowserCall::Device(remote_device::seal_call(&key, count, &call));
    let answer = forward_device(router, thread, step).await?;
    match (answer.result, answer.error) {
        (Some(BrowserCallResult::Device(done)), _) => remote_device::open_done(&key, count, done)
            .ok_or_else(|| {
                McpToolError::new(
                    ErrorCode::Failed,
                    "The screen's answer did not open with this session's key.",
                )
                .with_fix("try again; if it keeps failing, end the session and start another")
            }),
        (_, Some(error)) => Err(error),
        _ => Err(McpToolError::new(
            ErrorCode::Failed,
            "the screen's node answered with another call's result",
        )),
    }
}

/// An agent-device command of the agent's for its screen on another machine: the files it reads go from the worktree
/// first, it runs there, and the files it wrote come back into the worktree. One command at a time per agent session.
async fn run_elsewhere(
    router: &Arc<Router>,
    thread: &str,
    frame: &BrowserCallFrame,
    args: &[String],
) -> Result<DeviceDone, McpToolError> {
    let turn = router
        .remotes
        .lock()
        .get(thread)
        .map(|r| r.turn.clone())
        .ok_or_else(|| {
            McpToolError::new(
                ErrorCode::NotFound,
                "Your iOS screen on another machine has ended.",
            )
        })?;
    let _turn = turn.lock().await;
    let worktree = {
        let (worktree_of, thread) = (router.worktree_of.clone(), thread.to_owned());
        tokio::task::spawn_blocking(move || worktree_of(&thread))
            .await
            .ok()
            .flatten()
    }
    .ok_or_else(|| {
        McpToolError::new(
            ErrorCode::Failed,
            "The node doesn't know this session's worktree.",
        )
        .with_fix("say so in your result")
    })?;
    let mut seq = router.remotes.lock().get(thread).map_or(0, |r| r.seq);
    let mapped = remote_device::map(args, Path::new(frame.cwd.as_str()), &worktree, &mut seq)?;
    if let Some(remote) = router.remotes.lock().get_mut(thread) {
        remote.seq = seq;
    }
    for input in &mapped.inputs {
        let bytes = tokio::fs::read(&input.path).await.map_err(|e| {
            McpToolError::new(
                ErrorCode::Failed,
                format!("{} can't be read: {e}.", input.shown),
            )
        })?;
        let mut offset = 0u64;
        let mut pieces = bytes.chunks(remote_device::PIECE).peekable();
        if pieces.peek().is_none() {
            device_step(
                router,
                thread,
                frame,
                DeviceCall::Put {
                    name: input.name.clone(),
                    offset,
                    data_b64: String::new(),
                },
            )
            .await?;
        }
        for piece in pieces {
            let call = DeviceCall::Put {
                name: input.name.clone(),
                offset,
                data_b64: B64.encode(piece),
            };
            device_step(router, thread, frame, call).await?;
            offset += piece.len() as u64;
        }
    }
    let run = DeviceCall::Run {
        args: mapped.args.clone(),
    };
    let DeviceDone::Run {
        stdout,
        stderr,
        exit_code,
        files,
    } = device_step(router, thread, frame, run).await?
    else {
        return Err(McpToolError::new(
            ErrorCode::Failed,
            "the screen's node answered the command with another step's answer",
        ));
    };
    if let Some(remote) = router.remotes.lock().get_mut(thread) {
        for output in &mapped.outputs {
            remote.outputs.insert(output.name.clone(), output.clone());
        }
    }
    let mut notes = String::new();
    let mut back: Vec<(remote_device::Local, u64)> = Vec::new();
    for file in files {
        let local = router
            .remotes
            .lock()
            .get_mut(thread)
            .and_then(|r| r.outputs.remove(&file.name));
        let Some(local) = local else {
            continue;
        };
        match fetch(router, thread, frame, &file.name).await {
            Ok(bytes) => match remote_device::write_output(&worktree, &local.path, &bytes) {
                Ok(()) => back.push((local, bytes.len() as u64)),
                Err(why) => {
                    notes.push_str(&format!("fleetd: {} was not written: {why}\n", local.shown))
                }
            },
            Err(error) => notes.push_str(&format!(
                "fleetd: {} did not come back: {}\n",
                local.shown, error.message
            )),
        }
    }
    let named: Vec<&remote_device::Local> = mapped
        .inputs
        .iter()
        .chain(&mapped.outputs)
        .chain(back.iter().map(|(l, _)| l))
        .collect();
    Ok(DeviceDone::Run {
        stdout: remote_device::shown_back(&stdout, &named),
        stderr: remote_device::shown_back(&stderr, &named) + &notes,
        exit_code,
        files: back
            .iter()
            .map(|(local, bytes)| DeviceFile {
                name: local.shown.clone(),
                bytes: *bytes,
            })
            .collect(),
    })
}

/// A file the command wrote on the screen's node, a piece at a time.
async fn fetch(
    router: &Router,
    thread: &str,
    frame: &BrowserCallFrame,
    name: &str,
) -> Result<Vec<u8>, McpToolError> {
    let mut bytes = Vec::new();
    loop {
        let call = DeviceCall::Get {
            name: name.to_owned(),
            offset: bytes.len() as u64,
        };
        let DeviceDone::Get { data_b64, total } = device_step(router, thread, frame, call).await?
        else {
            return Err(McpToolError::new(ErrorCode::Failed, "not a file's piece"));
        };
        let piece = B64
            .decode(data_b64)
            .map_err(|e| McpToolError::new(ErrorCode::Failed, format!("not base64: {e}")))?;
        if total > remote_device::FILE_MAX || (piece.is_empty() && (bytes.len() as u64) < total) {
            return Err(McpToolError::new(
                ErrorCode::Failed,
                "the file is too large, or stopped short",
            ));
        }
        bytes.extend(piece);
        if bytes.len() as u64 >= total {
            return Ok(bytes);
        }
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
    /// agent-browser's and agent-device's (node/device), and first of all on the PATH the folder that holds the
    /// forwarding agent-device while the session's iOS screen runs on another machine (and isn't there otherwise).
    fn env(&self, thread: &str, path: Option<&str>) -> Vec<(String, String)> {
        let mut env = self.here().env(thread, path);
        let forwarder = remote_device::bin_dir(&self.home, thread)
            .to_string_lossy()
            .into_owned();
        match env.iter_mut().find(|(k, _)| k == "PATH") {
            Some((_, value)) => *value = format!("{forwarder}:{value}"),
            None => env.push((
                "PATH".to_owned(),
                match path.filter(|p| !p.is_empty()) {
                    Some(path) => format!("{forwarder}:{path}"),
                    None => forwarder,
                },
            )),
        }
        env
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

    /// A Navi's browser runs here, on its kept profile and inside its folder's fence: never on another machine. Its iOS
    /// screens keep their agent-device home in its session's folder, which its sandbox writes.
    fn navi(&self, thread: &str, navi: &str, folder: &std::path::Path) {
        if let Some(broker) = &self.broker {
            broker.navi(thread, navi, folder);
        }
        if let Some(ios) = &self.ios {
            ios.navi(thread);
        }
    }

    fn forget_signins(&self, navi: &str) -> Option<super::browser::Forgetting> {
        SessionHooks::forget_signins(self.broker.as_ref()?.as_ref(), navi)
    }

    /// The agent's claude exited: its session ends, here or on the machine hosting it.
    fn ended(&self, thread: &str) {
        self.filled_elsewhere.lock().remove(thread);
        if self.remotes.has(thread) {
            self.end_device(thread);
        }
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
        broker.not_navi(thread);
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
        let device = self
            .remotes
            .lock()
            .get(thread)
            .is_some_and(|r| r.session_id == session);
        if device {
            self.end_device(thread);
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
    /// The agent's last sealed device step: each must come after it.
    device_count: u64,
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
/// answer to send back. `navi_folder` is the folder of a Navi of this machine's, by its project: a person's browser
/// screen for that Navi runs on its kept profile, fenced in it.
pub async fn host(
    broker: Option<Arc<Broker>>,
    sessions: Option<Arc<device::Router>>,
    hub: &str,
    frame: HubToNode,
    hosted: &Hosted,
    box_key: Option<&NodeBoxKey>,
    navi_folder: impl Fn(&str) -> Option<PathBuf>,
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
                // Only the hub's own word opens a Navi's profile (a person's screen_open, D239): never anything sealed,
                // which any node can make for any runner.
                if let Some(navi) = host.navi.as_ref().map(|n| n.to_string()) {
                    let browser = matches!(
                        &host.frame.call,
                        BrowserCall::SessionStart(start)
                            if start.kind.is_none_or(|k| k == SessionKind::Browser)
                    );
                    let folder = navi_folder(&navi);
                    let (Some(broker), Some(folder), true) = (&broker, folder, browser) else {
                        return Some(SessionHostResult {
                            id: host.id,
                            frame: refuse(
                                &host.frame.id,
                                &format!("this machine has no Navi {navi} with a browser to open"),
                            ),
                        });
                    };
                    SessionHooks::navi(broker.as_ref(), &key, &navi, &folder);
                }
                hosted.lock().insert(
                    key.clone(),
                    HostedSession {
                        secrets: Some(Secrets(seal.secrets.clone())),
                        relay_key: zeroize::Zeroizing::new(relay_key),
                        device_count: 0,
                    },
                );
            }
            // A device step runs only sealed by the agent's node, after its last: never one the hub made up or played
            // again. Its answer goes back sealed.
            let mut host = host;
            let device = match &host.frame.call {
                BrowserCall::Device(DeviceCall::Sealed { count, data_b64 }) => {
                    let count = *count;
                    let opened = {
                        let mut all = hosted.lock();
                        all.get_mut(&key)
                            .filter(|h| count > h.device_count)
                            .and_then(|h| {
                                let call = remote_device::open_call(&h.relay_key, count, data_b64)?;
                                h.device_count = count;
                                Some((call, h.relay_key.clone()))
                            })
                    };
                    let Some((call, relay_key)) = opened else {
                        return Some(SessionHostResult {
                            id: host.id,
                            frame: refuse(
                                &host.frame.id,
                                "the device step did not open with this session's key, or came again",
                            ),
                        });
                    };
                    host.frame.call = BrowserCall::Device(call);
                    Some((count, relay_key))
                }
                BrowserCall::Device(_) => {
                    return Some(SessionHostResult {
                        id: host.id,
                        frame: refuse(
                            &host.frame.id,
                            "device steps come sealed by the agent's node",
                        ),
                    });
                }
                _ => None,
            };
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
            let mut frame = frame;
            if let (Some((count, relay_key)), Some(BrowserCallResult::Device(done))) =
                (&device, &mut frame.result)
            {
                *done = remote_device::seal_done(relay_key, *count, done);
            }
            match call {
                // The broker read them at the start: they leave this node's memory now.
                "session_start" if frame.result.is_some() => {
                    if let Some(h) = hosted.lock().get_mut(&key) {
                        h.secrets = None;
                    }
                }
                "session_start" | "session_end" => {
                    hosted.lock().remove(&key);
                    if let Some(broker) = &broker {
                        broker.not_navi(&key);
                    }
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
    use serde_json::Value;

    #[test]
    fn the_node_waits_past_the_hub_and_its_cancel() {
        use crate::hub::machine_roles::calls::{CANCEL_WAIT, START_WAIT};
        assert!(ROUTE_WAIT >= START_WAIT + CANCEL_WAIT + Duration::from_secs(30));
    }

    #[test]
    fn a_device_command_ends_on_its_machine_before_the_hub_or_the_node_stop_waiting() {
        use crate::hub::machine_roles::calls::DEVICE_WAIT;
        assert!(remote_device::RUN_WAIT + Duration::from_secs(5) <= DEVICE_WAIT);
        assert!(DEVICE_WAIT + Duration::from_secs(30) <= ROUTE_WAIT);
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
            home: PathBuf::from("/nonexistent/node"),
            worktree_of: Arc::new(|_| None),
            remotes: Remotes::default(),
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

    /// A Navi's browser runs on its own node, inside its fence, even with a hub that places sessions: the hub isn't
    /// asked, and the broker here answers (it has no browser yet).
    #[tokio::test(start_paused = true)]
    async fn a_navis_session_stays_here_whatever_the_hub_would_place() {
        let home = tempfile::tempdir().unwrap();
        let relay = LeadRelay::new();
        relay.set_hub_caps(vec![HUB_CAP_SESSION_ROUTE.to_owned()]);
        let broker = broker(home.path()).await;
        SessionHooks::navi(broker.as_ref(), "th-1", "ada", home.path());
        let answer = route(router(relay, Some(broker)), "th-1".into(), start()).await;
        let error = answer.error.unwrap();
        assert_ne!(error.code, ErrorCode::MachineOffline, "{}", error.message);
        assert!(error.message.contains("browser"), "{}", error.message);
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
                device_count: 0,
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
                device_count: 0,
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

    const HOST_KEY: &str = "H0123456789abcdef0123456789abcdef";
    const SCREEN: &str = "B0123456789abcdef0123456789abcdef";

    fn host_frame(call: Value) -> HubToNode {
        serde_json::from_value(json!({
            "t": "session_host", "id": "h1", "hostKey": HOST_KEY,
            "frame": { "id": "1", "cwd": "/work/app", "call": call },
        }))
        .unwrap()
    }

    /// The screen's node runs a device step only sealed with its session's relay key, and each only once: the hub
    /// can neither make one up nor play one again.
    #[tokio::test]
    async fn a_device_step_runs_only_sealed_by_the_agents_node_and_only_once() {
        let hosted = Hosted::default();
        hosted.lock().insert(
            HOST_KEY.to_owned(),
            HostedSession {
                secrets: None,
                relay_key: zeroize::Zeroizing::new([7; 32]),
                device_count: 0,
            },
        );
        let sessions = Arc::new(device::Router {
            browser: None,
            devices: None,
            ios: None,
            live: Default::default(),
            desktops: None,
        });
        let send = |call: DeviceCall| {
            let (sessions, hosted) = (sessions.clone(), hosted.clone());
            async move {
                let call = serde_json::to_value(BrowserCall::Device(call)).unwrap();
                host(
                    None,
                    Some(sessions),
                    "http://devbox:4790",
                    host_frame(call),
                    &hosted,
                    None,
                    |_| None,
                )
                .await
                .unwrap()
                .frame
                .error
                .unwrap()
                .message
            }
        };
        let run = DeviceCall::Run {
            args: vec!["snapshot".into()],
        };
        assert!(send(run.clone()).await.contains("come sealed"));
        let wrong_key = remote_device::seal_call(&[8; 32], 1, &run);
        assert!(send(wrong_key).await.contains("did not open"));
        // Opened, it reaches the screen's sessions (none here, so none is open).
        let sealed = remote_device::seal_call(&[7; 32], 1, &run);
        assert_eq!(send(sealed.clone()).await, "No iOS session is open.");
        assert!(send(sealed).await.contains("came again"));
        assert_eq!(
            send(remote_device::seal_call(&[7; 32], 2, &run)).await,
            "No iOS session is open."
        );
    }

    /// A hub whose runner hosts the agent's iOS screen: each device step is opened with the session's relay key and
    /// done in `work` with `program`, as the runner's node does, and its answer sealed back. The ops it got, in order.
    fn screen_elsewhere(
        relay: &LeadRelay,
        key: [u8; 32],
        work: remote_device::Work,
        program: PathBuf,
    ) -> (crate::node::lead::Attached, Arc<Mutex<Vec<String>>>) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let attached = relay.attach(tx);
        let ops: Arc<Mutex<Vec<String>>> = Arc::default();
        let (relay, seen) = (relay.clone(), ops.clone());
        tokio::spawn(async move {
            let mut last = 0;
            while let Some(line) = rx.recv().await {
                let Ok(fleetd_contracts::node_link::NodeToHub::LeadCall(frame)) =
                    serde_json::from_str(&line)
                else {
                    continue;
                };
                let LeadCall::SessionRoute(routed) = frame.call else {
                    continue;
                };
                let answer = match routed.frame.call {
                    BrowserCall::Device(DeviceCall::Sealed { count, data_b64 }) => {
                        assert!(count > last, "steps in order");
                        last = count;
                        let call = remote_device::open_call(&key, count, &data_b64)
                            .expect("sealed with the key");
                        seen.lock().unwrap().push(match &call {
                            DeviceCall::Run { args } => format!("run {}", args.join(" ")),
                            DeviceCall::Put { name, offset, .. } => format!("put {name} {offset}"),
                            DeviceCall::Get { name, offset } => format!("get {name} {offset}"),
                            DeviceCall::Sealed { .. } => unreachable!(),
                        });
                        let done = match call {
                            DeviceCall::Run { args } => match work.check(&args, true) {
                                Ok(()) => Ok(work
                                    .run(&program, &[], &args, remote_device::RUN_WAIT)
                                    .await
                                    .done()),
                                Err(e) => Err(e),
                            },
                            other => work.step(other),
                        };
                        match done {
                            Ok(done) => json!({ "id": "1", "result": {
                                "op": "device", "step": "sealed",
                                "dataB64": match remote_device::seal_done(&key, count, &done) {
                                    DeviceDone::Sealed { data_b64 } => data_b64,
                                    _ => unreachable!(),
                                },
                            }}),
                            Err(e) => json!({ "id": "1", "error": e }),
                        }
                    }
                    BrowserCall::SessionEnd(_) => {
                        seen.lock().unwrap().push("session_end".into());
                        json!({ "id": "1", "result": {
                            "op": "session_end", "sessionId": SCREEN, "kind": "ios", "files": [],
                        }})
                    }
                    other => panic!("not for the screen: {other:?}"),
                };
                relay.resolve(
                    serde_json::from_value(json!({
                        "id": frame.id,
                        "result": { "op": "session_route", "runner": "mac1", "here": false, "answer": answer },
                    }))
                    .unwrap(),
                );
            }
        });
        (attached, ops)
    }

    /// An agent on devbox drives its iOS screen on mac1 with agent-device: its app goes from its worktree, in pieces;
    /// the command runs there; the screenshot it took comes back into the worktree under the name it gave. Anything
    /// else is refused before a step leaves, and the screen's end takes the forwarding agent-device away.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_agents_command_for_its_ios_screen_elsewhere_runs_there_with_its_files() {
        const THREAD: &str = "th-agent-1";
        let dir = tempfile::tempdir().unwrap();
        let (home, worktree, mac) = (
            dir.path().join("node"),
            dir.path().join("work"),
            dir.path().join("mac"),
        );
        std::fs::create_dir_all(worktree.join("build")).unwrap();
        let app = vec![b'z'; remote_device::PIECE + 5];
        std::fs::write(worktree.join("build/app.zip"), &app).unwrap();
        // As agent-device does, it reads the app in its daemon's working directory, not the command's: the session's
        // daemon starts at session_start, in the node's.
        let program = dir.path().join("agent-device");
        std::fs::write(
            &program,
            "#!/bin/sh\n\
             case \"$1\" in\n\
             install) cd \"${0%/*}\"; [ -f \"$2\" ] || { echo \"App binary not found: $PWD/$2\" >&2; exit 1; }\n\
             echo \"Installed $2: $(wc -c < \"$2\" | tr -d ' ') bytes\";;\n\
             screenshot) printf PNG > \"$2\"; echo \"Saved $2\";;\n\
             *) echo \"ran $*\";;\n\
             esac\n",
        )
        .unwrap();
        std::fs::set_permissions(
            &program,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let key = [9u8; 32];
        let relay = LeadRelay::new();
        let (_link, ops) = screen_elsewhere(
            &relay,
            key,
            remote_device::Work::at(&mac, HOST_KEY),
            program,
        );
        let mut router = router(relay, None);
        let tree = worktree.clone();
        let r = Arc::get_mut(&mut router).unwrap();
        r.home = home.clone();
        r.worktree_of = Arc::new(move |_| Some(tree.clone()));
        router.remotes.lock().insert(
            THREAD.to_owned(),
            RemoteDevice::new(SCREEN.into(), zeroize::Zeroizing::new(key)),
        );
        remote_device::install_forwarder(&home, THREAD, "/n/bin/fleetd-agent-1").unwrap();
        let env = SessionHooks::env(router.as_ref(), THREAD, Some("/usr/bin"));
        let path = &env.iter().find(|(k, _)| k == "PATH").unwrap().1;
        assert!(
            path.starts_with(&format!(
                "{}:",
                remote_device::bin_dir(&home, THREAD).display()
            )),
            "the forwarder first: {path}"
        );
        let call = |call: Value, cwd: &Path| {
            let frame: BrowserCallFrame = serde_json::from_value(json!({
                "id": "c1", "cwd": cwd, "threadId": THREAD, "call": call,
            }))
            .unwrap();
            let router = router.clone();
            async move { serde_json::to_value(route(router, THREAD.to_owned(), frame).await).unwrap() }
        };
        let run = |args: &[&str]| json!({ "op": "device", "step": "run", "args": args });

        let installed = call(run(&["install", "app.zip"]), &worktree.join("build")).await;
        assert_eq!(
            installed["result"]["stdout"],
            format!("Installed app.zip: {} bytes\n", app.len()),
            "{installed}"
        );
        let shot = call(run(&["screenshot", "shots/home.png"]), &worktree).await;
        assert_eq!(shot["result"]["stdout"], "Saved shots/home.png\n", "{shot}");
        assert_eq!(
            shot["result"]["files"],
            json!([{ "name": "shots/home.png", "bytes": 3 }])
        );
        assert_eq!(
            std::fs::read(worktree.join("shots/home.png")).unwrap(),
            b"PNG"
        );
        assert_eq!(
            *ops.lock().unwrap(),
            vec![
                "put 1-app.zip 0".to_owned(),
                format!("put 1-app.zip {}", remote_device::PIECE),
                "run install in/1-app.zip".to_owned(),
                "run screenshot out/2-home.png".to_owned(),
                "get 2-home.png 0".to_owned(),
            ]
        );

        // Refused on devbox, before anything goes: a file outside the worktree, a command that doesn't drive the
        // screen, a file step of the agent's own.
        let outside = call(run(&["install", "/etc/hosts"]), &worktree).await;
        assert!(
            outside["error"]["message"]
                .as_str()
                .unwrap()
                .contains("outside your worktree"),
            "{outside}"
        );
        let shell = call(run(&["batch", "--steps", "[]"]), &worktree).await;
        assert!(
            shell["error"]["message"]
                .as_str()
                .unwrap()
                .contains("doesn't run here"),
            "{shell}"
        );
        let put = call(
            json!({ "op": "device", "step": "put", "name": "x", "offset": 0, "dataB64": "" }),
            &worktree,
        )
        .await;
        assert_eq!(put["error"]["code"], "forbidden", "{put}");
        assert_eq!(ops.lock().unwrap().len(), 5, "none of them reached mac1");

        // The agent's claude exits: the screen ends there, and its forwarder goes here.
        SessionHooks::ended(router.as_ref(), THREAD);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while router.remotes.has(THREAD) {
            assert!(std::time::Instant::now() < deadline, "not ended");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            ops.lock().unwrap().last().map(String::as_str),
            Some("session_end")
        );
        assert!(!remote_device::bin_dir(&home, THREAD).exists());
        let after = call(run(&["snapshot"]), &worktree).await;
        assert_eq!(after["error"]["code"], "not_found", "{after}");
    }

    #[test]
    fn only_a_hosted_key_gets_the_empty_masker() {
        assert!(host_masker("H0123456789abcdef0123456789abcdef").is_some());
        assert!(host_masker("019a2b3c-0000-7000-8000-000000000000").is_none());
        assert!(host_masker("Hello").is_none());
    }
}
