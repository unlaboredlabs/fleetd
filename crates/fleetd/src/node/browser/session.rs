//! One live browser session: its Chrome, the node's pipe connection to it, the page it follows (the newest page
//! target; when that closes, the one before), the screencast that feeds the video, and the action log: a line per
//! tool call of the agent's that drove the browser (its `agent-browser` commands, fleetd's session tools), each
//! followed by the page's DOM.
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::browser::{
    BrowserAction, BrowserControl, BrowserFrame, BrowserInput, BrowserSessionId, DomSnapshot,
    FrameBox, KeyAction, MouseAction, MouseButton, RecordingFile, SessionKind, StepTarget,
};
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::node_link::NodeToHub;
use fleetd_contracts::prim::{Int, NonEmpty, Text};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::cdp::{Cdp, Event};
use super::chrome::{Browser, HEIGHT, WIDTH};
use super::record::{self, Meta, Scrub, VideoSink};
use crate::node::mask::Secrets;
use crate::node::util::AbortOnDrop;
use crate::node::wire::to_json;

/// The start of a result's text the action log keeps.
const RESULT_CHARS: usize = 500;
/// A page's HTML past this is cut in the DOM trace.
const DOM_MAX_BYTES: usize = 2 << 20;
/// The longest the proxy holds the driver's click or keystroke to read the element it acts on.
const TARGET_WAIT: Duration = Duration::from_millis(250);
/// What Chrome answers `Page.startScreencast` on a page between renderers, and the longest a page's start waits it out.
const NO_ACTIVE_PAGE: &str = "Not attached to an active page";
const SCREENCAST_START: Duration = Duration::from_secs(10);
/// What the agent's driver hears while a person has control.
pub const PAUSED: &str = "A person has control of the browser now. Wait for them to hand it back (carry on with other \
                          work meanwhile); your next command after that sees the page as they left it.";

/// The page the session follows, and the pages before it.
#[derive(Default)]
struct Pages {
    /// (targetId, CDP sessionId), oldest first; the last is followed.
    stack: Vec<(String, String)>,
}

impl Pages {
    fn current(&self) -> Option<&(String, String)> {
        self.stack.last()
    }
}

pub struct Session {
    pub id: BrowserSessionId,
    pub thread: String,
    pub cwd: String,
    pub purpose: String,
    pub started_at: Timestamp,
    pub start: Instant,
    pub dir: PathBuf,
    pub cdp: Arc<Cdp>,
    /// A Navi's session: what its browser may touch on this machine (local.rs).
    pub fence: Option<Arc<super::local::Fence>>,
    browser: Mutex<Option<Browser>>,
    pages: Arc<Mutex<Pages>>,
    video: Option<VideoSink>,
    /// Why the recording lacks something, e.g. its video.
    note: Mutex<Option<String>>,
    seq: AtomicU64,
    control: Mutex<BrowserControl>,
    /// Its own secrets, then every value filled into its browser; wiped when the session goes.
    secrets: Mutex<Secrets>,
    scrub: Mutex<Arc<Scrub>>,
    pub credentials_filled: AtomicU64,
    /// The fields filled from 1Password, by `backendNodeId`: the driver may not write to them.
    filled_fields: Mutex<std::collections::HashSet<i64>>,
    last_active: Mutex<Instant>,
    /// The hash of the last DOM snapshot written: an unchanged page isn't written again.
    last_dom: Mutex<Option<[u8; 32]>>,
    /// One DOM capture at a time, in order.
    dom_turn: tokio::sync::Mutex<()>,
    /// The live view: who watches, and the newest frame.
    live: Mutex<Live>,
    /// Called when control changes here (a handback completes): the broker tells the hub.
    on_control: Mutex<Option<ControlHook>>,
    /// The element the driver's input acted on since the last step, until that step is logged.
    target: Mutex<Option<StepTarget>>,
    /// A person's input, applied one at a time in the order it came: a click focuses before the typing after it.
    inputs: tokio::sync::mpsc::UnboundedSender<BrowserInput>,
    _inputs: Mutex<Option<AbortOnDrop>>,
    /// The DOM captures after each step, taken one at a time in order; `close` waits for those queued.
    captures: tokio::sync::mpsc::UnboundedSender<Capture>,
    _captures: Mutex<Option<AbortOnDrop>>,
    _screencast: Mutex<Option<AbortOnDrop>>,
    _ticker: Mutex<Option<AbortOnDrop>>,
}

pub type ControlHook = Arc<dyn Fn(BrowserControl) + Send + Sync>;

