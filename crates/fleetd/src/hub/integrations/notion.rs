//! Notion: its official MCP server (`npx -y @notionhq/notion-mcp-server`, tools named after Notion's API:
//! `API-post-search`, `API-patch-page`, …) with the person's own internal integration token in `NOTION_TOKEN`, sealed
//! to Navi's machine. It reaches only the pages the person shares with that integration. The hosted server's names
//! (`notion-search`, `notion-update-page`, …), which xaq's Notion connection passes through, read the same way here.
use serde_json::Value;

use super::policy::{Draft, Rule, text_of};
use fleetd_contracts::integrations::ToolAction::{Delete, Write};

/// The official server's tools that only read.
pub const READS: &[&str] = &[
    "API-get-self",
    "API-get-user",
    "API-get-users",
    "API-post-search",
    "API-post-database-query",
    "API-get-block-children",
    "API-retrieve-a-block",
    "API-retrieve-a-page",
    "API-retrieve-a-page-property",
    "API-retrieve-a-comment",
    "API-retrieve-a-database",
    "API-retrieve-a-data-source",
    "API-query-data-source",
    "API-list-data-source-templates",
];

/// The hosted server's tools that only read.
const HOSTED_READS: &[&str] = &[
    "notion-search",
    "notion-fetch",
    "notion-get-self",
    "notion-get-users",
    "notion-get-teams",
    "notion-get-groups",
    "notion-get-comments",
    "notion-query-data-sources",
    "notion-query-meeting-notes",
    "notion-list-recent-pages",
    "notion-list-shared-pages",
    "notion-list-private-pages",
    "notion-list-favorite-pages",
    "notion-list-page-backlinks",
    "search",
    "fetch",
];

/// `API-patch-page` with `archived` or `in_trash` set moves the page to the trash.
fn trashes(input: &Value) -> bool {
    ["archived", "in_trash"]
        .iter()
        .any(|k| input[k].as_bool() == Some(true))
}

pub fn rule(tool: &str, input: &Value) -> Option<Rule> {
    if READS.contains(&tool) || HOSTED_READS.contains(&tool) {
        return Some(Rule::Read);
    }
    if let Some(op) = tool.strip_prefix("API-") {
        return Some(
            if ["get-", "retrieve-", "list-", "query-"]
                .iter()
                .any(|p| op.starts_with(p))
            {
                Rule::Read
            } else if op.starts_with("delete-") || (op == "patch-page" && trashes(input)) {
                Rule::Ask(Delete)
            } else {
                Rule::Ask(Write)
            },
        );
    }
    let op = tool.strip_prefix("notion-")?;
    Some(if op.contains("delete") {
        Rule::Ask(Delete)
    } else {
        Rule::Ask(Write)
    })
}

/// Every `content` string under `v`, in order: the text of rich-text arrays, blocks and titles.
fn texts(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(o) => {
            if let Some(Value::String(s)) = o.get("content")
                && !s.trim().is_empty()
            {
                out.push(s.clone());
            }
            for (k, child) in o {
                if k != "content" {
                    texts(child, out);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|i| texts(i, out)),
        // The official server takes nested JSON as strings at times; read those too.
        Value::String(s) if s.starts_with(['{', '[']) => {
            if let Ok(inner) = serde_json::from_str::<Value>(s) {
                texts(&inner, out);
            }
        }
        _ => {}
    }
}

/// The page's new title: a `title` property's text.
fn title(input: &Value) -> Option<String> {
    let props = input.get("properties")?;
    let mut out = Vec::new();
    for prop in props.as_object()?.values() {
        if let Some(t) = prop.get("title") {
            texts(t, &mut out);
        }
    }
    if out.is_empty() {
        texts(props.get("title")?, &mut out);
    }
    (!out.is_empty()).then(|| out.join(""))
}

pub fn draft(tool: &str, input: &Value) -> Draft {
    let op = tool
        .strip_prefix("API-")
        .or(tool.strip_prefix("notion-"))
        .unwrap_or(tool);
    let target = text_of(
        input,
        &[
            "page_id",
            "block_id",
            "database_id",
            "data_source_id",
            "comment_id",
        ],
    )
    .or_else(|| {
        let parent = input.get("parent")?;
        text_of(parent, &["page_id", "database_id", "data_source_id"])
            .map(|p| format!("Inside {p}"))
    });
    let mut body = Vec::new();
    for key in ["children", "rich_text", "content", "pages"] {
        if let Some(v) = input.get(key) {
            match v {
                Value::String(s) if !s.starts_with(['{', '[']) => body.push(s.clone()),
                other => texts(other, &mut body),
            }
        }
    }
    let heading = if op == "patch-page" && trashes(input) {
        "Move a Notion page to the trash".to_owned()
    } else {
        format!("Notion: {}", op.replace('-', " "))
    };
    Draft {
        title: Some(heading),
        subject: title(input),
        body: (!body.is_empty()).then(|| body.join("\n")),
        target,
        ..Draft::default()
    }
}
