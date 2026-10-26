//! Test connection (`mcp_test`): the node starts or reaches an MCP server as an agent's claude would, initializes it
//! and lists its tools, within [`TIMEOUT`]. A stdio server runs in the given directory with the agent's environment
//! plus its own env, and is killed afterwards; an HTTP server is called with its headers; an SSE server (MCP's older
//! HTTP transport) is read from its event stream. What goes wrong comes back as one line a person can act on, with a
//! command's stderr tail, every one of the server's secrets masked.
use std::path::Path;
use std::time::Duration;

use fleetd_contracts::mcp_servers::{McpTestResult, McpToolInfo, McpTransport};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use super::mcp_servers::Resolved;
use crate::cli::mcp_client::{self, McpClient, PROTOCOL_VERSION};

/// The whole test: start, initialize, list.
pub const TIMEOUT: Duration = Duration::from_secs(30);

/// The end of a command's stderr kept for an error.
const STDERR_TAIL: usize = 2000;

const CLIENT: &str = "fleetd-mcp-test";

pub async fn probe(server: &Resolved, cwd: &Path, env: &[(String, String)]) -> McpTestResult {
    let outcome = tokio::time::timeout(TIMEOUT, async {
        match &server.transport {
            McpTransport::Stdio { command, args } => {
                let args: Vec<&str> = args.iter().map(|a| a.as_str()).collect();
                stdio(command.as_str(), &args, cwd, env, &server.values).await
            }
            McpTransport::Http { url } => http(url.as_str(), &server.values).await,
            McpTransport::Sse { url } => sse(url.as_str(), &server.values).await,
        }
    })
    .await
    .unwrap_or_else(|_| {
        Err(format!(
            "no answer within {} s: the server didn't finish starting or listing its tools",
            TIMEOUT.as_secs()
        ))
    });
    let masker = super::mask::Masker::new(&server.secrets);
    match outcome {
        Ok((info, tools)) => McpTestResult {
            server: info,
            tools: tools.iter().filter_map(tool_info).collect(),
            error: None,
        },
        Err(error) => McpTestResult {
            error: Some(masker.text(&error).into_owned()),
            ..Default::default()
        },
    }
}

fn tool_info(tool: &Value) -> Option<McpToolInfo> {
    Some(McpToolInfo {
        name: tool.get("name")?.as_str()?.to_owned(),
        description: tool.get("description").and_then(Value::as_str).map(|d| {
            d.lines()
                .next()
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect()
        }),
    })
}

fn initialize(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "initialize", "params": {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": CLIENT, "version": env!("CARGO_PKG_VERSION") },
    }})
}

fn initialized() -> Value {
    json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
}

fn list(id: u64, cursor: Option<&str>) -> Value {
    let params = match cursor {
        Some(c) => json!({ "cursor": c }),
        None => json!({}),
    };
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list", "params": params })
}

/// A stdio server's process group, killed when dropped.
struct Group(u32);

