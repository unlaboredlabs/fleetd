//! The window's content: connect, then the board (tasking first), an order's view, Machines and Settings, with
//! the sidebar, the inbox panel, the machine and train strips, and the palette and floating composer on top.
//! Screens live in `board.rs`, `order.rs` and `inbox.rs` as `impl Shell` blocks; this file holds the hub link,
//! navigation, keys and the frame around them.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fleetd_contracts::app::AppClientMessage;
use fleetd_contracts::doctor::{DoctorFixKind, DoctorStatus};
use fleetd_contracts::ledger::{AskKind, AskState, BatchId, CheckSpec, WorkstreamId};
use fleetd_contracts::live::OrderPhase;
use fleetd_contracts::model::MachineStatus;
use futures::StreamExt;
use futures::channel::mpsc::{self, UnboundedSender};
use gpui::{
    AnyElement, App, ClipboardItem, Context, Div, Entity, FocusHandle, Focusable, Hsla, KeyBinding, KeyDownEvent, Keystroke, ModifiersChangedEvent,
    MouseButton, ScrollDelta, ScrollStrategy, ScrollWheelEvent, SharedString, Stateful, Subscription, SystemNotification, Task,
    UniformListScrollHandle, Window, actions, div, point, prelude::*, px, uniform_list,
};

use crate::actions;
use crate::bench::{self, Mode, Probe};
use crate::client;
use crate::composer::{self, Composer, ComposerEvent, Placement};
use crate::fake::{self, LogKind, LogStream};
use crate::input::{InputEvent, TextInput};
use crate::keychain::{self, Saved};
use crate::links;
use crate::live;
use crate::live::lanes::{Density, FleetLanes, LaneEvent};
use crate::live::strips::TrainStrip;
use crate::notify::{Target, unix_secs};
use crate::pair::{self, Failure};
use crate::palette::{self, Command, Palette, PaletteEvent};
use crate::seal;
use crate::settings::{self, Settings, SettingsEvent};
use crate::sidebar;
use crate::state::{Conn, Echo, ProjectKey, SentOrder, State};
use crate::theme::{STRONG, Theme, metric, size, theme};
use crate::ui::{self, Variant};

const LINES_PER_SEC: u64 = 50;
const SCROLL_PX_PER_SEC: f32 = 2400.;
/// How long launch shows a blank window before the connect screen while the saved key is still loading.
const LOAD_WAIT: Duration = Duration::from_secs(5);
const POLL_EVERY: Duration = Duration::from_secs(3);
/// The board resorts this long after the pointer leaves it (spec rule 8: nothing jumps while you look).
const RESORT_AFTER: Duration = Duration::from_secs(2);
/// Width of a tail line's "10:04:05  " stamp, which the log shows in its own column.
const STAMP_WIDTH: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    /// Reading the saved hub key.
    Loading,
    Connect,
    Board,
    Order,
    Machines,
    Settings,
}

actions!(shell, [FocusNext, FocusPrev]);

/// The app's keys: the text field bindings, the palette's and composer's, and Tab / Shift+Tab between fields,
/// buttons and rows.
pub fn bind_keys(cx: &mut App) {
    crate::input::bind_keys(cx);
    palette::bind_keys(cx);
    composer::bind_keys(cx);
    cx.bind_keys([KeyBinding::new("tab", FocusNext, None), KeyBinding::new("shift-tab", FocusPrev, None)]);
}

/// The first-run screen: a pairing code (primary) or, folded away, a key.
pub(crate) struct ConnectForm {
    hub: Entity<TextInput>,
    code: Entity<TextInput>,
    key: Entity<TextInput>,
    use_key: bool,
    /// What the screen is doing or found, e.g. that a hub answers on this computer.
    status: Option<String>,
    /// A pairing request is out.
    busy: bool,
    error: Option<Failure>,
}

/// One line of the bench's raw log. A long log holds tens of thousands of these, so it keeps one string plus
/// offsets.
pub(crate) struct LogRow {
    kind: LogKind,
    text: SharedString,
    /// `text[..stamp]` is the timestamp, `text[body..]` the line.
    stamp: u8,
    body: u16,
}

impl LogRow {
    fn new(kind: LogKind, text: &str) -> Self {
        let (stamp, body) = split_stamp(text);
        let body_at = (text.len() - body.len()).min(u16::MAX as usize);
        Self { kind, stamp: stamp.len() as u8, body: body_at as u16, text: text.to_string().into() }
    }

    fn stamp(&self) -> &str {
        &self.text[..self.stamp as usize]
    }

    fn body(&self) -> &str {
        &self.text[self.body as usize..]
    }
}

/// The live link to the hub. Dropping it stops the client.
pub(crate) struct HubLink {
    url: String,
    tx: UnboundedSender<AppClientMessage>,
    _tasks: [Task<()>; 3],
}

pub struct Shell {
    pub(crate) state: State,
    pub(crate) screen: Screen,
    /// The Machines list's keyboard row.
    selected: usize,
    /// The inbox panel's terse reply field.
    pub(crate) reply: Entity<TextInput>,
    form: ConnectForm,
    hub: Option<HubLink>,
    /// Shown above the screen, e.g. that the key could not be saved to the keychain.
    note: Option<String>,
    /// A masked field per open secret ask; the value lives only in the field's self-wiping buffer.
    pub(crate) secrets: HashMap<String, (Entity<TextInput>, Subscription)>,
    /// The text last copied, so its button says so.
    copied: Option<String>,
    /// Focus to move to on the next render (e.g. the composer once connected).
    pub(crate) pending_focus: Option<FocusHandle>,
    _subscriptions: Vec<Subscription>,
    log: Vec<LogRow>,
    log_scroll: UniformListScrollHandle,
    log_follow: bool,
    pub(crate) focus: FocusHandle,
    pub(crate) inbox_focus: FocusHandle,
    pub(crate) bench: Option<(LogStream, Probe)>,
    /// The bench's order view shows its raw 20k-line log (what the scroll bench scrolls) instead of the conversation.
    pub(crate) bench_log: bool,
    update: Option<String>,
    pub(crate) palette: Option<Entity<Palette>>,
    /// New orders: docked on the board, or floating over the order view (⌘N there).
    pub(crate) docked: Entity<Composer>,
    pub(crate) floating: Option<Entity<Composer>>,
    /// The order view's follow-up box.
    pub(crate) follow: Entity<Composer>,
    pub(crate) settings: Entity<Settings>,
    pub(crate) settings_section: settings::Section,
    /// Where Settings' Done goes back to.
    before_settings: Screen,
    pub(crate) prompts_ui: crate::prompts::Ui,
    sidebar_hidden: bool,
    seen: sidebar::Seen,
    /// The ask a notification or the palette pointed at, marked in the inbox.
    pub(crate) focus_ask: Option<String>,
    /// What the notification on screen opens when clicked.
    notified: Option<Target>,
    pub(crate) inbox_open: bool,
    /// The inbox panel's picked ask (1..9), by position.
    pub(crate) inbox_pick: Option<usize>,
    pub(crate) group_by_status: bool,
    /// The board's keyboard selection (an order id).
    pub(crate) selected_card: Option<String>,
    /// The project picked on the board or sidebar: the composer's default target.
    pub(crate) selected_project: Option<ProjectKey>,
    /// The board's row order while the pointer is over it.
    pub(crate) board_held: Option<Vec<String>>,
    resort: Option<Task<()>>,
    /// The board's virtualized list, its row ids and rows as last shown, and whether row heights may have changed.
    pub(crate) board_list: gpui::ListState,
    pub(crate) board_ids: Vec<String>,
    pub(crate) board_now: Vec<crate::board::Row>,
    pub(crate) board_remeasure: bool,
    /// The order view's lead conversation, a cached view.
    pub(crate) conv: Entity<crate::order::LeadConv>,
    pub(crate) card_lanes: HashMap<String, Entity<FleetLanes>>,
    pub(crate) order_lanes: Option<Entity<FleetLanes>>,
    order_lanes_for: Option<String>,
    train_strip: Entity<TrainStrip>,
    pub(crate) stop_confirm: bool,
    /// Narrow windows: the order view shows the lead conversation (true) or the fleet.
    pub(crate) order_tab: bool,
    /// ⌘/Ctrl is held: the sidebar shows jump numbers.
    cmd_held: bool,
    window_active: bool,
}

