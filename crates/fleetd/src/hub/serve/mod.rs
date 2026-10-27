//! `fleetd hub start` (alias `hub serve`): parses its flags, builds the [`Hub`] over the database in `--home`, starts
//! every area's background loop and serves HTTP until SIGTERM/SIGINT.
use crate::clock::{Clock, SystemClock};
use crate::hub::api::{self, Hub, HubConfig, Listen, Registry, Shutdown};
use crate::hub::auth::Auth;
use crate::hub::http;
use crate::hub::ledger::Decisions;
use crate::hub::store::{EventLog, HubDb, HubStore, resolve_hub_home};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;

mod wire;

pub const HUB_START_USAGE: &str =
    "  hub start [--home <dir>] [--listen <host:port>] [--queue-ttl <seconds>]
             run the hub (default home ~/.fleetd/hub, listen 127.0.0.1:4790,
             writes to an offline machine wait 24 h)
";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HubOptions {
    /// Absent means the default, `~/.fleetd/hub`.
    pub home: Option<String>,
    pub listen: Listen,
    /// How long a write to an offline machine waits in the queue; absent means 24 h.
    pub queue_ttl_sec: Option<u64>,
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
    const FLAGS: [&str; 3] = ["home", "listen", "queue-ttl"];
    let mut values: [Option<String>; 3] = Default::default();
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
    let [home, listen, ttl] = values;
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
        url: configured_url(&home),
        home,
        listen: options.listen.clone(),
        queue_ttl_sec: options.queue_ttl_sec,
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

/// Where devices and services reach the hub, as `fleetd init --url` kept it in `<home>/setup.json`; None for a hub
/// started by hand, or a URL on every interface (`0.0.0.0` reaches nothing).
pub fn configured_url(home: &std::path::Path) -> Option<String> {
    crate::cli::setup::state::read_setup(home)
        .ok()
        .flatten()
        .map(|s| s.url)
        .filter(|url| !url.is_empty() && !url.contains("0.0.0.0") && !url.contains("[::]"))
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
    let retired = Auth::new(db.clone(), clock.clone()).retire_owner_keys(&config.home)?;
    if retired > 0 {
        tracing::info!("revoked {retired} owner key(s) an earlier fleetd kept in the hub home");
    }
    // A sealed GitHub webhook secret and its key, left by a hub from before webhooks went; nothing reads them.
    for gone in ["github-webhook.secret", "webhook.key"] {
        let _ = std::fs::remove_file(config.home.join(gone));
    }
    // A lab hub sets FLEETD_HOST_SWEEP=off, so the metrics read no git host and the run needs no network.
    let hosts = if std::env::var("FLEETD_HOST_SWEEP").is_ok_and(|v| v == "off") {
        crate::hub::metrics::source::HostSources::none()
    } else {
        crate::hub::metrics::source::HostSources::real()
    };
    build_on_with(db, config, clock, hosts)
}

/// [`build`] over an opened database (tests use `HubDb::open_memory`), reading no git host for the metrics.
pub fn build_on(
    db: Arc<HubDb>,
    config: HubConfig,
    clock: Arc<dyn Clock>,
) -> anyhow::Result<Arc<Hub>> {
    build_on_with(
        db,
        config,
        clock,
        crate::hub::metrics::source::HostSources::none(),
    )
}

