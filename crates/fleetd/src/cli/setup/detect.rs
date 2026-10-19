//! What `fleetd init` finds on its own: Tailscale, the LAN address, SSH hosts, local git repos, and the install
//! command for a missing tool. Every probe here only reads.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// This machine on its tailnet, and the tailnet's other machines that could be workers.
#[derive(Debug, Default, PartialEq)]
pub struct Tailnet {
    pub ipv4: Option<String>,
    /// MagicDNS name without the trailing dot, e.g. `devbox.tail1234.ts.net`.
    pub dns_name: Option<String>,
    pub peers: Vec<Peer>,
}

#[derive(Debug, PartialEq)]
pub struct Peer {
    /// The first label of its MagicDNS name: what `machine add` would call it.
    pub name: String,
    pub dns_name: String,
}

/// `tailscale status --json`, when its backend runs. Only online Linux and macOS peers: what `machine add` sets up.
pub fn parse_tailscale_status(json: &str) -> Option<Tailnet> {
    let status: Value = serde_json::from_str(json).ok()?;
    if status.get("BackendState").and_then(Value::as_str) != Some("Running") {
        return None;
    }
    let me = status.get("Self")?;
    let dns = |node: &Value| {
        node.get("DNSName")
            .and_then(Value::as_str)
            .map(|name| name.trim_end_matches('.').to_owned())
            .filter(|name| !name.is_empty())
    };
    let ipv4 = me
        .get("TailscaleIPs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok())
        .map(str::to_owned);
    let mut peers: Vec<Peer> = status
        .get("Peer")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|peers| peers.values())
        .filter(|peer| peer.get("Online") == Some(&Value::Bool(true)))
        .filter(|peer| {
            matches!(
                peer.get("OS").and_then(Value::as_str),
                Some("linux" | "macOS")
            )
        })
        .filter_map(|peer| {
            let dns_name = dns(peer)?;
            let name = dns_name.split('.').next()?.to_owned();
            Some(Peer { name, dns_name })
        })
        .collect();
    peers.sort_by(|a, b| a.name.cmp(&b.name));
    Some(Tailnet {
        ipv4,
        dns_name: dns(me),
        peers,
    })
}

/// `Host` entries of an ssh_config that name one machine: no patterns, no negations.
pub fn parse_ssh_hosts(config: &str) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for line in config.lines() {
        let line = line.trim();
        let (keyword, rest) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((keyword, rest)) => (keyword, rest.trim_start_matches(['=', ' ', '\t'])),
            None => continue,
        };
        if !keyword.eq_ignore_ascii_case("host") {
            continue;
        }
        for host in rest.split_whitespace() {
            let host = host.trim_matches('"');
            if !host.is_empty()
                && !host.contains(['*', '?', '!'])
                && !hosts.iter().any(|h| h == host)
            {
                hosts.push(host.to_owned());
            }
        }
    }
    hosts
}

/// The `origin` URL in a `.git/config`, else the first remote's.
pub fn parse_git_remote(config: &str) -> Option<String> {
    let mut section = String::new();
    let mut first = None;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            section = line.to_owned();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "url" || !section.starts_with("[remote ") {
            continue;
        }
        let url = value.trim().to_owned();
        if section == "[remote \"origin\"]" {
            return Some(url);
        }
        first.get_or_insert(url);
    }
    first
}

/// `git@github.com:o/r.git`, `https://github.com/o/r` → `github.com/o/r`; other URLs unchanged.
pub fn short_remote(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    if let Some(rest) = url.strip_prefix("git@")
        && let Some((host, path)) = rest.split_once(':')
    {
        return format!("{host}/{path}");
    }
    for scheme in ["https://", "http://", "ssh://git@", "ssh://", "git://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            return rest.rsplit_once('@').map_or(rest, |(_, r)| r).to_owned();
        }
    }
    url.to_owned()
}

