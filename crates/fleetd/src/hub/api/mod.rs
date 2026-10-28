//! The `Hub` context every area reads, and the MCP tool registry every area plugs into.
//!
//! # Adding an area
//!
//! 1. Add the area's service to [`Hub`] as `pub <area>: Arc<Service>` and build it in `hub::serve::build`.
//! 2. If it runs a loop, start it in `hub::serve::start_loops` (one tokio task per loop; stop on `hub.shutdown`).
//! 3. If it serves MCP tools, give its module a `pub fn register(tools: &mut Registry)` and call it from [`registry`]
//!    below. Each tool is one [`Registry::add`]: the tool name from the contracts table, an input type that decodes
//!    with the contract's defaults and checks, and an async handler. The registry checks the tool's role from the
//!    contracts table before the handler runs; the handler checks the per-machine grant itself with [`require`] and
//!    filters fleet-wide results with [`readable`] / [`can_read`], and trims lists with
//!    [`cap`] and texts with [`clip`] to [`limits`]. Every refusal is a [`ToolError`] with a `fix`; every result
//!    carries a `next` hint where there is a next step. Store failures can be returned with `?` (they become the
//!    `failed` "The hub failed to answer that request." result and are logged), and a panic in a handler is
//!    turned into the same result, so one failed request never takes a connection down.
//! 4. Registering a tool that is already registered replaces it, so an area can take over one of the
//!    "not wired" stubs in `m1.rs` by registering after it (delete the stub when you do).
//!
//! # The node link
//!
//! `GET /node/link` upgrades to a WebSocket and hands it to the link area as
//! `crate::hub::link::handle(hub: Arc<Hub>, socket: axum::extract::ws::WebSocket)` (an `async fn` that runs until
//! the socket ends and never fails; refusals close the socket). Until the link area lands, `hub::http` answers that
//! route with a stand-in that closes the socket; the link area replaces that one line.
mod grants;
mod m1;
#[cfg(test)]
mod reads_tests;
mod registry;

pub use grants::*;
pub use registry::{CallError, Caller, Registry, ToolError};

use crate::clock::Clock;
use crate::hub::auth::Auth;
use crate::hub::store::{EventLog, HubDb, HubStore};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::watch;

/// Where the hub listens: `--listen host:port`, default 127.0.0.1:4790.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listen {
    pub host: String,
    pub port: u16,
}

impl Default for Listen {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 4790,
        }
    }
}

impl std::fmt::Display for Listen {
    /// `host:port` as the hub logs it (IPv6 hosts unbracketed).
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.host, self.port)
    }
}

/// The hub's settings from `fleetd hub start`.
#[derive(Clone, Debug)]
pub struct HubConfig {
    /// Resolved by `store::resolve_hub_home`.
    pub home: PathBuf,
    pub listen: Listen,
    /// The hub's public URL when one is configured (`fleetd init --url`); absent means `http://<listen>`.
    pub url: Option<String>,
    /// How long a write to an offline machine waits in the queue; absent means 24 h.
    pub queue_ttl_sec: Option<u64>,
}

impl HubConfig {
    pub fn url(&self) -> String {
        self.url
            .clone()
            .unwrap_or_else(|| format!("http://{}", self.listen))
    }
}

/// Fires once when the hub stops (SIGTERM/SIGINT). Loops and long-lived sockets select on [`Shutdown::wait`].
#[derive(Clone)]
pub struct Shutdown(Arc<watch::Sender<bool>>);

impl Default for Shutdown {
    fn default() -> Self {
        Self(Arc::new(watch::Sender::new(false)))
    }
}

impl Shutdown {
    pub fn trigger(&self) {
        self.0.send_replace(true);
    }
    pub fn is_triggered(&self) -> bool {
        *self.0.borrow()
    }
    /// Resolves once [`Shutdown::trigger`] was called (at once if it already was).
    pub async fn wait(&self) {
        let mut rx = self.0.subscribe();
        let _ = rx.wait_for(|stopped| *stopped).await;
    }
}

