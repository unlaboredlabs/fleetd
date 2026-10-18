//! The MCP endpoint at /mcp: Streamable HTTP with JSON responses only (POST; no GET stream, no DELETE), a static
//! tool list, and the caller's bearer checked on every request, with the wire behaviour older hubs had
//! (Effect's `McpServer.layerHttp`): sessions from `initialize`, protocol negotiation, 202 for notifications, and the
//! same JSON-RPC errors.
mod descriptions;

use crate::hub::api::{CallError, Caller, Hub, Registry, ToolError, clip};
use crate::hub::auth::AuthError;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::Response;
use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

/// Newest first; the first is answered to a client asking for one the hub doesn't speak.
const PROTOCOLS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SESSION_HEADER: &str = "mcp-session-id";
const PROTOCOL_HEADER: &str = "mcp-protocol-version";

/// The tools/list result, built once from the registry, and the sessions `initialize` opened.
pub struct McpEndpoint {
    tools_list: Value,
    /// Session id → negotiated protocol. Sessions live as long as the hub (there is no DELETE).
    sessions: Mutex<HashMap<String, &'static str>>,
}

impl McpEndpoint {
    pub fn new(tools: &Registry) -> Self {
        let doc = fleetd_contracts::schema::mcp_tools_document();
        let mut listed: Vec<Value> = Vec::new();
        let mut names: Vec<&str> = descriptions::DESCRIPTIONS
            .iter()
            .map(|(n, _)| *n)
            .filter(|n| tools.contains(n))
            .collect();
        let mut rest: Vec<&str> = tools.names().filter(|n| !names.contains(n)).collect();
        rest.sort_unstable();
        names.extend(rest);
        for name in names {
            let description = descriptions::DESCRIPTIONS
                .iter()
                .find(|(n, _)| *n == name)
                .map_or("", |(_, d)| d);
            let read_only = tools.scope(name) == Some(Role::Read);
            listed.push(json!({
                "name": name,
                "description": description,
                "inputSchema": input_schema(&doc, name),
                // Effect's MCP server fills in the hints it isn't given with these values.
                "annotations": { "readOnlyHint": read_only, "destructiveHint": true, "idempotentHint": false, "openWorldHint": false },
            }));
        }
        Self {
            tools_list: json!({ "tools": listed }),
            sessions: Mutex::default(),
        }
    }
}

/// A tool's input schema for tools/list. MCP requires an object root, so a non-object input becomes the empty
/// object schema, and the definitions it references (transitively) go to `$defs`.
fn input_schema(doc: &Value, name: &str) -> Value {
    let defs = &doc["$defs"];
    let mut input = &defs["McpTools"]["properties"][format!("{name}.input")];
    // schemars names input structs where Effect inlines them: look through a bare root `$ref`.
    while let Some(def) = input
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|r| r.strip_prefix("#/$defs/"))
    {
        input = &defs[def];
    }
    let mut root = if input["type"] == "object" {
        input.clone()
    } else {
        json!({ "type": "object", "properties": {} })
    };
    let mut used = BTreeMap::new();
    let mut pending = Vec::new();
    collect_refs(&root, &mut pending);
    while let Some(def) = pending.pop() {
        if used.contains_key(&def) {
            continue;
        }
        let schema = defs[&def].clone();
        collect_refs(&schema, &mut pending);
        used.insert(def, schema);
    }
    if !used.is_empty() {
        root["$defs"] = Value::Object(used.into_iter().collect());
    }
    root
}

