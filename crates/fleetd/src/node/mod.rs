//! The per-machine node: hub link, the session service that runs claude itself, the lead socket, cmd checks, sealed secrets, gated runs and node actions.
//!
//! The CLI calls [`join`] for `fleetd node join` and [`run`] for `fleetd node run` / `node serve`. Both run until
//! SIGINT or SIGTERM (`Ok`) or a failure the node cannot retry past (`Err`, exit 1 with `fleetd: <message>`).
pub mod actions;
pub mod browser;
pub mod cmd;
pub mod config;
pub mod device;
pub mod hosts;
pub mod identity;
pub mod landed;
pub mod lead;
pub mod link;
pub mod load;
pub mod mask;
pub mod mcp_probe;
pub mod mcp_servers;
pub mod order_env;
pub mod power;
pub mod preview;
pub mod project_env;
pub mod relay;
#[cfg(test)]
mod relay_tests;
pub mod repos;
pub mod runner;
pub mod secrets;
pub mod self_exe;
pub mod session_route;
pub mod sessions;
pub mod skills;
pub mod store;
pub mod update;
pub mod util;
pub mod wire;
pub mod worktree;
pub mod worktree_setup;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::oneshot;
use zeroize::Zeroizing;

use config::{NodeConfig, default_node_home, read_config, write_config};

/// `fleetd node …` usage.
pub const NODE_USAGE: &str = "  node join --hub <url> (--token <token> | --token-file <file|->) --machine <id> [--tags a,b]
            [--name <name>] [--home <dir>] [--enroll-only] [--claude-config-dir <dir>]
             enroll this machine with the hub, then keep its link up (node home default ~/.fleetd/node);
             --token-file - reads the token from stdin; --enroll-only exits once the hub has accepted this
             node; sessions use your own claude setup (~/.claude) unless --claude-config-dir names a
             dedicated one
  node run [--home <dir>]
             keep the link up for a machine that has joined
";

/// `fleetd node join`, after the CLI has parsed its flags (and read `--token-file`, see [`read_token_file`]).
#[derive(Clone, Debug, Default)]
pub struct JoinArgs {
    pub hub: String,
    pub token: String,
    pub machine: String,
    /// `--tags a,b`, already split; see [`parse_tags`].
    pub tags: Option<Vec<String>>,
    pub name: Option<String>,
    pub home: Option<PathBuf>,
    /// `--enroll-only`: stop once the hub has accepted the node's key instead of keeping the link up.
    pub enroll_only: bool,
    /// `--claude-config-dir`: a dedicated claude profile for this machine's sessions instead of the user's own.
    pub claude_config_dir: Option<String>,
}

/// `fleetd node run` / `node serve`.
#[derive(Clone, Debug, Default)]
pub struct RunArgs {
    pub home: Option<PathBuf>,
}

/// Why the node stopped for good. `Display` is the message the CLI prints after `fleetd: `.
#[derive(Debug, thiserror::Error)]
pub enum NodeError {
    /// Bad setup: an invalid machine id, an unreadable home, no enrolled config.
    #[error("{0}")]
    Setup(String),
    /// The lead socket cannot be served.
    #[error("{0}")]
    LeadSocket(String),
    /// The hub refused this node (bad key or token, protocol mismatch); retrying will not help.
    #[error("{0}")]
    Refused(link::LinkFatal),
}

/// `--token-file <file|->`: the token from a file, or from stdin for `-`, trimmed.
pub fn read_token_file(path: &str) -> std::io::Result<String> {
    let text = if path == "-" {
        std::io::read_to_string(std::io::stdin())?
    } else {
        std::fs::read_to_string(path)?
    };
    Ok(text.trim().to_owned())
}