impl Shell {
    pub fn new(bench: Option<Mode>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::theme::init(window, cx);
        live::motion::init(cx);
        live::motion::set_pref(crate::prefs::load().motion, cx);
        let settings = cx.new(|_| Settings::default());
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let log_scroll = UniformListScrollHandle::new();
        log_scroll.scroll_to_bottom();
        let reply = cx.new(|cx| TextInput::new(cx).placeholder("Reply by number: 1 go 2 nvm 3 b").multi_line(4).borderless());
        let hub = cx.new(|cx| {
            let mut input = TextInput::new(cx).placeholder(pair::LOCAL_HUB);
            input.set_text(pair::LOCAL_HUB, cx);
            input
        });
        let code = cx.new(|cx| TextInput::new(cx).placeholder("ABCD-2345"));
        let key = cx.new(|cx| TextInput::new(cx).placeholder("fld_…").masked(4096));
        let docked = cx.new(|cx| Composer::new(Placement::Docked, cx));
        let follow = cx.new(|cx| Composer::new(Placement::FollowUp, cx));
        let train_strip = cx.new(|_| TrainStrip::new());
        let subscriptions = vec![
            cx.subscribe(&reply, Self::on_reply_event),
            cx.subscribe(&hub, |this, _, e: &InputEvent, cx| {
                if *e == InputEvent::Submit {
                    if this.form.use_key { this.submit_key(cx) } else { this.submit_code(cx) }
                }
            }),
            cx.subscribe(&code, |this, _, e: &InputEvent, cx| {
                if *e == InputEvent::Submit {
                    this.submit_code(cx);
                }
            }),
            cx.subscribe(&key, |this, _, e: &InputEvent, cx| {
                if *e == InputEvent::Submit {
                    this.submit_key(cx);
                }
            }),
            cx.subscribe(&settings, |this, _, event: &SettingsEvent, cx| {
                match event {
                    SettingsEvent::Disconnect => this.disconnect(cx),
                }
                cx.notify();
            }),
            cx.subscribe_in(&docked, window, Self::on_composer_event),
            cx.subscribe_in(&follow, window, Self::on_composer_event),
        ];
        let mut shell = Self {
            state: State::default(),
            screen: Screen::Loading,
            selected: 0,
            pending_focus: Some(docked.focus_handle(cx)),
            reply,
            form: ConnectForm { hub, code, key, use_key: false, status: None, busy: false, error: None },
            hub: None,
            note: None,
            secrets: HashMap::new(),
            copied: None,
            _subscriptions: subscriptions,
            log: Vec::new(),
            log_scroll,
            log_follow: true,
            focus,
            inbox_focus: cx.focus_handle(),
            bench: None,
            bench_log: false,
            update: None,
            palette: None,
            docked,
            floating: None,
            follow,
            settings,
            settings_section: settings::Section::General,
            before_settings: Screen::Board,
            prompts_ui: crate::prompts::Ui::new(cx),
            sidebar_hidden: false,
            seen: sidebar::Seen::default(),
            focus_ask: None,
            notified: None,
            inbox_open: false,
            inbox_pick: None,
            group_by_status: false,
            selected_card: None,
            selected_project: None,
            board_held: None,
            resort: None,
            board_list: gpui::ListState::new(0, gpui::ListAlignment::Top, px(400.)),
            board_ids: Vec::new(),
            board_now: Vec::new(),
            board_remeasure: false,
            conv: cx.new(|_| crate::order::LeadConv::new()),
            card_lanes: HashMap::new(),
            order_lanes: None,
            order_lanes_for: None,
            train_strip,
            stop_confirm: false,
            order_tab: false,
            cmd_held: false,
            window_active: true,
        };
        cx.observe_window_activation(window, |this, window, cx| {
            this.window_active = window.is_window_active();
            this.update_live(true, cx);
        })
        .detach();
        match bench {
            Some(mode) => shell.start_bench(mode, window, cx),
            None => {
                shell.on_notification_click(window, cx);
                shell.listen_for_links(cx);
                shell.load_saved(cx);
                crate::update::watch(cx, |shell, text| shell.update = Some(text));
            }
        }
        shell
    }

    /// Clicking a "needs you" notification brings the window forward on what it was about: the ask, else the
    /// inbox, or Machines for a machine's trouble.
    fn on_notification_click(&self, window: &mut Window, cx: &mut Context<Self>) {
        let shell = cx.entity().downgrade();
        let handle = window.window_handle();
        // Called from the notification center's delegate, which can't unwind.
        cx.on_system_notification_response(move |_, cx| {
            crate::crash::guard("notification click", || {
                cx.activate(true);
                handle.update(cx, |_, window, _| window.activate_window()).ok();
                shell
                    .update(cx, |this, cx| {
                        match this.notified.take() {
                            Some(Target::Machines) => this.go(Screen::Machines),
                            Some(Target::Ask(id)) => {
                                this.toggle_inbox(true, cx);
                                this.focus_ask = Some(id);
                            }
                            Some(Target::Inbox) | None => this.toggle_inbox(true, cx),
                        }
                        cx.notify();
                    })
                    .ok();
            })
        });
    }

    /// Posts the notification the hub's attention rules and policy allow now, if any.
    fn notify_if_due(&mut self, cx: &mut App) {
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        if let Some(n) = self.state.take_notification(now_ms) {
            self.notified = Some(n.target);
            // One tag: a newer notification replaces an older one still on screen.
            cx.show_system_notification(SystemNotification {
                tag: "fleetd-needs-you".into(),
                title: n.title.into(),
                body: n.body.into(),
                actions: Vec::new(),
            });
        }
    }

    // ---- hub link ------------------------------------------------------------------------