fn collect_refs(schema: &Value, out: &mut Vec<String>) {
    match schema {
        Value::Object(map) => {
            for (key, value) in map {
                match (key.as_str(), value) {
                    ("$ref", Value::String(r)) => {
                        if let Some(def) = r.strip_prefix("#/$defs/") {
                            out.push(def.to_owned());
                        }
                    }
                    _ => collect_refs(value, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|v| collect_refs(v, out)),
        _ => {}
    }
}

fn json_response(status: StatusCode, body: &Value, extra: &[(&str, &str)]) -> Response {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    builder
        .body(Body::from(body.to_string()))
        .expect("valid response")
}

fn empty(status: StatusCode, extra: &[(&str, &str)]) -> Response {
    let mut builder = Response::builder().status(status);
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::empty()).expect("valid response")
}

fn tool_error_json(error: &McpToolError) -> Value {
    serde_json::to_value(error).expect("serializable error")
}

fn unauthorized(error: &McpToolError) -> Response {
    json_response(
        StatusCode::UNAUTHORIZED,
        &tool_error_json(error),
        &[
            ("cache-control", "no-store"),
            ("www-authenticate", r#"Bearer error="invalid_token""#),
        ],
    )
}

fn missing_bearer() -> McpToolError {
    McpToolError::new(ErrorCode::Forbidden, "The MCP endpoint needs an agent key.")
        .with_fix("Send Authorization: Bearer fld_… (create one with fleetd hub key create).")
}

fn rpc_error(id: &Value, code: i64, message: &str, tag: Option<&str>) -> Value {
    let mut error = json!({ "code": code, "message": message });
    if let Some(tag) = tag {
        error["_tag"] = json!(tag);
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

/// The bearer must be a live key on every request, so a revoked key stops working on its next call.
fn authenticate(hub: &Hub, headers: &HeaderMap) -> Result<Caller, Box<Response>> {
    let header = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let bearer = header.strip_prefix("Bearer ").map_or("", str::trim);
    if bearer.is_empty() {
        return Err(Box::new(unauthorized(&missing_bearer())));
    }
    match hub.auth.verify(bearer) {
        Ok(caller) => Ok(caller),
        Err(AuthError::Unauthorized(refused)) => Err(Box::new(unauthorized(&McpToolError {
            code: refused.code,
            message: refused.message,
            fix: refused.fix,
        }))),
        Err(error) => {
            tracing::error!(%error, "key check failed");
            Err(Box::new(json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &tool_error_json(&crate::hub::api::internal_error()),
                &[],
            )))
        }
    }
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// One request to /mcp.
pub async fn handle(
    hub: &Arc<Hub>,
    tools: &Registry,
    mcp: &McpEndpoint,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let caller = match authenticate(hub, &headers) {
        Ok(caller) => caller,
        Err(response) => return *response,
    };
    if method != Method::POST {
        return empty(StatusCode::METHOD_NOT_ALLOWED, &[("allow", "POST")]);
    }
    if !header_str(&headers, "content-type").is_some_and(|t| {
        t.split(';')
            .next()
            .is_some_and(|m| m.trim().eq_ignore_ascii_case("application/json"))
    }) {
        return empty(StatusCode::UNSUPPORTED_MEDIA_TYPE, &[]);
    }
    let accept = header_str(&headers, "accept").unwrap_or("");
    if !(accept.contains("*/*")
        || (accept.contains("application/json") && accept.contains("text/event-stream")))
    {
        return empty(StatusCode::NOT_ACCEPTABLE, &[]);
    }
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return json_response(
            StatusCode::OK,
            &rpc_error(&Value::Null, -32700, "Parse error", Some("ParseError")),
            &[],
        );
    };
    let Value::Object(message) = message else {
        // Batches were removed from the protocol; Effect answers them with a bare 400.
        return empty(StatusCode::BAD_REQUEST, &[]);
    };
    let id = message.get("id").cloned();
    let rpc_method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let session_id = header_str(&headers, SESSION_HEADER);

    if rpc_method == "initialize" {
        let id = id.unwrap_or(Value::Null);
        if session_id.is_some() {
            let error = rpc_error(
                &id,
                -32600,
                "initialize must not include an MCP-Session-Id header",
                Some("InvalidRequest"),
            );
            return json_response(StatusCode::BAD_REQUEST, &error, &[]);
        }
        let requested = message
            .get("params")
            .and_then(|p| p.get("protocolVersion"))
            .and_then(Value::as_str);
        let protocol = PROTOCOLS
            .iter()
            .copied()
            .find(|p| Some(*p) == requested)
            .unwrap_or(PROTOCOLS[0]);
        let session = new_session_id();
        mcp.sessions
            .lock()
            .expect("sessions lock")
            .insert(session.clone(), protocol);
        let result = json!({
            "protocolVersion": protocol,
            "capabilities": { "logging": {}, "tools": { "listChanged": true }, "completions": {} },
            "serverInfo": { "name": "fleetd", "version": env!("CARGO_PKG_VERSION") },
        });
        let body = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        return json_response(
            StatusCode::OK,
            &body,
            &[(PROTOCOL_HEADER, protocol), (SESSION_HEADER, &session)],
        );
    }

    let Some(session_id) = session_id else {
        let error = rpc_error(
            id.as_ref().unwrap_or(&Value::Null),
            -32600,
            "MCP-Session-Id header is required; send initialize to start a session",
            Some("InvalidRequest"),
        );
        return json_response(StatusCode::BAD_REQUEST, &error, &[]);
    };
    let Some(protocol) = mcp
        .sessions
        .lock()
        .expect("sessions lock")
        .get(session_id)
        .copied()
    else {
        return empty(StatusCode::NOT_FOUND, &[]);
    };
    if let Some(asked) = header_str(&headers, PROTOCOL_HEADER) {
        let id = id.as_ref().unwrap_or(&Value::Null);
        if !PROTOCOLS.contains(&asked) {
            let body = json!({ "jsonrpc": "2.0", "id": id, "error": {
                "code": -32022,
                "message": format!("Unsupported protocol version '{asked}'"),
                "data": { "supported": PROTOCOLS, "requested": asked },
            }});
            return json_response(StatusCode::BAD_REQUEST, &body, &[]);
        }
        if asked != protocol {
            let message = format!(
                "MCP-Protocol-Version header '{asked}' does not match negotiated protocol version '{protocol}'"
            );
            return json_response(
                StatusCode::BAD_REQUEST,
                &rpc_error(id, -32020, &message, None),
                &[],
            );
        }
    }
    let Some(id) = id else {
        // A notification (notifications/initialized, cancelled, …) or a client response: nothing to answer.
        return empty(StatusCode::ACCEPTED, &[(PROTOCOL_HEADER, protocol)]);
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let body = match rpc_method {
        "ping" | "logging/setLevel" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": mcp.tools_list }),
        "resources/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "resources": [] } }),
        "resources/templates/list" => {
            json!({ "jsonrpc": "2.0", "id": id, "result": { "resourceTemplates": [] } })
        }
        "prompts/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "prompts": [] } }),
        "tools/call" => match params.get("name").and_then(Value::as_str) {
            None => rpc_error(
                &id,
                -32602,
                "Invalid method parameters",
                Some("InvalidParams"),
            ),
            Some(name) => {
                let input = params.get("arguments").cloned().unwrap_or(Value::Null);
                match tools.call(hub, &caller, name, input).await {
                    Err(CallError::UnknownTool) => {
                        rpc_error(&id, -32602, &format!("Tool '{name}' not found"), None)
                    }
                    outcome => {
                        json!({ "jsonrpc": "2.0", "id": id, "result": call_result(name, outcome) })
                    }
                }
            }
        },
        "completion/complete" => rpc_error(
            &id,
            -32602,
            "Invalid method parameters",
            Some("InvalidParams"),
        ),
        other => rpc_error(
            &id,
            -32601,
            &format!("Method not found: {other}"),
            Some("MethodNotFound"),
        ),
    };
    json_response(StatusCode::OK, &body, &[(PROTOCOL_HEADER, protocol)])
}

/// Some clients show only the text and others only structuredContent, so both carry the result (or the error).
fn call_result(name: &str, outcome: Result<Value, CallError>) -> Value {
    let (value, is_error) = match outcome {
        Ok(output) => (output, false),
        Err(CallError::Tool(error)) => (tool_error_json(&error), true),
        Err(CallError::Invalid(detail)) => (
            tool_error_json(&invalid_input(
                name,
                &detail,
                "Check the arguments against the tool's input schema.",
            )),
            true,
        ),
        Err(CallError::UnknownTool) => unreachable!("answered as a JSON-RPC error"),
    };
    json!({ "content": [{ "type": "text", "text": value.to_string() }], "structuredContent": value, "isError": is_error })
}

/// The `invalid` result for input that failed to decode; `fix` differs between /mcp and /app.
pub fn invalid_input(tool: &str, detail: &str, fix: &str) -> ToolError {
    ToolError::new(
        ErrorCode::Invalid,
        clip(&format!("Invalid {tool} input: {detail}"), 1000),
    )
    .with_fix(fix)
}

/// A random v4 UUID, as Effect's server issues.
fn new_session_id() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}
