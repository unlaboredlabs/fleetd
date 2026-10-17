//! The per-machine node: hub link, T3 supervision and sessions, the lead socket, cmd checks, sealed secrets,
//! gated runs and node actions (TS: apps/node).
//!
//! The CLI calls [`join`] for `fleetd node join` and [`run`] for `fleetd node run` / `node serve`. Both run until
//! SIGINT or SIGTERM (`Ok`) or a failure the node cannot retry past (`Err`, exit 1 with `fleetd: <message>`).
pub mod actions;
pub mod cmd;
pub mod config;
pub mod identity;
pub mod lead;
pub mod link;
pub mod secrets;
pub mod sessions;
pub mod supervisor;
pub mod util;
pub mod wire;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::oneshot;
use zeroize::Zeroizing;

use config::{NodeConfig, default_node_home, read_config, write_config};

/// `fleetd node …` usage, as the TS CLI prints it.
pub const NODE_USAGE: &str = "  node join --hub <url> (--token <token> | --token-file <file|->) --machine <id> --t3-home <dir>
            --t3-url <url> [--t3-cmd <cmd>] [--t3-restart-cmd <cmd>] [--tags a,b] [--name <name>]
            [--home <dir>] [--enroll-only]
             enroll this machine with the hub, then keep its link up (node home default ~/.fleetd/node);
             --t3-restart-cmd (e.g. \"t3 service restart\") runs when T3 fails 3 health checks, else T3 is
             only reported down; --token-file - reads the token from stdin; --enroll-only exits once
             the hub has accepted this node
  node run [--home <dir>]
             keep the link up for a machine that has joined
";

/// `fleetd node join`, after the CLI has parsed its flags (and read `--token-file`, see [`read_token_file`]).
#[derive(Clone, Debug, Default)]
pub struct JoinArgs {
    pub hub: String,
    pub token: String,
    pub machine: String,
    pub t3_home: String,
    pub t3_url: String,
    /// `--t3-cmd`: the command that runs T3's CLI, split on whitespace. Default `t3`.
    pub t3_cmd: Option<String>,
    /// `--t3-restart-cmd`, split on whitespace. No default: without it the node never restarts T3.
    pub t3_restart_cmd: Option<String>,
    /// `--tags a,b`, already split; see [`parse_tags`].
    pub tags: Option<Vec<String>>,
    pub name: Option<String>,
    pub home: Option<PathBuf>,
    /// `--enroll-only`: stop once the hub has accepted the node's key instead of keeping the link up.
    pub enroll_only: bool,
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

fn split_argv(command: &str) -> Vec<String> {
    command.split_whitespace().map(str::to_owned).collect()
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
        t3_home: args.t3_home,
        t3_url: args.t3_url,
        t3_cmd: split_argv(args.t3_cmd.as_deref().unwrap_or("t3")),
        t3_restart_cmd: args.t3_restart_cmd.as_deref().map(split_argv),
        cmd_roots: None,
        enrolled: false,
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
    // The node logs to stdout like the TS node; a subscriber the CLI installed first wins.
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
    tracing::info!(machine_id = %config.machine_id, hub = %config.hub, t3_url = %config.t3_url, "fleetd node starting");
    let relay = lead::LeadRelay::new();
    let _socket = lead::serve_lead_socket(lead::lead_socket_path(home), relay.clone())
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
            node_version: env!("CARGO_PKG_VERSION").to_owned(),
            t3_url: config.t3_url.clone(),
        },
        identity,
        t3_info: link::t3_info_probe(
            config.t3_url.clone(),
            link::t3_source_commit(&config.t3_cmd),
        ),
        t3_restart: config
            .t3_restart_cmd
            .clone()
            .map(supervisor::restart_command),
        enroll_token,
        on_enrolled,
        sessions: Arc::new(sessions::CliSessions {
            t3_cmd: config.t3_cmd.clone(),
            t3_home: config.t3_home.clone(),
        }),
        lead_calls: relay,
        cmd_roots: config
            .cmd_roots
            .clone()
            .unwrap_or_else(|| vec![util::home_dir().to_string_lossy().into_owned()]),
        secrets: Some(link::NodeSecrets {
            box_key,
            home: home.to_path_buf(),
        }),
    };
    let enrolled = async {
        if !exit_when_enrolled || enrolled_rx.await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    tokio::select! {
        fatal = link::run_node(options) => Err(NodeError::Refused(fatal)),
        () = enrolled => Ok(()),
        () = shutdown_signal() => Ok(()),
    }
}