impl Drop for Group {
    fn drop(&mut self) {
        if let Ok(pid) = i32::try_from(self.0) {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
    }
}

/// One exchange with a server: send a message, and for a request read up to its response.
trait Exchange {
    async fn send(&mut self, message: &Value) -> Result<(), String>;
    async fn response(&mut self, id: u64) -> Result<Value, String>;
}

/// initialize, initialized, then every page of tools/list.
async fn session(x: &mut impl Exchange) -> Result<(Option<String>, Vec<Value>), String> {
    x.send(&initialize(0)).await?;
    let init = mcp_client::result_of(x.response(0).await?).map_err(|e| e.message())?;
    x.send(&initialized()).await?;
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    for id in 1..=20 {
        x.send(&list(id, cursor.as_deref())).await?;
        let page = mcp_client::result_of(x.response(id).await?).map_err(|e| e.message())?;
        tools.extend(
            page.get("tools")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    Ok((mcp_client::server_info(&init), tools))
}

fn matches(value: &Value, id: u64) -> bool {
    value.get("id").and_then(Value::as_u64) == Some(id)
        && (value.get("result").is_some() || value.get("error").is_some())
}

struct Stdio {
    stdin: tokio::process::ChildStdin,
    stdout: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    /// Its output ended: it is exiting, so its status is worth waiting for.
    ended: bool,
}

impl Exchange for Stdio {
    async fn send(&mut self, message: &Value) -> Result<(), String> {
        let line = format!("{message}\n");
        // Its input closes when it exits, possibly before it read a thing.
        if self.stdin.write_all(line.as_bytes()).await.is_err() {
            self.ended = true;
            return Err("the server exited before it answered".into());
        }
        Ok(())
    }

    async fn response(&mut self, id: u64) -> Result<Value, String> {
        loop {
            let Some(line) = self
                .stdout
                .next_line()
                .await
                .map_err(|e| format!("its output can't be read: {e}"))?
            else {
                self.ended = true;
                return Err("the server exited before it answered".into());
            };
            // A server may print other things, and asks of its own; only the response counts.
            if let Ok(value) = serde_json::from_str::<Value>(line.trim())
                && matches(&value, id)
            {
                return Ok(value);
            }
        }
    }
}

async fn stdio(
    command: &str,
    args: &[&str],
    cwd: &Path,
    env: &[(String, String)],
    values: &[(String, String)],
) -> Result<(Option<String>, Vec<Value>), String> {
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .envs(values.iter().map(|(k, v)| (k, v)))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "{command} was not found on this machine's PATH (or {} doesn't exist)",
                cwd.display()
            )
        } else {
            format!("{command} could not start: {e}")
        }
    })?;
    // Its whole process group goes when the test ends, by any path (the timeout drops this future): a launcher such
    // as `npx` or `uvx` runs the real server as its own child, which killing the launcher alone would leave behind.
    let group = child.id().map(Group);
    let mut stderr = child.stderr.take().expect("piped");
    let tail = tokio::spawn(async move {
        let mut all = Vec::new();
        let mut buf = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
            all.extend_from_slice(&buf[..n]);
            if all.len() > 4 * STDERR_TAIL {
                all.drain(..all.len() - STDERR_TAIL);
            }
        }
        all
    });
    let mut x = Stdio {
        stdin: child.stdin.take().expect("piped"),
        stdout: BufReader::new(child.stdout.take().expect("piped")).lines(),
        ended: false,
    };
    let outcome = session(&mut x).await;
    let ended = x.ended;
    drop(x);
    let status = if ended {
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        None
    };
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    // Its children too, before reading the rest of its stderr, which they may hold open.
    drop(group);
    match outcome {
        Ok(found) => Ok(found),
        Err(error) => {
            let text = tokio::time::timeout(Duration::from_secs(2), tail)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
            let text = String::from_utf8_lossy(&text);
            let text = text.trim();
            let tail: String = {
                let start = text.len().saturating_sub(STDERR_TAIL);
                let start = (start..=text.len())
                    .find(|i| text.is_char_boundary(*i))
                    .unwrap_or(text.len());
                text[start..].to_owned()
            };
            let exited = status
                .filter(|s| !s.success() && s.code().is_some())
                .map(|s| format!(" (exit {})", s.code().unwrap_or_default()))
                .unwrap_or_default();
            Err(if tail.is_empty() {
                format!("{error}{exited}")
            } else {
                format!("{error}{exited}: {tail}")
            })
        }
    }
}

async fn http(
    url: &str,
    headers: &[(String, String)],
) -> Result<(Option<String>, Vec<Value>), String> {
    let mut client = McpClient::connect_to(url.to_owned(), None, headers.to_vec(), CLIENT, TIMEOUT)
        .await
        .map_err(client_error)?;
    let tools = client.list_tools(TIMEOUT).await.map_err(client_error)?;
    Ok((client.server.clone(), tools))
}

fn client_error(error: mcp_client::McpError) -> String {
    match error {
        mcp_client::McpError::Unauthorized => {
            "the server refused its credentials (HTTP 401): check its headers".into()
        }
        mcp_client::McpError::Other(message) => http_error(message),
    }
}

fn http_error(message: String) -> String {
    if message.contains("401") {
        format!("{message}: the server refused its credentials; check its headers")
    } else {
        message
    }
}

/// MCP's older HTTP transport: a GET opens the event stream, whose first `endpoint` event names where to POST; every
/// answer comes back on the stream as a `message` event.
struct Sse {
    http: reqwest::Client,
    headers: Vec<(String, String)>,
    endpoint: Option<String>,
    base: url::Url,
    response: reqwest::Response,
    buffer: String,
}

impl Sse {
    /// The next event, `(event, data)`.
    async fn event(&mut self) -> Result<(String, String), String> {
        loop {
            if let Some(end) = self.buffer.find("\n\n") {
                let block: String = self.buffer.drain(..end + 2).collect();
                let (mut event, mut data) = ("message".to_owned(), String::new());
                for line in block.lines() {
                    if let Some(v) = line.strip_prefix("event:") {
                        event = v.trim().to_owned();
                    } else if let Some(v) = line.strip_prefix("data:") {
                        if !data.is_empty() {
                            data.push('\n');
                        }
                        data.push_str(v.strip_prefix(' ').unwrap_or(v));
                    }
                }
                if !data.is_empty() {
                    return Ok((event, data));
                }
                continue;
            }
            let chunk = self
                .response
                .chunk()
                .await
                .map_err(|e| mcp_client::describe(&e))?;
            let Some(chunk) = chunk else {
                return Err("the server closed its event stream".into());
            };
            self.buffer
                .push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
        }
    }
}

