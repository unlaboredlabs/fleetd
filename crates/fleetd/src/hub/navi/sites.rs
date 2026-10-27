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

/// The site `url` is on: its host, lower case, without a leading `www.`; none for anything but http and https.
pub fn site_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url)
        .or_else(|_| url::Url::parse(&format!("https://{url}")))
        .ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
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
            let mut words = command.split_whitespace();
            if words.next() != Some("agent-browser") {
                return None;
            }
            let mut words = words.filter(|w| !w.starts_with('-'));
            if !words.next().is_some_and(|verb| OPENS.contains(&verb)) {
                return None;
            }
            // Anything a shell would read as more than one plain command is no single visit.
            if command.contains(['&', '|', ';', '\n', '`', '>', '<', '$', '(', ')']) {
                return Some(Visit::Unknown);
            }
            let url = words.next().unwrap_or_default().trim_matches(['"', '\'']);
            if words.next().is_some() {
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
            bash("agent-browser --json goto 'https://x.example'"),
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
        // Not a visit: the relay's other rules decide.
        assert_eq!(bash("agent-browser click @e3"), None);
        assert_eq!(bash("curl https://a.example"), None);
        assert_eq!(visit("Read", &json!({ "file_path": "/x" })), None);
    }
}
