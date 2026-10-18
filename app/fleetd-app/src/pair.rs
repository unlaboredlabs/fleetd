//! Pairing: trade a one-time code from `fleetd pair` for a human key with `POST <hub>/pair` (no auth header; the
//! code is the credential). Also finds a hub on this machine, reads the `app-pair.json` that `fleetd init` /
//! `fleetd pair` leave for the app, and parses `fleetd://pair?hub=…&code=…` links.
//!
//! A few hundred bytes of HTTP/1.1 over the same TCP/TLS stack as the hub socket ([`crate::client`]), so the app
//! needs no HTTP client crate.

use std::path::PathBuf;
use std::time::Duration;

use std::cell::RefCell;

use futures::channel::mpsc::{self, UnboundedReceiver};
use futures::{AsyncReadExt, AsyncWriteExt, FutureExt, select};
use serde::Deserialize;

use crate::client;

/// Where `fleetd init` puts the hub unless told otherwise.
pub const LOCAL_HUB: &str = "http://127.0.0.1:4790";
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE: usize = 64 * 1024;

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paired {
    pub key: String,
    pub hub_url: String,
    pub hub_name: String,
}

/// What went wrong and what to do about it, as the hub words it when it answered.
#[derive(Debug, PartialEq, Deserialize)]
pub struct Failure {
    #[serde(default)]
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub fix: Option<String>,
}

impl Failure {
    fn new(message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self { code: String::new(), message: message.into(), fix: Some(fix.into()) }
    }
}

/// A code as typed: spaces and hyphens dropped, upper case, `XXXX-XXXX`. None unless 8 letters/digits.
pub fn normalize_code(input: &str) -> Option<String> {
    let raw: String = input.chars().filter(|c| !c.is_whitespace() && *c != '-').map(|c| c.to_ascii_uppercase()).collect();
    (raw.len() == 8 && raw.chars().all(|c| c.is_ascii_alphanumeric())).then(|| format!("{}-{}", &raw[..4], &raw[4..]))
}

/// What names the new key on the hub: this computer's name.
pub fn device_name() -> String {
    let from_cmd = || {
        let out = std::process::Command::new("hostname").output().ok()?;
        String::from_utf8(out.stdout).ok()
    };
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .or_else(from_cmd)
        .map(|n| n.trim().trim_end_matches(".local").to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "desktop app".into())
}

pub async fn pair(hub: &str, code: &str, device_name: &str) -> Result<Paired, Failure> {
    let Some(code) = normalize_code(code) else {
        return Err(Failure::new(
            "A pairing code is 8 letters and digits, like ABCD-2345.",
            "Run `fleetd pair` on the hub and type the code it prints.",
        ));
    };
    let body = serde_json::json!({ "code": code, "deviceName": device_name }).to_string();
    let (status, body) = request(hub, "POST", "/pair", Some(&body)).await?;
    if status == 200 {
        return serde_json::from_slice(&body).map_err(|_| {
            Failure::new(format!("{hub} answered, but not like a fleetd hub."), "Check the address is your hub's, e.g. http://127.0.0.1:4790.")
        });
    }
    Err(serde_json::from_slice::<Failure>(&body).unwrap_or_else(|_| {
        Failure::new(
            format!("{hub} answered HTTP {status} to /pair."),
            "Check the address is your fleetd hub's, and that the hub is up to date (`fleetd update` on the hub).",
        )
    }))
}

/// Whether a fleetd hub answers at `hub` (its `/healthz`).
pub async fn hub_answers(hub: &str) -> bool {
    match request(hub, "GET", "/healthz", None).await {
        Ok((200, body)) => serde_json::from_slice::<serde_json::Value>(&body).is_ok_and(|v| v["ok"] == true),
        _ => false,
    }
}

/// `app-pair.json` from `fleetd init` / `fleetd pair` on this machine.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPair {
    pub hub: String,
    pub code: String,
    pub expires_at: String,
}

impl AppPair {
    pub fn expired(&self, now_secs: i64) -> bool {
        crate::notify::unix_secs(&self.expires_at).is_none_or(|at| at <= now_secs)
    }
}

/// `$XDG_CONFIG_HOME/fleetd/app-pair.json` (default `~/.config`); on macOS `~/Library/Application Support/fleetd/`.
/// Must match `app_pair_file` in crates/fleetd/src/cli/pair.rs.
pub fn app_pair_file() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from)?;
    let dir = if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".config"))
    };
    Some(dir.join("fleetd").join("app-pair.json"))
}

pub fn read_app_pair(text: &str) -> Option<AppPair> {
    serde_json::from_str::<AppPair>(text).ok().filter(|p| !p.hub.is_empty() && !p.code.is_empty())
}

/// `fleetd://` links handed to the app, held until the window is up to take them.
pub struct Links(pub RefCell<Option<UnboundedReceiver<String>>>);

impl gpui::Global for Links {}