impl Exchange for Sse {
    async fn send(&mut self, message: &Value) -> Result<(), String> {
        if self.endpoint.is_none() {
            loop {
                let (event, data) = self.event().await?;
                if event == "endpoint" {
                    let at = self
                        .base
                        .join(data.trim())
                        .map_err(|_| format!("the server named a bad endpoint: {data}"))?;
                    // Its headers (secrets among them) go to the server's own origin only, as the MCP SDK has it.
                    if at.origin() != self.base.origin() {
                        return Err(format!(
                            "the server named an endpoint on another origin ({}): fleetd sends its headers only to {}",
                            at.origin().ascii_serialization(),
                            self.base.origin().ascii_serialization()
                        ));
                    }
                    self.endpoint = Some(at.to_string());
                    break;
                }
            }
        }
        let mut request = self
            .http
            .post(self.endpoint.as_deref().unwrap_or_default())
            .timeout(TIMEOUT)
            .header("content-type", "application/json")
            .body(message.to_string());
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|e| mcp_client::describe(&e))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(http_error(format!(
                "Error POSTing to endpoint (HTTP {}): {}",
                status.as_u16(),
                body.trim()
            )));
        }
        Ok(())
    }

    async fn response(&mut self, id: u64) -> Result<Value, String> {
        loop {
            let (event, data) = self.event().await?;
            if event != "message" {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(&data)
                && matches(&value, id)
            {
                return Ok(value);
            }
        }
    }
}

