//! `fleetd hub start` (alias `hub serve`): parses its flags, builds the [`Hub`] over the database in `--home`, starts
//! every area's background loop and serves HTTP until SIGTERM/SIGINT (TS: apps/hub/src/main.ts and
//! apps/cli/src/hub-start.ts).
use crate::clock::{Clock, SystemClock};
use crate::hub::api::{self, Hub, HubConfig, Listen, Registry, Shutdown};
use crate::hub::auth::Auth;
use crate::hub::http;
use crate::hub::store::{EventLog, HubDb, HubStore, resolve_hub_home};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;

pub const HUB_START_USAGE: &str = "  hub start [--home <dir>] [--listen <host:port>] [--queue-ttl <seconds>] [--router-model <model>]
             run the hub (default home ~/.fleetd/hub, listen 127.0.0.1:4790,
             writes to an offline machine wait 24 h, intents without a project
             are routed by the claude CLI with claude-haiku-5-5)
";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HubOptions {
    /// Absent means the default, `~/.fleetd/hub`.
    pub home: Option<String>,
    pub listen: Listen,
    /// How long a write to an offline machine waits in the queue; absent means 24 h.
    pub queue_ttl_sec: Option<u64>,
    /// The intake router's model; absent means claude-haiku-5-5.
    pub router_model: Option<String>,
}

/// `host:port`, `:port` or `port`; IPv6 hosts in brackets, as in `[::1]:4790`.
pub fn parse_listen(value: &str) -> Option<Listen> {
    let (raw_host, raw_port) = match value.rfind(':') {
        Some(colon) => (&value[..colon], &value[colon + 1..]),
        None => ("", value),
    };
    if raw_port.is_empty() || !raw_port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port = raw_port
        .parse::<u32>()
        .ok()
        .filter(|p| (1..=65535).contains(p))? as u16;
    let host = raw_host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(raw_host);
    Some(Listen {
        host: if host.is_empty() {
            Listen::default().host
        } else {
            host.to_owned()
        },
        port,
    })
}

/// The flags of `hub start`, with node:util `parseArgs`'s strict rules and messages: `--flag value` or
/// `--flag=value`, the last one wins, no positionals.
pub fn parse_hub_args(argv: &[String]) -> Result<HubOptions, String> {
    const FLAGS: [&str; 4] = ["home", "listen", "queue-ttl", "router-model"];
    let mut values: [Option<String>; 4] = Default::default();
    let mut args = argv.iter();
    while let Some(arg) = args.next() {
        if arg == "--" {
            if let Some(next) = args.next() {
                return Err(format!(
                    "Unexpected argument '{next}'. This command does not take positional arguments"
                ));
            }
            break;
        }
        let positional = || {
            format!("Unexpected argument '{arg}'. This command does not take positional arguments")
        };
        let Some(body) = arg.strip_prefix("--").filter(|b| !b.is_empty()) else {
            return Err(if arg.len() > 1 && arg.starts_with('-') {
                format!("Unknown option '{arg}'")
            } else {
                positional()
            });
        };
        let (name, inline) = match body.split_once('=') {
            Some((name, value)) => (name, Some(value.to_owned())),
            None => (body, None),
        };
        let Some(index) = FLAGS.iter().position(|f| *f == name) else {
            return Err(format!("Unknown option '--{name}'"));
        };
        let value = match inline {
            Some(value) => value,
            None => args
                .next()
                .cloned()
                .ok_or_else(|| format!("Option '--{name} <value>' argument missing"))?,
        };
        values[index] = Some(value);
    }
    let [home, listen, ttl, router_model] = values;
    let listen = match listen {
        None => Listen::default(),
        Some(raw) => {
            parse_listen(&raw).ok_or_else(|| format!("--listen must be host:port, got '{raw}'"))?
        }
    };
    let queue_ttl_sec = match ttl {
        None => None,
        Some(raw) => Some(
            raw.parse::<u64>()
                .ok()
                .filter(|n| {
                    *n > 0 && !raw.starts_with('0') && raw.bytes().all(|b| b.is_ascii_digit())
                })
                .ok_or_else(|| {
                    format!("--queue-ttl must be a whole number of seconds, got '{raw}'")
                })?,
        ),
    };
    Ok(HubOptions {
        home,
        listen,
        queue_ttl_sec,
        router_model,
    })
}

/// The CLI entry for `fleetd hub start <args>`: exit 2 on bad flags, 0 after SIGTERM/SIGINT, 1 on a failure.
pub fn hub_start(argv: &[String]) -> ExitCode {
    let options = match parse_hub_args(argv) {
        Ok(options) => options,
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{HUB_START_USAGE}");
            return ExitCode::from(2);
        }
    };
    let ansi = std::io::IsTerminal::is_terminal(&std::io::stderr());
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(ansi)
        .with_target(false)
        .try_init();
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let result = runtime.block_on(run(options));
    // Blocking work still running (a SQLite call, a child process wait) must not hold the exit past the grace.
    runtime.shutdown_timeout(Duration::from_millis(100));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("fleetd: {error}");
            ExitCode::from(1)
        }
    }
}

/// Runs the hub until SIGTERM/SIGINT. Refuses a home inside ~/.t3.
pub async fn run(options: HubOptions) -> anyhow::Result<()> {
    let user_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let home = resolve_hub_home(options.home.as_deref(), &user_home)?;
    let config = HubConfig {
        home,
        listen: options.listen.clone(),
        url: None,
        queue_ttl_sec: options.queue_ttl_sec,
        router_model: options.router_model.clone(),
    };
    let hub = build(config, Arc::new(SystemClock))?;
    let tools = Arc::new(api::registry());
    let listener =
        tokio::net::TcpListener::bind((hub.config.listen.host.as_str(), hub.config.listen.port))
            .await?;
    tracing::info!(
        "fleetd hub: home {}, listening on {}",
        hub.config.home.display(),
        hub.config.listen
    );
    let shutdown = hub.shutdown.clone();
    tokio::spawn(async move {
        stop_signal().await;
        shutdown.trigger();
    });
    let loops = start_loops(&hub, &tools);
    let served = http::serve(listener, hub, tools).await;
    for task in loops {
        task.abort();
    }
    Ok(served?)
}

async fn stop_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}

/// Every service over the database in `config.home`. Areas add their construction here (see hub::api).
pub fn build(config: HubConfig, clock: Arc<dyn Clock>) -> anyhow::Result<Arc<Hub>> {
    let db = HubDb::open(&config.home)?;
    build_on(db, config, clock)
}

/// [`build`] over an opened database (tests use `HubDb::open_memory`).
pub fn build_on(
    db: Arc<HubDb>,
    config: HubConfig,
    clock: Arc<dyn Clock>,
) -> anyhow::Result<Arc<Hub>> {
    let store = Arc::new(HubStore::new(db.clone()));
    let events = Arc::new(EventLog::new(db.clone(), clock.clone())?);
    let auth = Arc::new(Auth::new(db.clone(), clock.clone()));
    Ok(Arc::new(Hub {
        config,
        clock,
        shutdown: Shutdown::default(),
        db,
        store,
        events,
        auth,
    }))
}

/// Every area's long-running loop, one tokio task each; they stop with `hub.shutdown` (and are aborted after the
/// server returns). Areas add theirs here.
pub fn start_loops(hub: &Arc<Hub>, tools: &Arc<Registry>) -> Vec<JoinHandle<()>> {
    let (_hub, _tools) = (hub, tools);
    Vec::new()
}

#[cfg(test)]
mod tests;