/// The live view's state.
#[derive(Default)]
struct Live {
    /// The hub's link's frame slot, while the hub watches the session: its newest `browser_frame` waits there.
    watcher: Option<Arc<super::FrameSlot>>,
    seq: u64,
    last: Option<BrowserFrame>,
    /// The page's size in CSS pixels, as the last frame's metadata gave it: a person's input is scaled to it.
    page: (f64, f64),
    /// Each page's address, by target, as the browser last said: the followed one's goes on its frames.
    urls: std::collections::HashMap<String, String>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub struct Opened {
    pub id: BrowserSessionId,
    pub thread: String,
    pub cwd: String,
    pub purpose: String,
    pub dir: PathBuf,
    pub ffmpeg: Option<PathBuf>,
    /// The agent session's secrets (its project's, its order's, its MCP servers').
    pub secrets: Secrets,
    /// A Navi's session: what its browser may touch on this machine, put on before any driver reaches it.
    pub fence: Option<super::local::Fence>,
}

impl Session {
    /// Connects to a launched browser, follows its page and starts recording.
    pub async fn open(browser: Browser, opened: Opened) -> Result<Arc<Self>, String> {
        let mut stages = crate::stages::Stages::new("node browser open");
        stages.id(opened.id.as_str());
        let cdp = browser.cdp.clone();
        std::fs::create_dir_all(&opened.dir)
            .map_err(|e| format!("cannot make {}: {e}", opened.dir.display()))?;
        let (video, note) = match VideoSink::start(
            opened.ffmpeg.as_deref(),
            opened.dir.join(RecordingFile::Video.file_name()),
            (WIDTH, HEIGHT),
        ) {
            Ok(video) => (Some(video), None),
            Err(why) => (None, Some(why)),
        };
        stages.done("recorder");
        let started_at = Timestamp(crate::node::util::now_iso());
        let scrub = Arc::new(Scrub::new(&opened.secrets.0));
        let (inputs, mut queued) = tokio::sync::mpsc::unbounded_channel::<BrowserInput>();
        let (captures, mut steps) = tokio::sync::mpsc::unbounded_channel::<Capture>();
        let session = Arc::new(Self {
            id: opened.id,
            thread: opened.thread,
            cwd: opened.cwd,
            purpose: opened.purpose,
            started_at,
            start: Instant::now(),
            dir: opened.dir,
            cdp: cdp.clone(),
            fence: opened.fence.map(Arc::new),
            browser: Mutex::new(Some(browser)),
            pages: Arc::default(),
            video,
            note: Mutex::new(note),
            seq: AtomicU64::new(0),
            control: Mutex::default(),
            scrub: Mutex::new(scrub),
            secrets: Mutex::new(opened.secrets),
            credentials_filled: AtomicU64::new(0),
            filled_fields: Mutex::default(),
            last_active: Mutex::new(Instant::now()),
            last_dom: Mutex::default(),
            dom_turn: tokio::sync::Mutex::new(()),
            _screencast: Mutex::default(),
            _ticker: Mutex::default(),
            live: Mutex::default(),
            on_control: Mutex::default(),
            inputs,
            _inputs: Mutex::default(),
            captures,
            _captures: Mutex::default(),
            target: Mutex::default(),
        });
        {
            let weak = Arc::downgrade(&session);
            *lock(&session._captures) = Some(AbortOnDrop(tokio::spawn(async move {
                while let Some(capture) = steps.recv().await {
                    match capture {
                        Capture::Step(seq, target) => {
                            let Some(session) = weak.upgrade() else {
                                return;
                            };
                            session.capture_dom(seq, target).await;
                        }
                        Capture::Flush(done) => {
                            let _ = done.send(());
                        }
                    }
                }
            })));
        }
        {
            let weak = Arc::downgrade(&session);
            *lock(&session._inputs) = Some(AbortOnDrop(tokio::spawn(async move {
                while let Some(input) = queued.recv().await {
                    let Some(session) = weak.upgrade() else {
                        return;
                    };
                    if let Err(why) = session.input(input).await {
                        tracing::debug!(session = %session.id, error = %why, "browser input not delivered");
                    }
                }
            })));
        }
        // Listen before discovering: the existing page arrives as a targetCreated event.
        let events = cdp.events();
        *lock(&session._screencast) = Some(AbortOnDrop(tokio::spawn(screencast(
            Arc::downgrade(&session),
            events,
        ))));
        cdp.call(
            None,
            "Target.setDiscoverTargets",
            json!({ "discover": true }),
        )
        .await?;
        stages.done("discover");
        // The page is followed once attached; wait for it so the agent's first call is recorded.
        let deadline = Instant::now() + Duration::from_secs(5);
        while lock(&session.pages).current().is_none() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        stages.done("page");
        if let Some(video) = session.video.clone() {
            let start = session.start;
            *lock(&session._ticker) = Some(AbortOnDrop(tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    video.tick(start.elapsed());
                }
            })));
        }
        session.write_meta(None);
        Ok(session)
    }

    pub fn offset_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    pub fn touch(&self) {
        *lock(&self.last_active) = Instant::now();
    }

    pub fn idle_for(&self) -> Duration {
        lock(&self.last_active).elapsed()
    }

    pub fn control(&self) -> BrowserControl {
        *lock(&self.control)
    }

    pub fn set_control(&self, control: BrowserControl) {
        *lock(&self.control) = control;
    }

    pub fn on_control(&self, hook: ControlHook) {
        *lock(&self.on_control) = Some(hook);
    }

    /// The followed page's address for its frames, scrubbed as everything else the session sends, so a value a
    /// form submits by GET, or a redirect puts in a query string, never reaches the hub. Once the session filled a
    /// credential, its query and fragment go too: a value may be there in a form the scrubber doesn't know.
    fn frame_url(&self, live: &Live) -> Option<Text<0, 2000>> {
        let (target, _) = self.page()?;
        let mut url = self.scrub().text(live.urls.get(&target)?);
        if self.credentials_filled.load(Ordering::Relaxed) > 0 {
            url = without_query(&url).to_owned();
        }
        Some(Text::unchecked(url.chars().take(2000).collect::<String>()))
    }

    /// Sends this session's frames to the hub from now on (`Some`), the newest at once, or no more.
    pub fn set_watcher(&self, watcher: Option<Arc<super::FrameSlot>>) {
        let mut live = lock(&self.live);
        live.watcher = watcher;
        if live.watcher.is_some() {
            tracing::debug!(target: "fleetd::stages", screen = %self.id, ms = self.offset_ms(), frame = live.last.is_some(), "browser watched");
        }
        if let (Some(watcher), Some(last)) = (&live.watcher, &live.last) {
            let mut last = last.clone();
            // As things are now: a still page sends no new frame, so the newest says who drives and where it is.
            last.control = self.control();
            last.url = self.frame_url(&live);
            watcher.replace(self.id.as_str(), to_json(&NodeToHub::BrowserFrame(last)));
        }
    }

    /// One screencast frame of the followed page: kept as the newest, and sent while the hub watches.
    fn live_frame(&self, data: &str, jpeg: &[u8], metadata: &Value) {
        let Some((width, height)) = jpeg_size(jpeg) else {
            return;
        };
        let mut live = lock(&self.live);
        live.seq += 1;
        if live.seq == 1 {
            tracing::debug!(target: "fleetd::stages", screen = %self.id, ms = self.offset_ms(), watched = live.watcher.is_some(), "browser's first frame");
        }
        let css = |key: &str, or: u32| {
            metadata[key]
                .as_f64()
                .filter(|v| *v > 0.0)
                .unwrap_or(f64::from(or))
        };
        live.page = (css("deviceWidth", width), css("deviceHeight", height));
        let frame = BrowserFrame {
            session_id: self.id.clone(),
            seq: live.seq,
            jpeg_b64: NonEmpty::unchecked(data),
            width: Int::unchecked(i64::from(width)),
            height: Int::unchecked(i64::from(height)),
            url: self.frame_url(&live),
            control: self.control(),
        };
        // Only this session still holds the slot: its link went, and the hub watches again on the next one.
        if live
            .watcher
            .as_ref()
            .is_some_and(|w| Arc::strong_count(w) == 1)
        {
            live.watcher = None;
        }
        if let Some(watcher) = &live.watcher {
            watcher.replace(
                self.id.as_str(),
                to_json(&NodeToHub::BrowserFrame(frame.clone())),
            );
        }
        live.last = Some(frame);
    }

    /// Queues a person's input behind what came before it.
    pub fn queue_input(&self, input: BrowserInput) {
        let _ = self.inputs.send(input);
    }

    /// A person's input, on the followed page, while they have control. Coordinates come in the last frame's pixels.
    pub async fn input(&self, input: BrowserInput) -> Result<(), String> {
        if self.control() != BrowserControl::Human {
            return Err("the agent has control".into());
        }
        let Some((_, page)) = self.page() else {
            return Err("no page".into());
        };
        let (scale_x, scale_y) = {
            let live = lock(&self.live);
            match &live.last {
                Some(last) => (
                    live.page.0 / last.width.get() as f64,
                    live.page.1 / last.height.get() as f64,
                ),
                None => (1.0, 1.0),
            }
        };
        self.touch();
        let (method, params) = cdp_input(&input, scale_x, scale_y);
        self.cdp.call(Some(&page), method, params).await.map(drop)
    }

    pub fn scrub(&self) -> Arc<Scrub> {
        lock(&self.scrub).clone()
    }

    /// A value the session must never show: scrubbed from everything recorded or answered from now on.
    pub fn add_secret(&self, name: &str, value: &str) {
        let mut secrets = lock(&self.secrets);
        if secrets.0.iter().any(|(_, v)| v == value) {
            return;
        }
        secrets.0.push((name.to_owned(), value.to_owned()));
        *lock(&self.scrub) = Arc::new(Scrub::new(&secrets.0));
    }

    /// A field the node fills from 1Password, by its `backendNodeId`.
    pub fn filled_field(&self, backend: i64) {
        lock(&self.filled_fields).insert(backend);
    }

    pub fn is_filled_field(&self, backend: i64) -> bool {
        lock(&self.filled_fields).contains(&backend)
    }

    /// The page the session follows: (targetId, CDP sessionId).
    pub fn page(&self) -> Option<(String, String)> {
        lock(&self.pages).current().cloned()
    }

    pub fn note(&self) -> Option<String> {
        lock(&self.note).clone()
    }

    fn set_note(&self, note: String) {
        let mut held = lock(&self.note);
        *held = Some(match held.take() {
            Some(before) => format!("{before}; {note}"),
            None => note,
        });
    }

    pub fn meta(&self, ended_at: Option<String>) -> Meta {
        Meta {
            session_id: self.id.to_string(),
            kind: SessionKind::Browser,
            thread_id: self.thread.clone(),
            cwd: self.cwd.clone(),
            purpose: self.purpose.clone(),
            started_at: self.started_at.to_string(),
            ended_at,
            credentials_filled: self.credentials_filled.load(Ordering::Relaxed),
            note: self.note(),
        }
    }

    pub fn write_meta(&self, ended_at: Option<String>) {
        if let Err(e) = record::write_meta(&self.dir, &self.meta(ended_at)) {
            tracing::warn!(session = %self.id, error = %e, "browser session file not written");
        }
    }

    /// What the proxy answers the driver's command with instead of sending it on, if anything: what a session that
    /// filled a credential refuses (credentials.rs), and while a person has control, every command.
    pub fn refusal(&self, method: &str, params: &Value) -> Option<String> {
        if let Some(why) = super::credentials::refusal(self, method, params) {
            return Some(why);
        }
        match self.control() {
            BrowserControl::Agent => None,
            // Handed back: the agent's first command takes control again and sees the page as the person left it.
            BrowserControl::HandingBack => {
                self.set_control(BrowserControl::Agent);
                let hook = lock(&self.on_control).clone();
                if let Some(hook) = hook {
                    hook(BrowserControl::Agent);
                }
                None
            }
            BrowserControl::Human => Some(PAUSED.to_owned()),
        }
    }

    /// A message from the browser on its way to the driver (credentials.rs).
    pub fn outgoing(&self, message: Value) -> Value {
        super::credentials::outgoing(self, message)
    }

    /// Logs one step of the session's: a tool call of the agent's, or fleetd's own (a session tool, a fill), and
    /// returns its number.
    pub fn step(
        &self,
        tool: &str,
        args: Value,
        ok: bool,
        result: Option<&str>,
        duration_ms: u64,
    ) -> u64 {
        self.step_at(tool, args, ok, result, duration_ms, None)
    }

    /// An `agent-browser` command of the agent's: logged with the element it acted on, if it clicked or typed, and
    /// the ref it named it by. Returns its number and that element, for the DOM trace.
    pub fn agent_step(
        &self,
        command: &str,
        ok: bool,
        output: Option<&str>,
        duration_ms: u64,
    ) -> (u64, Option<StepTarget>) {
        let target = lock(&self.target).take().map(|mut t| {
            t.reference = element_ref(command);
            t
        });
        let seq = self.step_at(
            "agent-browser",
            json!({ "command": command }),
            ok,
            output,
            duration_ms,
            target.clone(),
        );
        (seq, target)
    }

    fn step_at(
        &self,
        tool: &str,
        mut args: Value,
        ok: bool,
        result: Option<&str>,
        duration_ms: u64,
        target: Option<StepTarget>,
    ) -> u64 {
        self.touch();
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let scrub = self.scrub();
        scrub.value(&mut args);
        let offset_ms = self.offset_ms().saturating_sub(duration_ms);
        self.log(BrowserAction {
            seq,
            at: Timestamp(crate::node::util::now_iso()),
            offset_ms,
            tool: tool.to_owned(),
            args,
            ok,
            result: result.map(|r| scrub.text(&r.chars().take(RESULT_CHARS).collect::<String>())),
            duration_ms,
            url: None,
            target,
        });
        seq
    }

    /// Notes the element one of the driver's commands is about to act on, before it goes: the one under a click,
    /// or the one focused when the first key of a step is typed. The latest click of a step wins.
    pub async fn note_target(&self, command: &Value) {
        // A note for the log never costs the agent real time: a page whose main thread is busy, or held by a
        // dialog, gets its step logged without the element.
        if tokio::time::timeout(TARGET_WAIT, self.find_target(command))
            .await
            .is_err()
        {
            tracing::debug!(session = %self.id, "step's element not read in time");
        }
    }

    async fn find_target(&self, command: &Value) {
        let params = &command["params"];
        let found = match command["method"].as_str().unwrap_or_default() {
            "Input.dispatchMouseEvent" if params["type"] == "mousePressed" => {
                let (Some(x), Some(y)) = (params["x"].as_f64(), params["y"].as_f64()) else {
                    return;
                };
                self.target_at(x, y).await
            }
            "Input.insertText" | "Input.dispatchKeyEvent"
                if lock(&self.target).is_none()
                    && (params["text"].is_string() || command["method"] == "Input.insertText") =>
            {
                self.target_focused().await
            }
            _ => return,
        };
        if let Some(found) = found {
            *lock(&self.target) = Some(found);
        }
    }

    async fn target_at(&self, x: f64, y: f64) -> Option<StepTarget> {
        let (_, page) = self.page()?;
        let node = self
            .cdp
            .call(
                Some(&page),
                "DOM.getNodeForLocation",
                json!({ "x": x.round() as i64, "y": y.round() as i64 }),
            )
            .await
            .ok()?;
        let backend = node["backendNodeId"].as_u64()?;
        let object = self
            .cdp
            .call(
                Some(&page),
                "DOM.resolveNode",
                json!({ "backendNodeId": backend }),
            )
            .await
            .ok()?;
        self.describe(&page, &object["object"]["objectId"], Some(backend))
            .await
    }

    async fn target_focused(&self) -> Option<StepTarget> {
        let (_, page) = self.page()?;
        let focused = self
            .cdp
            .call(
                Some(&page),
                "Runtime.evaluate",
                json!({ "expression": "document.activeElement" }),
            )
            .await
            .ok()?;
        let object = focused["result"]["objectId"].clone();
        let node = self
            .cdp
            .call(
                Some(&page),
                "DOM.describeNode",
                json!({ "objectId": object }),
            )
            .await
            .ok();
        let backend = node.and_then(|n| n["node"]["backendNodeId"].as_u64());
        self.describe(&page, &object, backend).await
    }

    /// An element's selector and box, the box scaled from the page's CSS pixels to the frame's.
    async fn describe(
        &self,
        page: &str,
        object: &Value,
        backend: Option<u64>,
    ) -> Option<StepTarget> {
        let described = self
            .cdp
            .call(
                Some(page),
                "Runtime.callFunctionOn",
                json!({ "objectId": object, "functionDeclaration": DESCRIBE, "returnByValue": true }),
            )
            .await
            .ok()?;
        let d = &described["result"]["value"];
        let selector = d["selector"].as_str().filter(|s| !s.is_empty())?.to_owned();
        let scale = {
            let live = lock(&self.live);
            let page_width = d["page"]
                .as_f64()
                .filter(|w| *w > 0.0)
                .unwrap_or(f64::from(WIDTH));
            live.last
                .as_ref()
                .map_or(f64::from(WIDTH) / page_width, |f| {
                    f.width.get() as f64 / page_width
                })
        };
        let n = |k: &str| d[k].as_f64().unwrap_or_default() * scale;
        Some(StepTarget {
            reference: None,
            selector,
            backend_node_id: backend,
            frame_box: Some(FrameBox {
                x: n("x"),
                y: n("y"),
                width: n("width"),
                height: n("height"),
            }),
        })
    }

    fn log(&self, action: BrowserAction) {
        if let Err(e) = record::append_action(&self.dir, &action, &self.scrub()) {
            tracing::warn!(session = %self.id, error = %e, "browser action not logged");
        }
    }

    /// Queues the DOM capture after action `seq`, behind those before it.
    pub fn queue_capture(&self, seq: u64, target: Option<StepTarget>) {
        let _ = self.captures.send(Capture::Step(seq, target));
    }

    /// Writes the page's HTML to the DOM trace after action `seq`, unless it is as the last one left it.
    async fn capture_dom(&self, seq: u64, target: Option<StepTarget>) {
        let _turn = self.dom_turn.lock().await;
        let Some((target_id, page)) = self.page() else {
            return;
        };
        let Ok(doc) = self
            .cdp
            .call(Some(&page), "DOM.getDocument", json!({ "depth": 0 }))
            .await
        else {
            return;
        };
        let Some(root) = doc.pointer("/root/nodeId").and_then(Value::as_u64) else {
            return;
        };
        let Ok(html) = self
            .cdp
            .call(Some(&page), "DOM.getOuterHTML", json!({ "nodeId": root }))
            .await
        else {
            return;
        };
        let mut html = html
            .get("outerHTML")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let info = self
            .cdp
            .call(
                None,
                "Target.getTargetInfo",
                json!({ "targetId": target_id }),
            )
            .await
            .unwrap_or_default();
        let url = info
            .pointer("/targetInfo/url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let title = info
            .pointer("/targetInfo/title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let hash: [u8; 32] = Sha256::digest(format!("{url}\n{html}").as_bytes()).into();
        {
            let mut last = lock(&self.last_dom);
            if *last == Some(hash) {
                return;
            }
            *last = Some(hash);
        }
        if html.len() > DOM_MAX_BYTES {
            let mut cut = DOM_MAX_BYTES;
            while !html.is_char_boundary(cut) {
                cut -= 1;
            }
            html.truncate(cut);
        }
        let snapshot = DomSnapshot {
            seq,
            offset_ms: self.offset_ms(),
            url,
            title,
            html,
            target,
        };
        if let Err(e) = record::append_dom(&self.dir, &snapshot, &self.scrub()) {
            tracing::warn!(session = %self.id, error = %e, "DOM snapshot not written");
        }
    }

    /// Stops recording and the browser: the video is finished, the text files scrubbed once more with every value the
    /// session knew, and the browser killed with its profile (a Navi's kept one stays). Returns the files there are.
    pub async fn close(&self) -> Vec<(RecordingFile, u64)> {
        // Every step's DOM capture queued so far lands first, while the page is still there.
        let (done, flushed) = tokio::sync::oneshot::channel();
        if self.captures.send(Capture::Flush(done)).is_ok()
            && tokio::time::timeout(Duration::from_secs(30), flushed)
                .await
                .is_err()
        {
            tracing::warn!(session = %self.id, "DOM captures not finished in 30 s");
        }
        // Held to the end: no capture runs while the files are scrubbed and closed.
        let _turn = self.dom_turn.lock().await;
        lock(&self._ticker).take();
        if let Some((_, page)) = self.page() {
            let _ = self
                .cdp
                .call(Some(&page), "Page.stopScreencast", json!({}))
                .await;
        }
        lock(&self._screencast).take();
        if let Some(video) = &self.video
            && let Err(why) = video.finish(self.start.elapsed()).await
        {
            let _ = std::fs::remove_file(self.dir.join(RecordingFile::Video.file_name()));
            self.set_note(format!("no video: {why}"));
        }
        let browser = lock(&self.browser).take();
        if let Some(browser) = browser {
            browser.close().await;
        }
        let scrub = self.scrub();
        for file in [RecordingFile::Actions, RecordingFile::Dom] {
            if let Err(e) = record::scrub_file(&self.dir.join(file.file_name()), &scrub) {
                tracing::warn!(session = %self.id, error = %e, "recording not scrubbed");
                let _ = std::fs::remove_file(self.dir.join(file.file_name()));
            }
        }
        self.write_meta(Some(crate::node::util::now_iso()));
        files(&self.dir)
    }
}

/// The recording files in `dir` and their sizes.
pub fn files(dir: &std::path::Path) -> Vec<(RecordingFile, u64)> {
    RecordingFile::ALL
        .iter()
        .filter_map(|f| {
            let len = std::fs::metadata(dir.join(f.file_name())).ok()?.len();
            (len > 0).then_some((*f, len))
        })
        .collect()
}

/// Follows the browser's pages and feeds their screencast to the video, until the session goes.
async fn screencast(
    session: std::sync::Weak<Session>,
    mut events: tokio::sync::mpsc::UnboundedReceiver<Event>,
) {
    loop {
        let Some(event) = events.recv().await else {
            return;
        };
        let Some(session) = session.upgrade() else {
            return;
        };
        match event.method.as_str() {
            "Page.screencastFrame" => {
                let Some(page) = event.session_id.as_deref() else {
                    continue;
                };
                if let Some(ack) = event.params.get("sessionId") {
                    session.cdp.post(
                        Some(page),
                        "Page.screencastFrameAck",
                        json!({ "sessionId": ack }),
                    );
                }
                if session.page().is_none_or(|(_, followed)| followed != page) {
                    continue;
                }
                let data = event
                    .params
                    .get("data")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let Ok(jpeg) = B64.decode(data) else {
                    continue;
                };
                session.live_frame(data, &jpeg, &event.params["metadata"]);
                if let Some(video) = &session.video {
                    video.frame(jpeg, session.start.elapsed());
                }
            }
            "Target.targetInfoChanged" => {
                let info = &event.params["targetInfo"];
                if let (Some(target), Some(url)) = (info["targetId"].as_str(), info["url"].as_str())
                {
                    lock(&session.live)
                        .urls
                        .insert(target.to_owned(), url.to_owned());
                }
            }
            "Target.targetCreated" => {
                let info = &event.params["targetInfo"];
                if info["type"] != "page" {
                    continue;
                }
                let target = info["targetId"].as_str().unwrap_or_default().to_owned();
                if let Some(url) = info["url"].as_str() {
                    lock(&session.live)
                        .urls
                        .insert(target.clone(), url.to_owned());
                }
                // Pages the driver attaches to show here too: follow each once, by the broker's own session.
                if lock(&session.pages).stack.iter().any(|(t, _)| *t == target) {
                    continue;
                }
                let Ok(page) = session.cdp.attach(&target).await else {
                    continue;
                };
                follow(&session, Some((target, page))).await;
            }
            "Target.targetDestroyed" | "Target.detachedFromTarget" => {
                // A page closed, or the broker's own session to it ended; the driver detaching changes nothing.
                let (target, gone_session) = match event.method.as_str() {
                    "Target.targetDestroyed" => {
                        (event.params["targetId"].as_str().unwrap_or_default(), "")
                    }
                    _ => ("", event.params["sessionId"].as_str().unwrap_or_default()),
                };
                lock(&session.live).urls.remove(target);
                let was_current = {
                    let mut pages = lock(&session.pages);
                    let current = pages.current().cloned();
                    let gone = |(t, s): &(String, String)| t == target || s == gone_session;
                    pages.stack.retain(|p| !gone(p));
                    current.is_some_and(|p| gone(&p))
                };
                if was_current {
                    follow(&session, None).await;
                }
            }
            _ => {}
        }
    }
}

/// Follows `page` (a new one), or the newest left when none: its screencast feeds the video from now on.
async fn follow(session: &Session, page: Option<(String, String)>) {
    let before = session.page();
    if let Some(page) = &page {
        lock(&session.pages).stack.push(page.clone());
    }
    let Some((_, now)) = session.page() else {
        return;
    };
    if let Some((_, old)) = before.filter(|(_, old)| *old != now) {
        let _ = session
            .cdp
            .call(Some(&old), "Page.stopScreencast", json!({}))
            .await;
    }
    let _ = session.cdp.call(Some(&now), "Page.enable", json!({})).await;
    // A page swapping renderers (its first navigation, as a session's often comes at once) has none to screencast
    // for a moment, and Chrome refuses: start again once it has one, or the page never sends a frame.
    let deadline = Instant::now() + SCREENCAST_START;
    let started = loop {
        let started = session
            .cdp
            .call(
                Some(&now),
                "Page.startScreencast",
                json!({ "format": "jpeg", "quality": 70, "maxWidth": WIDTH, "maxHeight": HEIGHT }),
            )
            .await;
        match started {
            Err(e) if e.contains(NO_ACTIVE_PAGE) && Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            started => break started,
        }
    };
    if let Err(e) = started {
        tracing::warn!(session = %session.id, error = %e, "screencast not started");
    }
}

/// A JPEG's width and height, from its first start-of-frame marker.
pub fn jpeg_size(jpeg: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    while at + 9 < jpeg.len() {
        if jpeg[at] != 0xff {
            return None;
        }
        let marker = jpeg[at + 1];
        let len = usize::from(u16::from_be_bytes([jpeg[at + 2], jpeg[at + 3]]));
        // SOF0..SOF15 but DHT (c4), JPG (c8) and DAC (cc).
        if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
            let height = u16::from_be_bytes([jpeg[at + 5], jpeg[at + 6]]);
            let width = u16::from_be_bytes([jpeg[at + 7], jpeg[at + 8]]);
            return (width > 0 && height > 0).then(|| (u32::from(width), u32::from(height)));
        }
        at += 2 + len;
    }
    None
}

