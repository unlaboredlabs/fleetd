//! A Navi's site gate: its lead's first fetch (`WebFetch`) or browser visit (`agent-browser open|goto|navigate <url>`)
//! to a site asks the person in its chat, and their approval allows the site from then on, until they revoke it
//! (`navi_sites`, `navi_site_revoke`). The relay (`approvals/permissions.rs`) asks here before anything else.
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
const OPENS: &[&str] = &["open", "goto", "navigate"];

/// The characters a remembered visit's command may hold besides letters, digits and spaces: none a shell reads as more
/// than a literal character. A URL with `?` or `&`, or anything quoted, is a visit asked each time.
const PLAIN_CHARS: &[char] = &['@', '.', '_', ':', '/', '=', '-', '%', '+', ','];

/// The only flag a remembered visit may carry. Any other (`--session`, `--cdp`, `--action-policy`, `--config`,
/// `--headers`, `--args`, `--profile`, …) changes which browser runs or how, so the visit is asked each time.
const VISIT_FLAGS: &[&str] = &["--json"];

/// The characters a URL the gate reads may hold: a plain URL's, so the shell passes it on unchanged and the browser
/// reads the host the gate read. No `\` (a browser reads it as `/`, a shell drops it), quote, whitespace, control or
/// shell character.
fn plain(url: &str) -> bool {
    !url.is_empty()
        && url
            .chars()
            .all(|c| c.is_alphanumeric() || "-._~:/?#[]@!*+,=%".contains(c))
}

/// The site `url` is on: its host as the URL library reads it (lower case, IDN as punycode), without a leading
/// `www.`; none for anything but a plain http or https URL with no user in it.
pub fn site_of(url: &str) -> Option<String> {
    if !plain(url) {
        return None;
    }
    let parsed = if url.contains("://") {
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
    (!host.is_empty()).then_some(host)
}

/// What a prompt for `tool` with `input` visits; none when it isn't a fetch or a browser visit.
pub fn visit(tool: &str, input: &Value) -> Option<Visit> {
    let url = match tool {
        "WebFetch" => input.get("url").and_then(Value::as_str).unwrap_or_default(),
        "Bash" => {
            let command = input.get("command").and_then(Value::as_str)?.trim();
            let mut words = command.split(' ').filter(|w| !w.is_empty());
            if words.next() != Some("agent-browser") {
                return None;
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
                return None;
            }
            // Anything a shell could read as more than literal words (braces, globs, `~`, quotes, a substitution, a
            // separator) is no visit to remember.
            if !command
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == ' ' || PLAIN_CHARS.contains(&c))
            {
                return Some(Visit::Unknown);
            }
            // One plain URL, maybe in one pair of quotes, and nothing else: anything a shell could read another way
            // (a tab, a backslash, a second command) is no visit the gate can name.
            let url = words.next().unwrap_or_default();
            let url = ['"', '\'']
                .iter()
                .find_map(|q| url.strip_prefix(*q).and_then(|u| u.strip_suffix(*q)))
                .unwrap_or(url);
            if words.next().is_some() || !plain(url) {
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
            "agent-browser open 'https://allowed.example'",
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
        // Not a visit: the relay's other rules decide.
        assert_eq!(bash("agent-browser click @e3"), None);
        assert_eq!(bash("curl https://a.example"), None);
        assert_eq!(visit("Read", &json!({ "file_path": "/x" })), None);
    }
}
