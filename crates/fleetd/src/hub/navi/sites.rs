//! A Navi's site gate: its lead's first fetch (`WebFetch`) or browser visit (`agent-browser open|goto|navigate <url>`)
//! to a site asks the person in its chat, and their approval allows the site from then on, until they revoke it
//! (`navi_sites`, `navi_site_revoke`). A link the person writes in their own chat message allows its site too
//! ([`pasted`]). The relay (`approvals/permissions.rs`) asks here before anything else; any other shell command runs
//! unasked (D208), its writes held to the Navi's folder by the OS sandbox.
use serde_json::Value;

/// What a prompt visits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Visit {
    /// Its host, without a leading `www.`.
    Site(String),
    /// A fetch or visit whose site can't be read (another scheme, a compound command): asked each time, never
    /// remembered.
    Unknown,
}

/// The browser commands that go to a URL.
const OPENS: &[&str] = &["open", "goto", "navigate", "read"];

/// The characters a remembered visit's command may hold besides letters, digits and spaces: none a shell reads as more
/// than a literal character. A URL with `?` or `&`, or anything quoted, is a visit asked each time.
const PLAIN_CHARS: &[char] = &['@', '.', '_', ':', '/', '=', '-', '%', '+', ','];

/// The only flag a remembered visit may carry. Any other (`--session`, `--cdp`, `--action-policy`, `--config`,
/// `--headers`, `--args`, `--profile`, …) changes which browser runs or how, so the visit is asked each time.
const VISIT_FLAGS: &[&str] = &["--json"];

/// The characters a URL the gate reads may hold: a URL's own (RFC 3986), so the browser reads the host the gate read.
/// No `\` (a browser reads it as `/`, a shell drops it), double quote, whitespace or control character. A command's URL
/// is held to fewer: [`PLAIN_CHARS`], or anything but `'` inside one single-quoted literal.
fn plain(url: &str) -> bool {
    !url.is_empty()
        && url
            .chars()
            .all(|c| c.is_alphanumeric() || "-._~:/?#[]@!$&'()*+,;=%".contains(c))
}

/// Whether `url` names a scheme of its own (`file:`, `data:`, `about:`, `https://`): text before a `:` that isn't a
/// host's port (`localhost:3000`, `example.org:8080/a`).
fn has_scheme(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else {
        return false;
    };
    let port = rest.split(['/', '?', '#']).next().unwrap_or_default();
    !scheme.contains(['/', '.'])
        && (rest.starts_with("//") || port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()))
}

/// The site `url` is on: its host as the URL library reads it (lower case, IDN as punycode), without a leading
/// `www.`; a loopback host with its port (`localhost:3000`), since each port is a different program. None for anything
/// but a plain http or https URL with no user in it: `file:`, `data:`, `javascript:`, `about:`, `chrome:` and the rest
/// ask every time.
pub fn site_of(url: &str) -> Option<String> {
    if !plain(url) {
        return None;
    }
    let parsed = if has_scheme(url) {
        url::Url::parse(url)
    } else {
        url::Url::parse(&format!("https://{url}"))
    }
    .ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    let host = parsed
        .host_str()?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    let loopback = host == "localhost"
        || host.ends_with(".localhost")
        || match parsed.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
    let host = match parsed.port_or_known_default() {
        Some(port) if loopback => format!("{host}:{port}"),
        _ => host,
    };
    (!host.is_empty()).then_some(host)
}

/// The sites of the http and https links in a person's own chat message, each once: [`site_of`] each link's scheme and
/// host, so `(https://example.org/a)` and `https://example.org.` are on example.org.
pub fn pasted(text: &str) -> Vec<String> {
    let mut sites: Vec<String> = Vec::new();
    let lower = text.to_ascii_lowercase();
    for (at, _) in lower.match_indices("http") {
        let rest = &text[at..];
        let Some(scheme) = ["https://", "http://"].into_iter().find(|s| {
            rest.get(..s.len())
                .is_some_and(|r| r.eq_ignore_ascii_case(s))
        }) else {
            continue;
        };
        let host: String = rest[scheme.len()..]
            .chars()
            .take_while(|c| c.is_alphanumeric() || "-._~:[]@%".contains(*c))
            .collect();
        let host = host.trim_end_matches(['.', ':']);
        if let Some(site) = site_of(&format!("{scheme}{host}"))
            && !sites.contains(&site)
        {
            sites.push(site);
        }
    }
    sites
}

/// Whether a shell could read `command` as more than one plain command: a separator, a pipe, a substitution, a
/// redirect or another line.
fn compound(command: &str) -> bool {
    command.contains([';', '&', '|', '$', '`', '(', ')', '<', '>', '\n', '\r'])
}

/// Whether any word of `command` is one of the browser's [`OPENS`].
fn names_an_open(command: &str) -> bool {
    command
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
        .any(|w| OPENS.contains(&w))
}

