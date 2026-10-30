//! A Navi's MCP servers, each one of the project's MCP servers (`mcp_servers.rs`), as the hub's tool policy reads them
//! (`hub/integrations`): which tools read and run unasked, which ask the person every time, and which are blocked even
//! if approved. An ask is a session's permission prompt relayed as an approval, carrying a [`ToolPreview`]: the tool
//! and exactly the input it runs with.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::brand;
use crate::mcp_servers::McpServerName;
use crate::prim::{Line, List, Text};

/// A custom server's tools a person marked as only reading, run unasked. At most this many.
pub const READ_TOOLS_MAX: usize = 200;

brand!(
    /// A tool's name as its server lists it (`search_threads`, `API-post-search`): at most 128, no spaces.
    McpToolName,
    name = "McpToolName",
    pattern = r"^[A-Za-z0-9_.:/-]{1,128}$"
);

/// What the person marked a server's tools as, on its row (`McpServer.integration`). A server without one has no tool
/// marked as reading.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpIntegration {
    /// The server's tools that only read, as the person marked them when connecting it. A tool the policy blocks stays
    /// blocked even when listed here.
    #[serde(default, skip_serializing_if = "<[McpToolName]>::is_empty")]
    pub read_tools: List<McpToolName, 0, READ_TOOLS_MAX, true>,
}

/// The hub's policy for one tool.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolPolicy {
    /// Reads: runs without asking.
    Read,
    /// Writes, sends, deletes or shares: asks the person every time, showing exactly what it would do.
    Ask,
    /// Moves money, trades or creates accounts, or would send what looks like a credential: refused even if
    /// approved.
    Blocked,
}

/// What an asking tool would do, for the card's heading and its urgency.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolAction {
    /// Reaches another person: an email, a reply, an invitation or an answer to one.
    Send,
    /// Changes something of the person's: a draft, a label, a page, a document.
    Write,
    /// Removes something: a message, an event, a page, a file.
    Delete,
    /// Gives someone else access to something.
    Share,
    /// Pays or buys: money leaves the person's account.
    Spend,
}

/// The tool's input as it runs, pretty-printed, at most this many characters. It is never cut: an input past it is
/// refused rather than asked about, so approving never runs more than the card shows.
pub const PREVIEW_INPUT_MAX: usize = 100_000;

/// What an approval card shows for an asking tool: what it does and everything it gets. The input is the exact one
/// the tool runs with once approved; nothing is a summary the agent wrote.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolPreview {
    /// The configured server's name, as claude prefixes its tools (`mcp__<server>__<tool>`).
    pub server: McpServerName,
    pub tool: McpToolName,
    pub action: ToolAction,
    /// What it does, as a verb phrase the app puts after "<the Navi> wants to": "Use create_page on docs".
    pub title: Line<1, 200>,
    /// Everything the tool gets, as JSON.
    pub input: Text<0, PREVIEW_INPUT_MAX>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preview_reads_and_writes_in_camel_case() {
        let p: ToolPreview = serde_json::from_value(serde_json::json!({
            "server": "docs",
            "tool": "create_page",
            "action": "write",
            "title": "Use create_page on docs",
            "input": "{}"
        }))
        .unwrap();
        assert_eq!(p.tool.as_str(), "create_page");
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["title"], "Use create_page on docs");
    }

    #[test]
    fn tool_names() {
        for good in ["search_pages", "API-post-search", "list-files", "a.b"] {
            assert!(McpToolName::new(good).is_ok(), "{good}");
        }
        for bad in ["", "a b", &"x".repeat(129)] {
            assert!(McpToolName::new(bad).is_err(), "{bad}");
        }
    }
}