/// The Windows virtual key code of a key the browser names, for the keys whose default action needs one.
fn key_code(key: &str) -> Option<u32> {
    Some(match key {
        "Backspace" => 8,
        "Tab" => 9,
        "Enter" => 13,
        "Escape" => 27,
        " " => 32,
        "PageUp" => 33,
        "PageDown" => 34,
        "End" => 35,
        "Home" => 36,
        "ArrowLeft" => 37,
        "ArrowUp" => 38,
        "ArrowRight" => 39,
        "ArrowDown" => 40,
        "Delete" => 46,
        k if k.chars().count() == 1 => {
            let c = k.chars().next()?.to_ascii_uppercase();
            if c.is_ascii_alphanumeric() {
                c as u32
            } else {
                return None;
            }
        }
        _ => return None,
    })
}

/// The CDP command for a person's input, its coordinates scaled from frame to page pixels.
pub fn cdp_input(input: &BrowserInput, scale_x: f64, scale_y: f64) -> (&'static str, Value) {
    match input {
        BrowserInput::Mouse {
            action,
            x,
            y,
            button,
            click_count,
            delta_x,
            delta_y,
            modifiers,
        } => {
            let kind = match action {
                MouseAction::Pressed => "mousePressed",
                MouseAction::Released => "mouseReleased",
                MouseAction::Moved => "mouseMoved",
                MouseAction::Wheel => "mouseWheel",
            };
            let button = match button {
                MouseButton::None => "none",
                MouseButton::Left => "left",
                MouseButton::Middle => "middle",
                MouseButton::Right => "right",
            };
            (
                "Input.dispatchMouseEvent",
                json!({
                    "type": kind, "x": x * scale_x, "y": y * scale_y, "button": button,
                    "clickCount": click_count.get(), "deltaX": delta_x, "deltaY": delta_y,
                    "modifiers": modifiers.get(),
                }),
            )
        }
        BrowserInput::Key {
            action,
            key,
            code,
            text,
            modifiers,
        } => {
            let text = text
                .as_ref()
                .map(|t| t.to_string())
                .or_else(|| (key.as_str() == "Enter").then(|| "\r".to_owned()));
            let kind = match (action, &text) {
                (KeyAction::Down, Some(_)) => "keyDown",
                (KeyAction::Down, None) => "rawKeyDown",
                (KeyAction::Up, _) => "keyUp",
            };
            let mut params =
                json!({ "type": kind, "key": key.as_str(), "modifiers": modifiers.get() });
            if let Some(code) = code {
                params["code"] = code.as_str().into();
            }
            if let Some(vk) = key_code(key.as_str()) {
                params["windowsVirtualKeyCode"] = vk.into();
                params["nativeVirtualKeyCode"] = vk.into();
            }
            if let (Some(text), KeyAction::Down) = (text, action) {
                params["text"] = text.clone().into();
                params["unmodifiedText"] = text.into();
            }
            ("Input.dispatchKeyEvent", params)
        }
        BrowserInput::Text { text } => ("Input.insertText", json!({ "text": text.as_str() })),
    }
}

