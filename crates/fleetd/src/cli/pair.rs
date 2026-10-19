//! `fleetd pair`: mints a one-time pairing code in the hub home's database (as `hub key create` does, so the hub
//! need not be running) and writes `app-pair.json`, which the desktop app on this machine reads to pair by itself.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::CliResult;
use super::args::{self, Kind, Spec};
use super::setup::{DEFAULT_LISTEN, mkdir_private, parse_listen, write_private};
use crate::clock::SystemClock;
use crate::hub::pair::PairCodes;
use crate::hub::store::HubDb;

pub const PAIR_USAGE: &str = r#"  pair [--name <device>] [--home <dir>]
             print a one-time code (15 min) that pairs the desktop app with this hub;
             the app on this machine pairs by itself
  pair --worker <machine-id> [--home <dir>]
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
    /// The `app-pair.json` written for the app on this machine.
    pub app_pair_file: PathBuf,
}

/// Mints a code for the hub at `home` (default `~/.fleetd/hub`) and writes `app-pair.json`. `name` names the key
/// when the device doesn't send a name of its own.
pub fn mint(home: Option<&str>, name: Option<&str>) -> Result<Minted, String> {
    let home = super::hub_key::resolve_home(home)?;
    let db = HubDb::open(&home).map_err(|error| error.to_string())?;
    let minted = PairCodes::new(db, Arc::new(SystemClock))
        .create(name.filter(|n| !n.trim().is_empty()))
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
fn local_hub_urls(home: &Path) -> Result<Vec<String>, String> {
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

fn rank_url(url: &str) -> u8 {
    let host = url
        .split_once("://")
        .map_or(url, |(_, rest)| rest)
        .split('/')
        .next()
        .unwrap_or_default();
    let host = match host.rsplit_once(':') {
        Some((h, port)) if port.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => host,
    };
    let host = host.trim_matches(['[', ']']);
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
                ("home", Kind::Str),
                ("name", Kind::Str),
                ("worker", Kind::Str),
            ],
            positionals: false,
        },
    ) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    if let Some(machine) = v.str("worker") {
        return match worker_command(v.str("home"), machine) {
            Ok(text) => CliResult {
                code: 0,
                stdout: text,
                stderr: String::new(),
            },
            Err(message) => CliResult::err(1, format!("fleetd: {message}\n")),
        };
    }
    match mint(v.str("home"), v.str("name")) {
        Ok(minted) => CliResult {
            code: 0,
            stdout: describe(&minted),
            stderr: String::new(),
        },
        Err(message) => CliResult::err(1, format!("fleetd: {message}\n")),
    }
}

/// The command a new worker runs to join: the installer, then `fleetd init --join` with a one-time enrollment code
/// for `machine` (the node join path's own token, so nothing new crosses the wire).
pub fn worker_command(home: Option<&str>, machine: &str) -> Result<String, String> {
    let machine_id = fleetd_contracts::ids::MachineId::new(machine)
        .map_err(|_| format!("'{machine}' is not a machine id ([a-z0-9-]{{1,32}})"))?;
    let home = super::hub_key::resolve_home(home)?;
    let setup = super::setup::state::read_setup(&home)?;
    let urls = local_hub_urls(&home)?;
    let hub = super::hub_key::open_hub(&home)?;
    let token = hub
        .auth
        .create_enroll_token(&machine_id)
        .map_err(|error| error.to_string())?;
    let identity = setup
        .and_then(|s| s.git_identity)
        .map(|id| {
            format!(
                " --git-identity {}",
                super::setup::units::q(&format!("{} <{}>", id.name, id.email))
            )
        })
        .unwrap_or_default();
    Ok(format!(
        "On {machine}, run:\n\n  curl -fsSL https://fleetd.sh | sh && ~/.local/bin/fleetd init --join {} --code {} --machine-id {machine}{identity}\n\nThe code works once, until {}. {machine} needs claude installed and must reach the hub at that address.\n",
        urls[0], token.token, token.expires_at
    ))
}

fn describe(minted: &Minted) -> String {
    let mut out = format!(
        "Pairing code: {}  (single use, valid until {})\nHub address:  {}\n",
        minted.code, minted.expires_at, minted.urls[0]
    );
    if minted.urls.len() > 1 {
        out += &format!("  or:         {}\n", minted.urls[1..].join(", "));
    }
    out += &format!(
        "Pairing link: {}\n\nThe fleetd app on this machine pairs by itself when it opens. On another device, open the\napp and enter the code and hub address above, or open the link there.\n",
        minted.deep_link
    );
    out
}

#[cfg(test)]
mod tests {

    #[test]
    fn reads_the_listen_address_of_a_running_hub() {
        let line =
            "/home/u/.fleetd/bin/fleetd hub start --home /h --listen 127.0.0.1:4796 --queue-ttl 60";
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
    fn deep_links_carry_the_hub_url_encoded() {
        assert_eq!(
            deep_link("http://100.101.102.103:4790", "ABCD-EFGH"),
            "fleetd://pair?hub=http%3A%2F%2F100.101.102.103%3A4790&code=ABCD-EFGH"
        );
    }
}
