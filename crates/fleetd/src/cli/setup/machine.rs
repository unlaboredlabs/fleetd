//! `fleetd machine add|remove`: sets up (or undoes) a worker over SSH, printing every remote command before it runs.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::model::MachineStatus;
use sha2::{Digest, Sha256};

use super::super::args::{self, Kind, Spec};
use super::super::hub_key::{HubAccess, open_hub, resolve_home};
use super::machine_plan::{
    DEFAULT_T3_PORT, Facts, MachineAddInput, PROBE_SCRIPT, Stdin, Step, fresh_facts, local_target,
    plan_machine_add, plan_machine_remove, probe_command,
};
use super::ssh::{SshTarget, run_ssh, show_ssh};
use super::state::{MachineRecord, read_setup, write_setup};
use super::units::unit_suffix;
use super::{Probe, T3_NPM_VERSION, current_exe, parse_listen, probe_listen, say};

pub fn machine_usage() -> String {
    format!(
        "  machine add <ssh-host> [--machine-id <id>] [--tags a,b] [--dry-run] [--t3-port <port>]
            [--hub-url <url>] [--ssh-config <file>] [--home <hub home>] [--unit-suffix <s>]
             set up a worker over SSH: installs T3 {T3_NPM_VERSION} and the fleetd node under the SSH
             user, configures the fleetd Claude instance, enrolls the node, starts both as services and
             waits until the machine is online; prints every remote command first, --dry-run only prints
             (for a fresh machine, without connecting); safe to run again
  machine remove <id> [--purge-t3] [--home <hub home>]
             stop and delete the node's service and key on the machine and revoke it on the hub; T3 and
             its data stay unless --purge-t3
"
    )
}

fn fail(message: &str) -> u8 {
    say(&format!("fleetd: {message}"));
    1
}

fn usage(message: &str) -> u8 {
    say(&format!("fleetd: {message}\n\nusage:\n{}", machine_usage()));
    2
}

/// `user@host.example:22` → `host`, as a machine id.
pub fn machine_id_from_host(host: &str) -> String {
    let host = host.rsplit('@').next().unwrap_or(host);
    let label = host.split('.').next().unwrap_or(host).to_lowercase();
    let mut id = String::new();
    let mut replacing = false;
    for c in label.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
            id.push(c);
            replacing = false;
        } else if !replacing {
            id.push('-');
            replacing = true;
        }
    }
    id.trim_matches('-').chars().take(32).collect()
}

fn describe_stdin(step: &Step, exe: &Path, exe_len: u64) -> Option<String> {
    step.stdin.as_ref().map(|stdin| match stdin {
        Stdin::Binary => format!(
            "stdin: the fleetd binary {} ({exe_len} bytes)",
            exe.display()
        ),
        Stdin::EnrollToken => "stdin: one-time enroll token (not shown)".into(),
        Stdin::Text { label, text } => format!("stdin: {label} ({} bytes)", text.len()),
    })
}

fn print_step(index: usize, total: usize, step: &Step, exe: &Path, exe_len: u64) {
    say(&format!("[{index}/{total}] {}", step.title));
    say(&format!("  $ {}", step.command));
    if let Some(stdin) = describe_stdin(step, exe, exe_len) {
        say(&format!("    ({stdin})"));
    }
}

fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.trim().split('\n').collect();
    lines[lines.len().saturating_sub(15)..].join("\n")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Milliseconds since the epoch of an ISO-8601 UTC timestamp as the hub writes it (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
fn parse_iso_ms(text: &str) -> Option<i64> {
    let num = |range: std::ops::Range<usize>| text.get(range).and_then(|s| s.parse::<i64>().ok());
    let (y, mo, d, h, mi, s) = (
        num(0..4)?,
        num(5..7)?,
        num(8..10)?,
        num(11..13)?,
        num(14..16)?,
        num(17..19)?,
    );
    let ms = if text.as_bytes().get(19) == Some(&b'.') {
        num(20..23).unwrap_or(0)
    } else {
        0
    };
    // Howard Hinnant's days_from_civil.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms)
}

/// True once the hub has the machine online and heard from its node at or after `since_ms`. A quick node restart
/// does not flap the status, so there may be no fresh machine.online event to wait for; the hub writes from its own
/// process, so this re-reads the record every second.
async fn wait_online(
    hub: &HubAccess,
    machine_id: &MachineId,
    since_ms: i64,
    timeout: Duration,
) -> bool {
    let deadline = since_ms + timeout.as_millis() as i64;
    while now_ms() < deadline {
        if let Ok(Some(machine)) = hub.store.machine_get(machine_id)
            && machine.status == MachineStatus::Online
            && parse_iso_ms(&machine.last_seen_at.to_string()).is_some_and(|at| at >= since_ms)
        {
            return true;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    false
}

async fn add_command(argv: &[String]) -> u8 {
    const OPTIONS: &[(&str, Kind)] = &[
        ("machine-id", Kind::Str),
        ("tags", Kind::Str),
        ("dry-run", Kind::Bool),
        ("t3-port", Kind::Str),
        ("hub-url", Kind::Str),
        ("ssh-config", Kind::Str),
        ("home", Kind::Str),
        ("unit-suffix", Kind::Str),
    ];
    let v = match args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: true,
        },
    ) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    let [host] = v.positionals.as_slice() else {
        return usage("machine add takes one ssh host");
    };
    let machine_id = v
        .string("machine-id")
        .unwrap_or_else(|| machine_id_from_host(host));
    let Ok(machine) = MachineId::new(machine_id.clone()) else {
        return usage(&format!(
            "'{machine_id}' is not a machine id ([a-z0-9-]{{1,32}}); pass --machine-id"
        ));
    };
    let port_text = v
        .string("t3-port")
        .unwrap_or_else(|| DEFAULT_T3_PORT.to_string());
    let Some(t3_port) = port_text.trim().parse::<u16>().ok().filter(|p| *p >= 1) else {
        return usage(&format!(
            "--t3-port must be a port, got '{}'",
            v.str("t3-port").unwrap_or("undefined")
        ));
    };

    let home = match resolve_home(v.str("home")) {
        Ok(home) => home,
        Err(message) => return fail(&message),
    };
    let state = match read_setup(&home) {
        Ok(Some(state)) => state,
        Ok(None) => {
            return fail(&format!(
                "{} has no hub set up: run fleetd init first",
                home.display()
            ));
        }
        Err(message) => return fail(&message),
    };
    let suffix = match v.str("unit-suffix") {
        None => state.unit_suffix.clone(),
        Some(text) => match unit_suffix(Some(text)) {
            Some(suffix) => suffix,
            None => {
                return usage(&format!(
                    "--unit-suffix takes letters, digits and dashes, got '{text}'"
                ));
            }
        },
    };
    // The worker gets this very binary; for now only a machine that can run it.
    let exe = match current_exe() {
        Ok(exe) => exe,
        Err(message) => return fail(&message),
    };
    let binary = match std::fs::read(&exe) {
        Ok(bytes) => bytes,
        Err(error) => {
            return fail(&format!(
                "machine add copies the running fleetd to the machine, and {} is unreadable: {error}",
                exe.display()
            ));
        }
    };
    let exe_len = binary.len() as u64;
    let target = SshTarget {
        host: host.clone(),
        config: v.str("ssh-config").map(|config| {
            std::path::absolute(config)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| config.to_owned())
        }),
    };
    let input = MachineAddInput {
        machine_id: machine_id.clone(),
        tags: v
            .str("tags")
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .collect(),
        hub_url: v.string("hub-url").unwrap_or_else(|| state.url.clone()),
        unit_suffix: suffix,
        t3_port,
        t3_version: T3_NPM_VERSION.into(),
        git_identity: state.git_identity.clone(),
        binary_digest: format!("{:x}", Sha256::digest(&binary)),
        binary_target: local_target(),
        version: env!("CARGO_PKG_VERSION").into(),
        hub_has_node_key: false,
    };

    if v.flag("dry-run") {
        let user = match host.split_once('@') {
            Some((user, _)) => user.to_owned(),
            None => std::env::var("USER")
                .or_else(|_| std::env::var("LOGNAME"))
                .unwrap_or_else(|_| "user".into()),
        };
        let plan = match plan_machine_add(&fresh_facts(&user, &input.binary_target.1), &input) {
            Ok(plan) => plan,
            Err(message) => return fail(&message),
        };
        say(&format!(
            "dry run: nothing runs. Planned for a fresh Linux machine at {host} (home {}); a real run first reads the machine's state over SSH and leaves out what is already done:",
            plan.layout
                .fleetd
                .strip_suffix("/.fleetd")
                .unwrap_or(&plan.layout.fleetd)
        ));
        say(&format!(
            "[probe] read the machine's state (read-only)\n  $ {}\n    (stdin: the probe script)",
            probe_command(&input.unit_suffix)
        ));
        for (i, step) in plan.steps.iter().enumerate() {
            print_step(i + 1, plan.steps.len(), step, &exe, exe_len);
        }
        say(&format!("[hub] wait until {machine_id} is online"));
        for note in &plan.notes {
            say(&format!("note: {note}"));
        }
        return 0;
    }

    if parse_listen(&state.listen).is_none()
        || probe_listen(&parse_listen(&state.listen).unwrap_or_default()).await != Probe::Hub
    {
        return fail(&format!(
            "no hub answers at {}: start it first (fleetd init, or fleetd hub start --home {})",
            state.listen,
            home.display()
        ));
    }
    let hub = match open_hub(&home) {
        Ok(hub) => hub,
        Err(message) => return fail(&message),
    };

    say(&format!(
        "setting up {machine_id} on {host}; every remote command is shown before it runs."
    ));
    say(&format!(
        "[probe] read the machine's state (read-only)\n  $ {}\n    (stdin: the probe script)",
        probe_command(&input.unit_suffix)
    ));
    let probed = run_ssh(
        &target,
        &probe_command(&input.unit_suffix),
        Some(PROBE_SCRIPT.as_bytes()),
    )
    .await;
    if probed.code != 0 {
        return fail(&format!(
            "cannot read {host} over SSH (exit {}):\n{}",
            probed.code,
            tail(&probed.stderr)
        ));
    }
    let last = probed.stdout.trim().split('\n').next_back().unwrap_or("{}");
    let parsed: serde_json::Value = serde_json::from_str(last).unwrap_or_default();
    if parsed.get("error").is_some() {
        return fail(&format!(
            "no Node on {host}: install Node 24 or newer for {}, then run again",
            host.split('@').next().unwrap_or(host)
        ));
    }
    let facts: Facts = match serde_json::from_value(parsed) {
        Ok(facts) => facts,
        Err(error) => {
            return fail(&format!(
                "cannot read what the probe found on {host}: {error}"
            ));
        }
    };

    let has_key = hub
        .auth
        .node_pub_key(&machine)
        .is_ok_and(|key| key.is_some());
    let input = MachineAddInput {
        hub_has_node_key: has_key,
        ..input
    };
    let plan = match plan_machine_add(&facts, &input) {
        Ok(plan) => plan,
        Err(message) => return fail(&message),
    };
    // Recorded before anything changes, so `machine remove` can undo a run that stopped half way.
    let mut recorded = state.clone();
    recorded.machines.insert(
        machine_id.clone(),
        MachineRecord {
            ssh_host: host.clone(),
            ssh_config: target.config.clone(),
            platform: plan.platform,
            home: facts.home.clone(),
            config_home: facts.config_home.clone(),
            uid: facts.uid,
            unit_suffix: input.unit_suffix.clone(),
            t3_port,
        },
    );
    if let Err(message) = write_setup(&home, &recorded) {
        return fail(&message);
    }

    // Set after each step, so after the last one (the node's (re)start) only the new node can count as online.
    let mut steps_done = now_ms();
    for (i, step) in plan.steps.iter().enumerate() {
        print_step(i + 1, plan.steps.len(), step, &exe, exe_len);
        let stdin: Option<Vec<u8>> = match &step.stdin {
            None => None,
            Some(Stdin::Text { text, .. }) => Some(text.clone().into_bytes()),
            Some(Stdin::Binary) => Some(binary.clone()),
            Some(Stdin::EnrollToken) => match hub.auth.create_enroll_token(&machine) {
                Ok(token) => Some(format!("{}\n", token.token).into_bytes()),
                Err(error) => return fail(&error.to_string()),
            },
        };
        let result = run_ssh(&target, &step.command, stdin.as_deref()).await;
        if result.code != 0 {
            return fail(&format!(
                "step {} failed (exit {}):\n{}\nfix that and run the same command again; finished steps are skipped.",
                i + 1,
                result.code,
                tail(&format!("{}\n{}", result.stdout, result.stderr))
            ));
        }
        steps_done = now_ms();
        let shown = result.stdout.trim();
        if !shown.is_empty() && shown.len() < 200 && !shown.contains('\n') {
            say(&format!("  → {shown}"));
        }
    }

    let already = !plan.node_restarts
        && hub
            .store
            .machine_get(&machine)
            .ok()
            .flatten()
            .is_some_and(|m| m.status == MachineStatus::Online);
    if !already {
        say(&format!(
            "[hub] waiting until {machine_id} is online (up to 2 min)"
        ));
        if !wait_online(&hub, &machine, steps_done, Duration::from_secs(120)).await {
            return fail(&format!(
                "{machine_id} did not come online within 2 min. Its node log is {}/node.log on {host}; the node must reach the hub at {}.",
                plan.layout.logs, input.hub_url
            ));
        }
    }
    say(&format!("{machine_id} is online."));
    for note in &plan.notes {
        say(&format!("note: {note}"));
    }
    0
}