/// Run on an element over the node's own connection: a CSS selector for it (from its nearest ancestor with an id, by
/// tag and position), its box in CSS pixels, and the page's width. Reads no value.
const DESCRIBE: &str = "function() { \
    const path = []; let el = this; \
    while (el && el.nodeType === 1 && path.length < 12) { \
        if (el.id) { path.unshift('#' + CSS.escape(el.id)); break; } \
        let step = el.localName; const parent = el.parentElement; \
        if (parent) { \
            const same = Array.from(parent.children).filter((c) => c.localName === el.localName); \
            if (same.length > 1) step += ':nth-of-type(' + (same.indexOf(el) + 1) + ')'; \
        } \
        path.unshift(step); el = parent; \
    } \
    const r = this.getBoundingClientRect(); \
    return { selector: path.join(' > '), x: r.x, y: r.y, width: r.width, height: r.height, page: innerWidth }; \
}";

/// The ref an `agent-browser` command names an element by (`@e3`), if any.
pub fn element_ref(command: &str) -> Option<String> {
    command
        .split(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .find(|word| {
            word.strip_prefix("@e")
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
        .map(str::to_owned)
}

/// A job for a session's DOM capture queue.
enum Capture {
    /// The page after step `seq`, with the element it acted on.
    Step(u64, Option<StepTarget>),
    /// Answers once every capture queued before it is written.
    Flush(tokio::sync::oneshot::Sender<()>),
}

/// A URL without its query and fragment.
pub fn without_query(url: &str) -> &str {
    url.find(['?', '#']).map_or(url, |at| &url[..at])
}