/// `owner/repo` from what a person pastes for a GitHub repo: a URL, `github.com/o/r`, `git@github.com:o/r.git`
/// or `o/r`.
pub fn parse_github_repo(text: &str) -> Option<(String, String)> {
    let text = text.trim();
    let short = short_remote(text);
    let path = short
        .strip_prefix("github.com/")
        .or_else(|| short.strip_prefix("www.github.com/"))
        .or_else(|| (!text.contains(':') && !text.contains('.')).then_some(short.as_str()))?;
    let mut parts = path.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (ok(owner) && ok(repo) && parts.next().is_none()).then(|| (owner.to_owned(), repo.to_owned()))
}

#[derive(Debug, PartialEq)]
pub struct Repo {
    pub path: PathBuf,
    pub remote: Option<String>,
}

/// Where people keep checkouts, under the home directory.
pub const REPO_ROOTS: [&str; 7] = [
    "src",
    "code",
    "projects",
    "dev",
    "Developer",
    "repos",
    "git",
];

/// Git checkouts under `roots`, at most two levels down, without looking inside a checkout.
pub fn find_repos(roots: &[PathBuf]) -> Vec<Repo> {
    fn visit(dir: &Path, depth: u32, found: &mut Vec<Repo>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                !name.starts_with('.') && name != "node_modules" && name != "target"
            })
            .map(|e| e.path())
            .collect();
        dirs.sort();
        for path in dirs {
            let git = path.join(".git");
            if git.is_dir() {
                let remote = std::fs::read_to_string(git.join("config"))
                    .ok()
                    .and_then(|config| parse_git_remote(&config));
                found.push(Repo { path, remote });
            } else if depth < 2 {
                visit(&path, depth + 1, found);
            }
        }
    }
    let mut found = Vec::new();
    for root in roots {
        visit(root, 1, &mut found);
    }
    found
}