    fn load_saved(&mut self, cx: &mut Context<Self>) {
        // The one-time move of an old keychain item can sit behind a system prompt: the connect screen doesn't wait.
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LOAD_WAIT).await;
            this.update(cx, |this, cx| {
                if matches!(this.screen, Screen::Loading) {
                    this.first_run(cx);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
        cx.spawn(async move |this, cx| {
            let loaded = match keychain::from_env() {
                Some(saved) => Ok(keychain::Loaded { saved: Some(saved), note: None }),
                None => cx.background_executor().spawn(async { keychain::load() }).await,
            };
            this.update(cx, |this, cx| {
                // Paired another way while a prompt was up.
                if this.hub.is_some() {
                    return;
                }
                let waiting = matches!(this.screen, Screen::Loading);
                match loaded {
                    Ok(keychain::Loaded { saved: Some(saved), note }) => {
                        this.note = note;
                        this.connect(saved, cx);
                    }
                    Ok(keychain::Loaded { saved: None, note }) => {
                        if note.is_some() {
                            this.form.status = note;
                        }
                        if waiting {
                            this.first_run(cx);
                        }
                    }
                    Err(e) => {
                        let fix = "You can still connect; the key then lasts until the app quits.";
                        this.form.error = Some(Failure { code: String::new(), message: e, fix: Some(fix.into()) });
                        if waiting {
                            this.first_run(cx);
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn connect(&mut self, saved: Saved, cx: &mut Context<Self>) {
        let (out_tx, out_rx) = mpsc::unbounded();
        let (in_tx, mut in_rx) = mpsc::unbounded();
        let run = cx.background_executor().spawn(client::run(saved.url.clone(), saved.key, out_rx, in_tx));
        let pump = cx.spawn(async move |this, cx| {
            while let Some(incoming) = in_rx.next().await {
                let ok = this.update(cx, |this, cx| {
                    let out = this.state.apply(incoming);
                    this.send(out);
                    this.after_state_change(cx);
                    this.notify_if_due(cx);
                    cx.notify();
                });
                if ok.is_err() {
                    return;
                }
            }
        });
        let poll = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL_EVERY).await;
                let ok = this.update(cx, |this, cx| {
                    let out = this.state.poll(now_ms());
                    this.send(out);
                    this.notify_if_due(cx);
                });
                if ok.is_err() {
                    return;
                }
            }
        });
        self.hub = Some(HubLink { url: saved.url, tx: out_tx, _tasks: [run, pump, poll] });
        self.state = State::default();
        self.screen = Screen::Board;
        self.selected = 0;
        self.pending_focus = Some(self.docked.focus_handle(cx));
    }

    /// No saved hub: show the connect screen and try, in order, a `fleetd://pair` link that launched us (handled by
    /// [`Self::listen_for_links`]), the `app-pair.json` that `fleetd init` leaves on the hub machine, and a hub
    /// answering on this computer.
    fn first_run(&mut self, cx: &mut Context<Self>) {
        self.screen = Screen::Connect;
        self.pending_focus = Some(self.form.code.focus_handle(cx));
        cx.spawn(async move |this, cx| {
            let file = pair::app_pair_file();
            let read = file.clone();
            let found = cx.background_executor().spawn(async move { read.and_then(|f| std::fs::read_to_string(f).ok()) }).await;
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
            let auto = found.as_deref().and_then(pair::read_app_pair);
            let started = this
                .update(cx, |this, cx| {
                    let auto = auto?;
                    this.form.hub.update(cx, |i, cx| i.set_text(&auto.hub, cx));
                    if this.form.busy || auto.expired(now) {
                        return None;
                    }
                    this.form.code.update(cx, |i, cx| i.set_text(&auto.code, cx));
                    this.start_pair(auto.hub, auto.code, file, cx);
                    Some(())
                })
                .ok()
                .flatten();
            if started.is_some() {
                return;
            }
            let hub = this.update(cx, |this, cx| this.form.hub.read(cx).text().trim().to_string()).unwrap_or_default();
            let probe = hub.clone();
            let answers = cx.background_executor().spawn(async move { pair::hub_answers(&probe).await }).await;
            this.update(cx, |this, cx| {
                if this.form.status.is_none() && !this.form.busy {
                    this.form.status = Some(if answers {
                        format!("Found your hub at {hub}. Enter the code from `fleetd pair` to connect.")
                    } else {
                        "No hub answers on this computer. Enter your hub's address and a code from `fleetd pair` run there, or set up a hub with `fleetd init`.".into()
                    });
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// `fleetd://pair?hub=…&code=…` links, from the OS (macOS) or the command line (Linux `.desktop` `%u`).
    fn listen_for_links(&mut self, cx: &mut Context<Self>) {
        let Some(mut links) = cx.try_global::<pair::Links>().and_then(|l| l.0.borrow_mut().take()) else { return };
        cx.spawn(async move |this, cx| {
            while let Some(link) = links.next().await {
                let ok = this.update(cx, |this, cx| {
                    let Some((hub, code)) = pair::parse_deep_link(&link) else {
                        this.note = Some(format!("Ignored a link this app doesn't handle: {link}"));
                        return cx.notify();
                    };
                    this.form.hub.update(cx, |i, cx| i.set_text(&hub, cx));
                    this.form.code.update(cx, |i, cx| i.set_text(&code, cx));
                    if !this.form.busy {
                        this.start_pair(hub, code, None, cx);
                    }
                });
                if ok.is_err() {
                    return;
                }
            }
        })
        .detach();
    }

    fn submit_code(&mut self, cx: &mut Context<Self>) {
        if self.form.busy {
            return;
        }
        let hub = self.form.hub.read(cx).text().trim().to_string();
        let code = self.form.code.read(cx).text().to_string();
        self.start_pair(hub, code, None, cx);
    }

    /// Redeems `code` at `hub` (POST /pair), saves the key and connects. `auto_file` is the `app-pair.json` the
    /// code came from, deleted once the hub has taken or refused the code.
    fn start_pair(&mut self, hub: String, code: String, auto_file: Option<std::path::PathBuf>, cx: &mut Context<Self>) {
        if let Err(e) = client::app_url(&hub) {
            self.form.error =
                Some(Failure { code: String::new(), message: e, fix: Some("Use the hub's address, e.g. http://127.0.0.1:4790.".into()) });
            return cx.notify();
        }
        self.form.busy = true;
        self.form.error = None;
        self.form.status = Some(format!("Pairing with {hub}…"));
        if self.hub.is_none() {
            self.screen = Screen::Connect;
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let device = pair::device_name();
            let target = hub.clone();
            let result = cx.background_executor().spawn(async move { pair::pair(&target, &code, &device).await }).await;
            // The hub has used up or refused the code: the file is spent either way.
            if (result.is_ok() || result.as_ref().is_err_and(|f| f.code.starts_with("pair_code_")))
                && let Some(file) = auto_file
            {
                std::fs::remove_file(file).ok();
            }
            this.update(cx, |this, cx| {
                this.form.busy = false;
                match result {
                    Ok(paired) => {
                        this.form.status = None;
                        this.form.code.update(cx, |i, cx| i.clear(cx));
                        this.note = Some(format!("Paired with {}.", paired.hub_name));
                        this.save_and_connect(Saved { url: hub, key: paired.key }, cx);
                    }
                    Err(failure) => {
                        this.form.status = None;
                        if this.hub.is_some() {
                            this.note = Some(format!("Pairing failed: {} {}", failure.message, failure.fix.as_deref().unwrap_or("")));
                        }
                        this.form.error = Some(failure);
                        this.pending_focus = Some(this.form.code.focus_handle(cx));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn submit_key(&mut self, cx: &mut Context<Self>) {
        let url = self.form.hub.read(cx).text().trim().to_string();
        let key = self.form.key.read(cx).text().trim().to_string();
        if let Err(e) = client::app_url(&url) {
            self.form.error =
                Some(Failure { code: String::new(), message: e, fix: Some("Use the hub's address, e.g. http://127.0.0.1:4790.".into()) });
            return cx.notify();
        }
        if key.is_empty() {
            self.form.error = Some(Failure {
                code: String::new(),
                message: "Paste a key for this device.".into(),
                fix: Some("On the hub, run `fleetd hub key create --human --name <device>` and paste the key it prints.".into()),
            });
            self.pending_focus = Some(self.form.key.focus_handle(cx));
            return cx.notify();
        }
        self.form.key.update(cx, |i, cx| i.clear(cx));
        self.form.error = None;
        self.save_and_connect(Saved { url, key }, cx);
        cx.notify();
    }

    fn save_and_connect(&mut self, saved: Saved, cx: &mut Context<Self>) {
        let to_save = saved.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { keychain::save(&to_save) }).await;
            this.update(cx, |this, cx| {
                if let Err(e) = result {
                    this.note = Some(format!("{e} Connected for this session only; the key was not stored anywhere."));
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        self.connect(saved, cx);
    }

    fn disconnect(&mut self, cx: &mut Context<Self>) {
        self.hub = None;
        self.secrets.clear();
        self.state = State::default();
        self.screen = Screen::Connect;
        self.note = None;
        self.form.status = None;
        self.pending_focus = Some(self.form.code.focus_handle(cx));
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async { keychain::clear() }).await;
            this.update(cx, |this, cx| {
                this.form.error = result.err().map(|message| Failure { code: String::new(), message, fix: None });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn send(&self, out: Vec<AppClientMessage>) {
        if let Some(hub) = &self.hub {
            for message in out {
                hub.tx.unbounded_send(message).ok();
            }
        }
    }

    fn after_state_change(&mut self, cx: &mut Context<Self>) {
        self.seen.prime(&self.state);
        if let Conn::Refused(message) = &self.state.conn {
            self.form.error = Some(Failure {
                code: String::new(),
                message: message.clone(),
                fix: Some("Pair again with a code from `fleetd pair` on the hub, or use another key.".into()),
            });
            self.hub = None;
            self.secrets.clear();
            self.screen = Screen::Connect;
            self.pending_focus = Some(self.form.code.focus_handle(cx));
        }
        // An ask answered or withdrawn elsewhere drops (and wipes) what was typed for it; a new one gets a field.
        self.secrets.retain(|id, _| self.state.asks.get(id.as_str()).is_some_and(|a| a.state == AskState::Open));
        let open: Vec<String> = self
            .state
            .asks
            .values()
            .filter(|a| a.kind == AskKind::Secret && a.state == AskState::Open && !self.secrets.contains_key(a.ask_id.as_str()))
            .map(|a| a.ask_id.to_string())
            .collect();
        for id in open {
            let input = cx.new(|cx| TextInput::new(cx).placeholder("Type or paste the value; Enter seals and sends").masked(seal::SECRET_MAX_BYTES));
            let ask_id = id.clone();
            let sub = cx.subscribe(&input, move |this, input, e: &InputEvent, cx| match e {
                InputEvent::Submit => this.submit_secret(&ask_id, cx),
                InputEvent::Cancel => input.update(cx, |i, cx| i.clear(cx)),
                InputEvent::TooLong => {
                    this.state.echo = Some(Echo { text: format!("A secret is at most {} bytes.", seal::SECRET_MAX_BYTES), ok: false });
                    cx.notify();
                }
                InputEvent::Changed => cx.notify(),
            });
            self.secrets.insert(id, (input, sub));
        }
        if let Some(pick) = self.inbox_pick {
            let n = self.state.inbox().len();
            self.inbox_pick = (n > 0).then(|| pick.min(n - 1));
        }
        self.sync_composers(cx);
        self.sync_lanes(cx);
        self.update_live(false, cx);
        self.sync_conversation(cx);
        self.board_remeasure = true;
    }

    pub(crate) fn now_secs(&self) -> i64 {
        self.state.live.hub_now_ms(now_ms()) / 1000
    }

    /// What the composers need from the state: targets and their machines, the selection, the router's guess,
    /// uploads, mention candidates, and whether Send can work.
    pub(crate) fn sync_composers(&mut self, cx: &mut Context<Self>) {
        let state = &self.state;
        let targets: Vec<composer::Target> = state
            .projects
            .iter()
            .map(|r| {
                let m = state.machine(&r.summary.machine_id);
                composer::Target {
                    key: r.key(),
                    title: r.summary.title.clone().into(),
                    machine: m.map_or_else(|| r.summary.machine_id.to_string(), |m| m.name.clone()).into(),
                    machine_offline: m.is_none_or(|m| m.status == MachineStatus::Offline),
                }
            })
            .collect();
        let offline = match (&state.conn, self.bench.is_some()) {
            (_, true) | (Conn::Live, _) => None,
            (Conn::Connecting { retry_in: Some(d), .. }, _) => Some(format!("Not connected; retrying in {} s", d.as_secs_f32().ceil() as u64)),
            (Conn::Connecting { .. }, _) => Some("Connecting to the hub…".into()),
            (Conn::Refused(_), _) => Some("The hub refused this key.".into()),
        };
        let mut orders = Vec::new();
        let mut prs = Vec::new();
        for row in &state.projects {
            for card in state.live.orders(&row.key()) {
                orders.push((card.workstream_id.to_string(), card.title.to_string()));
                for pr in card.prs.iter() {
                    prs.push((pr.number.get() as u64, pr.url.to_string(), card.title.to_string()));
                }
            }
        }
        let selected = match self.screen {
            Screen::Order => state.order.as_ref().and_then(|o| o.key.clone()),
            _ => self.selected_project.clone(),
        };
        let sync = composer::Sync {
            targets,
            selected,
            last_used: state.last_project.clone(),
            guess: state.guess.clone(),
            guessing: state.guessing(),
            offline,
            uploads: state.uploads.clone(),
            orders,
            prs,
            files: state.files.clone(),
        };
        for c in [Some(&self.docked), self.floating.as_ref(), Some(&self.follow)].into_iter().flatten() {
            c.update(cx, |c, cx| c.set_sync(sync.clone(), cx));
        }
        if let Some(w) = state.order.as_ref().map(|o| o.workstream_id.clone()) {
            self.follow.update(cx, |c, cx| c.set_order(&w, cx));
        }
    }

    /// Keeps one lanes entity per order card on the board (and one for the open order), fed from the live state.
    fn sync_lanes(&mut self, cx: &mut Context<Self>) {
        let hub_now = self.state.live.hub_now_ms(now_ms());
        let stale = self.state.live_stale() && self.bench.is_none();
        let mut keep = HashSet::new();
        for row in &self.state.projects {
            for card in self.state.live.orders(&row.key()) {
                let id = card.workstream_id.to_string();
                keep.insert(id.clone());
                let lanes = self.state.live.lanes(&card.workstream_id);
                let entity = self.card_lanes.entry(id).or_insert_with(|| {
                    let w = card.workstream_id.clone();
                    let e = cx.new(|cx| FleetLanes::new(w, Density::Card, cx));
                    cx.subscribe(&e, Self::on_lane_event).detach();
                    e
                });
                entity.update(cx, |l, cx| l.set(lanes, hub_now, stale, cx));
            }
        }
        self.card_lanes.retain(|id, _| keep.contains(id));
        match self.state.order.as_ref().map(|o| o.workstream_id.clone()) {
            Some(w) => {
                if self.order_lanes_for.as_deref() != Some(w.as_str()) {
                    let id = WorkstreamId::unchecked(&w);
                    let e = cx.new(|cx| FleetLanes::new(id, Density::Full, cx));
                    cx.subscribe(&e, Self::on_lane_event).detach();
                    self.order_lanes = Some(e);
                    self.order_lanes_for = Some(w.clone());
                }
                let lanes: Vec<_> = self
                    .state
                    .live
                    .lanes(&WorkstreamId::unchecked(&w))
                    .into_iter()
                    .filter(|l| l.role != fleetd_contracts::live::AgentRole::Lead)
                    .collect();
                if let Some(e) = &self.order_lanes {
                    e.update(cx, |l, cx| l.set(lanes, hub_now, stale, cx));
                }
            }
            None => {
                self.order_lanes = None;
                self.order_lanes_for = None;
            }
        }
        let trains = self.state.live.trains().to_vec();
        self.train_strip.update(cx, |s, cx| s.set(trains, cx));
    }

    fn on_lane_event(&mut self, lanes: Entity<FleetLanes>, event: &LaneEvent, cx: &mut Context<Self>) {
        match event {
            LaneEvent::OpenPr(url) => cx.open_url(url.as_ref()),
            LaneEvent::Open(_) if self.screen != Screen::Order => {
                let w = lanes.read(cx).workstream().to_string();
                self.open_order(&w, cx);
            }
            LaneEvent::Open(_) => {}
            LaneEvent::Told(thread, who) => self.open_told(thread.clone(), who.clone(), cx),
        }
    }

    /// Subscribes to what's on screen: the board's lanes while it shows, the open order's in focus; nothing while
    /// the window is in the background. `force` after the window comes back, for a fresh full frame.
    fn update_live(&mut self, force: bool, cx: &mut Context<Self>) {
        if self.bench.is_some() {
            return;
        }
        let active = self.window_active;
        let board = active && self.screen == Screen::Board;
        let focus = if active && self.screen == Screen::Order { self.state.order.as_ref().map(|o| o.workstream_id.clone()) } else { None };
        let out = self.state.subscribe_live(board, focus.as_deref(), force && active);
        self.send(out);
        cx.notify();
    }

    // ---- navigation and keys ---------------------------------------------------------------

    pub(crate) fn go(&mut self, screen: Screen) {
        // Settings works before connecting too (appearance); everything else needs a hub.
        if !self.connected() && screen != Screen::Settings {
            return;
        }
        if screen == Screen::Settings && self.screen != Screen::Settings {
            self.before_settings = self.screen;
        }
        if screen != Screen::Order && self.screen == Screen::Order {
            self.state.close_order();
            self.floating = None;
            self.stop_confirm = false;
        }
        if screen == Screen::Machines && self.screen != Screen::Machines {
            let out = self.state.open_doctor();
            self.send(out);
        }
        self.screen = screen;
        self.selected = 0;
    }

    pub(crate) fn open_order(&mut self, workstream_id: &str, cx: &mut Context<Self>) {
        if !self.connected() {
            return;
        }
        self.floating = None;
        self.stop_confirm = false;
        if self.bench.is_none() {
            let out = self.state.open_order(workstream_id);
            self.send(out);
        } else {
            self.state.open_order(workstream_id);
        }
        if let Some(key) = self.state.order.as_ref().and_then(|o| o.key.clone()) {
            if let Some(row) = self.state.project(&key) {
                self.seen.mark(&key, row.summary.last_activity_at.as_str());
            }
            self.selected_project = Some(key);
        }
        self.selected_card = Some(workstream_id.to_string());
        self.screen = Screen::Order;
        self.pending_focus = Some(self.follow.focus_handle(cx));
        self.after_state_change(cx);
        cx.notify();
    }

    /// ⌘L: the composer on screen.
    pub(crate) fn focus_composer(&mut self, cx: &mut Context<Self>) {
        self.pending_focus = Some(match (self.screen, &self.floating) {
            (_, Some(f)) => f.focus_handle(cx),
            (Screen::Order, None) => self.follow.focus_handle(cx),
            (Screen::Board, None) => self.docked.focus_handle(cx),
            _ => self.focus.clone(),
        });
        cx.notify();
    }

    /// ⌘N: the board's composer, or a floating one over the order view so you keep your place.
    fn new_order(&mut self, target: Option<ProjectKey>, window: &mut Window, cx: &mut Context<Self>) {
        if !self.connected() {
            return;
        }
        self.palette = None;
        if self.screen == Screen::Order {
            let floating = cx.new(|cx| Composer::new(Placement::Floating, cx));
            cx.subscribe_in(&floating, window, Self::on_composer_event).detach();
            if let Some(key) = target {
                floating.update(cx, |c, cx| c.choose(Some(key), cx));
            }
            self.pending_focus = Some(floating.focus_handle(cx));
            self.floating = Some(floating);
            self.sync_composers(cx);
        } else {
            self.go(Screen::Board);
            if let Some(key) = target {
                self.docked.update(cx, |c, cx| c.choose(Some(key), cx));
            }
            self.pending_focus = Some(self.docked.focus_handle(cx));
        }
        cx.notify();
    }

    fn on_composer_event(&mut self, composer: &Entity<Composer>, event: &ComposerEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            ComposerEvent::Send(draft) => {
                let request_id = format!("app-{}", now_ms());
                let order = SentOrder {
                    request_id,
                    to: draft.target.clone(),
                    text: draft.text.clone(),
                    template: draft.template,
                    attachments: draft.attachments.clone(),
                    refs: draft.refs.clone(),
                    status: crate::state::Sent::Sending,
                };
                let out = self.state.submit_order(order);
                self.send(out);
                if self.floating.as_ref() == Some(composer) {
                    self.floating = None;
                    self.pending_focus = Some(self.follow.focus_handle(cx));
                }
            }
            ComposerEvent::Note { draft, urgent } => {
                let id = format!("note-{}", now_ms());
                let out = self.state.note(&draft.text, *urgent, draft.attachments.clone(), draft.refs.clone(), &id);
                self.send(out);
            }
            ComposerEvent::Dismiss => {
                if self.floating.as_ref() == Some(composer) {
                    self.floating = None;
                    self.pending_focus = Some(self.follow.focus_handle(cx));
                } else if self.screen == Screen::Order {
                    self.go(Screen::Board);
                    self.pending_focus = Some(self.docked.focus_handle(cx));
                } else {
                    window.focus(&self.focus, cx);
                }
            }
            ComposerEvent::Preview(text) => {
                let out = self.state.preview(text);
                self.send(out);
            }
            ComposerEvent::Files { key, query } => {
                let out = self.state.list_files(key, query);
                self.send(out);
            }
            ComposerEvent::Upload { local, name, mime, data_b64 } => {
                let out = self.state.attach(*local, name, mime, data_b64.clone());
                self.send(out);
            }
        }
        self.after_state_change(cx);
        cx.notify();
    }

    /// The orders the sidebar lists, in its order: ⌘1..9 and ⌘[ / ⌘] walk these.
    fn sidebar_orders(&self) -> Vec<String> {
        sidebar::orders(&self.state, self.now_secs()).into_iter().map(|(_, id)| id).collect()
    }

    fn step_order(&mut self, by: isize, cx: &mut Context<Self>) {
        let orders = self.sidebar_orders();
        if orders.is_empty() {
            return;
        }
        let current = self.state.order.as_ref().and_then(|o| orders.iter().position(|w| *w == o.workstream_id));
        let next = match current {
            Some(ix) => (ix as isize + by).rem_euclid(orders.len() as isize) as usize,
            None => 0,
        };
        let w = orders[next].clone();
        self.open_order(&w, cx);
    }

    fn move_card(&mut self, by: isize, cx: &mut Context<Self>) {
        let cards = self.board_cards();
        if cards.is_empty() {
            return;
        }
        let ix = self.selected_card.as_ref().and_then(|s| cards.iter().position(|c| c == s));
        let next = match ix {
            Some(ix) => (ix as isize + by).clamp(0, cards.len() as isize - 1) as usize,
            None => 0,
        };
        self.selected_card = Some(cards[next].clone());
        if let Some(row) = self.board_now.iter().position(|r| matches!(r, crate::board::Row::Card(id) if *id == cards[next])) {
            self.board_list.scroll_to_reveal_item(row + 1);
        }
        self.hold_board(true, cx);
        self.hold_board(false, cx);
        cx.notify();
    }

    /// Freezes the board's order while the pointer is on it (or a key just moved the selection); it resorts
    /// [`RESORT_AFTER`] after the last interaction.
    pub(crate) fn hold_board(&mut self, holding: bool, cx: &mut Context<Self>) {
        if holding {
            self.resort = None;
            if self.board_held.is_none() {
                let ids = self.board_rows().iter().map(crate::board::row_id).collect();
                self.board_held = Some(ids);
            }
            return;
        }
        self.resort = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(RESORT_AFTER).await;
            this.update(cx, |this, cx| {
                this.board_held = None;
                cx.notify();
            })
            .ok();
        }));
    }

    /// Accelerators only: everything here is also a click away. Text goes to whichever field has focus.
    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let ks = &event.keystroke;
        if let Some((_, probe)) = &mut self.bench {
            probe.key_received(Instant::now(), &ks.key);
        }
        let m = &ks.modifiers;
        if m.secondary() && !m.alt && !m.shift {
            if let Some(n) = ks.key.parse::<usize>().ok().filter(|n| (1..=9).contains(n)) {
                if let Some(w) = self.sidebar_orders().get(n - 1).cloned() {
                    self.open_order(&w, cx);
                }
                cx.stop_propagation();
            }
            return;
        }
        if m.control || m.platform || m.alt {
            return;
        }
        let key = ks.key.as_str();
        let field_focused = !self.focus.is_focused(window) && !self.inbox_focus.is_focused(window);
        if key == "escape" {
            // Esc: close a menu (the field does) → the panel → the order view back to the board.
            if self.state.prompts.told.is_some() {
                self.state.prompts.told = None;
            } else if self.prompts_ui.picker.is_some() {
                self.prompts_ui.picker = None;
            } else if self.stop_confirm {
                self.stop_confirm = false;
            } else if self.inbox_open {
                self.toggle_inbox(false, cx);
            } else if self.screen == Screen::Order {
                self.go(Screen::Board);
                self.pending_focus = Some(self.docked.focus_handle(cx));
            } else {
                return;
            }
            cx.stop_propagation();
            cx.notify();
            return;
        }
        if field_focused {
            return;
        }
        match (self.screen, key) {
            (Screen::Board, "up" | "k") => self.move_card(-1, cx),
            (Screen::Board, "down" | "j") => self.move_card(1, cx),
            (Screen::Board, "enter") => {
                if let Some(w) = self.selected_card.clone() {
                    self.open_order(&w, cx);
                }
            }
            (Screen::Machines, "up" | "down") if !self.state.machines.is_empty() => {
                let len = self.state.machines.len();
                self.selected = if key == "up" { self.selected.saturating_sub(1) } else { (self.selected + 1).min(len - 1) };
            }
            _ => {
                // Typing with no field focused (after clicking the background) goes to the composer on screen.
                if let Some(text) = printable(ks).filter(|_| matches!(self.screen, Screen::Board | Screen::Order) && !self.inbox_open) {
                    let target = if self.screen == Screen::Order { self.follow.clone() } else { self.docked.clone() };
                    let text = text.to_string();
                    target.update(cx, |c, cx| c.type_text(&text, cx));
                    self.pending_focus = Some(target.focus_handle(cx));
                } else {
                    return;
                }
            }
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn on_modifiers(&mut self, event: &ModifiersChangedEvent, _: &mut Window, cx: &mut Context<Self>) {
        let held = event.modifiers.secondary() && !event.modifiers.shift && !event.modifiers.alt;
        if held != self.cmd_held {
            self.cmd_held = held;
            cx.notify();
        }
    }

    // ---- overlays and commands ------------------------------------------------------------

    fn pick(&mut self, pick: sidebar::Pick, window: &mut Window, cx: &mut Context<Self>) {
        match pick {
            sidebar::Pick::Board => {
                self.go(Screen::Board);
                self.pending_focus = Some(self.docked.focus_handle(cx));
            }
            sidebar::Pick::Machines => self.go(Screen::Machines),
            sidebar::Pick::Settings => self.go(Screen::Settings),
            sidebar::Pick::Project(key) => {
                self.selected_project = if self.selected_project.as_ref() == Some(&key) && self.screen == Screen::Board { None } else { Some(key) };
                self.go(Screen::Board);
                self.pending_focus = Some(self.docked.focus_handle(cx));
                self.sync_composers(cx);
            }
            sidebar::Pick::Order(w) => self.open_order(&w, cx),
        }
        let _ = window;
        cx.notify();
    }

    /// Runs a palette command. Every one of these is also a click or a menu item away.
    fn run(&mut self, command: Command, window: &mut Window, cx: &mut Context<Self>) {
        self.palette = None;
        self.focus_composer(cx);
        match command {
            Command::Board => {
                self.go(Screen::Board);
                self.focus_composer(cx);
            }
            Command::Inbox => self.toggle_inbox(true, cx),
            Command::Machines => self.go(Screen::Machines),
            Command::Settings => self.go(Screen::Settings),
            Command::Project(key) => self.pick(sidebar::Pick::Project(key), window, cx),
            Command::Order(w) => self.open_order(&w, cx),
            Command::Ask(id) => {
                self.toggle_inbox(true, cx);
                self.focus_ask = Some(id);
            }
            Command::NewOrder(target) => self.new_order(target, window, cx),
            Command::NewOrderText(text) => {
                self.new_order(None, window, cx);
                let target = self.floating.clone().unwrap_or_else(|| self.docked.clone());
                target.update(cx, |c, cx| c.set_text(&text, cx));
            }
            Command::ToggleGroup => self.group_by_status = !self.group_by_status,
            Command::Connect => self.disconnect(cx),
        }
        cx.notify();
    }

    fn toggle_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.take().is_some() || !self.connected() {
            self.focus_composer(cx);
            return cx.notify();
        }
        self.floating = None;
        let items = palette::items(&self.state);
        let palette = cx.new(|cx| Palette::new(items, window, cx));
        cx.subscribe_in(&palette, window, |this, _, event: &PaletteEvent, window, cx| match event {
            PaletteEvent::Run(command) => this.run(command.clone(), window, cx),
            PaletteEvent::Dismiss => this.close_overlays(cx),
        })
        .detach();
        self.palette = Some(palette);
        cx.notify();
    }

    fn close_overlays(&mut self, cx: &mut Context<Self>) {
        self.palette = None;
        self.floating = None;
        self.state.prompts.told = None;
        self.focus_composer(cx);
    }

    pub(crate) fn close_settings(&mut self, cx: &mut Context<Self>) {
        self.screen = self.before_settings;
        self.prompts_ui.picker = None;
        self.focus_composer(cx);
        cx.notify();
    }

    pub(crate) fn connected(&self) -> bool {
        self.hub.is_some() || self.bench.is_some()
    }

    // ---- frame -------------------------------------------------------------------------------

    fn conn_line(&self, t: &Theme) -> sidebar::Conn {
        let host = self.hub.as_ref().map(|h| h.url.split("://").nth(1).unwrap_or(&h.url).trim_end_matches('/').to_string()).unwrap_or_default();
        let (color, label) = match (&self.state.conn, self.bench.is_some()) {
            (_, true) => (t.warning, "Bench fixture, no hub".to_string()),
            (Conn::Live, _) => (t.success, format!("Connected to {host}")),
            (Conn::Connecting { reason: None, .. }, _) => (t.faint, format!("Connecting to {host}…")),
            (Conn::Connecting { reason: Some(r), retry_in }, _) => {
                (t.warning, format!("Reconnecting in {}s: {r}", retry_in.map_or(0, |d| d.as_secs_f32().ceil() as u64)))
            }
            (Conn::Refused(_), _) => (t.danger, "The hub refused this key".to_string()),
        };
        sidebar::Conn { label: label.into(), color }
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &theme(cx).clone();
        let active = match self.screen {
            Screen::Board => match &self.selected_project {
                Some(key) => sidebar::Active::Project(key.clone()),
                None => sidebar::Active::Board,
            },
            Screen::Machines => sidebar::Active::Machines,
            Screen::Settings => sidebar::Active::Settings,
            Screen::Order => self.state.order.as_ref().map_or(sidebar::Active::None, |o| sidebar::Active::Order(o.workstream_id.clone())),
            Screen::Loading | Screen::Connect => sidebar::Active::None,
        };
        let this = cx.entity().downgrade();
        let on_pick: sidebar::OnPick = Rc::new(move |pick, window, cx| {
            this.update(cx, |this, cx| this.pick(pick, window, cx)).ok();
        });
        let update = self.update.clone().map(|text| {
            div()
                .px_4()
                .pb_3()
                .flex()
                .flex_col()
                .gap_1()
                .text_size(px(size::XS))
                .child(div().text_color(t.accent).child(text))
                .child(self.command_line("copy-update", "fleetd update", cx))
                .into_any_element()
        });
        sidebar::render(t, &self.state, &self.seen, &active, self.now_secs(), self.cmd_held, self.conn_line(t), update, on_pick)
    }

    /// The bottom of the window: machines and slots, then the merge trains when one has a head or a queue.
    fn strips(&self, cx: &mut Context<Self>) -> Div {
        let t = &theme(cx).clone();
        let trains = self.state.live.trains().iter().any(|tr| !tr.chips.is_empty() || tr.frozen);
        let machines = live::strips::machine_strip(t, self.state.live.machines(), self.state.live.slots());
        div()
            .flex_none()
            .flex()
            .flex_col()
            .bg(t.sidebar)
            .border_t_1()
            .border_color(t.hairline)
            .child(ui::clickable(t, div().id("machine-strip")).h(px(metric::ROW)).flex().items_center().child(machines).on_click(cx.listener(
                |this, _, _, cx| {
                    this.go(Screen::Machines);
                    cx.notify();
                },
            )))
            .when(trains, |d| {
                d.child(div().h(px(metric::ROW)).px_4().flex().items_center().border_t_1().border_color(t.hairline).child(self.train_strip.clone()))
            })
    }

    /// "2 need you ⌘I" and "⌘K" in the title bar.
    fn title_items(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        if !self.connected() || matches!(self.screen, Screen::Connect | Screen::Loading) {
            return Vec::new();
        }
        let t = &theme(cx).clone();
        let n = self.state.inbox().len();
        let palette = ui::clickable(t, div().id("title-palette"))
            .px_1p5()
            .text_size(px(size::XS))
            .text_color(t.quiet)
            .hover(|s| s.underline())
            .child(ui::shortcut("K"))
            .on_click(cx.listener(|this, _, window, cx| this.toggle_palette(window, cx)));
        let badge = ui::clickable(t, div().id("title-inbox"))
            .flex()
            .items_center()
            .gap_1p5()
            .px_1p5()
            .text_size(px(size::XS))
            .text_color(if n > 0 { t.text } else { t.quiet })
            .hover(|s| s.underline())
            .when(n > 0, |d| d.child(ui::dot(t.warning)).font_weight(STRONG).child(format!("{n} need{} you", if n == 1 { "s" } else { "" })))
            .when(n == 0, |d| d.child("Inbox"))
            .child(div().font_weight(crate::theme::REGULAR).text_color(t.quiet).child(ui::shortcut("I")))
            .on_click(cx.listener(|this, _, _, cx| {
                let open = !this.inbox_open;
                this.toggle_inbox(open, cx);
            }));
        vec![div().w(px(24.)).into_any_element(), palette.into_any_element(), badge.into_any_element()]
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(focus) = self.pending_focus.take() {
            window.focus(&focus, cx);
        }
        let screen = match self.screen {
            Screen::Loading => div().flex_1().into_any_element(),
            Screen::Connect => self.connect_screen(cx),
            Screen::Board => self.board_screen(cx),
            Screen::Order => self.order_screen(window, cx),
            Screen::Machines => self.machines_screen(cx),
            Screen::Settings => {
                let hub = settings::Hub {
                    url: self.hub.as_ref().map(|h| h.url.clone().into()),
                    status: self.conn_line(theme(cx)).label,
                    live: self.state.conn == Conn::Live && self.hub.is_some(),
                };
                self.settings.update(cx, |s, _| s.hub = hub);
                self.settings_screen(cx)
            }
        };
        let t = theme(cx).clone();
        let banner = self.note.clone().or_else(|| self.state.notice.clone());
        let chrome = self.connected() && !matches!(self.screen, Screen::Connect | Screen::Loading);
        let main = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .when_some(banner, |d, text| {
                d.child(div().px_4().py_2().border_b_1().border_color(t.hairline).child(self.error_line("copy-banner", text, None, cx)))
            })
            .child(div().flex_1().min_h_0().flex().child(screen))
            .when(chrome, |d| d.children(self.echo_line(cx)));
        let overlay = |child: AnyElement, cx: &mut Context<Self>| {
            // A click outside the floating panel closes it; the panel itself stops clicks reaching what's under.
            div()
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .items_center()
                .pt(px(88.))
                .occlude()
                .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, cx| this.close_overlays(cx)))
                .child(div().occlude().child(child))
        };
        let panel = (chrome && self.inbox_open).then(|| {
            let panel = self.inbox_panel(window, cx);
            div().absolute().top(px(34.)).bottom_0().right_0().child(live::motion::slide_panel("inbox-panel-slide", panel, true))
        });
        let title_items = self.title_items(cx);
        let told = self.told_sheet(window, cx);
        div()
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(t.bg)
            .text_color(t.text)
            .text_size(px(size::MD))
            .font_family(t.ui_font.clone())
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .on_modifiers_changed(cx.listener(Self::on_modifiers))
            .on_action(cx.listener(|_, _: &FocusNext, window, cx| window.focus_next(cx)))
            .on_action(cx.listener(|_, _: &FocusPrev, window, cx| window.focus_prev(cx)))
            .on_action(cx.listener(|this, _: &actions::OpenSettings, _, cx| {
                this.go(Screen::Settings);
                cx.notify();
            }))
            .when(self.connected(), |d| {
                d.on_action(cx.listener(|this, _: &actions::NewOrder, window, cx| this.new_order(None, window, cx)))
                    .on_action(cx.listener(|this, _: &actions::FocusComposer, _, cx| this.focus_composer(cx)))
                    .on_action(cx.listener(|this, _: &actions::ToggleCommandPalette, window, cx| this.toggle_palette(window, cx)))
                    .on_action(cx.listener(|this, _: &actions::ToggleInbox, _, cx| {
                        let open = !this.inbox_open;
                        this.toggle_inbox(open, cx);
                    }))
                    .on_action(cx.listener(|this, _: &actions::GoToBoard, _, cx| {
                        this.go(Screen::Board);
                        this.focus_composer(cx);
                    }))
                    .on_action(cx.listener(|this, _: &actions::ToggleGrouping, _, cx| {
                        this.group_by_status = !this.group_by_status;
                        cx.notify();
                    }))
                    .on_action(cx.listener(|this, _: &actions::ToggleSidebar, _, cx| {
                        this.sidebar_hidden = !this.sidebar_hidden;
                        cx.notify();
                    }))
                    .when(self.screen == Screen::Order, |d| {
                        d.on_action(cx.listener(|this, _: &actions::PreviousOrder, _, cx| this.step_order(-1, cx)))
                            .on_action(cx.listener(|this, _: &actions::NextOrder, _, cx| this.step_order(1, cx)))
                            .on_action(cx.listener(|this, _: &actions::StopOrder, _, cx| {
                                let stoppable = this
                                    .state
                                    .order
                                    .as_ref()
                                    .and_then(|o| o.card.as_ref())
                                    .is_none_or(|c| !matches!(c.phase, OrderPhase::Stopped | OrderPhase::Done | OrderPhase::Failed));
                                this.stop_confirm = stoppable;
                                cx.notify();
                            }))
                    })
            })
            .child(crate::titlebar::TitleBar::new().children(title_items))
            .child(div().flex_1().min_h_0().flex().when(chrome && !self.sidebar_hidden, |d| d.child(self.sidebar(cx))).child(main))
            .when(chrome, |d| d.child(self.strips(cx)))
            .children(panel)
            .when_some(self.palette.clone(), |d, p| d.child(overlay(p.into_any_element(), cx)))
            .when_some(self.floating.clone(), |d, c| d.child(overlay(c.into_any_element(), cx)))
            .when_some(told, |d, sheet| d.child(overlay(sheet, cx)))
    }
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

impl Shell {
    fn copy(&mut self, text: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
        self.copied = Some(text);
        cx.notify();
    }

    /// A small button that copies `text` and then says so.
    pub(crate) fn copy_button(&self, id: impl Into<SharedString>, text: impl Into<String>, cx: &mut Context<Self>) -> Stateful<Div> {
        let text = text.into();
        let copied = self.copied.as_deref() == Some(text.as_str());
        ui::copy_button(theme(cx), id.into(), copied).on_click(cx.listener(move |this, _, _, cx| this.copy(text.clone(), cx)))
    }

    /// An error and its fix, with a Copy button for both, so they can be pasted into an issue or a search.
    pub(crate) fn error_line(&self, id: impl Into<SharedString>, message: impl Into<String>, fix: Option<String>, cx: &mut Context<Self>) -> Div {
        let message = message.into();
        let all = match &fix {
            Some(fix) => format!("{message}\n{fix}"),
            None => message.clone(),
        };
        let copy = self.copy_button(id, all, cx);
        ui::error(theme(cx), message, fix.map(Into::into), copy)
    }

    /// A command to run elsewhere, in mono, with a Copy button.
    pub(crate) fn command_line(&self, id: impl Into<SharedString>, command: impl Into<String>, cx: &mut Context<Self>) -> Div {
        let command = command.into();
        let copy = self.copy_button(id, command.clone(), cx);
        ui::command(theme(cx), command, copy)
    }

    pub(crate) fn quick_reply(&mut self, batch_id: BatchId, raw: String, cx: &mut Context<Self>) {
        let out = self.state.reply(&raw, Some(&batch_id));
        self.send(out);
        cx.notify();
    }

    fn push_log(&mut self, line: LogRow) {
        self.log.push(line);
        if self.log_follow {
            self.log_scroll.scroll_to_item(self.log.len() - 1, ScrollStrategy::Bottom);
        }
    }

    /// Seals the typed value to the sink machine's key and sends only the ciphertext, then wipes the field.
    pub(crate) fn submit_secret(&mut self, ask_id: &str, cx: &mut Context<Self>) {
        let Some((input, _)) = self.secrets.get(ask_id) else { return };
        let input = input.clone();
        let Some(ask) = self.state.asks.get(ask_id) else { return };
        let value = input.read(cx).text();
        if value.is_empty() {
            return;
        }
        match self.state.secret_target(ask).and_then(|(machine, key)| Ok((machine, seal::seal(&key, value.as_bytes())?))) {
            Ok((machine, sealed)) => {
                let out = self.state.submit_secret(ask_id, &machine, sealed);
                self.send(out);
                input.update(cx, |i, cx| i.clear(cx));
            }
            Err(e) => self.state.echo = Some(Echo { text: e, ok: false }),
        }
        cx.notify();
    }

    /// Opens a clicked link; a path on another machine is copied instead, and the echo says so.
    pub(crate) fn link_opener(&self, workspace: Option<String>, cx: &mut Context<Self>) -> links::OnOpen {
        let this = cx.entity().downgrade();
        Rc::new(move |link, _, cx| {
            if let links::Opened::Copied(path) = links::open(link, workspace.as_deref(), cx) {
                this.update(cx, |this, cx| {
                    this.state.echo = Some(Echo { text: format!("{path} isn't on this computer; copied its path."), ok: true });
                    cx.notify();
                })
                .ok();
            }
        })
    }

    fn connect_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let form = &self.form;
        let field = |label: &'static str, input: &Entity<TextInput>| {
            div().flex().flex_col().gap_1().child(div().text_size(px(size::XS)).text_color(t.quiet).child(label)).child(input.clone())
        };
        let mut col = div()
            .w(px(440.))
            .flex()
            .flex_col()
            .gap_4()
            .child(div().text_size(px(size::XL)).font_weight(STRONG).child("Connect to your fleetd hub"))
            // The pairing messages mark commands with backticks; the command names read fine without them here.
            .when_some(form.status.clone(), |d, status| d.child(div().whitespace_normal().text_color(t.quiet).child(status.replace('`', ""))))
            .child(field("Hub address", &form.hub));
        if !form.use_key {
            col = col
                .child(field("Pairing code", &form.code))
                .child(
                    div().flex().child(
                        ui::button(t, "pair", if form.busy { "Connecting…" } else { "Connect" }, Variant::Primary, !form.busy)
                            .on_click(cx.listener(|this, _, _, cx| this.submit_code(cx))),
                    ),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().text_color(t.quiet).child("No code yet? On the hub, run this and type the code it prints:"))
                        .child(self.command_line("copy-pair", "fleetd pair", cx)),
                );
        }
        if let Some(error) = &form.error {
            col =
                col.child(self.error_line("copy-connect-error", error.message.replace('`', ""), error.fix.as_ref().map(|f| f.replace('`', "")), cx));
        }
        col = col.child(
            ui::clickable(t, div().id("use-key"))
                .flex()
                .gap_1()
                .items_center()
                .text_color(t.accent)
                .child(if form.use_key { "▾ Use a key instead" } else { "▸ Use a key instead" })
                .on_click(cx.listener(|this, _, _, cx| {
                    this.form.use_key = !this.form.use_key;
                    this.form.error = None;
                    let target = if this.form.use_key { &this.form.key } else { &this.form.code };
                    this.pending_focus = Some(target.focus_handle(cx));
                    cx.notify();
                })),
        );
        if form.use_key {
            col = col
                .child(field("Key", &form.key))
                .child(
                    div().flex().child(
                        ui::button(t, "connect-key", "Connect with key", Variant::Primary, true)
                            .on_click(cx.listener(|this, _, _, cx| this.submit_key(cx))),
                    ),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .text_color(t.quiet)
                                .whitespace_normal()
                                .child("On the hub, create a key for this device, so your answers are recorded as yours:"),
                        )
                        .child(self.command_line("copy-key-create", "fleetd hub key create --human --name <device>", cx)),
                );
        }
        col = col.child(div().text_size(px(size::XS)).text_color(t.quiet).child(format!("The key is kept {}.", keychain::where_kept())));
        // Left-aligned at a third of the window, like a document, not a centred card.
        div().id("connect").flex_1().min_h_0().overflow_y_scroll().flex().flex_col().pt(px(96.)).pb_8().pl(px(120.)).child(col).into_any_element()
    }

    fn machines_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = &theme(cx).clone();
        let mut list = div().id("machines").flex_1().min_h_0().overflow_y_scroll().p_2().pb_6().flex().flex_col();
        if self.state.machines.is_empty() {
            list = list.child(ui::empty(t, "No machines yet.", "Add one on the hub with fleetd machine add <ssh-host>, or run fleetd init again."));
        }
        for (ix, m) in self.state.machines.iter().enumerate() {
            let (color, status) = match m.status {
                MachineStatus::Online => (t.success, "online"),
                MachineStatus::Degraded => (t.warning, "degraded"),
                MachineStatus::Offline => (t.danger, "offline"),
            };
            let detail = match (&m.degraded_reason, m.status) {
                (Some(reason), _) => reason.clone(),
                (None, MachineStatus::Offline) => format!("Last seen {}", ago(m.last_seen_at.as_str())),
                _ => String::new(),
            };
            let versions = format!("node {}", m.node_version);
            list = list.child(
                ui::row(t, SharedString::from(format!("machine-{}", m.name)), ix == self.selected)
                    .h(px(metric::ROW + 8.))
                    .gap_3()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected = ix;
                        cx.notify();
                    }))
                    .child(
                        div()
                            .w(px(140.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(ui::dot(color))
                            .child(div().font_weight(STRONG).child(m.name.clone())),
                    )
                    .child(div().w(px(72.)).flex_none().text_size(px(size::XS)).text_color(t.quiet).child(status))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_color(if m.degraded_reason.is_some() { t.warning } else { t.quiet })
                            .child(detail),
                    )
                    .child(div().flex_none().text_size(px(size::XS)).text_color(t.quiet).font_family(t.mono_font.clone()).child(versions))
                    .child(
                        div()
                            .w(px(64.))
                            .flex_none()
                            .flex()
                            .justify_end()
                            .text_size(px(size::XS))
                            .text_color(t.quiet)
                            .child(ago(m.last_seen_at.as_str())),
                    ),
            );
        }
        list = list.child(self.doctor_section(cx));
        div().flex_1().flex().flex_col().min_w_0().child(ui::header(t, "Machines", String::new())).child(list).into_any_element()
    }

    fn doctor_section(&self, cx: &mut Context<Self>) -> Div {
        let t = &theme(cx).clone();
        let doctor = self.state.doctor.as_ref();
        let rerunning = self.state.doctor_rerunning();
        let checked = match doctor.and_then(|d| d.checked_at.as_ref().map(|t| t.as_str())) {
            Some(at) => format!("Checked {}", ago(at)),
            None => "Checking…".into(),
        };
        let rerun = ui::button(t, "doctor-rerun", if rerunning { "Re-running…" } else { "Re-run" }, Variant::Ghost, !rerunning).on_click(
            cx.listener(|this, _, _, cx| {
                let out = this.state.rerun_doctor();
                this.send(out);
                cx.notify();
            }),
        );
        let mut section = div().px_2().flex().flex_col().max_w(px(metric::MEASURE + 340.)).child(
            div()
                .pt_6()
                .pb_2()
                .flex()
                .gap_3()
                .items_center()
                .child(div().font_weight(STRONG).child("Setup checks"))
                .child(div().text_size(px(size::XS)).text_color(t.quiet).child(checked))
                .child(div().flex_1())
                .child(rerun),
        );
        if let Some(e) = doctor.and_then(|d| d.error.clone()) {
            section = section.child(self.error_line("copy-doctor-error", e, None, cx));
        }
        for check in doctor.map(|d| d.checks.as_slice()).unwrap_or_default() {
            let color = match check.status {
                DoctorStatus::Ok => t.success,
                DoctorStatus::Warn => t.warning,
                DoctorStatus::Fail => t.danger,
                _ => t.faint,
            };
            let ok = check.status == DoctorStatus::Ok;
            let mut row = div()
                .py_2()
                .flex()
                .gap_3()
                .items_start()
                .border_b_1()
                .border_color(t.hairline)
                .child(ui::dot(color))
                .child(
                    div()
                        .w(px(170.))
                        .flex_none()
                        .pt(px(1.))
                        .font_family(t.mono_font.clone())
                        .text_size(px(size::SM))
                        .text_color(t.quiet)
                        .child(check.id.to_string()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .whitespace_normal()
                        .when(ok, |d| d.text_color(t.quiet))
                        .when(!ok, |d| d.font_weight(STRONG))
                        .child(check.message.to_string()),
                );
            if let Some(fix) = check.fix.as_ref().filter(|_| !ok) {
                let mut fix_col = div().w(px(320.)).flex_none().flex().flex_col().gap_1().child(ui::quiet(t, fix.label.to_string()));
                if let Some(command) = fix.command.as_ref().filter(|_| fix.kind == DoctorFixKind::Manual) {
                    fix_col = fix_col.child(self.command_line(format!("copy-fix-{}", check.id), command.to_string(), cx));
                }
                if fix.kind == DoctorFixKind::Auto {
                    let id = check.id.clone();
                    let fixing = self.state.doctor_fixing(&id);
                    fix_col = fix_col.child(
                        div().flex().child(
                            ui::button(
                                t,
                                SharedString::from(format!("fix-{id}")),
                                if fixing { "Fixing…" } else { "Fix" },
                                Variant::Secondary,
                                !fixing,
                            )
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let out = this.state.fix_doctor(&id);
                                this.send(out);
                                cx.notify();
                            })),
                        ),
                    );
                }
                row = row.child(fix_col);
            }
            section = section.child(row);
        }
        section
    }

    /// What the last action did (sent, saved, refused), above the reply field on every screen.
    fn echo_line(&self, cx: &mut Context<Self>) -> Option<Div> {
        let t = &theme(cx).clone();
        let echo = self.state.echo.as_ref()?;
        Some(
            div()
                .min_h(px(metric::ROW + 4.))
                .flex_none()
                .px_4()
                .flex()
                .items_center()
                .gap_2()
                .border_t_1()
                .border_color(t.hairline)
                .text_size(px(size::XS))
                .child(ui::dot(if echo.ok { t.success } else { t.warning }))
                .child(div().flex_1().min_w_0().whitespace_normal().child(echo.text.clone()))
                .when(!echo.ok, |d| d.child(self.copy_button("copy-echo", echo.text.clone(), cx))),
        )
    }

    /// The bench's raw lead log in the order view: 20k uniform rows, which the scroll run scrolls.
    pub(crate) fn bench_log_pane(&mut self, t: &Theme, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.drive_scroll_bench(window);
        if !self.log_follow && self.scroll_bench_idle() && self.log_scroll.is_scrolled_to_end() == Some(true) {
            self.log_follow = true;
        }
        let on_open = self.link_opener(None, cx);
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_w_0()
            .child(div().h(px(metric::BAR - 8.)).flex_none().px_4().flex().items_center().text_size(px(size::XS)).text_color(t.quiet).child(format!(
                "Lead log · {} lines · {}",
                self.log.len(),
                if self.log_follow { "following" } else { "paused" }
            )))
            .child(
                uniform_list(
                    "log",
                    self.log.len(),
                    cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                        let t = theme(cx);
                        range.map(|ix| log_row(t, ix, &this.log[ix], &on_open)).collect::<Vec<_>>()
                    }),
                )
                .track_scroll(&self.log_scroll)
                .on_scroll_wheel(cx.listener(Self::on_log_wheel))
                .flex_1()
                .font_family(t.mono_font.clone())
                .text_size(px(size::SM)),
            )
    }

    fn on_log_wheel(&mut self, event: &ScrollWheelEvent, _: &mut Window, _: &mut Context<Self>) {
        let up = match event.delta {
            ScrollDelta::Pixels(p) => p.y > px(0.),
            ScrollDelta::Lines(l) => l.y > 0.,
        };
        if up {
            self.log_follow = false;
        }
    }

    // ---- bench -----------------------------------------------------------------------------

    fn start_bench(&mut self, mode: Mode, window: &mut Window, cx: &mut Context<Self>) {
        let history: usize = env_num("FLEETD_HISTORY", 20_000);
        let mut stream = LogStream::new(1);
        self.log = (0..history).map(|_| to_row(stream.next_line())).collect();
        self.state = fake::fixture_state();
        self.prompts_ui.fake = Some(fake::PromptHub::new());
        self.seen.prime(&self.state);
        // Two projects with news since you last looked, so the fixture shows the unread state.
        for row in self.state.projects.iter().skip(3).step_by(4).take(2) {
            self.seen.mark(&row.key(), "2026-10-17T09:00:00.000Z");
        }
        self.bench = Some((stream, Probe::new()));
        // The scroll run scrolls the order view's raw log; the other runs and screenshots show the conversation.
        self.bench_log = mode == Mode::Scroll;
        // FLEETD_SCREEN picks the screen the fixture opens on, for screenshots; the speed runs use the order view.
        let screen = std::env::var("FLEETD_SCREEN").unwrap_or_default();
        let (base, extra) = screen.split_once('+').unwrap_or((screen.as_str(), ""));
        match base {
            "board" => self.screen = Screen::Board,
            "machines" => self.go(Screen::Machines),
            "settings" => self.go(Screen::Settings),
            "prompts" | "instructions" => self.bench_prompts(base, extra, cx),
            _ => {
                self.state.order = None;
                self.open_order(fake::FIXTURE_ORDER, cx);
                // Opening an order refetches its lead's log; the fixture has no hub, so put its log back.
                self.state.detail = fake::fixture_state().detail;
            }
        }
        match extra {
            "told" | "told-task" => self.bench_told(extra == "told-task", cx),
            "inbox" => self.toggle_inbox(true, cx),
            "status" => self.group_by_status = true,
            "narrow" => {}
            _ => {}
        }
        self.after_state_change(cx);
        self.focus_composer(cx);
        if env_num("FLEETD_STREAM", 1) == 1 {
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(1000 / LINES_PER_SEC)).await;
                    let appended = this.update(cx, |this, cx| {
                        let line = to_row(this.bench.as_mut().unwrap().0.next_line());
                        this.push_log(line);
                        cx.notify();
                    });
                    if appended.is_err() {
                        return;
                    }
                }
            })
            .detach();
        }
        spawn_bench(mode, window, cx);
    }

    fn probe(&mut self) -> &mut Probe {
        &mut self.bench.as_mut().unwrap().1
    }

    fn scroll_bench_idle(&self) -> bool {
        self.bench.as_ref().is_none_or(|(_, p)| p.scroll_started.is_none())
    }

    fn drive_scroll_bench(&mut self, window: &mut Window) {
        let Some(started) = self.bench.as_ref().and_then(|(_, p)| p.scroll_started) else { return };
        self.log_follow = false;
        let state = self.log_scroll.0.borrow();
        let max = f32::from(state.base_handle.max_offset().y).max(1.);
        let y = (started.elapsed().as_secs_f32() * SCROLL_PX_PER_SEC) % max;
        state.base_handle.set_offset(point(px(0.), px(-y)));
        window.request_animation_frame();
    }
}

/// A contract enum's wire value, e.g. "irreversible".
pub fn wire_label<T: serde::Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        _ => "?".into(),
    }
}

