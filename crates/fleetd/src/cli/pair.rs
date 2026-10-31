//! `fleetd pair`: mints a one-time pairing code in the hub home's database (as `hub key create` does, so the hub
//! need not be running) and writes `app-pair.json`, which the desktop app on this machine reads to pair by itself.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::CliResult;
use super::args::{self, Kind, Spec};
use super::setup::{DEFAULT_LISTEN, mkdir_private, parse_listen, write_private};
use crate::clock::SystemClock;
use crate::hub::pair::{self as hub_pair, PairCodes};
use crate::hub::store::HubDb;
use fleetd_contracts::auth::Role;

pub const PAIR_USAGE: &str = r#"  pair [--name <device>] [--role <read|operate|admin>] [--no-qr]
             print a one-time code (15 min) that pairs the fleetd app with this hub, and a QR
             of its link for the phone app to scan (--no-qr leaves it out); the desktop app
             on this machine pairs by itself. The device gets --role (default admin, which
             changes the hub's settings) on every machine
  pair --worker <machine-id>
             print the one command that makes another machine a worker of this hub, with
             a one-time code (15 min): for a machine the hub can't reach over SSH
"#;

/// A minted pairing code and everything a device needs to redeem it.
#[derive(Debug, Clone, PartialEq)]
pub struct Minted {
    /// `XXXX-XXXX`, single use.
    pub code: String,
    /// Where a device can reach the hub, best first: tailnet, then LAN, then localhost.
    pub urls: Vec<String>,
    /// `fleetd://pair?hub=<urls[0]>&code=<code>`.
    pub deep_link: String,
    /// RFC 3339.
    pub expires_at: String,
    /// What the paired device may do, on every machine.
    pub role: Role,
    /// The `app-pair.json` written for the app on this machine.
    pub app_pair_file: PathBuf,
}

/// Mints a code for the hub at `home` (default `~/.fleetd/hub`) and writes `app-pair.json`. `name` names the key
/// when the device doesn't send a name of its own; `role` is what it may do, on every machine.
pub fn mint(home: Option<&str>, name: Option<&str>, role: Role) -> Result<Minted, String> {
    let home = super::hub_key::resolve_home(home)?;
    let db = HubDb::open(&home).map_err(|error| error.to_string())?;
    let minted = PairCodes::new(db, Arc::new(SystemClock))
        .create(name.filter(|n| !n.trim().is_empty()), role)
        .map_err(|error| error.to_string())?;
    let urls = local_hub_urls(&home)?;
    let deep_link = deep_link(&urls[0], &minted.code);
    let app_pair_file = app_pair_file();
    write_app_pair(&app_pair_file, &urls[0], &minted.code, &minted.expires_at)?;
    Ok(Minted {
        code: minted.code,
        urls,
        deep_link,
        expires_at: minted.expires_at,
        role,
        app_pair_file,
    })
}

pub fn deep_link(hub: &str, code: &str) -> String {
    let hub: String = url::form_urlencoded::byte_serialize(hub.as_bytes()).collect();
    format!("fleetd://pair?hub={hub}&code={code}")
}

/// `$XDG_CONFIG_HOME/fleetd/app-pair.json` (default `~/.config`); on macOS `~/Library/Application Support/fleetd/`.
/// A relocated fleetd dir (`FLEETD_HOME`, `--home`) holds it instead, where the app run with the same
/// `FLEETD_HOME` looks.
pub fn app_pair_file() -> PathBuf {
    if let Some(dir) = crate::home::relocated() {
        return dir.join("app-pair.json");
    }
    let home = super::home_dir();
    let dir = if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".config"))
    };
    dir.join("fleetd").join("app-pair.json")
}

fn write_app_pair(file: &Path, hub: &str, code: &str, expires_at: &str) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        mkdir_private(dir)?;
    }
    let text = serde_json::json!({ "hub": hub, "code": code, "expiresAt": expires_at });
    write_private(file, &format!("{text}\n"))
}

