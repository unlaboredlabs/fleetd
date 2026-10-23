//! claude's stream-json lines, decoded to the fields fleetd reads. Unknown fields are ignored and unknown line types
//! decode to [`Line::Other`], so a newer claude adds without breaking us; the conformance check catches a change to
//! a field we do read.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One stdout line.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Line {
    System(System),
    Assistant(Assistant),
    User(User),
    StreamEvent(StreamEvent),
    Result(ResultLine),
    ControlRequest(ControlRequest),
    ControlResponse(ControlResponse),
    ControlCancelRequest(ControlCancel),
    RateLimitEvent(RateLimitEvent),
    CommandLifecycle(CommandLifecycle),
    #[serde(other)]
    Other,
}

/// `system`: init, status, compact_boundary, api_retry and others, told apart by `subtype`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct System {
    pub subtype: String,
    pub session_id: Option<String>,
    /// The line's own id; fleetd uses it as the item id of compactions and retries.
    pub uuid: Option<String>,
    // init
    pub claude_code_version: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub capabilities: Option<Vec<String>>,
    /// Tool names the session offers (claude's own and `mcp__<server>__<tool>`).
    pub tools: Option<Vec<String>>,
    // status
    pub status: Option<String>,
    /// `requesting`: the user messages this model request carries (`request_marker_lists_v1`).
    pub user_message_uuids: Option<Vec<String>>,
    pub compact_result: Option<String>,
    // compact_boundary
    pub compact_metadata: Option<CompactMetadata>,
    // api_retry
    pub attempt: Option<u32>,
    pub max_retries: Option<u32>,
    pub retry_delay_ms: Option<u64>,
    pub error_status: Option<u16>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CompactMetadata {
    pub trigger: String,
    pub pre_tokens: Option<u64>,
    pub post_tokens: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Assistant {
    pub message: AssistantMessage,
    pub parent_tool_use_id: Option<String>,
    /// Set on synthetic error messages: authentication_failed, rate_limit, overloaded, server_error, unknown, ….
    pub error: Option<String>,
    pub api_error_status: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct AssistantMessage {
    pub id: String,
    pub model: Option<String>,
    pub content: Vec<Block>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text {
        text: String,
    },
    Thinking {
        #[serde(default)]
        thinking: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct User {
    pub message: UserMessage,
    pub parent_tool_use_id: Option<String>,
    /// The tool's structured output (Bash: stdout, stderr, interrupted), or an error string.
    pub tool_use_result: Option<Value>,
    #[serde(default, rename = "isReplay")]
    pub is_replay: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum UserContent {
    Text(String),
    Blocks(Vec<Block>),
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct UserMessage {
    pub content: UserContent,
}

/// `--include-partial-messages`: one Messages API streaming event.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct StreamEvent {
    pub event: Value,
    pub parent_tool_use_id: Option<String>,
    /// The id of the assistant message being streamed; the complete message carries the same id.
    pub api_message_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ResultLine {
    /// success (also for API errors, with is_error) or error_during_execution, error_max_turns, ….
    pub subtype: String,
    pub is_error: bool,
    pub result: Option<String>,
    pub terminal_reason: Option<String>,
    pub api_error_status: Option<u16>,
    pub errors: Option<Vec<String>>,
    /// Why claude refused to start the turn (gateway sign-in, org pin, …); written with
    /// `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` set.
    pub startup_failure_reason: Option<String>,
    pub usage: Option<Usage>,
    pub total_cost_usd: Option<f64>,
    pub user_message_uuid: Option<String>,
    /// The run's wall time and API time by claude's own count.
    pub duration_ms: Option<u64>,
    pub duration_api_ms: Option<u64>,
    /// Every user message the turn took in: the first, then any that joined it.
    pub user_message_uuids: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Default, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
}

/// claude -> fleetd. Only `can_use_tool` is expected; any other subtype gets an error response.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ControlRequest {
    pub request_id: String,
    pub request: ControlRequestBody,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ControlRequestBody {
    pub subtype: String,
    pub tool_name: Option<String>,
    pub input: Option<Value>,
    pub tool_use_id: Option<String>,
    pub description: Option<String>,
    pub blocked_path: Option<String>,
    pub decision_reason: Option<String>,
}

/// The answer to one of fleetd's own control requests (interrupt, initialize).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ControlResponse {
    pub response: ControlResponseBody,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ControlResponseBody {
    /// success or error.
    pub subtype: String,
    pub request_id: String,
    pub response: Option<Value>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ControlCancel {
    pub request_id: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RateLimitEvent {
    pub rate_limit_info: RateLimitInfo,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitInfo {
    pub status: String,
    pub resets_at: Option<i64>,
    pub rate_limit_type: Option<String>,
    pub utilization: Option<f64>,
}

/// One user message's lifecycle: queued, started, completed, cancelled.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CommandLifecycle {
    pub command_uuid: String,
    pub state: String,
}

/// stdin lines fleetd writes.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Input {
    User {
        message: InputMessage,
        parent_tool_use_id: Option<String>,
        session_id: String,
        uuid: String,
        /// `now`: the running turn ends at its next tool boundary and this message gets its own turn. Absent = `next`.
        #[serde(skip_serializing_if = "Option::is_none")]
        priority: Option<&'static str>,
    },
    ControlRequest {
        request_id: String,
        request: Value,
    },
    ControlResponse {
        response: Value,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InputMessage {
    pub role: &'static str,
    pub content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every recorded stdout line decodes, and none of the types fleetd reads falls through to `Other`.
    #[test]
    fn every_fixture_line_decodes() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/node/runner/fixtures");
        let mut lines = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            for (n, raw) in std::fs::read_to_string(&path).unwrap().lines().enumerate() {
                let rec: Value = serde_json::from_str(raw).unwrap();
                if rec["dir"] != "out" {
                    continue;
                }
                let msg = &rec["msg"];
                let line: Line = serde_json::from_value(msg.clone())
                    .unwrap_or_else(|e| panic!("{}:{}: {e}", path.display(), n + 1));
                let ty = msg["type"].as_str().unwrap_or_default();
                if matches!(line, Line::Other) {
                    assert!(
                        !matches!(
                            ty,
                            "system" | "assistant" | "user" | "result" | "control_request"
                        ),
                        "{}:{}: {ty} decoded as Other",
                        path.display(),
                        n + 1
                    );
                }
                lines += 1;
            }
        }
        assert!(lines > 100, "fixtures missing: only {lines} lines");
    }
}
