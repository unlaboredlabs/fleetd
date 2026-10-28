//! `fleetd google-mcp --home <node home> --project <id> [--folder <the Navi's folder>]`: a Navi's Google tools
//! (node/google/tools.rs), served over stdio, one JSON-RPC message per line. Its email attaches files from `--folder`
//! only, and none without it. The node puts it in a Navi lead's `--mcp-config` when the Navi has a Google
//! account (node/mcp_servers.rs), as the server `google`; it reads the Navi's tokens from the node's home, never from
//! its arguments or environment, so no token is in the session's config. The hub's policy answers each call's
//! permission prompt before it gets here (hub/integrations).
use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde_json::{Value, json};

use crate::node::google::{Endpoints, Session, tools};

const PROTOCOL_VERSION: &str = "2025-06-18";

/// One JSON-RPC message in, its answer out (`None` for a notification).
pub async fn handle(session: &Session, message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message["method"].as_str().unwrap_or_default();
    let result = match method {
        "initialize" => json!({
            "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "fleetd-google", "version": crate::version() },
            "instructions": "The person's own Gmail, Calendar and Drive. Reads and drafts run at once; a send, reply, \
                             invitation, upload or share waits for the person's approval in the app and goes out \
                             exactly as approved.",
        }),
        "ping" => json!({}),
        "tools/list" => tools::list(),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or_default();
            let input = &message["params"]["arguments"];
            match tools::call(session, name, input).await {
                Ok(answer) => json!({
                    "content": [{ "type": "text", "text": tools::text(&answer) }],
                    "isError": false,
                }),
                Err(why) => {
                    json!({ "content": [{ "type": "text", "text": why }], "isError": true })
                }
            }
        }
        _ => {
            return Some(json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") },
            }));
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// Serves stdin until it closes.
pub fn run(argv: &[String]) -> u8 {
    let flag = |name: &str| {
        argv.iter()
            .position(|a| a == name)
            .and_then(|i| argv.get(i + 1))
            .filter(|v| !v.is_empty())
            .cloned()
    };
    let (Some(home), Some(project)) = (flag("--home"), flag("--project")) else {
        eprintln!(
            "usage: fleetd google-mcp --home <node home> --project <project id> [--folder <navi folder>]"
        );
        return 2;
    };
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return 1;
    };
    let session = Session {
        folder: flag("--folder").map(PathBuf::from),
        ..Session::new(PathBuf::from(home), project, Endpoints::default())
    };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(message) => runtime.block_on(handle(&session, &message)),
            Err(e) => Some(json!({
                "jsonrpc": "2.0", "id": null,
                "error": { "code": -32700, "message": format!("parse error: {e}") },
            })),
        };
        if let Some(answer) = answer
            && writeln!(stdout, "{answer}")
                .and_then(|()| stdout.flush())
                .is_err()
        {
            break;
        }
    }
    0
}
