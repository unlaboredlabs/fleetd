//! The per-tool policy the hub enforces on a session's MCP tools. Every tool resolves to a [`Rule`]: first the blocked
//! list, by the words of the tool's name, for every server; then the server's tools the person marked as reading;
//! anything else asks, with an action guessed from its name. An asking tool whose input looks like it holds a
//! credential is blocked too.
use fleetd_contracts::integrations::{
    McpToolName, PREVIEW_INPUT_MAX, ToolAction, ToolPolicy, ToolPreview,
};
use fleetd_contracts::mcp_servers::{FLEETD_SERVER, McpServer, McpServerName};
use fleetd_contracts::prim::{Line, Text, js_len};
use serde_json::Value;

/// What the hub does with one call of one tool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rule {
    Read,
    Ask(ToolAction),
    Blocked(Never),
}

/// What is refused even when a person approves it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Never {
    Money,
    Trading,
    Accounts,
    Credential,
}

impl Never {
    /// The refusal, for the agent (which tells the person) and the thread.
    pub fn why(self) -> &'static str {
        match self {
            Never::Money => {
                "Blocked by fleetd: an assistant never moves money between accounts, even with your approval. Tell \
                 the person what you wanted to do; they make the transfer themselves."
            }
            Never::Trading => {
                "Blocked by fleetd: an assistant never trades, even with your approval. Tell the person what you \
                 wanted to do; they place the trade themselves."
            }
            Never::Accounts => {
                "Blocked by fleetd: an assistant never creates accounts in the person's name, even with their \
                 approval. Tell the person; they sign up themselves."
            }
            Never::Credential => {
                "Blocked by fleetd: this would send or store what looks like a password, key or token, which never \
                 leaves through an assistant, even with approval. Leave the value out; a secret goes through \
                 request_secret."
            }
        }
    }
}

impl From<Rule> for ToolPolicy {
    fn from(rule: Rule) -> Self {
        match rule {
            Rule::Read => ToolPolicy::Read,
            Rule::Ask(_) => ToolPolicy::Ask,
            Rule::Blocked(_) => ToolPolicy::Blocked,
        }
    }
}

/// An asking call whose whole input doesn't fit on its card: approving it would run what the person couldn't see.
pub const TOO_LARGE: &str = "Blocked by fleetd: this call is too large to show on an approval card in full, and \
     fleetd never asks you to approve what you can't see. Split it into smaller calls.";

/// The hub's answer to a session's permission prompt for an MCP tool.
#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    /// A read: answer Allow.
    Allow,
    /// Ask the person, showing this; once approved, answer Allow with the exact input it was read from.
    Ask(Box<ToolPreview>),
    /// Answer Deny with this, and ask no one.
    Block(&'static str),
}

