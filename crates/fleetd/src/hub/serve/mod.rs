//! `fleetd hub start` (alias `hub serve`): parses its flags, builds the [`Hub`] over the database in `--home`, starts
//! every area's background loop and serves HTTP until SIGTERM/SIGINT.
use crate::clock::{Clock, SystemClock};
use crate::hub::api::{self, Hub, HubConfig, Listen, Registry, Shutdown};
use crate::hub::auth::Auth;
use crate::hub::digests::HumanDigests;
use crate::hub::http;
use crate::hub::ledger::{Asks, Decisions, Inbox};
use crate::hub::store::{EventLog, HubDb, HubStore, resolve_hub_home};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;

mod wire;

pub const HUB_START_USAGE: &str = "  hub start [--home <dir>] [--listen <host:port>] [--queue-ttl <seconds>] [--retro-model <model>]
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
    /// The retro's one-shot model; absent means claude-haiku-5-5.
    pub retro_model: Option<String>,
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
    const FLAGS: [&str; 4] = ["home", "listen", "queue-ttl", "retro-model"];
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
    let [home, listen, ttl, retro_model] = values;
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
        retro_model,
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

/// Runs the hub until SIGTERM/SIGINT.
pub async fn run(options: HubOptions) -> anyhow::Result<()> {
    let user_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let home = resolve_hub_home(options.home.as_deref(), &user_home);
    let config = HubConfig {
        home,
        listen: options.listen.clone(),
        url: None,
        queue_ttl_sec: options.queue_ttl_sec,
        retro_model: options.retro_model.clone(),
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
    crate::hub::prompts::start(
        &db,
        &events,
        &crate::hub::store::iso_ms(crate::hub::store::now_ms(clock.as_ref())),
    )?;
    let auth = Arc::new(Auth::new(db.clone(), clock.clone()));
    let decisions = Arc::new(Decisions::new(db.clone(), events.clone(), clock.clone()));
    let asks = Arc::new(Asks::new(db.clone(), events.clone(), clock.clone()));
    let inbox = Inbox::new(db.clone(), events.clone(), clock.clone());
    let digests = Arc::new(HumanDigests::new(
        asks.clone(),
        decisions.clone(),
        store.clone(),
        events.clone(),
        clock.clone(),
    ));
    let time = crate::hub::time::Time::new(db.clone(), clock.clone());
    let executors =
        crate::hub::executor::Executors::new(store.clone(), events.clone(), clock.clone());
    let node_commands = Arc::new(crate::hub::link::NodeCommands::default());
    let lead_calls = Arc::new(crate::hub::link::LeadCalls::default());
    let link = crate::hub::link::NodeLinkServer::new(crate::hub::link::server::LinkDeps {
        hub_id: crate::hub::link::server::hub_id(),
        store: store.clone(),
        events: events.clone(),
        auth: auth.clone(),
        executors: executors.clone(),
        commands: node_commands.clone(),
        lead_calls: lead_calls.clone(),
        clock: clock.clone(),
        time: time.clone(),
    });
    executors.set_time(time.clone());
    let watchdog = crate::hub::watchdog::Watchdog::new(
        crate::hub::watchdog::config_from_env(|k| std::env::var(k).ok()),
        executors.clone(),
        store.clone(),
        events.clone(),
        clock.clone(),
    );
    let sweep = crate::hub::sweep::Sweep::new(
        store.clone(),
        events.clone(),
        watchdog.clone(),
        clock.clone(),
    );
    let queue =
        crate::hub::queue::WriteQueue::from_config(&config, &db, &events, &clock, &executors);
    let ops = crate::hub::usage::wire::build(&config, clock.clone());
    let wakes = crate::hub::wakes::Wakes::new(
        db.clone(),
        queue.clone(),
        events.clone(),
        ops.usage.clone(),
        clock.clone(),
    );
    let webhooks = crate::hub::webhooks::Webhooks::for_home(
        &config.home,
        db.clone(),
        events.clone(),
        auth.clone(),
        clock.clone(),
    )?;
    let fresh = Arc::new(crate::hub::status::fresh::Fresh::default());
    let checks = crate::hub::checks::build(&db, &events, &clock);
    let train_host =
        crate::hub::train::hub_host::HubHost::new(clock.clone(), events.clone(), store.clone());
    let (train, reviews) = crate::hub::reviews::build(
        train_host.clone(),
        clock.clone(),
        db.clone(),
        Arc::new(crate::hub::train::github::SystemGh),
        crate::hub::train::TrainOptions {
            fresh: fresh.clone(),
            ..Default::default()
        },
    );
    let hub_task_ports =
        crate::hub::tasks::wire::HubTaskPorts::new(executors.clone(), node_commands.clone());
    let task_ports: Arc<dyn crate::hub::tasks::ports::TaskPorts> = hub_task_ports.clone();
    let lead_ports = task_ports.clone();
    let slots = crate::hub::slots::Slots::new(
        db.clone(),
        &store,
        &events,
        Arc::new(move |m, t| lead_ports.lead_of(m, t)),
        crate::hub::slots::SlotsOptions::default(),
    )?;
    let leases = crate::hub::leases::Leases::new(db.clone(), events.clone(), clock.clone());
    let source = crate::hub::leases::policy::NodePolicySource {
        store: store.clone(),
        ports: task_ports.clone(),
    };
    let policies = crate::hub::leases::Policies::new(Arc::new(source), clock.clone());
    executors.set_tool_policy(policies.clone());
    let tasks = crate::hub::tasks::Tasks::new(crate::hub::tasks::TaskDeps {
        db: db.clone(),
        store: store.clone(),
        events: events.clone(),
        clock: clock.clone(),
        ports: task_ports,
        slots: slots.clone(),
        leases: leases.clone(),
        policies: policies.clone(),
    });
    let leads = crate::hub::leads::Area::new(
        crate::hub::leads::Ctx::new(db.clone(), store.clone(), events.clone(), clock.clone()),
        crate::hub::leads::AreaOptions {
            home: &config.home,
            leads: Default::default(),
        },
    )?;
    crate::hub::leads::wiring::wire_area(
        &leads,
        crate::hub::leads::wiring::Links {
            executors: &executors,
            queue: &queue,
            commands: &node_commands,
            asks: &asks,
            decisions: &decisions,
            inbox: &inbox,
            lead_calls: &lead_calls,
            digests: &digests,
            claims: &checks.claims,
            estimates: &checks.estimates,
        },
    );
    // Before the hub takes calls: no clone the previous process started is reported as running.
    if let Err(e) =
        crate::hub::projects::fail_interrupted(&events, crate::hub::checks::now_ts(clock.as_ref()))
    {
        tracing::warn!(error = %e, "projects: interrupted clones not closed");
    }
    let plans = crate::hub::plan::Plans::new(db.clone(), events.clone(), clock.clone());
    let hub = Arc::new(Hub {
        config,
        clock,
        shutdown: Shutdown::default(),
        db,
        store,
        events,
        auth,
        decisions,
        asks,
        inbox,
        digests,
        executors,
        node_commands,
        lead_calls,
        link,
        watchdog,
        sweep,
        queue,
        wakes,
        webhooks,
        incidents: checks.incidents,
        estimates: checks.estimates,
        receipts: checks.receipts,
        value_bar: checks.value_bar,
        checks: checks.checks,
        claims: checks.claims,
        ops: ops.ports,
        usage: ops.usage,
        doctor: ops.doctor,
        retro: ops.retro,
        approvals: ops.approvals,
        train,
        reviews,
        slots,
        leases,
        policies,
        tasks,
        leads,
        time,
        status: crate::hub::status::Status::new(fresh),
        plans,
    });
    crate::hub::train::hooks::restore(&hub);
    checks.ports.bind(&hub);
    train_host.bind(&hub);
    hub.checks.set_time(hub.time.sink());
    hub.slots.set_time(hub.time.sink());
    hub.leads.intake.set_time(hub.time.sink());
    crate::hub::train::calls::register_lead_calls(&hub);
    crate::hub::checks::hub_ports::wire_misfiled(&hub);
    crate::hub::tasks::wire::wire(&hub, &hub_task_ports);
    wire::wire(&hub);
    crate::hub::approvals::tools::register_lead_calls(&hub);
    crate::hub::plan::calls::register_lead_calls(&hub);
    crate::hub::steer::wire(&hub);
    Ok(hub)
}

/// Every area's long-running loop, one tokio task each; they stop with `hub.shutdown` (and are aborted after the
/// server returns). Areas add theirs here.
pub fn start_loops(hub: &Arc<Hub>, tools: &Arc<Registry>) -> Vec<JoinHandle<()>> {
    let _tools = tools;
    let mut loops = Vec::new();
    if let Err(error) = hub.asks.start() {
        tracing::error!(%error, "re-arming the collecting batch failed");
    }
    let shutdown = hub.shutdown.clone();
    loops.push(tokio::spawn(
        hub.digests
            .clone()
            .run(async move { shutdown.wait().await }),
    ));
    hub.link.start();
    loops.push(hub.watchdog.start());
    loops.push(tokio::spawn(crate::hub::orders::idle::run(hub.clone())));
    loops.push(tokio::spawn(crate::hub::orders::filler::run(hub.clone())));
    loops.push(tokio::spawn(crate::hub::steer::run_sweep(hub.clone())));
    loops.push(hub.sweep.start(crate::hub::sweep::SWEEP_EVERY_MS));
    loops.push(crate::hub::queue::start_loops(hub));
    loops.extend(crate::hub::checks::start_loops(hub));
    loops.extend(crate::hub::usage::wire::start(hub));
    // The train and reviews spawn their own tasks (a repo's loop starts on its first enqueue); this one stops them.
    hub.train.start();
    let reviews = hub.reviews.start();
    let (shutdown, train) = (hub.shutdown.clone(), hub.train.clone());
    let stopper = tokio::spawn(async move {
        shutdown.wait().await;
        train.stop();
    });
    loops.push(reviews);
    loops.push(stopper);
    loops.push(tokio::spawn(
        hub.slots
            .clone()
            .run(hub.events.clone(), hub.shutdown.clone()),
    ));
    loops.push(tokio::spawn(hub.tasks.clone().run(hub.shutdown.clone())));
    loops.extend(hub.leads.run());
    loops.extend(hub.time.start(hub));
    loops.push(tokio::spawn(hub.status.clone().run(hub.clone())));
    loops.push(tokio::spawn(crate::hub::status::calib::run(hub.clone())));
    loops
}

#[cfg(test)]
mod tests;