/// The hub's listen address and URL from `setup.json`, or the defaults when `fleetd init` never ran.
pub(crate) fn local_hub_urls(home: &Path) -> Result<Vec<String>, String> {
    let setup = super::setup::state::read_setup(home)?;
    // Without init's setup.json, the hub someone started by hand tells its address in its own command line.
    let running = setup.is_none().then(|| running_listen(home)).flatten();
    let listen_text = setup
        .as_ref()
        .map(|s| s.listen.as_str())
        .or(running.as_deref())
        .unwrap_or(DEFAULT_LISTEN);
    let (host, port) = parse_listen(listen_text)
        .ok_or_else(|| format!("the hub's listen address '{listen_text}' is not host:port"))?;
    let host_ip = host.parse::<IpAddr>().ok();
    let everywhere = host_ip.is_some_and(|ip| ip.is_unspecified());
    let configured = setup
        .map(|s| s.url)
        .filter(|url| !url.contains("0.0.0.0") && !url.contains("[::]"));
    let (tailnet, lan) = if everywhere {
        (tailnet_ip(), lan_ip())
    } else {
        (None, None)
    };
    Ok(hub_urls(&host, port, configured.as_deref(), tailnet, lan))
}

/// `--listen` of the hub process that has this home's database open.
pub(crate) fn running_listen(home: &Path) -> Option<String> {
    super::setup::processes_holding(&home.join("hub.sqlite"))
        .into_iter()
        .find_map(|pid| {
            let out = std::process::Command::new("ps")
                .args(["-o", "args=", "-p", &pid.to_string()])
                .stderr(std::process::Stdio::null())
                .output()
                .ok()?;
            listen_from_args(&String::from_utf8_lossy(&out.stdout))
        })
}

/// `--listen <addr>` or `--listen=<addr>` in a `fleetd hub start` command line.
fn listen_from_args(args: &str) -> Option<String> {
    let mut words = args.split_whitespace();
    while let Some(word) = words.next() {
        if word == "--listen" {
            return words.next().map(str::to_owned);
        }
        if let Some(value) = word.strip_prefix("--listen=") {
            return Some(value.to_owned());
        }
    }
    None
}

/// Best first: tailnet, other names, LAN, loopback. A hub on every interface is offered at each address that
/// reaches it; one on a single address only there (plus its configured URL).
pub fn hub_urls(
    listen_host: &str,
    port: u16,
    configured: Option<&str>,
    tailnet: Option<Ipv4Addr>,
    lan: Option<IpAddr>,
) -> Vec<String> {
    let url = |ip: IpAddr| match ip {
        IpAddr::V4(v4) => format!("http://{v4}:{port}"),
        IpAddr::V6(v6) => format!("http://[{v6}]:{port}"),
    };
    let mut candidates: Vec<(u8, String)> = Vec::new();
    if let Some(configured) = configured {
        candidates.push((
            rank_url(configured),
            configured.trim_end_matches('/').to_owned(),
        ));
    }
    match listen_host.trim_matches(['[', ']']).parse::<IpAddr>() {
        Ok(ip) if ip.is_unspecified() => {
            for ip in [tailnet.map(IpAddr::V4), lan].into_iter().flatten() {
                candidates.push((rank_ip(ip), url(ip)));
            }
            candidates.push((3, url(IpAddr::V4(Ipv4Addr::LOCALHOST))));
        }
        Ok(ip) => candidates.push((rank_ip(ip), url(ip))),
        Err(_) => candidates.push((1, format!("http://{listen_host}:{port}"))),
    }
    candidates.sort_by_key(|(rank, _)| *rank);
    let mut urls: Vec<String> = Vec::new();
    for (_, url) in candidates {
        if !urls.contains(&url) {
            urls.push(url);
        }
    }
    urls
}

/// `url`'s host, without its port or IPv6 brackets.
fn url_host(url: &str) -> &str {
    let host = url
        .split_once("://")
        .map_or(url, |(_, rest)| rest)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    let host = match host.rsplit_once(':') {
        Some((h, port)) if port.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => host,
    };
    host.trim_matches(['[', ']'])
}

/// The first of `urls` a phone can reach: none on this machine's loopback (127.0.0.1, ::1, localhost) or at the
/// every-interface 0.0.0.0, which reach nothing from another device.
pub fn phone_url<'a>(urls: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    urls.into_iter().map(str::trim).find(|url| {
        let host = url_host(url).to_ascii_lowercase();
        !host.is_empty()
            && match host.parse::<IpAddr>() {
                Ok(ip) => !ip.is_loopback() && !ip.is_unspecified(),
                Err(_) => host != "localhost" && !host.ends_with(".localhost"),
            }
    })
}