/// A tool name's words, lower case: `create_account`, `createAccount` and `API-create-account` are all
/// `[create, account]`.
pub fn words(name: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut prev_lower = false;
    for c in name.chars() {
        if !c.is_alphanumeric() {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            prev_lower = false;
            continue;
        }
        if c.is_uppercase() && prev_lower && !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        word.extend(c.to_lowercase());
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

const MONEY: &[&str] = &[
    "transfer",
    "transfers",
    "payout",
    "payouts",
    "withdraw",
    "withdrawal",
    "withdrawals",
    "wire",
    "remit",
    "remittance",
    "money",
    "fund",
    "funds",
];
/// Sending one of these moves money: `send_transaction`, `broadcast_tx`.
const MONEY_SENT: (&[&str], &[&str]) = (
    &["send", "sign", "submit", "broadcast"],
    &["transaction", "transactions", "tx"],
);
const TRADING: &[&str] = &[
    "trade", "trades", "trading", "sell", "swap", "stake", "unstake", "stock", "stocks", "equity",
    "equities", "crypto", "bitcoin", "btc",
];
/// Buying or ordering one of these trades: `buy_shares`, `place_order`.
const TRADED: (&[&str], &[&str]) = (
    &["buy", "place", "submit", "open", "close"],
    &[
        "order",
        "orders",
        "share",
        "shares",
        "position",
        "positions",
    ],
);
const SPEND: &[&str] = &[
    "pay", "payment", "payments", "purchase", "buy", "checkout", "charge",
];
const DELETE: &[&str] = &[
    "delete", "remove", "trash", "destroy", "erase", "purge", "drop",
];
const SEND: &[&str] = &[
    "send", "reply", "forward", "email", "message", "post", "publish", "invite", "notify", "tweet",
];
const SHARE: &[&str] = &["share", "grant", "permission", "permissions"];

/// What the name alone refuses, on any server.
pub fn never(tool: &str) -> Option<Never> {
    let w = words(tool);
    let has = |list: &[&str]| w.iter().any(|x| list.contains(&x.as_str()));
    let both = |(verbs, nouns): (&[&str], &[&str])| has(verbs) && has(nouns);
    if has(MONEY) || both(MONEY_SENT) {
        return Some(Never::Money);
    }
    if has(TRADING) || both(TRADED) {
        return Some(Never::Trading);
    }
    let signs_up = w.iter().any(|x| x == "signup" || x == "register")
        || w.windows(2).any(|p| p[0] == "sign" && p[1] == "up");
    let opens_account = w
        .iter()
        .any(|x| ["create", "open", "new"].contains(&x.as_str()))
        && w.iter().any(|x| x == "account" || x == "accounts");
    (signs_up || opens_account).then_some(Never::Accounts)
}

/// What an unknown tool would do, from its name.
pub fn guess(tool: &str) -> ToolAction {
    let w = words(tool);
    let has = |list: &[&str]| w.iter().any(|x| list.contains(&x.as_str()));
    if has(SPEND) {
        ToolAction::Spend
    } else if has(DELETE) {
        ToolAction::Delete
    } else if has(SHARE) {
        ToolAction::Share
    } else if has(SEND) {
        ToolAction::Send
    } else {
        ToolAction::Write
    }
}

/// The tools a server's person marked as reading.
fn reads_of(server: Option<&McpServer>) -> &[McpToolName] {
    server
        .and_then(|s| s.integration.as_ref())
        .map_or(&[], |i| i.read_tools.as_slice())
}

/// The rule for one call: blocked by name, then the tools marked as reading, then an ask.
pub fn rule(read_tools: &[McpToolName], tool: &str) -> Rule {
    if let Some(n) = never(tool) {
        return Rule::Blocked(n);
    }
    if read_tools.iter().any(|t| t.as_str() == tool) {
        return Rule::Read;
    }
    Rule::Ask(guess(tool))
}

/// A tool's policy by its name alone, as the connect screen lists it.
pub fn tool_policy(server: &McpServer, tool: &str) -> ToolPolicy {
    rule(reads_of(Some(server)), tool).into()
}

/// `mcp__<server>__<tool>` split at a configured server's name, or at the first `__` after the prefix.
fn split<'a>(tool_name: &'a str, servers: &[McpServer]) -> Option<(&'a str, &'a str)> {
    let rest = tool_name.strip_prefix("mcp__")?;
    servers
        .iter()
        .find_map(|s| {
            let tool = rest.strip_prefix(s.name.as_str())?.strip_prefix("__")?;
            Some((&rest[..s.name.len()], tool))
        })
        .or_else(|| rest.split_once("__"))
        .filter(|(_, tool)| !tool.is_empty())
}

/// The hub's answer to a permission prompt for `tool_name` with `input`, given the session's MCP servers (its
/// project's and the global ones it gets). `None` for anything but a configured or the person's own MCP server's
/// tool: fleetd's own tools and claude's are not this table's.
pub fn verdict(tool_name: &str, input: &Value, servers: &[McpServer]) -> Option<Verdict> {
    let (server_name, tool) = split(tool_name, servers)?;
    if server_name.eq_ignore_ascii_case(FLEETD_SERVER) {
        return None;
    }
    let server = servers.iter().find(|s| s.name.as_str() == server_name);
    Some(match rule(reads_of(server), tool) {
        Rule::Read => Verdict::Allow,
        Rule::Blocked(n) => Verdict::Block(n.why()),
        Rule::Ask(action) => {
            if holds_credential(input) {
                return Some(Verdict::Block(Never::Credential.why()));
            }
            if js_len(&serde_json::to_string_pretty(input).unwrap_or_default()) > PREVIEW_INPUT_MAX
            {
                return Some(Verdict::Block(TOO_LARGE));
            }
            match preview(server_name, tool, action, input) {
                Some(p) => Verdict::Ask(Box::new(p)),
                // A name the contracts can't carry is no tool fleetd shows a person: refused rather than asked blind.
                None => Verdict::Block(
                    "Blocked by fleetd: this tool's name can't be shown on an approval card.",
                ),
            }
        }
    })
}

/// Whether any part of `input` looks like a credential: the whole of it, and each string in it on its own, so one
/// inside a JSON-encoded string is read unescaped.
fn holds_credential(input: &Value) -> bool {
    let shows = |text: &str| crate::hub::redact::redact(text) != text;
    fn strings<'a>(v: &'a Value, out: &mut Vec<&'a str>) {
        match v {
            Value::String(s) => out.push(s),
            Value::Array(items) => items.iter().for_each(|i| strings(i, out)),
            Value::Object(o) => o.values().for_each(|i| strings(i, out)),
            _ => {}
        }
    }
    let mut all = Vec::new();
    strings(input, &mut all);
    shows(&input.to_string()) || all.into_iter().any(shows)
}