async fn sse(
    url: &str,
    headers: &[(String, String)],
) -> Result<(Option<String>, Vec<Value>), String> {
    let base = url::Url::parse(url).map_err(|_| format!("{url} is not a URL"))?;
    let http = reqwest::Client::builder()
        .user_agent(format!("{CLIENT}/{}", env!("CARGO_PKG_VERSION")))
        .redirect(mcp_client::same_origin_redirects())
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = http.get(url).header("accept", "text/event-stream");
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request.send().await.map_err(|e| mcp_client::describe(&e))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(http_error(format!(
            "Error opening the event stream (HTTP {}): {}",
            status.as_u16(),
            body.trim()
        )));
    }
    let mut x = Sse {
        http,
        headers: headers.to_vec(),
        endpoint: None,
        base,
        response,
        buffer: String::new(),
    };
    session(&mut x).await
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::mcp_servers::{McpArg, McpUrl};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;

    use super::*;

    const TOKEN: &str = "s3cret-token-value";

    fn answer(id: u64, method: &str) -> Value {
        match method {
            "initialize" => json!({ "jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": PROTOCOL_VERSION, "capabilities": { "tools": {} },
                "serverInfo": { "name": "fake-mcp", "version": "1.2.0" } } }),
            _ => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [
                { "name": "search", "description": "Searches the docs.\nMore lines.", "inputSchema": {} },
                { "name": "fetch", "inputSchema": {} } ] } }),
        }
    }

    fn found(result: &McpTestResult) {
        assert_eq!(result.error, None);
        assert_eq!(result.server.as_deref(), Some("fake-mcp 1.2.0"));
        assert_eq!(
            result.tools,
            [
                McpToolInfo {
                    name: "search".into(),
                    description: Some("Searches the docs.".into())
                },
                McpToolInfo {
                    name: "fetch".into(),
                    description: None
                },
            ]
        );
    }

    fn resolved(transport: McpTransport, values: &[(&str, &str)]) -> Resolved {
        Resolved {
            name: "fake".into(),
            transport,
            values: values
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            secrets: vec![("fake.TOKEN".into(), TOKEN.into())],
        }
    }

    /// A stdio server as a shell script: answers initialize and tools/list once its TOKEN is right, else says why on
    /// stderr, printing the token, and exits.
    fn script(dir: &Path) -> McpTransport {
        let init = answer(0, "initialize");
        let list = answer(1, "tools/list");
        let path = dir.join("fake-mcp");
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\nif [ \"$TOKEN\" != \"{TOKEN}\" ]; then echo \"bad token: $TOKEN, want {TOKEN}\" >&2; exit 2; fi\n\
                 echo 'starting' >&2\nread l\necho 'not json'\nprintf '%s\\n' '{init}'\nread l\nread l\nprintf '%s\\n' '{list}'\nread l\n"
            ),
        )
        .unwrap();
        // Run through sh, not exec'd: a file just written can't be exec'd while another test's fork holds it open
        // for writing (ETXTBSY).
        McpTransport::Stdio {
            command: McpArg::new("sh").unwrap(),
            args: vec![McpArg::new(path.to_string_lossy()).unwrap()],
        }
    }

    fn env() -> Vec<(String, String)> {
        vec![(
            "PATH".into(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
        )]
    }

    #[tokio::test]
    async fn a_working_stdio_server_lists_its_tools() {
        let dir = tempfile::tempdir().unwrap();
        let server = resolved(script(dir.path()), &[("TOKEN", TOKEN)]);
        found(&probe(&server, dir.path(), &env()).await);
    }

    #[tokio::test]
    async fn a_failing_stdio_server_says_why_with_its_stderr_and_no_secret() {
        let dir = tempfile::tempdir().unwrap();
        let server = resolved(script(dir.path()), &[("TOKEN", "wrong")]);
        let result = probe(&server, dir.path(), &env()).await;
        let error = result.error.unwrap();
        assert!(error.contains("exited before it answered"), "{error}");
        assert!(error.contains("(exit 2)"), "{error}");
        assert!(error.contains("bad token: wrong"), "{error}");
        assert!(
            error.contains("***fake.TOKEN***") && !error.contains(TOKEN),
            "{error}"
        );
        assert!(result.tools.is_empty());

        let missing = resolved(
            McpTransport::Stdio {
                command: McpArg::new("no-such-mcp-server").unwrap(),
                args: vec![],
            },
            &[],
        );
        let error = probe(&missing, dir.path(), &env()).await.error.unwrap();
        assert!(
            error.contains("no-such-mcp-server was not found"),
            "{error}"
        );
    }

    /// One HTTP request off a connection: its request line, headers and body.
    async fn request(stream: &mut tokio::net::TcpStream) -> Option<(String, String, Value)> {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        while !buf.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).await.ok()? == 0 {
                return None;
            }
            buf.push(byte[0]);
        }
        let head = String::from_utf8_lossy(&buf).into_owned();
        let len = head
            .lines()
            .find_map(|l| {
                l.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|v| v.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        let mut body = vec![0u8; len];
        stream.read_exact(&mut body).await.ok()?;
        let line = head.lines().next().unwrap_or_default().to_owned();
        Some((
            line,
            head,
            serde_json::from_slice(&body).unwrap_or(Value::Null),
        ))
    }

    async fn respond(stream: &mut tokio::net::TcpStream, status: &str, kind: &str, body: &str) {
        let text = format!(
            "HTTP/1.1 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(text.as_bytes()).await.unwrap();
    }

    /// A streamable HTTP server that wants `authorization: Bearer <TOKEN>`, answering tools/list as SSE.
    async fn http_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let Some((_, head, body)) = request(&mut stream).await else {
                        return;
                    };
                    if !head
                        .to_ascii_lowercase()
                        .contains(&format!("authorization: bearer {TOKEN}"))
                    {
                        return respond(&mut stream, "401 Unauthorized", "text/plain", "bad token")
                            .await;
                    }
                    let method = body["method"].as_str().unwrap_or_default();
                    match body["id"].as_u64() {
                        None => respond(&mut stream, "202 Accepted", "text/plain", "").await,
                        Some(id) if method == "tools/list" => {
                            let event = format!("event: message\ndata: {}\n\n", answer(id, method));
                            respond(&mut stream, "200 OK", "text/event-stream", &event).await
                        }
                        Some(id) => {
                            respond(
                                &mut stream,
                                "200 OK",
                                "application/json",
                                &answer(id, method).to_string(),
                            )
                            .await
                        }
                    }
                });
            }
        });
        url
    }

    #[tokio::test]
    async fn an_http_server_lists_its_tools_and_one_that_refuses_says_so() {
        let url = McpUrl::new(http_server().await).unwrap();
        let ok = resolved(
            McpTransport::Http { url: url.clone() },
            &[("Authorization", &format!("Bearer {TOKEN}"))],
        );
        found(&probe(&ok, Path::new("/"), &[]).await);

        let refused = resolved(
            McpTransport::Http { url },
            &[("Authorization", "Bearer nope")],
        );
        let error = probe(&refused, Path::new("/"), &[]).await.error.unwrap();
        assert!(
            error.contains("HTTP 401") && error.contains("check its headers"),
            "{error}"
        );

        let down = resolved(
            McpTransport::Http {
                url: McpUrl::new("http://127.0.0.1:9/mcp").unwrap(),
            },
            &[],
        );
        assert!(probe(&down, Path::new("/"), &[]).await.error.is_some());
    }

    /// A listener that counts the connections it gets: where a header must never go.
    async fn elsewhere() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                respond(&mut stream, "202 Accepted", "text/plain", "").await;
            }
        });
        (url, hits)
    }

    #[tokio::test]
    async fn an_sse_endpoint_on_another_origin_gets_no_header() {
        let (other, hits) = elsewhere().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/sse", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let other = other.clone();
                tokio::spawn(async move {
                    if request(&mut stream).await.is_none() {
                        return;
                    }
                    let head = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\nevent: endpoint\r\ndata: {other}/steal\r\n\r\n"
                    );
                    stream.write_all(head.as_bytes()).await.unwrap();
                    tokio::time::sleep(Duration::from_secs(5)).await;
                });
            }
        });
        let server = resolved(
            McpTransport::Sse {
                url: McpUrl::new(url).unwrap(),
            },
            &[("Authorization", &format!("Bearer {TOKEN}"))],
        );
        let error = probe(&server, Path::new("/"), &[]).await.error.unwrap();
        assert!(error.contains("another origin"), "{error}");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_redirect_to_another_origin_is_not_followed() {
        let (other, hits) = elsewhere().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                if request(&mut stream).await.is_none() {
                    continue;
                }
                let moved = format!(
                    "HTTP/1.1 307 Temporary Redirect\r\nlocation: {other}/mcp\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                );
                stream.write_all(moved.as_bytes()).await.unwrap();
            }
        });
        let server = resolved(
            McpTransport::Http {
                url: McpUrl::new(url).unwrap(),
            },
            &[("X-Api-Key", TOKEN)],
        );
        let error = probe(&server, Path::new("/"), &[]).await.error.unwrap();
        assert!(error.contains("307"), "{error}");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    /// A launcher (`npx`, `uvx`) runs the real server as its own child: the test kills both.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_launchers_server_goes_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("server.pid");
        let path = dir.path().join("launcher");
        std::fs::write(
            &path,
            format!(
                "sleep 300 &\necho $! > {}\nread l\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":0,\"error\":{{\"code\":-1,\"message\":\"nope\"}}}}'\nwait\n",
                pid_file.display()
            ),
        )
        .unwrap();
        let server = resolved(
            McpTransport::Stdio {
                command: McpArg::new("sh").unwrap(),
                args: vec![McpArg::new(path.to_string_lossy()).unwrap()],
            },
            &[],
        );
        let error = probe(&server, dir.path(), &env()).await.error.unwrap();
        assert!(error.contains("nope"), "{error}");
        let pid = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .to_owned();
        // Gone, or a zombie its new parent hasn't reaped yet.
        let gone = || match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => true,
            Ok(stat) => stat
                .rsplit_once(") ")
                .is_some_and(|(_, rest)| rest.starts_with('Z')),
        };
        for _ in 0..50 {
            if gone() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the launcher's server {pid} still runs");
    }

    #[tokio::test]
    async fn an_sse_server_lists_its_tools() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/sse", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let rx = std::sync::Arc::new(tokio::sync::Mutex::new(Some(rx)));
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let (tx, rx) = (tx.clone(), rx.clone());
                tokio::spawn(async move {
                    let Some((line, _, body)) = request(&mut stream).await else {
                        return;
                    };
                    if line.starts_with("GET") {
                        let Some(mut events) = rx.lock().await.take() else {
                            return;
                        };
                        let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n\
                                    event: endpoint\r\ndata: /messages?session=1\r\n\r\n";
                        stream.write_all(head.as_bytes()).await.unwrap();
                        while let Some(event) = events.recv().await {
                            stream.write_all(event.as_bytes()).await.unwrap();
                        }
                    } else {
                        assert!(line.starts_with("POST /messages?session=1"), "{line}");
                        if let Some(id) = body["id"].as_u64() {
                            let method = body["method"].as_str().unwrap_or_default();
                            let _ = tx
                                .send(format!("event: message\ndata: {}\n\n", answer(id, method)));
                        }
                        respond(&mut stream, "202 Accepted", "text/plain", "Accepted").await;
                    }
                });
            }
        });
        let server = resolved(
            McpTransport::Sse {
                url: McpUrl::new(url).unwrap(),
            },
            &[],
        );
        found(&probe(&server, Path::new("/"), &[]).await);
    }
}