/// [`build_on`] with the git host readers the metrics' sweep uses: real for a shipped hub, none or fakes otherwise.
pub fn build_on_with(
    db: Arc<HubDb>,
    config: HubConfig,
    clock: Arc<dyn Clock>,
    hosts: crate::hub::metrics::source::HostSources,
) -> anyhow::Result<Arc<Hub>> {
    db.set_memory_dir(config.home.join("memory"));
    db.set_skills_dir(config.home.join("skills"));
    let store = Arc::new(HubStore::new(db.clone()));
    let events = Arc::new(EventLog::new(db.clone(), clock.clone())?);
    crate::hub::prompts::start(
        &db,
        &events,
        &crate::hub::store::iso_ms(crate::hub::store::now_ms(clock.as_ref())),
    )?;
    let auth = Arc::new(Auth::new(db.clone(), clock.clone()));
    let decisions = Arc::new(Decisions::new(db.clone(), events.clone(), clock.clone()));
    let requests = crate::hub::approvals::store::Requests::new(db.clone());
    let time = crate::hub::time::Time::new(db.clone(), clock.clone());
    let executors =
        crate::hub::executor::Executors::new(store.clone(), events.clone(), clock.clone());
    let node_commands = Arc::new(crate::hub::link::NodeCommands::default());
    let lead_calls = Arc::new(crate::hub::link::LeadCalls::default());
    let slots = crate::hub::slots::Slots::new(db.clone(), clock.clone(), &store, &events)?;
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
        slots: slots.clone(),
    });
    executors.set_time(time.clone());
    let watchdog = crate::hub::watchdog::Watchdog::new(
        crate::hub::watchdog::stall_ms_from_env(),
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
    let ops = crate::hub::usage::wire::build(&config, clock.clone(), requests.clone());
    let wakes = crate::hub::wakes::Wakes::new(
        db.clone(),
        queue.clone(),
        events.clone(),
        ops.usage.clone(),
        clock.clone(),
    );
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
    let source = crate::hub::policy::NodePolicySource {
        executors: executors.clone(),
    };
    let policies = crate::hub::policy::Policies::new(Arc::new(source), clock.clone());
    executors.set_tool_policy(policies.clone());
    executors.set_mcp_servers(db.clone());
    executors.set_skills(db.clone());
    let tasks = crate::hub::tasks::Tasks::new(crate::hub::tasks::TaskDeps {
        db: db.clone(),
        store: store.clone(),
        events: events.clone(),
        clock: clock.clone(),
        ports: task_ports.clone(),
        slots: slots.clone(),
        policies: policies.clone(),
    });
    let leads = crate::hub::leads::Area::new(crate::hub::leads::Ctx::new(
        db.clone(),
        store.clone(),
        events.clone(),
        clock.clone(),
    ));
    crate::hub::leads::wiring::wire_area(
        &leads,
        crate::hub::leads::wiring::Links {
            executors: &executors,
            queue: &queue,
            requests: &requests,
            decisions: &decisions,
            lead_calls: &lead_calls,
        },
    );
    // Before the hub takes calls: no clone the previous process started is reported as running.
    if let Err(e) =
        crate::hub::projects::fail_interrupted(&events, crate::hub::checks::now_ts(clock.as_ref()))
    {
        tracing::warn!(error = %e, "projects: interrupted clones not closed");
    }
    let chat = crate::hub::chat::Chat::new(db.clone(), events.clone(), clock.clone());
    let automations = crate::hub::automations::Automations::new(
        db.clone(),
        events.clone(),
        clock.clone(),
        leads.clone(),
    );
    let prs =
        crate::hub::prs::Prs::new(Arc::new(crate::hub::train::github::SystemGh), clock.clone());
    let work = crate::hub::work::Work::new(
        db.clone(),
        events.clone(),
        clock.clone(),
        Arc::new(crate::hub::work::TaskPaths(task_ports)),
    );

    let updates = crate::hub::update::Updates::new(
        &config.home,
        clock.clone(),
        crate::hub::update::Timing::default(),
    );
    let repos = crate::hub::repos::Repos::new(db.clone());
    let hub = Arc::new(Hub {
        config,
        clock,
        shutdown: Shutdown::default(),
        db,
        store,
        events,
        auth,
        decisions,
        executors,
        node_commands,
        lead_calls,
        link,
        watchdog,
        sweep,
        queue,
        wakes,
        automations,
        verdicts: checks.verdicts,
        ops: ops.ports,
        usage: ops.usage,
        doctor: ops.doctor,
        approvals: ops.approvals,
        train,
        reviews,
        slots,
        policies,
        tasks,
        leads,
        time,
        status: crate::hub::status::Status::new(fresh),
        chat,
        prs,
        work,
        repos,
        metrics: crate::hub::metrics::Metrics::new(hosts),
        updates,
        relays: Arc::default(),
        previews: Arc::default(),
    });
    hub.updates
        .set_ports(Arc::new(crate::hub::update::ports::HubPorts(
            Arc::downgrade(&hub),
        )));
    checks.ports.bind(&hub);
    train_host.bind(&hub);
    crate::hub::train::calls::register_lead_calls(&hub);
    crate::hub::train::calls::watch_writer_prs(&hub);
    crate::hub::tasks::wire::wire(&hub, &hub_task_ports);
    wire::wire(&hub);
    crate::hub::approvals::tools::register_lead_calls(&hub);
    crate::hub::memory::calls::register_lead_calls(&hub);
    crate::hub::automations::calls::register_lead_calls(&hub);
    crate::hub::checklist::calls::register_lead_calls(&hub);
    crate::hub::browser::calls::register_lead_calls(&hub);
    crate::hub::machine_roles::wire(&hub);
    crate::hub::preview::wire(&hub);
    crate::hub::skills::calls::register_lead_calls(&hub);
    crate::hub::usage::calls::register_lead_calls(&hub);
    crate::hub::steer::wire(&hub);
    crate::hub::chat::tools::extend_status(&hub);
    crate::hub::work::register_sweep(&hub);
    crate::hub::repos::backfill(&hub);
    Ok(hub)
}