/// macOS delivers links through the open-URLs callback (the scheme is registered in the bundle's Info.plist);
/// on Linux the `.desktop` file's `Exec=fleetd-app %u` passes them as arguments.
pub fn listen(app: &gpui::Application) -> Links {
    let (tx, rx) = mpsc::unbounded();
    for arg in std::env::args().skip(1).filter(|a| a.starts_with("fleetd://")) {
        tx.unbounded_send(arg).ok();
    }
    // Called from AppKit's open-URLs delegate method, which can't unwind.
    app.on_open_urls(move |urls| {
        crate::crash::guard("open url", || {
            for url in urls {
                tx.unbounded_send(url).ok();
            }
        })
    });
    Links(RefCell::new(Some(rx)))
}

/// `fleetd://pair?hub=<url-encoded>&code=<code>` → (hub, code).
pub fn parse_deep_link(link: &str) -> Option<(String, String)> {
    let rest = link.trim().strip_prefix("fleetd://")?;
    let (path, query) = rest.split_once('?')?;
    if path.trim_end_matches('/') != "pair" {
        return None;
    }
    let mut hub = None;
    let mut code = None;
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "hub" => hub = Some(v.into_owned()),
            "code" => code = Some(v.into_owned()),
            _ => {}
        }
    }
    Some((hub.filter(|h| !h.is_empty())?, code.filter(|c| !c.is_empty())?))
}