/// What to do when the hub has no address a phone can reach.
pub fn loopback_only_fix() -> &'static str {
    "Give the hub an address your phone reaches, its tailnet or LAN address: run `fleetd init` again on the hub and \
     pick it (Settings › Hub › Setup › Where the hub listens says how), then pair the phone again."
}

/// `text` as a QR in Unicode half-blocks, two rows of modules a line, with its quiet zone. Light modules are drawn,
/// so it reads on a dark terminal as dark-on-light.
pub fn terminal_qr(text: &str) -> Option<String> {
    use qrcode::render::unicode::Dense1x2;
    let code = qrcode::QrCode::with_error_correction_level(text, qrcode::EcLevel::L).ok()?;
    Some(
        code.render::<Dense1x2>()
            .dark_color(Dense1x2::Light)
            .light_color(Dense1x2::Dark)
            .build(),
    )
}

fn rank_url(url: &str) -> u8 {
    let host = url_host(url);
    match host.parse::<IpAddr>() {
        Ok(ip) => rank_ip(ip),
        Err(_) if host.ends_with(".ts.net") => 0,
        Err(_) if host == "localhost" => 3,
        Err(_) => 1,
    }
}

fn rank_ip(ip: IpAddr) -> u8 {
    match ip {
        ip if ip.is_loopback() => 3,
        IpAddr::V4(v4) if is_tailnet(v4) => 0,
        IpAddr::V4(v4) if v4.is_private() || v4.is_link_local() => 2,
        IpAddr::V6(v6) if is_tailnet_v6(v6) => 0,
        IpAddr::V6(v6) if v6.is_unique_local() || v6.is_unicast_link_local() => 2,
        _ => 1,
    }
}

/// Tailscale's CGNAT range, 100.64.0.0/10.
fn is_tailnet(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (64..128).contains(&b)
}

/// fd7a:115c:a1e0::/48.
fn is_tailnet_v6(ip: Ipv6Addr) -> bool {
    ip.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0]
}

/// `tailscale ip -4`, only when a `tailscale` binary is on PATH (never through a shell's not-found hook).
fn tailnet_ip() -> Option<Ipv4Addr> {
    let bin = std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join("tailscale"))
        .find(|p| p.is_file())?;
    let out = std::process::Command::new(bin)
        .args(["ip", "-4"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|line| line.trim().parse::<Ipv4Addr>().ok())
        .filter(|ip| is_tailnet(*ip))
}

/// The address of the interface the default route leaves by. Connecting a UDP socket sends nothing.
fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

/// `fleetd pair`.
pub fn pair_command(argv: &[String]) -> CliResult {
    let usage =
        |message: &str| CliResult::err(2, format!("fleetd: {message}\n\nusage:\n{PAIR_USAGE}"));
    let v = match args::parse(
        argv,
        &Spec {
            options: &[
                ("name", Kind::Str),
                ("no-qr", Kind::Bool),
                ("role", Kind::Str),
                ("worker", Kind::Str),
            ],
            positionals: false,
        },
    ) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    if let Some(machine) = v.str("worker") {
        if v.has("role") || v.flag("no-qr") {
            return usage("--worker joins a machine and takes no --role or --no-qr");
        }
        return match worker_command(None, machine) {
            Ok(text) => CliResult {
                code: 0,
                stdout: text,
                stderr: String::new(),
            },
            Err(message) => CliResult::err(1, format!("fleetd: {message}\n")),
        };
    }
    let role = match v.str("role") {
        None => hub_pair::DEFAULT_ROLE,
        Some(text) => match hub_pair::parse_role(text) {
            Some(role) => role,
            None => return usage("--role must be read, operate or admin"),
        },
    };
    match mint(None, v.str("name"), role) {
        Ok(minted) => CliResult {
            code: 0,
            stdout: describe(&minted, !v.flag("no-qr")),
            stderr: String::new(),
        },
        Err(message) => CliResult::err(1, format!("fleetd: {message}\n")),
    }
}

/// The command a new worker runs to join: the installer, which then runs `fleetd init --join` with a one-time
/// enrollment code for `machine` (the node join path's own token, so nothing new crosses the wire).
pub fn worker_command(home: Option<&str>, machine: &str) -> Result<String, String> {
    let machine_id = fleetd_contracts::ids::MachineId::new(machine)
        .map_err(|_| format!("'{machine}' is not a machine id ([a-z0-9-]{{1,32}})"))?;
    let home = super::hub_key::resolve_home(home)?;
    let hub = super::hub_key::open_hub(&home)?;
    let join = worker_join(&home, &hub.auth, &machine_id, false)?;
    Ok(format!(
        "On {machine}, run:\n\n  {}\n\nThe code works once, until {}. {machine} needs claude installed and must reach the hub at that address.\n",
        join.line, join.expires_at
    ))
}