async fn remove_command(argv: &[String]) -> u8 {
    let v = match args::parse(
        argv,
        &Spec {
            options: &[("purge-t3", Kind::Bool), ("home", Kind::Str)],
            positionals: true,
        },
    ) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    let Some(machine) = v
        .positionals
        .first()
        .and_then(|id| MachineId::new(id.clone()).ok())
    else {
        return usage("machine remove takes a machine id");
    };
    let machine_id = machine.to_string();
    let home = match resolve_home(v.str("home")) {
        Ok(home) => home,
        Err(message) => return fail(&message),
    };
    let state = match read_setup(&home) {
        Ok(state) => state,
        Err(message) => return fail(&message),
    };
    let record = state
        .as_ref()
        .and_then(|s| s.machines.get(&machine_id))
        .cloned();
    let purge = v.flag("purge-t3");

    let mut remote_ok = true;
    match &record {
        None => say(&format!(
            "{machine_id} was not set up by fleetd machine add from this hub, so only its key is revoked here; stop its node by hand."
        )),
        Some(record) => {
            let target = SshTarget {
                host: record.ssh_host.clone(),
                config: record.ssh_config.clone(),
            };
            let steps = plan_machine_remove(
                record.platform,
                &record.home,
                &record.config_home,
                record.uid,
                &record.unit_suffix,
                purge,
            );
            for (i, step) in steps.iter().enumerate() {
                say(&format!(
                    "[{}/{}] {}\n  $ {}",
                    i + 1,
                    steps.len(),
                    step.title,
                    step.command
                ));
                let result = run_ssh(&target, &step.command, None).await;
                if result.code != 0 {
                    remote_ok = false;
                    say(&format!(
                        "  failed (exit {}): {}",
                        result.code,
                        tail(&result.stderr)
                    ));
                    let rest: Vec<String> = steps[i..]
                        .iter()
                        .map(|s| format!("    {}", show_ssh(&target, &s.command)))
                        .collect();
                    say(&format!(
                        "  run the remaining steps yourself:\n{}",
                        rest.join("\n")
                    ));
                    break;
                }
            }
        }
    }

    let hub = match open_hub(&home) {
        Ok(hub) => hub,
        Err(message) => return fail(&message),
    };
    let revoked = match hub
        .auth
        .revoke_node(&machine)
        .and_then(|revoked| hub.store.machine_remove(&machine).map(|()| revoked))
    {
        Ok(revoked) => revoked,
        Err(error) => return fail(&error.to_string()),
    };
    say(&if revoked {
        format!("revoked {machine_id}'s node key; the hub refuses that node from now on.")
    } else {
        format!("the hub held no node key for {machine_id}.")
    });
    if let (Some(mut state), Some(_)) = (state, &record) {
        state.machines.remove(&machine_id);
        if let Err(message) = write_setup(&home, &state) {
            return fail(&message);
        }
    }
    if let Some(record) = &record
        && !purge
    {
        say(&format!(
            "T3 and its data stay on {}; remove them with --purge-t3.",
            record.ssh_host
        ));
    }
    if remote_ok { 0 } else { 1 }
}

/// `fleetd machine …`.
pub async fn machine_command(argv: &[String]) -> u8 {
    match argv.first().map(String::as_str) {
        Some("add") => add_command(&argv[1..]).await,
        Some("remove") => remove_command(&argv[1..]).await,
        Some(other) => usage(&format!("unknown machine command '{other}'")),
        None => usage("missing machine command"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_id_from_an_ssh_host() {
        assert_eq!(
            machine_id_from_host("wynn@Mac-Mini.tail1234.ts.net"),
            "mac-mini"
        );
        assert_eq!(machine_id_from_host("forge"), "forge");
        assert_eq!(machine_id_from_host("build_box_2"), "build-box-2");
    }

    #[test]
    fn reads_hub_timestamps() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(
            parse_iso_ms("2026-10-17T10:00:00.000Z"),
            Some(1_792_231_200_000)
        );
    }
}