/// `--tags a, b,,c` → `["a", "b", "c"]`.
pub fn parse_tags(tags: &str) -> Vec<String> {
    tags.split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Creates the node key and config, enrolls with the one-time token, then keeps the link up.
pub async fn join(args: JoinArgs) -> Result<(), NodeError> {
    if !config::is_machine_id(&args.machine) {
        return Err(NodeError::Setup(format!(
            "machine id '{}' must match [a-z0-9-]{{1,32}}",
            args.machine
        )));
    }
    let home = args.home.clone().unwrap_or_else(default_node_home);
    let config = NodeConfig {
        hub: args.hub,
        machine_id: args.machine.clone(),
        name: args.name.unwrap_or(args.machine),
        tags: args.tags.unwrap_or_default(),
        cmd_roots: None,
        claude_config_dir: args.claude_config_dir,
        min_free_gb: None,
        mem_per_agent_gb: None,
        disk_per_agent_gb: None,
        enrolled: false,
        browser: None,
        preview: None,
        device: None,
    };
    write_config(&home, &config).map_err(|_| {
        NodeError::Setup(format!(
            "cannot write the node config in {}",
            home.display()
        ))
    })?;
    run_node(
        &home,
        config,
        Some(Zeroizing::new(args.token)),
        args.enroll_only,
    )
    .await
}

/// Keeps the link up for a node that has joined.
pub async fn run(args: RunArgs) -> Result<(), NodeError> {
    let home = args.home.unwrap_or_else(default_node_home);
    let config = read_config(&home).map_err(|_| {
        NodeError::Setup(format!("node config in {} is unreadable", home.display()))
    })?;
    match config {
        Some(config) if config.enrolled => run_node(&home, config, None, false).await,
        _ => Err(NodeError::Setup(format!(
            "this node has not joined a hub (no enrolled config in {}): run fleetd node join first",
            home.display()
        ))),
    }
}

/// Resolves on SIGINT or SIGTERM.
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut int), Ok(mut term)) = (
        signal(SignalKind::interrupt()),
        signal(SignalKind::terminate()),
    ) else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = int.recv() => {}
        _ = term.recv() => {}
    }
}