/// One line for a done-when list.
pub fn describe(check: &CheckSpec) -> String {
    match check {
        CheckSpec::PrMerged { repo, pr } => match pr {
            Some(pr) => format!("PR #{pr} merged in {repo}"),
            None => format!("PR merged in {repo}"),
        },
        CheckSpec::CiGreen { repo, r#ref } => format!("CI green on {repo}{}", r#ref.as_ref().map(|r| format!(" @ {r}")).unwrap_or_default()),
        CheckSpec::Http { url, status, contains } => {
            format!("GET {url} → {status}{}", contains.as_ref().map(|c| format!(" containing \"{c}\"")).unwrap_or_default())
        }
        CheckSpec::Cmd { machine_id, argv, expect_exit } => format!("`{}` on {machine_id} exits {expect_exit}", argv.join(" ")),
        CheckSpec::Test { repo, test_id } => format!("test {test_id} passes in {repo}"),
        CheckSpec::Judge { criteria } => format!("judge: {criteria}"),
        CheckSpec::Human { question } => format!("you confirm: {question}"),
    }
}

/// "2026-10-17T10:04:05.123Z" → "10:04:05".
pub fn clock(iso: &str) -> &str {
    iso.get(11..19).unwrap_or(iso)
}

/// "4m ago"-style age; computed at render, which only happens on change, so it never ticks by itself.
pub fn ago(iso: &str) -> String {
    let Some(then) = unix_secs(iso) else { return iso.to_string() };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    let s = (now - then).max(0);
    match s {
        0..60 => "just now".into(),
        60..3600 => format!("{}m ago", s / 60),
        3600..86_400 => format!("{}h ago", s / 3600),
        _ => format!("{}d ago", s / 86_400),
    }
}

/// "6m", "2h", "3d": an order's age on its card.
pub fn ago_short(iso: &str, now_secs: i64) -> String {
    let Some(then) = unix_secs(iso) else { return String::new() };
    match (now_secs - then).max(0) {
        s @ 0..3600 => format!("{}m", s / 60),
        s @ 3600..86_400 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86_400),
    }
}