/// What a worker needs to join the hub at `home` by itself: its address, a one-time code, the commit identity, and
/// the line that installs fleetd and joins with them.
pub struct WorkerJoin {
    pub hub: String,
    pub code: String,
    /// RFC 3339.
    pub expires_at: String,
    /// `Name <email>`.
    pub git_identity: Option<String>,
    pub line: String,
}

/// Mints the one-time code `fleetd pair --worker` prints, and the app's Add machine shows. `rejoin`: the line enrolls
/// a machine that joined before again (`--rejoin`), repairing it.
pub fn worker_join(
    home: &Path,
    auth: &crate::hub::auth::Auth,
    machine: &fleetd_contracts::ids::MachineId,
    rejoin: bool,
) -> Result<WorkerJoin, String> {
    let setup = super::setup::state::read_setup(home)?;
    let urls = local_hub_urls(home)?;
    let token = auth
        .create_enroll_token(machine)
        .map_err(|error| error.to_string())?;
    let git_identity = setup
        .and_then(|s| s.git_identity)
        .map(|id| format!("{} <{}>", id.name, id.email));
    Ok(WorkerJoin {
        line: join_line(
            &urls[0],
            &token.token,
            machine.as_str(),
            git_identity.as_deref(),
        ) + if rejoin { " --rejoin" } else { "" },
        hub: urls[0].clone(),
        code: token.token,
        expires_at: token.expires_at,
        git_identity,
    })
}

/// One line that installs fleetd and joins the hub, asking nothing: install.sh takes the join options and runs
/// `fleetd init --join` with them instead of the setup wizard. Every value is quoted for the shell.
pub fn join_line(hub: &str, code: &str, machine: &str, identity: Option<&str>) -> String {
    use super::setup::units::q;
    let mut line = format!(
        "curl -fsSL https://fleetd.sh | sh -s -- --join {} --code {} --machine-id {}",
        q(hub),
        q(code),
        q(machine)
    );
    if let Some(identity) = identity {
        line += &format!(" --git-identity {}", q(identity));
    }
    line
}

/// What `fleetd pair` prints: with `qr`, the link a phone can open as a QR above the code, or why there is none.
fn describe(minted: &Minted, qr: bool) -> String {
    let mut out = String::new();
    if qr {
        out += &phone_qr(minted);
    }
    out += &format!(
        "Pairing code: {}  (single use, valid until {})\nGrants:       {} on every machine\nHub address:  {}\n",
        minted.code,
        minted.expires_at,
        crate::hub::api::role_name(minted.role),
        minted.urls[0]
    );
    if minted.urls.len() > 1 {
        out += &format!("  or:         {}\n", minted.urls[1..].join(", "));
    }
    out += &format!(
        "Pairing link: {}\n\nThe fleetd app on this machine pairs by itself when it opens. On a phone, scan the QR with the\nfleetd app. On another device, enter the code and hub address above in the app, or open the link there.\n",
        minted.deep_link
    );
    out
}