/// One HTTP/1.1 exchange with the hub; returns status and body.
async fn request(hub: &str, method: &str, path: &str, body: Option<&str>) -> Result<(u16, Vec<u8>), Failure> {
    let target = client::app_url(hub).map_err(|e| Failure::new(e, "Use the hub's address, e.g. http://127.0.0.1:4790."))?;
    let host = target.url.split_once("://").map_or("", |(_, r)| r.split('/').next().unwrap_or(""));
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: fleetd-app/{}\r\nConnection: close\r\n", crate::update::VERSION);
    if let Some(body) = body {
        head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    let exchange = async {
        let unreachable = |e: String| {
            Failure::new(
                format!("Can't reach {}: {e}", target.addr),
                "Check the hub is running (`fleetd doctor` on the hub) and this address is reachable from here.",
            )
        };
        let tcp = async_net::TcpStream::connect(target.addr.as_str()).await.map_err(|e| unreachable(e.to_string()))?;
        let mut stream: Box<dyn client::Io> = match &target.tls_name {
            None => Box::new(tcp),
            Some(name) => Box::new(client::tls_connect(name, tcp).await.map_err(|e| unreachable(format!("TLS failed: {e}")))?),
        };
        let io = |e: std::io::Error| unreachable(e.to_string());
        stream.write_all(head.as_bytes()).await.map_err(io)?;
        stream.write_all(body.unwrap_or("").as_bytes()).await.map_err(io)?;
        stream.flush().await.map_err(io)?;
        let mut raw = Vec::new();
        stream.take(MAX_RESPONSE as u64).read_to_end(&mut raw).await.map_err(io)?;
        parse_response(&raw).ok_or_else(|| Failure::new(format!("{hub} sent a reply that isn't HTTP."), "Check the address is your fleetd hub's."))
    };
    select! {
        result = exchange.fuse() => result,
        _ = FutureExt::fuse(async_io::Timer::after(TIMEOUT)) => Err(Failure::new(
            format!("{hub} didn't answer within {} s.", TIMEOUT.as_secs()),
            "Check the hub is running and reachable from this computer.",
        )),
    }
}

/// Status and body of a complete response read to EOF (`Connection: close`), chunked or not.
fn parse_response(raw: &[u8]) -> Option<(u16, Vec<u8>)> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let body = &raw[split + 4..];
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let mut chunked = false;
    let mut length = None;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        match name.trim().to_ascii_lowercase().as_str() {
            "transfer-encoding" => chunked = value.to_ascii_lowercase().contains("chunked"),
            "content-length" => length = value.trim().parse::<usize>().ok(),
            _ => {}
        }
    }
    if !chunked {
        return Some((status, body[..length.unwrap_or(body.len()).min(body.len())].to_vec()));
    }
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n")?;
        let size = usize::from_str_radix(std::str::from_utf8(&rest[..line_end]).ok()?.split(';').next()?.trim(), 16).ok()?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Some((status, out));
        }
        out.extend_from_slice(rest.get(..size)?);
        rest = rest.get(size + 2..)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A one-request hub on a free local port that answers with `response`; returns its URL and the request it saw.
    fn fake_hub(response: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0; 4096];
            // Read until the body announced by Content-Length is in.
            loop {
                let n = socket.read(&mut buf).unwrap();
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request);
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let len = head.lines().find_map(|l| l.strip_prefix("Content-Length: ")).map_or(0, |v| v.parse().unwrap());
                    if body.len() >= len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            socket.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (url, seen)
    }

    #[test]
    fn pairing_posts_the_normalized_code_and_returns_the_key() {
        let (url, seen) = fake_hub(concat!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 79\r\n\r\n",
            r#"{"key":"fld_abc","hubUrl":"http://100.64.0.1:4790","hubName":"forge"}          "#
        ));
        let paired = async_io::block_on(pair(&url, "abcd 2345", "mac")).unwrap();
        assert_eq!(paired, Paired { key: "fld_abc".into(), hub_url: "http://100.64.0.1:4790".into(), hub_name: "forge".into() });
        let request = seen.join().unwrap();
        assert!(request.starts_with("POST /pair HTTP/1.1\r\n"), "{request}");
        assert!(!request.to_ascii_lowercase().contains("authorization"));
        let body: serde_json::Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body, serde_json::json!({ "code": "ABCD-2345", "deviceName": "mac" }));
    }

    #[test]
    fn a_refused_code_carries_the_hubs_fix() {
        let (url, _) = fake_hub(concat!(
            "HTTP/1.1 401 Unauthorized\r\ntransfer-encoding: chunked\r\n\r\n",
            "20\r\n{\"code\":\"pair_code_expired\",\"mes\r\n",
            "43\r\nsage\":\"That code expired.\",\"fix\":\"Run `fleetd pair` on the hub.\"}  \r\n",
            "0\r\n\r\n"
        ));
        let failure = async_io::block_on(pair(&url, "ABCD-2345", "mac")).unwrap_err();
        assert_eq!(failure.code, "pair_code_expired");
        assert_eq!(failure.message, "That code expired.");
        assert_eq!(failure.fix.as_deref(), Some("Run `fleetd pair` on the hub."));
    }

    #[test]
    fn a_non_hub_answer_and_no_answer_both_say_what_to_check() {
        let (url, _) = fake_hub("HTTP/1.1 404 Not Found\r\ncontent-length: 9\r\n\r\nnot found");
        let failure = async_io::block_on(pair(&url, "ABCD-2345", "mac")).unwrap_err();
        assert!(failure.message.contains("HTTP 404"), "{failure:?}");
        assert!(failure.fix.is_some());
        // Nothing listens on a port we just released.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let failure = async_io::block_on(pair(&format!("http://127.0.0.1:{port}"), "ABCD-2345", "mac")).unwrap_err();
        assert!(failure.message.starts_with("Can't reach"), "{failure:?}");
        assert!(failure.fix.unwrap().contains("fleetd doctor"));
    }

    #[test]
    fn a_malformed_code_is_caught_before_sending() {
        let failure = async_io::block_on(pair("http://127.0.0.1:9", "ABC", "mac")).unwrap_err();
        assert!(failure.message.contains("8 letters"));
    }

    #[test]
    fn healthz_detects_a_hub() {
        let (url, seen) = fake_hub("HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n{\"ok\":true}");
        assert!(async_io::block_on(hub_answers(&url)));
        assert!(seen.join().unwrap().starts_with("GET /healthz HTTP/1.1\r\n"));
    }

    #[test]
    fn codes_normalize_case_spaces_and_hyphens() {
        assert_eq!(normalize_code(" abcd-2345 ").as_deref(), Some("ABCD-2345"));
        assert_eq!(normalize_code("ABCD2345").as_deref(), Some("ABCD-2345"));
        assert_eq!(normalize_code("AB-CD-23-45").as_deref(), Some("ABCD-2345"));
        assert_eq!(normalize_code("ABCD-234"), None);
        assert_eq!(normalize_code("ABCD-23!5"), None);
    }

    #[test]
    fn deep_links_parse_the_url_encoded_hub() {
        let link = "fleetd://pair?hub=http%3A%2F%2F100.64.0.1%3A4790&code=ABCD-2345";
        assert_eq!(parse_deep_link(link), Some(("http://100.64.0.1:4790".into(), "ABCD-2345".into())));
        assert_eq!(parse_deep_link("fleetd://pair/?code=X&hub=h"), Some(("h".into(), "X".into())));
        assert_eq!(parse_deep_link("fleetd://pair?hub=h"), None);
        assert_eq!(parse_deep_link("fleetd://other?hub=h&code=X"), None);
        assert_eq!(parse_deep_link("https://pair?hub=h&code=X"), None);
    }

    #[test]
    fn app_pair_file_is_read_and_expiry_checked() {
        let pair = read_app_pair(r#"{"hub":"http://127.0.0.1:4790","code":"ABCD-2345","expiresAt":"2026-10-18T10:15:00Z"}"#).unwrap();
        let at = crate::notify::unix_secs("2026-10-18T10:15:00Z").unwrap();
        assert!(!pair.expired(at - 1));
        assert!(pair.expired(at));
        assert_eq!(read_app_pair(r#"{"hub":"","code":"X","expiresAt":"2026-10-18T10:15:00Z"}"#), None);
        assert_eq!(read_app_pair("not json"), None);
    }
}