/// The exact command that installs `tool` here, for the line that says it is missing.
pub fn install_command(tool: &str, os: &str, os_release: Option<&str>) -> String {
    let like = os_release
        .map(|text| {
            text.lines()
                .filter_map(|l| l.strip_prefix("ID=").or_else(|| l.strip_prefix("ID_LIKE=")))
                .map(|v| v.trim_matches('"').to_owned())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let family = |name: &str| like.split_whitespace().any(|id| id == name);
    match tool {
        "claude" => "curl -fsSL https://claude.ai/install.sh | bash".into(),
        "gh" if os == "macos" => "brew install gh".into(),
        "gh" if family("debian") || family("ubuntu") => "sudo apt install gh".into(),
        "gh" if family("fedora") || family("rhel") => "sudo dnf install gh".into(),
        "gh" if family("arch") => "sudo pacman -S github-cli".into(),
        "gh" => "see https://github.com/cli/cli#installation".into(),
        // Where a non-interactive SSH shell finds it, which a version manager's shell hook is not.
        "node" if os == "macos" => "brew install node".into(),
        "node" => "curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs".into(),
        other => format!("install {other}"),
    }
}

/// `Name <id+login@users.noreply.github.com>` from `gh api user`: the identity GitHub shows for public commits.
pub fn noreply_identity(gh_user_json: &str) -> Option<String> {
    let user: Value = serde_json::from_str(gh_user_json).ok()?;
    let login = user.get("login")?.as_str()?;
    let id = user.get("id")?.as_u64()?;
    Some(format!("{login} <{id}+{login}@users.noreply.github.com>"))
}

/// This machine's LAN address: the source address of a route to the internet. A UDP connect sends nothing.
pub fn lan_ipv4() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if ip.is_private() => Some(ip.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tailscale_status() {
        let json = r#"{"BackendState":"Running",
          "Self":{"DNSName":"devbox.tail1.ts.net.","TailscaleIPs":["fd7a::1","100.1.2.3"],"OS":"linux","Online":true},
          "Peer":{
            "a":{"DNSName":"mac-mini.tail1.ts.net.","OS":"macOS","Online":true},
            "b":{"DNSName":"iphone.tail1.ts.net.","OS":"iOS","Online":true},
            "c":{"DNSName":"box.tail1.ts.net.","OS":"linux","Online":false},
            "d":{"DNSName":"homeserver.tail1.ts.net.","OS":"linux","Online":true}}}"#;
        let tailnet = parse_tailscale_status(json).unwrap();
        assert_eq!(tailnet.ipv4.as_deref(), Some("100.1.2.3"));
        assert_eq!(tailnet.dns_name.as_deref(), Some("devbox.tail1.ts.net"));
        assert_eq!(
            tailnet
                .peers
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            ["homeserver", "mac-mini"]
        );
        assert_eq!(tailnet.peers[1].dns_name, "mac-mini.tail1.ts.net");
        assert_eq!(
            parse_tailscale_status(r#"{"BackendState":"NeedsLogin","Self":{}}"#),
            None
        );
        assert_eq!(parse_tailscale_status("not json"), None);
    }

    #[test]
    fn reads_ssh_hosts() {
        let config = "Host *\n  ForwardAgent no\nHost mac-mini studio\n  HostName 10.0.0.2\n\
                      host=build-box\nHost *.corp !bad db?\nMatch host foo\nHost mac-mini\n";
        assert_eq!(parse_ssh_hosts(config), ["mac-mini", "studio", "build-box"]);
    }

    #[test]
    fn reads_git_remotes() {
        let config = "[core]\n\turl = nope\n[remote \"upstream\"]\n\turl = git@github.com:a/b.git\n\
                      [remote \"origin\"]\n\turl = https://github.com/me/b.git\n";
        assert_eq!(
            parse_git_remote(config).as_deref(),
            Some("https://github.com/me/b.git")
        );
        assert_eq!(
            parse_git_remote("[remote \"up\"]\nurl = x\n").as_deref(),
            Some("x")
        );
        assert_eq!(parse_git_remote("[core]\n"), None);
        assert_eq!(short_remote("git@github.com:me/b.git"), "github.com/me/b");
        assert_eq!(
            short_remote("https://user@gitlab.com/me/b/"),
            "gitlab.com/me/b"
        );
    }

    #[test]
    fn reads_a_pasted_github_repo() {
        let want = Some(("unlaboredlabs".to_owned(), "fleetd".to_owned()));
        for text in [
            "https://github.com/unlaboredlabs/fleetd",
            "https://github.com/unlaboredlabs/fleetd.git",
            "github.com/unlaboredlabs/fleetd/",
            "git@github.com:unlaboredlabs/fleetd.git",
            "unlaboredlabs/fleetd",
        ] {
            assert_eq!(parse_github_repo(text), want, "{text}");
        }
        for text in [
            "https://gitlab.com/a/b",
            "github.com/a",
            "github.com/a/b/tree/main",
            "a b/c",
        ] {
            assert_eq!(parse_github_repo(text), None, "{text}");
        }
    }

    #[test]
    fn finds_repos_two_levels_down() {
        let home = tempfile::tempdir().unwrap();
        let src = home.path().join("src");
        let make = |rel: &str, config: Option<&str>| {
            let git = src.join(rel).join(".git");
            std::fs::create_dir_all(&git).unwrap();
            if let Some(config) = config {
                std::fs::write(git.join("config"), config).unwrap();
            }
        };
        make(
            "fleetd",
            Some("[remote \"origin\"]\n\turl = git@github.com:o/fleetd.git\n"),
        );
        make("fleetd/vendor/inner", None);
        make("work/api", None);
        make("a/b/too-deep", None);
        make(".hidden/x", None);
        let repos = find_repos(&[src.clone(), home.path().join("missing")]);
        assert_eq!(
            repos
                .iter()
                .map(|r| r
                    .path
                    .strip_prefix(&src)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned())
                .collect::<Vec<_>>(),
            ["fleetd", "work/api"]
        );
        assert_eq!(
            repos[0].remote.as_deref(),
            Some("git@github.com:o/fleetd.git")
        );
    }

    #[test]
    fn install_commands_and_identity() {
        let ubuntu = "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n";
        assert_eq!(
            install_command("gh", "linux", Some(ubuntu)),
            "sudo apt install gh"
        );
        assert_eq!(install_command("gh", "macos", None), "brew install gh");
        assert_eq!(
            noreply_identity(r#"{"login":"ada-lovelace","id":12345678,"name":null}"#).as_deref(),
            Some("ada-lovelace <12345678+ada-lovelace@users.noreply.github.com>")
        );
    }
}