async fn run_node(
    home: &Path,
    config: NodeConfig,
    enroll_token: Option<Zeroizing<String>>,
    exit_when_enrolled: bool,
) -> Result<(), NodeError> {
    // The node logs to stdout; a subscriber the CLI installed first wins.
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stdout)
        .with_ansi(false)
        .try_init();
    let shown = home.display();
    let identity = identity::load_or_create_identity(home)
        .map_err(|_| NodeError::Setup(format!("cannot read or create the node key in {shown}")))?;
    let box_key = identity::load_or_create_box_key(home).map_err(|_| {
        NodeError::Setup(format!("cannot read or create the node box key in {shown}"))
    })?;
    tracing::info!(machine_id = %config.machine_id, hub = %config.hub, "fleetd node starting");
    let store = store::NodeStore::open(&home.join("sessions.sqlite"))
        .map_err(|e| NodeError::Setup(format!("cannot open the session store in {shown}: {e}")))?;
    // Before any session starts: their fleetd tools run this binary, wherever an update moves the installed one.
    let pin_home = home.to_owned();
    let _ = tokio::task::spawn_blocking(move || self_exe::pin(&pin_home)).await;
    let session_config = sessions::SessionConfig::for_node(home);
    let runner = Arc::new(runner::claude::ClaudeRunner::new(claude_binary()));
    // Probed off the async threads now rather than by the first spawn.
    tokio::task::spawn_blocking(runner::scope::current);
    let node_sessions = sessions::SessionService::start(store, runner, session_config)
        .await
        .map_err(|e| NodeError::Setup(format!("cannot settle the stored sessions: {e}")))?;
    let wakes = Arc::new(power::Wakes::default());
    let _power = util::AbortOnDrop(tokio::spawn(power::run(
        node_sessions.clone(),
        wakes.clone(),
    )));
    let relay = lead::LeadRelay::new();
    let identify: lead::Identify = {
        let sessions = node_sessions.clone();
        Arc::new(move |pid| sessions.peer_session(pid))
    };
    let mask_for: lead::MaskFor = {
        let sessions = node_sessions.clone();
        Arc::new(move |session| match session_route::host_masker(session) {
            Some(masker) => Ok(masker),
            None => sessions.call_masker(session),
        })
    };
    let browser_config = config.browser.clone().unwrap_or_default();
    let broker = match browser_config.enabled() {
        true => {
            let sessions = node_sessions.clone();
            let broker = browser::Broker::start(
                home,
                browser_config,
                Arc::new(browser::upload::RelayHub(relay.clone())),
                Arc::new(move |session| {
                    if session_route::hosted(session) {
                        // Hosted for an agent on another machine: none of its secrets are here.
                        return Ok(mask::Secrets(Vec::new()));
                    }
                    sessions.call_secrets(session)
                }),
            )
            .await;
            Some(broker)
        }
        false => None,
    };
    let device_config = config.device.clone().unwrap_or_default();
    let devices = match device_config.enabled() {
        true => Some(
            device::Devices::start(
                home,
                device_config,
                Arc::new(browser::upload::RelayHub(relay.clone())),
                {
                    let sessions = node_sessions.clone();
                    Arc::new(move |session| {
                        if session_route::hosted(session) {
                            // Hosted for an agent on another machine: none of its secrets are here.
                            return Ok(mask::Secrets(Vec::new()));
                        }
                        sessions.call_secrets(session)
                    })
                },
            )
            .await,
        ),
        false => None,
    };
    let sessions_router = (broker.is_some() || devices.is_some()).then(|| {
        Arc::new(device::Router {
            browser: broker.clone(),
            devices: devices.clone(),
            live: Default::default(),
        })
    });
    let router = Arc::new(session_route::Router {
        broker: broker.clone(),
        devices,
        relay: relay.clone(),
        hub: config.hub.clone(),
        mask_for: mask_for.clone(),
    });
    if sessions_router.is_some() {
        node_sessions.set_browser(router.clone());
    }
    let preview_config = config.preview.clone().unwrap_or_default();
    let previews = preview_config.enabled().then(|| {
        let sessions = node_sessions.clone();
        preview::Previews::for_node(
            home,
            &preview_config,
            Arc::new(move |id| sessions.project_workspace(id)),
            broker.clone(),
        )
    });
    if let Some(previews) = &previews {
        node_sessions.set_previews(previews.clone());
    }
    let _socket = lead::serve_lead_socket(
        lead::lead_socket_path(home),
        relay.clone(),
        identify,
        mask_for,
        Some(session_route::routed(router)),
    )
    .await
    .map_err(NodeError::LeadSocket)?;

    let (enrolled_tx, enrolled_rx) = oneshot::channel::<()>();
    let on_enrolled: Option<Box<dyn FnOnce() + Send>> = enroll_token.as_ref().map(|_| {
        let home = home.to_path_buf();
        let config = NodeConfig {
            enrolled: true,
            ..config.clone()
        };
        Box::new(move || {
            if let Err(error) = write_config(&home, &config) {
                tracing::warn!(%error, "cannot mark the node enrolled in its config");
            }
            tracing::info!("enrolled with the hub; later starts use `fleetd node run`");
            let _ = enrolled_tx.send(());
        }) as Box<dyn FnOnce() + Send>
    });
    let options = link::RunNodeOptions {
        settings: link::LinkSettings {
            hub: config.hub.clone(),
            machine_id: config.machine_id.clone(),
            name: config.name.clone(),
            tags: config.tags.clone(),
            node_version: crate::version().to_owned(),
        },
        identity,
        enroll_token,
        on_enrolled,
        node_sessions: node_sessions.clone(),
        wakes,
        lead_calls: relay,
        cmd_roots: config
            .cmd_roots
            .clone()
            .unwrap_or_else(|| vec![util::home_dir().to_string_lossy().into_owned()]),
        secrets: Some(link::NodeSecrets {
            box_key,
            home: home.to_path_buf(),
        }),
        browser: broker.clone(),
        previews: previews.clone(),
        sessions: sessions_router.clone(),
    };
    let enrolled = async {
        if !exit_when_enrolled || enrolled_rx.await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    tokio::select! {
        fatal = link::run_node(options) => Err(NodeError::Refused(fatal)),
        () = enrolled => Ok(()),
        () = shutdown_signal() => {
            node_sessions.shutdown().await;
            if let Some(previews) = &previews {
                previews.stop_all().await;
            }
            if let Some(router) = &sessions_router {
                router.shutdown().await;
            }
            Ok(())
        }
    }
}

/// `claude` from PATH, else the native installer's `~/.local/bin/claude` (a service's PATH often lacks it). A
/// missing binary is the runner's probe to report, not a reason to stop the node.
fn claude_binary() -> PathBuf {
    let on_path = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("claude"))
            .find(|bin| bin.is_file())
    });
    on_path.unwrap_or_else(|| {
        let local = util::home_dir().join(".local/bin/claude");
        if local.is_file() {
            local
        } else {
            PathBuf::from("claude")
        }
    })
}