/// The QR of the pairing link for a phone, with the hub at an address a phone reaches; or, when the hub has none,
/// why there is no QR and how to give it one.
fn phone_qr(minted: &Minted) -> String {
    let Some(hub) = phone_url(minted.urls.iter().map(String::as_str)) else {
        return format!(
            "No QR for a phone: the hub is only at {}, which a phone can't reach. {}\n\n",
            minted.urls.join(", "),
            loopback_only_fix()
        );
    };
    match terminal_qr(&deep_link(hub, &minted.code)) {
        Some(qr) => format!("Scan with the fleetd app on your phone:\n\n{qr}\n\n"),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn the_worker_command_installs_and_joins_in_one_step() {
        assert_eq!(
            super::join_line(
                "http://devbox.example.ts.net:4790",
                "abc123",
                "laptop",
                Some("O'Neil Ada <1+ada@users.noreply.github.com>")
            ),
            "curl -fsSL https://fleetd.sh | sh -s -- --join http://devbox.example.ts.net:4790 --code abc123 \
             --machine-id laptop --git-identity 'O'\\''Neil Ada <1+ada@users.noreply.github.com>'"
        );
        // No `&& fleetd init` after the pipe: the installer's own wizard would ask for the hub and code first.
        let line = super::join_line("http://hub:4790", "c", "mac", None);
        assert_eq!(
            line,
            "curl -fsSL https://fleetd.sh | sh -s -- --join http://hub:4790 --code c --machine-id mac"
        );
        assert!(!line.contains("&&"));
    }

    #[test]
    fn reads_the_listen_address_of_a_running_hub() {
        let line = "/home/u/.fleetd/bin/fleetd hub start --home /h --listen 127.0.0.1:4796";
        assert_eq!(listen_from_args(line).as_deref(), Some("127.0.0.1:4796"));
        assert_eq!(
            listen_from_args("fleetd hub start --listen=[::1]:4790").as_deref(),
            Some("[::1]:4790")
        );
        assert_eq!(listen_from_args("fleetd hub start --home /h"), None);
    }

    use super::*;

    #[test]
    fn a_hub_on_every_interface_is_offered_tailnet_then_lan_then_localhost() {
        let urls = hub_urls(
            "0.0.0.0",
            4790,
            None,
            Some(Ipv4Addr::new(100, 101, 102, 103)),
            Some("192.168.1.20".parse().unwrap()),
        );
        assert_eq!(
            urls,
            [
                "http://100.101.102.103:4790",
                "http://192.168.1.20:4790",
                "http://127.0.0.1:4790"
            ]
        );
        // The default route through the tailnet: one address, no duplicate.
        let urls = hub_urls(
            "::",
            4790,
            None,
            Some(Ipv4Addr::new(100, 101, 102, 103)),
            Some("100.101.102.103".parse().unwrap()),
        );
        assert_eq!(
            urls,
            ["http://100.101.102.103:4790", "http://127.0.0.1:4790"]
        );
    }

    #[test]
    fn a_hub_on_one_address_is_offered_there_with_its_configured_url_ranked() {
        assert_eq!(
            hub_urls("127.0.0.1", 4790, Some("http://127.0.0.1:4790"), None, None),
            ["http://127.0.0.1:4790"]
        );
        assert_eq!(
            hub_urls(
                "100.101.102.103",
                4790,
                Some("https://devbox.tail1234.ts.net/"),
                None,
                None
            ),
            [
                "https://devbox.tail1234.ts.net",
                "http://100.101.102.103:4790"
            ]
        );
        assert_eq!(
            hub_urls(
                "192.168.1.20",
                4790,
                Some("http://localhost:4790"),
                None,
                None
            ),
            ["http://192.168.1.20:4790", "http://localhost:4790"]
        );
    }

    #[test]
    fn role_takes_read_operate_or_admin_and_not_with_worker() {
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let out = pair_command(&argv(&["--role", "owner"]));
        assert_eq!(out.code, 2);
        assert!(
            out.stderr.contains("--role must be read, operate or admin"),
            "{}",
            out.stderr
        );
        let out = pair_command(&argv(&["--worker", "lab-b", "--role", "admin"]));
        assert_eq!(out.code, 2);
        assert!(out.stderr.contains("takes no --role"), "{}", out.stderr);
        assert_eq!(hub_pair::parse_role("operate"), Some(Role::Operate));
        assert_eq!(hub_pair::DEFAULT_ROLE, Role::Admin);
    }

    #[test]
    fn deep_links_carry_the_hub_url_encoded() {
        assert_eq!(
            deep_link("http://100.101.102.103:4790", "ABCD-EFGH"),
            "fleetd://pair?hub=http%3A%2F%2F100.101.102.103%3A4790&code=ABCD-EFGH"
        );
        // A URL's own query, fragment, path, IPv6 brackets and spaces stay inside `hub`: none leaks out as a parameter.
        let hub = "https://devbox.tail1234.ts.net/fleet hub?x=1&code=EVIL#top";
        let link = deep_link(hub, "ABCD-EFGH");
        assert_eq!(
            link,
            "fleetd://pair?hub=https%3A%2F%2Fdevbox.tail1234.ts.net%2Ffleet+hub%3Fx%3D1%26code%3DEVIL%23top&code=ABCD-EFGH"
        );
        let parsed = url::Url::parse(&link).unwrap();
        let params: Vec<(String, String)> = parsed.query_pairs().into_owned().collect();
        assert_eq!(
            params,
            [
                ("hub".into(), hub.into()),
                ("code".into(), "ABCD-EFGH".into())
            ]
        );
        assert_eq!(
            deep_link("http://[fd7a:115c:a1e0::1]:4790", "ABCD-EFGH"),
            "fleetd://pair?hub=http%3A%2F%2F%5Bfd7a%3A115c%3Aa1e0%3A%3A1%5D%3A4790&code=ABCD-EFGH"
        );
    }

    #[test]
    fn a_phone_is_never_given_a_loopback_or_every_interface_address() {
        for url in [
            "http://127.0.0.1:4790",
            "http://127.1.2.3:4790",
            "http://localhost:4790",
            "http://LOCALHOST",
            "http://hub.localhost:4790",
            "http://[::1]:4790",
            "http://0.0.0.0:4790",
            "http://[::]:4790",
            "",
        ] {
            assert_eq!(phone_url([url]), None, "{url}");
        }
        assert_eq!(
            phone_url(["http://127.0.0.1:4790", "http://192.168.1.20:4790"]),
            Some("http://192.168.1.20:4790")
        );
        assert_eq!(
            phone_url([
                "https://devbox.tail1234.ts.net",
                "http://100.101.102.103:4790"
            ]),
            Some("https://devbox.tail1234.ts.net")
        );
        assert_eq!(
            phone_url(["http://[fd7a:115c:a1e0::1]:4790"]),
            Some("http://[fd7a:115c:a1e0::1]:4790")
        );
    }

    fn minted(urls: &[&str]) -> Minted {
        let urls: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
        Minted {
            code: "ABCD-EFGH".into(),
            deep_link: deep_link(&urls[0], "ABCD-EFGH"),
            urls,
            expires_at: "2026-10-29T10:15:00.000Z".into(),
            role: Role::Admin,
            app_pair_file: PathBuf::from("/h/app-pair.json"),
        }
    }

    #[test]
    fn fleetd_pair_prints_a_qr_of_the_phones_link_above_the_code() {
        let out = describe(
            &minted(&["http://127.0.0.1:4790", "http://192.168.1.20:4790"]),
            true,
        );
        let (above, below) = out.split_once("Pairing code: ABCD-EFGH").unwrap();
        assert!(
            above.starts_with("Scan with the fleetd app on your phone:\n\n"),
            "{out}"
        );
        let qr = terminal_qr(&deep_link("http://192.168.1.20:4790", "ABCD-EFGH")).unwrap();
        assert!(above.contains(&qr), "{out}");
        // Half-blocks, two rows of modules a line, square: as wide as it is tall in modules.
        let lines: Vec<&str> = qr.lines().collect();
        let width = lines[0].chars().count();
        assert!(lines.iter().all(|l| l.chars().count() == width));
        assert!(
            qr.chars()
                .all(|c| matches!(c, ' ' | '▀' | '▄' | '█' | '\n')),
            "{qr}"
        );
        assert!(lines.len() * 2 >= width && lines.len() * 2 <= width + 1);
        assert!(below.contains("Hub address:  http://127.0.0.1:4790"));

        let plain = describe(
            &minted(&["http://127.0.0.1:4790", "http://192.168.1.20:4790"]),
            false,
        );
        assert!(plain.starts_with("Pairing code: ABCD-EFGH"), "{plain}");
        assert!(!plain.contains('█'));
    }

    #[test]
    fn fleetd_pair_on_a_loopback_only_hub_prints_no_qr_and_says_how_to_fix_it() {
        let out = describe(&minted(&["http://127.0.0.1:4790"]), true);
        assert!(!out.contains('█'), "{out}");
        assert!(
            out.starts_with(
                "No QR for a phone: the hub is only at http://127.0.0.1:4790, which a phone can't reach. Give the hub"
            ),
            "{out}"
        );
        assert!(out.contains("Pairing code: ABCD-EFGH"));
    }

    #[test]
    fn no_qr_is_not_for_worker() {
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let out = pair_command(&argv(&["--worker", "lab-b", "--no-qr"]));
        assert_eq!(out.code, 2);
        assert!(
            out.stderr.contains("takes no --role or --no-qr"),
            "{}",
            out.stderr
        );
    }
}