/// What a session's claude gets at launch: the read tools in `--allowedTools`, so it never asks for them, and a tool
/// a person marked as reading but the blocked list refuses in `--disallowedTools`. The hub's [`verdict`] still answers
/// every prompt that comes; these only save the asks.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchRules {
    pub allowed: Vec<String>,
    pub disallowed: Vec<String>,
}

pub fn launch_rules(servers: &[McpServer]) -> LaunchRules {
    let mut out = LaunchRules::default();
    for s in servers.iter().filter(|s| s.enabled && s.roles.lead) {
        for tool in reads_of(Some(s)).iter().map(|t| t.as_str()) {
            let rule = format!("mcp__{}__{tool}", s.name);
            if never(tool).is_some() {
                out.disallowed.push(rule);
            } else {
                out.allowed.push(rule);
            }
        }
    }
    out
}

/// `text` cut to `max` UTF-16 units, ending in `…` when cut.
pub fn clip_utf16(text: &str, max: usize) -> (String, bool) {
    if js_len(text) <= max {
        return (text.to_owned(), false);
    }
    let mut out = String::new();
    let mut len = 0;
    for c in text.chars() {
        if len + c.len_utf16() > max.saturating_sub(1) {
            break;
        }
        len += c.len_utf16();
        out.push(c);
    }
    out.push('…');
    (out, true)
}

fn line<const MAX: usize>(text: &str) -> Option<Line<1, MAX>> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    Line::new(clip_utf16(&flat, MAX).0).ok()
}

/// The card for an asking call: its title, and the whole input it runs with.
pub fn preview(server: &str, tool: &str, action: ToolAction, input: &Value) -> Option<ToolPreview> {
    Some(ToolPreview {
        server: McpServerName::new(server).ok()?,
        tool: McpToolName::new(tool).ok()?,
        action,
        title: line(&format!("Use {tool} on {server}"))?,
        // Whole: `verdict` refuses an input past the bound before it asks.
        input: Text::new(serde_json::to_string_pretty(input).unwrap_or_default()).ok()?,
    })
}