/// Everything the hub's areas share. One per hub; handlers get it as `Arc<Hub>`. Each area adds its service here
/// as a `pub` field (see the module docs).
pub struct Hub {
    pub config: HubConfig,
    pub clock: Arc<dyn Clock>,
    pub shutdown: Shutdown,
    pub db: Arc<HubDb>,
    pub store: Arc<HubStore>,
    pub events: Arc<EventLog>,
    pub auth: Arc<Auth>,
    pub decisions: Arc<crate::hub::ledger::Decisions>,
    pub executors: Arc<crate::hub::executor::Executors>,
    pub node_commands: Arc<crate::hub::link::NodeCommands>,
    pub lead_calls: Arc<crate::hub::link::LeadCalls>,
    pub link: Arc<crate::hub::link::NodeLinkServer>,
    pub watchdog: Arc<crate::hub::watchdog::Watchdog>,
    pub sweep: Arc<crate::hub::sweep::Sweep>,
    pub queue: Arc<crate::hub::queue::WriteQueue>,
    pub wakes: Arc<crate::hub::wakes::Wakes>,
    pub automations: Arc<crate::hub::automations::Automations>,
    pub verdicts: Arc<crate::hub::reviews::verdicts::Verdicts>,
    pub ops: Arc<crate::hub::usage::wire::OpsPorts>,
    pub usage: Arc<crate::hub::usage::Usage>,
    pub doctor: Arc<crate::hub::doctor::Doctor>,
    pub approvals: Arc<crate::hub::approvals::Approvals>,
    pub train: Arc<crate::hub::train::Train>,
    pub reviews: Arc<crate::hub::reviews::Reviews>,
    pub slots: Arc<crate::hub::slots::Slots>,
    pub policies: Arc<crate::hub::policy::Policies>,
    pub tasks: Arc<crate::hub::tasks::Tasks>,
    pub leads: Arc<crate::hub::leads::Area>,
    pub time: Arc<crate::hub::time::Time>,
    pub status: Arc<crate::hub::status::Status>,
    pub chat: Arc<crate::hub::chat::Chat>,
    pub prs: Arc<crate::hub::prs::Prs>,
    pub work: Arc<crate::hub::work::Work>,
    /// Each project's repos (hub/repos).
    pub repos: Arc<crate::hub::repos::Repos>,
    pub metrics: Arc<crate::hub::metrics::Metrics>,
    pub updates: Arc<crate::hub::update::Updates>,
    /// Session relays waiting for their runner's side (machine_roles/relay.rs).
    pub relays: Arc<crate::hub::machine_roles::relay::Relays>,
    /// Which node link last spoke of each running preview (hub/preview).
    pub previews: Arc<crate::hub::preview::Previews>,
    /// Machines added and removed from the app (hub/machine_setup).
    pub machine_setup: Arc<crate::hub::machine_setup::MachineSetup>,
}

/// Every MCP tool the hub serves, from every area that registers. The one place that lists them.
pub fn registry() -> Registry {
    let mut tools = Registry::default();
    m1::register(&mut tools);
    // Areas register here, after the M1 stubs so theirs replace them:
    crate::hub::ledger::register(&mut tools);
    crate::hub::executor::register(&mut tools);
    crate::hub::wakes::tools::register(&mut tools);
    crate::hub::usage::tools::register(&mut tools);
    crate::hub::doctor::tools::register(&mut tools);
    crate::hub::approvals::tools::register(&mut tools);
    crate::hub::projects::tools::register(&mut tools);
    crate::hub::mcp_servers::tools::register(&mut tools);
    crate::hub::claude_accounts::tools::register(&mut tools);
    crate::hub::hub_links::tools::register(&mut tools);
    crate::hub::google::tools::register(&mut tools);
    crate::hub::train::tools::register(&mut tools);
    crate::hub::tasks::tools::register(&mut tools);
    crate::hub::steer::tools::register(&mut tools);
    crate::hub::leads::tools::register(&mut tools);
    crate::hub::orders::tools::register(&mut tools);
    crate::hub::prompts::tools::register(&mut tools);
    crate::hub::memory::tools::register(&mut tools);
    crate::hub::automations::tools::register(&mut tools);
    crate::hub::checklist::tools::register(&mut tools);
    crate::hub::navi::tools::register(&mut tools);
    crate::hub::browser::tools::register(&mut tools);
    crate::hub::machine_roles::tools::register(&mut tools);
    crate::hub::machine_setup::tools::register(&mut tools);
    crate::hub::preview::tools::register(&mut tools);
    crate::hub::skills::tools::register(&mut tools);
    crate::hub::time::tools::register(&mut tools);
    crate::hub::update::tools::register(&mut tools);
    crate::hub::metrics::tools::register(&mut tools);
    crate::hub::status::tools::register(&mut tools);
    crate::hub::chat::tools::register(&mut tools);
    crate::hub::agents::tools::register(&mut tools);
    crate::hub::prs::tools::register(&mut tools);
    crate::hub::work::tools::register(&mut tools);
    crate::hub::info::register(&mut tools);
    crate::hub::people::tools::register(&mut tools);
    tools
}