/// What a prompt for `tool` with `input` visits; none when it isn't a fetch or a browser visit. Every other shell
/// command runs unasked, so an agent-browser open anywhere in a command the gate can't read whole (after `cd x &&`,
/// through `npx`, in a loop) is a visit asked each time.
pub fn visit(tool: &str, input: &Value) -> Option<Visit> {
    let url = match tool {
        "WebFetch" => input.get("url").and_then(Value::as_str).unwrap_or_default(),
        "Bash" => {
            let command = input.get("command").and_then(Value::as_str)?.trim();
            if !command.contains("agent-browser") {
                return None;
            }
            let mut words = command.split(' ').filter(|w| !w.is_empty());
            if words.next() != Some("agent-browser") {
                return names_an_open(command).then_some(Visit::Unknown);
            }
            let all: Vec<&str> = words.collect();
            // A flag beyond --json changes which browser runs or how; its value may stand where the verb would.
            let flagged = all
                .iter()
                .filter(|w| w.starts_with('-'))
                .any(|w| !VISIT_FLAGS.contains(&w.split_once('=').map_or(*w, |(name, _)| name)));
            if flagged && all.iter().any(|w| OPENS.contains(w)) {
                return Some(Visit::Unknown);
            }
            let mut words = all.iter().copied().filter(|w| !w.starts_with('-'));
            if !words.next().is_some_and(|verb| OPENS.contains(&verb)) {
                // Another browser command (a click, a snapshot), unless a second command after it opens a site.
                return (compound(command) && names_an_open(command)).then_some(Visit::Unknown);
            }
            // One plain URL, or one whole single-quoted literal (inside which a shell expands nothing, so a pasted
            // link's `?` and `&` go as they are), and nothing else. Anything a shell could read as more than literal
            // words (braces, globs, `~`, double quotes, a substitution, a separator, a tab, a backslash, a second
            // command) is no visit the gate can name.
            let literal = |c: char| c.is_ascii_alphanumeric() || PLAIN_CHARS.contains(&c);
            let url = words.next().unwrap_or_default();
            let quoted = url
                .strip_prefix('\'')
                .and_then(|u| u.strip_suffix('\''))
                .filter(|u| !u.contains('\''));
            let before = command.strip_suffix(url).unwrap_or(command);
            if words.next().is_some()
                || !before.chars().all(|c| c == ' ' || literal(c))
                || (quoted.is_none() && !url.chars().all(literal))
            {
                return Some(Visit::Unknown);
            }
            let url = quoted.unwrap_or(url);
            if !plain(url) {
                return Some(Visit::Unknown);
            }
            url
        }
        _ => return None,
    };
    Some(site_of(url).map_or(Visit::Unknown, Visit::Site))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_fetch_or_an_open_visits_its_host() {
        let fetch = |url: &str| visit("WebFetch", &json!({ "url": url, "prompt": "x" }));
        let site = |s: &str| Some(Visit::Site(s.to_owned()));
        assert_eq!(fetch("https://www.Example.com/a?b=c"), site("example.com"));
        assert_eq!(
            fetch("http://mail.example.com:8080/"),
            site("mail.example.com")
        );
        assert_eq!(fetch("file:///etc/passwd"), Some(Visit::Unknown));
        assert_eq!(
            fetch("https://en.example/wiki/A_(b)?x=1&y=2;z"),
            site("en.example")
        );
        let bash = |c: &str| visit("Bash", &json!({ "command": c }));
        assert_eq!(
            bash("agent-browser open https://dentist.example/book"),
            site("dentist.example")
        );
        assert_eq!(
            bash("agent-browser --json goto https://x.example"),
            site("x.example")
        );
        assert_eq!(bash("agent-browser open example.org"), site("example.org"));
        assert_eq!(
            bash("agent-browser open https://a.example && curl https://b.example"),
            Some(Visit::Unknown)
        );
        assert_eq!(
            bash("agent-browser open https://a.example $(cat x)"),
            Some(Visit::Unknown)
        );
        // A host the shell or the browser would read another way: asked each time, never remembered.
        for tricky in [
            "agent-browser open https://allowed.example\\@evil.example",
            "agent-browser open http:\\\\evil.example",
            "agent-browser open https://allowed.example%40evil.example",
            "agent-browser open https://user@allowed.example",
            "agent-browser open https://allowed.example\tevil.example",
            "agent-browser open \"https://allowed.example\"evil.example",
            "agent-browser open javascript:alert(1)",
            "agent-browser open ftp://allowed.example",
        ] {
            assert_eq!(bash(tricky), Some(Visit::Unknown), "{tricky}");
        }
        assert_eq!(
            fetch("https://allowed.example\\@evil.example"),
            Some(Visit::Unknown)
        );
        // An IDN host is the punycode host the browser asks DNS for; in a command it isn't plain, so it asks.
        assert_eq!(
            fetch("https://bücher.example/"),
            site("xn--bcher-kva.example")
        );
        assert_eq!(
            bash("agent-browser open https://bücher.example/"),
            Some(Visit::Unknown)
        );
        assert_eq!(
            fetch("https://xn--bcher-kva.example/"),
            site("xn--bcher-kva.example")
        );
        // A shell's expansions, quotes or a query: a visit asked each time, never remembered.
        for expands in [
            "agent-browser open https://allowed.example/{x,--cdp=9222}",
            "agent-browser open https://allowed.example/*",
            "agent-browser open https://allowed.example/[ab]",
            "agent-browser open https://allowed.example/~x",
            "agent-browser open \"https://allowed.example\"",
            "agent-browser open https://allowed.example/`id`",
            "agent-browser open https://allowed.example/search?q=a",
        ] {
            assert_eq!(bash(expands), Some(Visit::Unknown), "{expands}");
        }
        // A flag that changes the browser: a visit asked each time, never remembered, wherever the flag stands.
        for flagged in [
            "agent-browser --action-policy=./p.json --cdp=9222 open https://allowed.example",
            "agent-browser open https://allowed.example --session other",
            "agent-browser --config ./c.json goto https://allowed.example",
            "agent-browser open https://allowed.example --headers '{}'",
        ] {
            assert_eq!(bash(flagged), Some(Visit::Unknown), "{flagged}");
        }
        // Only http and https name a site; every other scheme asks each time.
        for url in [
            "file:/etc/passwd",
            "file:///etc/passwd",
            "data:text/html,hi",
            "javascript:alert(1)",
            "about:blank",
            "chrome://settings",
            "view-source:https://allowed.example",
        ] {
            assert_eq!(fetch(url), Some(Visit::Unknown), "{url}");
        }
        // A loopback host is a site per port: each port is another program.
        assert_eq!(fetch("http://localhost:3000/app"), site("localhost:3000"));
        assert_eq!(
            bash("agent-browser open localhost:5173"),
            site("localhost:5173")
        );
        assert_eq!(fetch("http://127.0.0.1:8080/"), site("127.0.0.1:8080"));
        assert_eq!(fetch("http://localhost/"), site("localhost:80"));
        assert_eq!(fetch("https://example.org:8443/a"), site("example.org"));
        // `read` fetches a URL as `open` does.
        assert_eq!(
            bash("agent-browser read https://dentist.example/a"),
            site("dentist.example")
        );
        // One whole single-quoted URL goes as it is: a pasted link's query names its site.
        assert_eq!(
            bash("agent-browser open 'https://allowed.example'"),
            site("allowed.example")
        );
        assert_eq!(
            bash("agent-browser open 'https://docs.example/d/1/edit?usp=sharing&a=b#h'"),
            site("docs.example")
        );
        for quoted in [
            "agent-browser open 'https://allowed.example'evil.example",
            "agent-browser open 'https://allowed.example' 'x'",
            "agent-browser open 'https://a.example\\@evil.example'",
            "agent-browser open 'https://a.example/a b'",
            "agent-browser open ''https://a.example''",
            "agent-browser open 'https://a.example",
            "agent-browser open 'https://a.example' --json",
        ] {
            assert_eq!(bash(quoted), Some(Visit::Unknown), "{quoted}");
        }
        // An open further into a command, or after another browser command, is a visit asked each time.
        for buried in [
            "cd notes && agent-browser open https://a.example",
            "npx agent-browser open https://a.example",
            "agent-browser click @e3 && agent-browser open https://a.example",
            "agent-browser click @e3; agent-browser goto https://a.example",
            "agent-browser fill @e2 \"$(agent-browser navigate https://a.example)\"",
            "agent-browser snapshot\nagent-browser read https://a.example",
        ] {
            assert_eq!(bash(buried), Some(Visit::Unknown), "{buried}");
        }
        // Not a visit: any other command runs unasked.
        for runs in [
            "agent-browser click @e3",
            "agent-browser fill @e2 'open the door'",
            "agent-browser eval 'document.title'",
            "agent-browser --session other snapshot",
            "curl https://a.example",
            "npx -y xaq-cli connect https://a.example --setup-mcp",
            "cat notes/open.md | grep read",
        ] {
            assert_eq!(bash(runs), None, "{runs}");
        }
        assert_eq!(visit("Read", &json!({ "file_path": "/x" })), None);
    }

    #[test]
    fn a_persons_links_name_their_sites() {
        assert_eq!(
            pasted(
                "Read https://macbook.example.ts.net/skill.md and follow it, then (https://www.Docs.example/a?b=c), \
                 [x](http://localhost:3000/app) and https://docs.example."
            ),
            ["macbook.example.ts.net", "docs.example", "localhost:3000"]
        );
        // A link with a user, another scheme, or no scheme names no site.
        assert!(
            pasted(
                "https://user@evil.example ftp://a.example example.org file:///etc/passwd http:// https://"
            )
            .is_empty()
        );
        // The host ends where a plain URL's characters do.
        assert_eq!(
            pasted("<https://a.example>, \"https://b.example\""),
            ["a.example", "b.example"]
        );
        assert_eq!(pasted("HTTPS://A.example/x"), ["a.example"]);
    }
}