fn printable(ks: &Keystroke) -> Option<&str> {
    ks.key_char.as_deref().filter(|ch| !ch.chars().any(char::is_control))
}

pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max { text.to_string() } else { format!("{}…", text.chars().take(max - 1).collect::<String>()) }
}

fn spawn_bench(mode: Mode, window: &mut Window, cx: &mut Context<Shell>) {
    let x11_window = x11_window_id(window);
    cx.spawn_in(window, async move |this, cx| {
        let tick = Duration::from_millis(10);
        let wait = async |cx: &mut gpui::AsyncWindowContext, d: Duration| cx.background_executor().timer(d).await;
        // First present.
        loop {
            wait(cx, tick).await;
            let Ok(Some(first)) = this.update(cx, |s, _| {
                let p = s.probe();
                p.poll();
                p.first_present.map(|at| (p.unix_ns(at), p.first_draw.map_or(0, |d| p.unix_ns(d)), p.draws_to_first_present))
            }) else {
                continue;
            };
            let (present, draw, draws) = first;
            let x11 = x11_window.unwrap_or(0);
            this.update(cx, |s, _| {
                s.probe().emit(&format!("event=first_present unix_ns={present} first_draw_unix_ns={draw} draws={draws} x11_window={x11}"))
            })
            .ok();
            break;
        }
        let emit_keys = |s: &mut Shell| {
            let p = s.probe();
            for (key, lat) in p.poll() {
                p.emit(&format!("event=key key={key} latency_ns={}", lat.as_nanos()));
            }
        };
        match mode {
            Mode::Cold => {}
            Mode::Idle | Mode::Live => return,
            Mode::KeysInternal => {
                wait(cx, Duration::from_secs(1)).await;
                for i in 0..bench::KEYSTROKES {
                    // Enter every 40 letters keeps the echo on screen; the driver counts letters only.
                    if i > 0 && i % 40 == 0 {
                        cx.update(|window, cx| window.dispatch_keystroke(Keystroke::parse("enter").unwrap(), cx)).ok();
                        wait(cx, Duration::from_millis(50)).await;
                    }
                    let key = ((b'a' + (i % 26) as u8) as char).to_string();
                    // Not inside an entity update: dispatch re-enters Shell's key handler.
                    cx.update(|window, cx| window.dispatch_keystroke(Keystroke::parse(&key).unwrap(), cx)).ok();
                    wait(cx, Duration::from_millis(50)).await;
                    this.update(cx, |s, _| emit_keys(s)).ok();
                }
                wait(cx, Duration::from_millis(300)).await;
                this.update(cx, |s, _| emit_keys(s)).ok();
                this.update_in(cx, |s, window, _| s.probe().emit(&format!("event=keys active={}", window.is_window_active()))).ok();
            }
            Mode::KeysExternal => {
                wait(cx, Duration::from_secs(1)).await;
                this.update_in(cx, |s, window, cx| {
                    // The focused composer's text field in window pixels: where the driver watches for each echo.
                    let scale = window.scale_factor();
                    let field = s.follow.read(cx).field_bounds(cx).map_or_else(String::new, |b| {
                        let [x, y, w, h] = [b.origin.x, b.origin.y, b.size.width, b.size.height].map(|v| (f32::from(v) * scale).round() as i64);
                        format!(" field={x},{y},{w},{h}")
                    });
                    s.probe().emit(&format!("event=ready x11_window={}{field}", x11_window.unwrap_or(0)))
                })
                .ok();
                // The driver quits us after its last key; keep resolving latencies until then.
                loop {
                    wait(cx, Duration::from_millis(20)).await;
                    if this.update(cx, |s, _| emit_keys(s)).is_err() {
                        return;
                    }
                }
            }
            Mode::Scroll => {
                wait(cx, Duration::from_secs(1)).await;
                let start = Instant::now();
                this.update(cx, |s, cx| {
                    s.probe().scroll_started = Some(start);
                    cx.notify();
                })
                .ok();
                wait(cx, bench::SCROLL_FOR).await;
                let end = Instant::now();
                wait(cx, Duration::from_millis(100)).await;
                this.update_in(cx, |s, window, _| {
                    let active = window.is_window_active();
                    let p = s.probe();
                    p.poll();
                    let (fps, worst) = bench::scroll_stats(&p.presents, start, end);
                    p.scroll_started = None;
                    p.emit(&format!("event=scroll fps={fps:.1} worst_frame_us={} active={active}", worst.as_micros()));
                })
                .ok();
            }
        }
        this.update(cx, |s, _| s.probe().emit("event=done")).ok();
        cx.update(|_, cx| cx.quit()).ok();
    })
    .detach();
}

