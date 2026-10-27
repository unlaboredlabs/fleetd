//! A Navi's integrations: Google (Gmail, Calendar and Drive, fleetd's own server, `crate::google`), Notion (its official
//! server with the person's own integration token) and any other MCP server. Each is one of the project's MCP servers
//! (`mcp_servers.rs`) marked with what it is, so the hub knows its tools: a per-tool policy table (`hub/integrations`)
//! says which read and run unasked, which ask the person every time, and which are blocked even if approved. An ask is
//! a session's permission prompt relayed as an approval, carrying a [`ToolPreview`]: exactly who it goes to and what it
//! says, or which page or file it changes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::mcp_servers::McpServerName;
use crate::prim::{Line, List, Text};

/// What a configured MCP server is to the hub's tool policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationKind {
    /// Gmail, Google Calendar and Google Drive through fleetd's own `google` server, with the person's own account
    /// (`crate::google`).
    Google,
    /// Notion's official MCP server (`@notionhq/notion-mcp-server`) with the person's internal integration token.
    Notion,
    /// Any other server, by URL or command: every tool asks unless the person marked it as one that only reads.
    Custom,
}

/// A custom server's tools a person marked as only reading, run unasked. At most this many.
pub const READ_TOOLS_MAX: usize = 200;

brand!(
    /// A tool's name as its server lists it (`search_threads`, `API-post-search`): at most 128, no spaces.
    McpToolName,
    name = "McpToolName",
    pattern = r"^[A-Za-z0-9_.:/-]{1,128}$"
);

/// The integration a server is, on its row (`McpServer.integration`). A server without one is a custom one with no
/// tool marked as reading.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpIntegration {
    pub kind: IntegrationKind,
    /// A custom server's tools that only read, as the person marked them when connecting it. Ignored for Google and
    /// Notion, whose tools the hub's table knows. A tool the policy blocks stays blocked even when listed here.
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
    /// Removes something: mail to the trash, an event, a page, a file.
    Delete,
    /// Gives someone else access to something.
    Share,
    /// Pays or buys: money leaves the person's account.
    Spend,
}

/// The tool's input as it runs, pretty-printed, at most this many characters, a file's bytes said by their size. It is
/// never cut: an input past it is refused rather than asked about, so approving never runs more than the card shows.
/// A body, part of it, is whole too; the app folds a long one with Show all.
pub const PREVIEW_INPUT_MAX: usize = 100_000;

/// A file an asking tool attaches, as its input names it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAttachment {
    /// The name the recipient sees: "tenant-form.pdf", or what the file is when the tool names it by id.
    pub name: Line<1, 300>,
    /// Its size, when its bytes are in the input.
    pub bytes: Option<u64>,
    /// Where it comes from, when not from the input: "from Drive", "from message 18c2".
    pub from: Option<Line<1, 200>>,
}

/// What an approval card shows for an asking tool: who it reaches and what it says, or what it changes. Every field is
/// read from the exact input the tool runs with once approved; nothing is a summary the agent wrote.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolPreview {
    pub integration: IntegrationKind,
    /// The configured server's name, as claude prefixes its tools (`mcp__<server>__<tool>`).
    pub server: McpServerName,
    pub tool: McpToolName,
    pub action: ToolAction,
    /// What it does, as a verb phrase the app puts after "<the Navi> wants to": "Send an email", "Reply to an email".
    pub title: Line<1, 200>,
    /// The account it acts as, when the tool names one (the connected Google account's address).
    pub account: Option<Line<1, 320>>,
    /// Every recipient, as the tool gets them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub to: Vec<Line<1, 320>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cc: Vec<Line<1, 320>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bcc: Vec<Line<1, 320>>,
    /// Who it reaches when the tool decides that itself, such as a reply to a message's sender: said in words, since
    /// the card can't list them.
    pub audience: Option<Line<1, 300>>,
    pub subject: Option<Text<0, 1000>>,
    /// The text that goes out or goes in: the email's body, the event's notes, the page's new content.
    pub body: Option<Text<0, PREVIEW_INPUT_MAX>>,
    /// Every file it attaches.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<PreviewAttachment>,
    /// What it acts on: a message, an event, a page or a file, by name or id.
    pub target: Option<Text<0, 2000>>,
    /// When, for an event: "2026-11-03 10:00 → 11:00".
    pub when: Option<Line<1, 200>>,
    /// Everything the tool gets, as JSON, so nothing is hidden behind the fields above.
    pub input: Text<0, PREVIEW_INPUT_MAX>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preview_reads_and_writes_in_camel_case() {
        let p: ToolPreview = serde_json::from_value(serde_json::json!({
            "integration": "google",
            "server": "google",
            "tool": "send_message",
            "action": "send",
            "title": "Send an email",
            "to": ["ana@example.com"],
            "subject": "Lunch",
            "body": "Tuesday?",
            "input": "{}"
        }))
        .unwrap();
        assert_eq!(p.to.len(), 1);
        let back = serde_json::to_value(&p).unwrap();
        assert!(back.get("cc").is_none() && back.get("attachments").is_none());
    }

    #[test]
    fn tool_names() {
        for good in ["search_threads", "API-post-search", "notion-fetch", "a.b"] {
            assert!(McpToolName::new(good).is_ok(), "{good}");
        }
        for bad in ["", "a b", &"x".repeat(129)] {
            assert!(McpToolName::new(bad).is_err(), "{bad}");
        }
    }
}
