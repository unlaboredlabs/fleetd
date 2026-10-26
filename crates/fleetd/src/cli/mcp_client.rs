//! The little of an MCP Streamable HTTP client the CLI needs: initialize once, then call tools. The node's connection
//! test (node/mcp_probe.rs) uses it too, against any server, with that server's headers and no key.
//! Answers may come as JSON or as an SSE stream; both are read to the matching response.

use std::time::Duration;

use serde_json::{Value, json};

pub const PROTOCOL_VERSION: &str = "2025-06-18";

pub enum McpError {
    /// HTTP 401: the hub refused the key.
    Unauthorized,
    Other(String),
}

impl McpError {
    pub fn message(&self) -> String {
        match self {
            McpError::Unauthorized => "the hub refused the key (401)".into(),
            McpError::Other(message) => message.clone(),
        }
    }
}

/// A tool's answer: its first text content as JSON, and whether it is an error result.
pub struct ToolResult {
    pub is_error: bool,
    pub body: Value,
}

pub struct McpClient {
    http: reqwest::Client,
    url: String,
    /// The hub's bearer key; none for another server, whose own headers say who calls.
    key: Option<String>,
    headers: Vec<(String, String)>,
    session: Option<String>,
    /// The server's `serverInfo`: `name version`.
    pub server: Option<String>,
    protocol: String,
    next_id: u64,
}

/// `new URL("mcp", hub + "/")`.
pub fn endpoint(hub: &str) -> String {
    if hub.ends_with('/') {
        format!("{hub}mcp")
    } else {
        format!("{hub}/mcp")
    }
}

impl McpClient {
    pub async fn connect(
        hub: &str,
        key: &str,
        name: &str,
        timeout: Duration,
    ) -> Result<Self, McpError> {
        Self::connect_to(
            endpoint(hub),
            Some(key.to_owned()),
            Vec::new(),
            name,
            timeout,
        )
        .await
    }

    /// Any streamable HTTP server at `url`, `headers` on every request.
    pub async fn connect_to(
        url: String,
        key: Option<String>,
        headers: Vec<(String, String)>,
        name: &str,
        timeout: Duration,
    ) -> Result<Self, McpError> {
        let http = reqwest::Client::builder()
            .user_agent(format!("{name}/{}", env!("CARGO_PKG_VERSION")))
            .redirect(same_origin_redirects())
            .build()
            .map_err(|error| McpError::Other(error.to_string()))?;
        let mut client = McpClient {
            http,
            url,
            key,
            headers,
            session: None,
            server: None,
            protocol: PROTOCOL_VERSION.into(),
            next_id: 0,
        };
        let init = client
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": name, "version": env!("CARGO_PKG_VERSION") },
                }),
                timeout,
            )
            .await?;
        if let Some(version) = init.get("protocolVersion").and_then(Value::as_str) {
            client.protocol = version.to_owned();
        }
        client.server = server_info(&init);
        client
            .post(
                &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
                timeout,
            )
            .await?;
        Ok(client)
    }

    pub async fn call_tool(
        &mut self,
        name: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Result<ToolResult, McpError> {
        let result = self
            .request(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
                timeout,
            )
            .await?;
        let text = result
            .get("content")
            .and_then(Value::as_array)
            .and_then(|content| content.first())
            .and_then(|item| item.get("text"))
            .and_then(Value::as_str)
            .ok_or_else(|| McpError::Other(format!("{name} answered without text content")))?;
        let body = serde_json::from_str(text).map_err(|error| {
            McpError::Other(format!("{name} answered with invalid JSON: {error}"))
        })?;
        Ok(ToolResult {
            is_error: result.get("isError") == Some(&Value::Bool(true)),
            body,
        })
    }

    /// `tools/list`, every page: each tool's object as the server sent it.
    pub async fn list_tools(&mut self, timeout: Duration) -> Result<Vec<Value>, McpError> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..TOOL_PAGES {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let page = self.request("tools/list", params, timeout).await?;
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
        Ok(tools)
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, McpError> {
        let id = self.next_id;
        self.next_id += 1;
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let response = self
            .post(&message, timeout)
            .await?
            .ok_or_else(|| McpError::Other(format!("no answer to {method}")))?;
        let reply = find_response(&response, id)
            .ok_or_else(|| McpError::Other(format!("no answer to {method}")))?;
        result_of(reply)
    }

    /// The raw body of the answer, or `None` for 202 Accepted.
    async fn post(
        &mut self,
        message: &Value,
        timeout: Duration,
    ) -> Result<Option<String>, McpError> {
        let mut request = self.http.post(&self.url).timeout(timeout);
        if let Some(key) = &self.key {
            request = request.bearer_auth(key);
        }
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }
        let mut request = request
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .header("mcp-protocol-version", &self.protocol)
            .body(message.to_string());
        if let Some(session) = &self.session {
            request = request.header("mcp-session-id", session);
        }
        let response = request
            .send()
            .await
            .map_err(|error| McpError::Other(describe(&error)))?;
        let status = response.status();
        if status.as_u16() == 401 {
            return Err(McpError::Unauthorized);
        }
        if let Some(session) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            self.session = Some(session.to_owned());
        }
        if status.as_u16() == 202 {
            return Ok(None);
        }
        let body = response
            .text()
            .await
            .map_err(|error| McpError::Other(describe(&error)))?;
        if !status.is_success() {
            return Err(McpError::Other(format!(
                "Error POSTing to endpoint (HTTP {}): {}",
                status.as_u16(),
                body.trim()
            )));
        }
        Ok(Some(body))
    }
}

/// Redirects followed only within the first URL's origin: a request's headers (a key, a server's secrets) never go
/// to another.
pub fn same_origin_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let same = attempt
            .previous()
            .first()
            .is_some_and(|first| first.origin() == attempt.url().origin());
        if same && attempt.previous().len() < 10 {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

/// Pages of `tools/list` read at most.
const TOOL_PAGES: usize = 20;

/// A JSON-RPC response's result, or its error as text.
pub fn result_of(reply: Value) -> Result<Value, McpError> {
    if let Some(error) = reply.get("error") {
        return Err(McpError::Other(format!(
            "MCP error {}: {}",
            error.get("code").map(Value::to_string).unwrap_or_default(),
            error.get("message").and_then(Value::as_str).unwrap_or("")
        )));
    }
    Ok(reply.get("result").cloned().unwrap_or(Value::Null))
}

/// `name version` from an initialize result's `serverInfo`.
pub fn server_info(init: &Value) -> Option<String> {
    let info = init.get("serverInfo")?;
    let name = info.get("name").and_then(Value::as_str)?;
    Some(match info.get("version").and_then(Value::as_str) {
        Some(version) => format!("{name} {version}"),
        None => name.to_owned(),
    })
}

pub fn describe(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        text = format!("{text}: {cause}");
        source = cause.source();
    }
    text
}

/// The JSON-RPC response with `id`, from a JSON body or the `data:` lines of an SSE body.
fn find_response(body: &str, id: u64) -> Option<Value> {
    let matches = |value: &Value| value.get("id").and_then(Value::as_u64) == Some(id);
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        return match value {
            Value::Array(items) => items.into_iter().find(matches),
            value => matches(&value).then_some(value),
        };
    }
    let mut data = String::new();
    for line in body.lines().chain(std::iter::once("")) {
        if let Some(rest) = line.strip_prefix("data:") {
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
            data.push('\n');
        } else if line.is_empty() && !data.is_empty() {
            if let Ok(value) = serde_json::from_str::<Value>(&data)
                && matches(&value)
            {
                return Some(value);
            }
            data.clear();
        }
    }
    None
}
