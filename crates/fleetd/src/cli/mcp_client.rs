//! The little of an MCP Streamable HTTP client that `listen` and `retro run` need: initialize once, then call tools.
//! Answers may come as JSON or as an SSE stream; both are read to the matching response.

use std::time::Duration;

use serde_json::{Value, json};

const PROTOCOL_VERSION: &str = "2025-06-18";

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
    key: String,
    session: Option<String>,
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
        let http = reqwest::Client::builder()
            .user_agent(format!("{name}/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| McpError::Other(error.to_string()))?;
        let mut client = McpClient {
            http,
            url: endpoint(hub),
            key: key.to_owned(),
            session: None,
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
        if let Some(error) = reply.get("error") {
            return Err(McpError::Other(format!(
                "MCP error {}: {}",
                error.get("code").map(Value::to_string).unwrap_or_default(),
                error.get("message").and_then(Value::as_str).unwrap_or("")
            )));
        }
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    }

    /// The raw body of the answer, or `None` for 202 Accepted.
    async fn post(
        &mut self,
        message: &Value,
        timeout: Duration,
    ) -> Result<Option<String>, McpError> {
        let mut request = self
            .http
            .post(&self.url)
            .timeout(timeout)
            .bearer_auth(&self.key)
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

fn describe(error: &reqwest::Error) -> String {
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