/// Every area's long-running loop, one tokio task each; they stop with `hub.shutdown` (and are aborted after the
/// server returns). Areas add theirs here.
pub fn start_loops(hub: &Arc<Hub>, tools: &Arc<Registry>) -> Vec<JoinHandle<()>> {
    let _tools = tools;
    let mut loops = Vec::new();
    hub.link.start();
    loops.push(hub.watchdog.start());
    loops.push(tokio::spawn(crate::hub::chat::flow::run(hub.clone())));
    loops.push(tokio::spawn(crate::hub::steer::run_sweep(hub.clone())));
    loops.push(tokio::spawn(crate::hub::intake::attachments::run_sweep(
        hub.clone(),
    )));
    loops.push(tokio::spawn(crate::hub::browser::run_prune(hub.clone())));
    loops.push(tokio::spawn(crate::hub::machine_roles::run_prune(
        hub.clone(),
    )));
    loops.push(tokio::spawn(crate::hub::preview::run_sweep(hub.clone())));
    loops.push(tokio::spawn(crate::hub::preview::run_untracked(
        hub.clone(),
    )));
    loops.push(hub.sweep.start(crate::hub::sweep::SWEEP_EVERY_MS));
    loops.push(crate::hub::queue::start_loops(hub));
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
    // An update the previous hub process started: the watcher's verdict, then the nodes.
    loops.push(tokio::spawn(hub.updates.clone().resume()));
    // The channel's newest build, downloaded ahead so that Update only swaps and restarts.
    loops.push(tokio::spawn(hub.updates.clone().prefetch_loop()));
    loops.push(hub.automations.start());
    loops.extend(hub.time.start(hub));
    loops.extend(crate::hub::metrics::start(hub));
    loops.push(tokio::spawn(hub.status.clone().run(hub.clone())));
    hub.work
        .set_landings(Arc::new(crate::hub::work::landings::LandingStore(
            hub.db.clone(),
        )));
    loops.push(tokio::spawn(crate::hub::work::bind::run(hub.clone())));
    loops.push(tokio::spawn(crate::hub::projects::order_env::run(
        hub.clone(),
    )));
    loops.push(tokio::spawn(crate::hub::work::landings::run(
        hub.clone(),
        Arc::new(crate::hub::work::landings::HubLandingPorts(hub.clone())),
    )));
    loops
}

#[cfg(test)]
mod tests;