fn x11_window_id(window: &Window) -> Option<u32> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Xcb(h) => Some(h.window.get()),
        RawWindowHandle::Xlib(h) => Some(h.window as u32),
        _ => None,
    }
}

fn to_row(line: fake::LogLine) -> LogRow {
    LogRow::new(line.kind, &line.text)
}

fn env_num(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn text_row() -> Div {
    div().h(px(metric::LINE)).px_4().flex().items_center().whitespace_nowrap().overflow_hidden()
}

/// One log line: a grey timestamp column, then the line; links in it are clickable; diff lines are tinted.
fn log_row(t: &Theme, ix: usize, line: &LogRow, on_open: &links::OnOpen) -> Div {
    let text = SharedString::from(line.body().to_string());
    let body = div().min_w_0().text_color(log_color(t, line.kind));
    // Checked per visible row as it's drawn, so a 20k-line log costs nothing up front.
    let body = if links::has_link(&text) { body.child(links::text(t, format!("log-{ix}"), text, false, on_open.clone())) } else { body.child(text) };
    text_row().child(div().w(px(96.)).flex_none().text_color(t.quiet).child(SharedString::from(line.stamp().to_string()))).child(body)
}

/// Quiet work, loud failures: output and passing checks are grey, errors red, your own words in the accent.
fn log_color(t: &Theme, kind: LogKind) -> Hsla {
    match kind {
        LogKind::Tool | LogKind::Thought => t.text,
        LogKind::Output | LogKind::Ok => t.quiet,
        LogKind::Error => t.danger,
    }
}

/// "10:04:05.120  ● Read(a.rs)" -> ("10:04:05.120", "● Read(a.rs)"). A line without a stamp loses the stamp
/// column's worth of indent, so continuation lines line up under the text they continue.
fn split_stamp(text: &str) -> (&str, &str) {
    match text.split_once("  ") {
        Some((stamp, rest)) if stamp.len() >= 8 && stamp.as_bytes()[0].is_ascii_digit() && stamp.as_bytes()[2] == b':' => (stamp, rest),
        _ => {
            let indent = text.len() - text.trim_start_matches(' ').len();
            ("", &text[indent.min(STAMP_WIDTH)..])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_ages_are_short() {
        let at = unix_secs("2026-10-18T10:00:00.000Z").unwrap();
        assert_eq!(ago_short("2026-10-18T10:00:00.000Z", at + 359), "5m");
        assert_eq!(ago_short("2026-10-18T10:00:00.000Z", at + 7200), "2h");
        assert_eq!(ago_short("2026-10-18T10:00:00.000Z", at - 10), "0m", "a clock behind the hub reads as now");
    }
}
