//! The "Agent tools" reference page, written whole to `docs/site/src/content/docs/reference/agent-tools.md` from the code fleetd runs:
//! the agent MCP server's tool registry and schemas (`cli/agent_mcp.rs`), the hub's call policy
//! (`hub/tasks/policy.rs`), and the deny list and environment claude is launched with (`node/runner/claude`). Only
//! the example calls and a few lines of framing are written here, and every example is checked against its tool's
//! schema by the same decoder the MCP server uses.

use std::collections::BTreeSet;
use std::path::Path;

use fleetd::cli::agent_mcp::{self, Role, SERVER_NAME, Tool};
use fleetd::hub::orders::phase;
use fleetd::hub::slots::sizing::HARD_TOP;
use fleetd::hub::tasks::policy::{
    self, CallerAgent, MAX_DEPTH, MAX_OPEN_TASKS, SPAWN_OPS, WORKER_OPS,
};
use fleetd::node::runner::claude::{
    AGENT_DISALLOWED_WHY, ASSISTANT_ALLOWED_WHY, ASSISTANT_ASK_WHY, AUTO_MEMORY_OFF_ENV,
    AUTO_MEMORY_OFF_WHY, DEFAULT_ENV_WHY, DISALLOWED_WHY, HELPER_MODEL_ENV, HELPER_MODEL_WHY,
    LEAD_DISALLOWED_WHY, NESTING_VARS_WHY, PROMPT_CACHE_TTL_VARS, PROMPT_CACHE_TTL_WHY,
    SESSION_ENV_WHY, SUBAGENTS_OFF_ENV_WHY, SUBAGENTS_ON_ENV_WHY, WORKER_ENV, WORKER_ENV_WHY,
};
use fleetd::node::runner::claude::{conformance, version::TESTED};
use fleetd_contracts::lead_calls::GatedRunCall;
use fleetd_contracts::ledger::GatedClass;
use fleetd_contracts::live::AgentRole;
use fleetd_contracts::schema::inline_schema;
use fleetd_contracts::sessions::SessionRole;
use fleetd_contracts::tasks::{TaskId, TaskKind};
use serde_json::{Value, json};

/// Under Starlight's content directory.
pub const PATH: &str = "reference/agent-tools.md";

const FRONT: &str = "---
title: Agent tools
description: The tools fleetd gives each agent, the Claude Code tools it blocks, the settings it forces and the limits the hub enforces.
sidebar: { order: 20 }
---
";

const INTRO: &str = "Generated from fleetd's source by `cargo run -p docsgen`, so it matches the code. Don't edit this \
file by hand: CI fails when it differs from the generator's output.

Every agent fleetd starts is a Claude Code session. fleetd adds its own MCP server, named `{server}`, with the tools \
for the agent's role. Claude Code shows them as `mcp__{server}__<tool>`. Each call goes to the hub, which checks it \
whatever the prompt says.

";

const SETUP: &str = "## What your own setup adds

fleetd starts sessions with your own Claude Code setup underneath.

| Your setup | In a session |
|---|---|
| MCP servers (user, project, local) | Loaded. fleetd adds its `{server}` server next to them. |
| Skills, plugins, hooks, `CLAUDE.md` | Loaded as in your own `claude`. |
| Allow and deny rules | Applied. fleetd's blocked tools stay blocked: its settings outrank yours. |
| Your own agents (`~/.claude/agents`) | Listed, but nothing can start them: the Agent tool is blocked. |
| Env in your settings | Applied, except the switches above, which fleetd sets last. |

A project's policy file can add rules for its sessions: `tools.allow` and `tools.deny` (Claude Code rule syntax).

### See it in a session

| Where | What you see |
|---|---|
| App: open an agent in the panel's Agents tab, then **What it was told** | \"What the writer was told\": the exact first message, which prompt versions it used and the tools it never gets. |
| CLI on the hub machine: `fleetd prompts show --session <machine>/<thread>` | The first message alone. |
| MCP client: `session_prompt_get` | The same as the app. |
| `claude mcp list` in the project's folder | Your own MCP servers, which the session loads too. |
";

pub fn page(root: &Path) -> Result<String, String> {
    let lead_tools: Vec<&Tool> = agent_mcp::tools_for(Role::Lead).collect();
    let task_tools: Vec<&Tool> = agent_mcp::tools_for(Role::Worker).collect();
    let mut md = String::from(FRONT);
    md.push('\n');
    md.push_str(&INTRO.replace("{server}", SERVER_NAME));
    md.push_str(&roles());
    md.push_str(&limits(&lead_tools, &task_tools)?);
    md.push_str(&tool_section(
        "Lead tools",
        "Every lead gets these.",
        Role::Lead,
        &lead_tools,
        &[],
    )?);
    let lead_names: Vec<&str> = lead_tools.iter().map(|t| t.name).collect();
    md.push_str(&tool_section(
        "Task tools",
        "Every task's agent gets these: implementers, readers, reviewers and QA.",
        Role::Worker,
        &task_tools,
        &lead_names,
    )?);
    md.push_str(&builtins(root)?);
    md.push_str(&switches()?);
    md.push_str(&SETUP.replace("{server}", SERVER_NAME));
    Ok(md)
}

fn cell(text: &str) -> String {
    prose(&text.split_whitespace().collect::<Vec<_>>().join(" ")).replace('|', "\\|")
}

/// Source text as markdown that shows it literally: outside code spans, `<n>` is not an HTML tag and `*` is not
/// emphasis.
fn prose(text: &str) -> String {
    let mut out = String::new();
    for (i, part) in text.split('`').enumerate() {
        if i > 0 {
            out.push('`');
        }
        if i % 2 == 1 {
            out.push_str(part);
        } else {
            out.push_str(&part.replace('<', "&lt;").replace('*', "\\*"));
        }
    }
    out
}

/// Consecutive items that share a reason, as one row each.
fn grouped<'a>(items: impl IntoIterator<Item = (String, &'a str)>) -> Vec<(Vec<String>, &'a str)> {
    let mut rows: Vec<(Vec<String>, &str)> = Vec::new();
    for (item, why) in items {
        match rows.last_mut() {
            Some((names, last)) if *last == why => names.push(item),
            _ => rows.push((vec![item], why)),
        }
    }
    rows
}

fn code_list<'a>(items: impl IntoIterator<Item = &'a str>) -> String {
    items
        .into_iter()
        .map(|i| format!("`{i}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn task_caller() -> CallerAgent {
    CallerAgent::Task(TaskId::unchecked("T1"))
}

/// The role's word as the app shows it.
fn role_name(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Lead => "Lead",
        AgentRole::Implementer => "Implementer",
        AgentRole::Reader => "Reader",
        AgentRole::Reviewer => "Reviewer",
        AgentRole::Verifier => "Verifier",
        AgentRole::Qa => "QA",
    }
}

/// How fleetd starts a session of this role, which picks its MCP tools.
fn session_role(role: AgentRole) -> SessionRole {
    match role {
        AgentRole::Lead => SessionRole::Lead,
        AgentRole::Implementer
        | AgentRole::Reader
        | AgentRole::Reviewer
        | AgentRole::Verifier
        | AgentRole::Qa => SessionRole::Worker,
    }
}

/// How a task of `role` is started, from the hub's own kind-to-role rule.
fn started_as(role: AgentRole) -> Option<String> {
    for kind in [TaskKind::Write, TaskKind::Read, TaskKind::Review] {
        for qa in [false, true] {
            if phase::role(kind, qa) != role {
                continue;
            }
            let kind = serde_json::to_value(kind).ok()?;
            let kind = kind.as_str()?;
            let mut how = format!("`spawn_agent` with kind `{kind}`");
            if qa {
                how.push_str(" and `qa: true`");
            }
            if kind == "write" {
                how.push_str(". Gets its own worktree and branch");
            }
            return Some(how);
        }
    }
    None
}

fn tool_set(session: SessionRole) -> &'static str {
    match session.cli_arg() {
        Some("lead") => "[Lead tools](#lead-tools)",
        Some(_) => "[Task tools](#task-tools)",
        None => "None",
    }
}

fn roles() -> String {
    let mut md = String::from(
        "## Roles\n\nThe app shows each agent's role on its lane. The role decides the fleetd tools; every session \
         gets the same [Claude Code tools](#claude-code-tools).\n\n| Role | How it starts | fleetd tools | Can start \
         agents |\n|---|---|---|---|\n",
    );
    let can_spawn = |caller: &CallerAgent| {
        if SPAWN_OPS.iter().all(|op| policy::check(caller, op).is_ok()) {
            "Yes"
        } else {
            "No"
        }
    };
    for role in [
        AgentRole::Lead,
        AgentRole::Implementer,
        AgentRole::Reader,
        AgentRole::Reviewer,
        AgentRole::Qa,
    ] {
        let session = session_role(role);
        let (how, caller) = match session {
            SessionRole::Lead => (
                "One per project, started by the project's first order".to_owned(),
                CallerAgent::Lead,
            ),
            _ => (
                started_as(role).unwrap_or_else(|| "A task".to_owned()),
                task_caller(),
            ),
        };
        md.push_str(&format!(
            "| {} | {how} | {} | {} |\n",
            role_name(role),
            tool_set(session),
            can_spawn(&caller)
        ));
    }
    md.push('\n');
    md
}

/// The tool names for lead-call `ops`, in the order given, each once; None when an op has no tool.
fn names_of<'a>(ops: &[&str], tools: &[&'a Tool]) -> Option<Vec<&'a str>> {
    let mut names: Vec<&str> = Vec::new();
    for op in ops {
        let name = tools.iter().find(|t| t.op == *op)?.name;
        if !names.contains(&name) {
            names.push(name);
        }
    }
    Some(names)
}

fn enum_values(schema: &Value) -> Vec<String> {
    schema["enum"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

fn limits(lead: &[&Tool], task: &[&Tool]) -> Result<String, String> {
    let (Some(spawners), Some(worker_calls)) =
        (names_of(SPAWN_OPS, lead), names_of(WORKER_OPS, task))
    else {
        return Err("agent tools: a hub policy op has no MCP tool".into());
    };
    let gated = inline_schema::<GatedRunCall>();
    let timeout = gated["properties"]["timeoutSec"]["maximum"]
        .as_u64()
        .ok_or("agent tools: gated_run's timeoutSec has no maximum")?;
    let gated_classes = enum_values(&inline_schema::<GatedClass>());
    let mut md = String::from(
        "## Hub limits\n\nThe hub checks these on every fleetd call a session makes, through its MCP tools or a \
         `fleetd` command in its shell. A refusal says why and what to do instead.\n\n| Limit | Value |\n|---|---|\n",
    );
    md.push_str(&format!(
        "| Who can start agents | A lead, with {}. A task's agent can't. |\n",
        code_list(spawners.iter().copied())
    ));
    md.push_str(&format!(
        "| Depth | {MAX_DEPTH}. A lead is depth 0 and its tasks depth {MAX_DEPTH}; nothing goes deeper. |\n"
    ));
    md.push_str(&format!(
        "| Open tasks per lead | {MAX_OPEN_TASKS}, or twice the project's max agents when that is more (queued, running \
         or idle). |\n"
    ));
    md.push_str(
        "| Agents running at once, per project | The project's max agents, which a person sets (`cap_set`, the \
         chat's Max agents); unset, its machine's cap within the fleet cap. A spawn over it queues and starts by itself; a review goes \
         ahead of queued writers. The lead is not an agent and doesn't count. |\n",
    );
    md.push_str(&format!(
        "| Agents running at once, per machine | The machine's max agents, which a person may set up to the fleet cap \
         (`cap_set`, `fleetd machine set`, Settings › Hub › Machines). Unset: what the machine fits, one per CPU less one in \
         eight, and 2 GB of memory each after a quarter (4 to 16 GB) is left for the system, at most {HARD_TOP}. \
         Either way new agents pause while memory in use runs short, and wait for 5 GB of disk each above the \
         free-space floor. |\n"
    ));
    md.push_str(
        "| Agents running at once, fleet-wide | The machines' caps added up, unless a person set a fleet cap. |\n",
    );
    md.push_str(&format!(
        "| Calls a task's agent may make | {}. Every other call is refused. |\n",
        code_list(worker_calls.iter().copied())
    ));
    md.push_str(&format!(
        "| Gated commands (`gated_run`) | Classes {}. Run only after a human approves; at most {timeout} s. |\n",
        code_list(gated_classes.iter().map(String::as_str))
    ));
    md.push('\n');
    md.push_str(
        "These limits cover calls to fleetd, not what the agent's own shell can do. A task runs with full Bash, so \
         `gated_run` is not the only way it could run a command. A process that leaves its session's process tree \
         (for example with `setsid`) and scrubs its environment counts as you, with no limits: see \"Known limit\" \
         on the Security page. Run agents you don't trust as a different OS user.\n\n",
    );
    Ok(md)
}

/// The roles that are offered a tool making call `op` and that the hub lets make it.
fn who_may_call(tool: &Tool) -> String {
    let op = tool.op;
    // The hub refuses them to every lead but a Navi's (`hub/navi/bridge.rs`).
    if fleetd::hub::navi::bridge::OPS.contains(&op) {
        return "a Navi's lead".into();
    }
    let mut who = Vec::new();
    for (role, caller, name) in [
        (Role::Lead, CallerAgent::Lead, "a lead"),
        (Role::Worker, task_caller(), "a task's agent"),
    ] {
        // A browser call never reaches the hub's policy: the session's own node answers it.
        if agent_mcp::tools_for(role).any(|t| t.op == op)
            && (tool.browser || policy::check(&caller, op).is_ok())
        {
            who.push(name);
        }
    }
    who.join(", ")
}

/// A heading for `tool`, unique on the page: a task tool that has a lead namesake says so.
fn heading(tool: &Tool, taken: &[&str]) -> String {
    if taken.contains(&tool.name) {
        format!("{} (task)", tool.name)
    } else {
        tool.name.to_owned()
    }
}

fn anchor(heading: &str) -> String {
    crate::slugify(heading)
}

fn tool_section(
    title: &str,
    intro: &str,
    role: Role,
    tools: &[&Tool],
    taken: &[&str],
) -> Result<String, String> {
    let mut md = format!(
        "## {title}\n\n{intro}\n\n| Tool | What it does | Needs a human |\n|---|---|---|\n"
    );
    for tool in tools {
        let h = heading(tool, taken);
        md.push_str(&format!(
            "| [`{}`](#{}) | {} | {} |\n",
            tool.name,
            anchor(&h),
            cell(first_sentence(tool.description)),
            cell(tool.human.unwrap_or("No")),
        ));
    }
    md.push('\n');
    for tool in tools {
        let h = heading(tool, taken);
        md.push_str(&format!("### {h}\n\n{}\n\n", prose(tool.description)));
        let schema = (tool.schema)();
        let mut rows = Vec::new();
        params(&schema, "", &mut rows);
        if rows.is_empty() {
            md.push_str("No parameters.\n\n");
        } else {
            md.push_str("| Parameter | Type | Required | Description |\n|---|---|---|---|\n");
            for row in rows {
                md.push_str(&format!(
                    "| `{}` | {} | {} | {} |\n",
                    row.name,
                    row.ty,
                    if row.required { "yes" } else { "no" },
                    cell(&row.description)
                ));
            }
            md.push('\n');
        }
        let checked = match tool.browser {
            true => "answered by its node, which runs the browser",
            false => "checked by the hub",
        };
        md.push_str(&format!(
            "**Who may call:** {}, {checked}. **Needs a human:** {}\n\n",
            who_may_call(tool),
            tool.human.unwrap_or("no.")
        ));
        let arguments = example(role, tool.name)
            .ok_or_else(|| format!("agent tools: {} has no example call", tool.name))?;
        check_example(role, tool, &arguments)?;
        // Written by hand so `name` comes first; serde_json's map sorts keys.
        let arguments = serde_json::to_string_pretty(&arguments)
            .map_err(|e| e.to_string())?
            .replace('\n', "\n  ");
        md.push_str(&format!(
            "```json\n{{\n  \"name\": \"{}\",\n  \"arguments\": {arguments}\n}}\n```\n\n",
            tool.name
        ));
    }
    Ok(md)
}

fn first_sentence(text: &str) -> &str {
    match text.find(". ") {
        Some(i) => &text[..=i],
        None => text,
    }
}

struct Param {
    name: String,
    ty: String,
    required: bool,
    description: String,
}

/// One row per property, nested objects and arrays of objects flattened as `a.b` and `a[].b`.
fn params(schema: &Value, prefix: &str, rows: &mut Vec<Param>) {
    let required: Vec<&str> = schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let Some(props) = schema["properties"].as_object() else {
        return;
    };
    for (key, prop) in props {
        let name = format!("{prefix}{key}");
        rows.push(Param {
            name: name.clone(),
            ty: type_of(prop),
            required: required.contains(&key.as_str()),
            description: describe(prop),
        });
        if prop["properties"].is_object() {
            params(prop, &format!("{name}."), rows);
        } else if prop["items"]["properties"].is_object() {
            params(&prop["items"], &format!("{name}[]."), rows);
        }
    }
}

fn type_of(prop: &Value) -> String {
    if let Some(t) = prop["type"].as_str() {
        return match t {
            "array" => format!("{}[]", type_of(&prop["items"])),
            "number" | "integer" | "boolean" | "string" | "object" => t.to_owned(),
            other => other.to_owned(),
        };
    }
    let variants = prop["oneOf"]
        .as_array()
        .or_else(|| prop["anyOf"].as_array());
    let types: BTreeSet<String> = variants.into_iter().flatten().map(type_of).collect();
    match types.len() {
        1 => types.into_iter().next().unwrap_or_default(),
        0 => "any".to_owned(),
        _ => types.into_iter().collect::<Vec<_>>().join(" or "),
    }
}

/// The property's own description, cleaned of source-code notation, then its constraints in words.
fn describe(prop: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(d) = prop["description"].as_str() {
        parts.push(clean(d));
    }
    let values = enum_values(prop);
    if !values.is_empty() {
        parts.push(format!(
            "One of {}.",
            code_list(values.iter().map(String::as_str))
        ));
    }
    if let Some(variants) = prop["oneOf"]
        .as_array()
        .or_else(|| prop["anyOf"].as_array())
    {
        let consts: Vec<String> = variants
            .iter()
            .filter_map(|v| {
                let c = v["const"].as_str().map(str::to_owned).or_else(|| {
                    let e = enum_values(v);
                    (e.len() == 1).then(|| e[0].clone())
                })?;
                Some(match v["description"].as_str() {
                    Some(d) => format!("`{c}` ({})", d.trim_end_matches('.')),
                    None => format!("`{c}`"),
                })
            })
            .collect();
        let shapes: Vec<String> = variants
            .iter()
            .filter_map(|v| v["properties"].as_object())
            .map(|p| format!("{{{}}}", p.keys().cloned().collect::<Vec<_>>().join(", ")))
            .collect();
        if !consts.is_empty() && consts.len() == variants.len() {
            parts.push(format!("One of {}.", consts.join(", ")));
        }
        if !shapes.is_empty() {
            parts.push(format!("One of these shapes: {}.", shapes.join("; ")));
        }
        if prop["description"].is_null() {
            let other: Vec<String> = variants
                .iter()
                .filter(|v| v["const"].is_null() && enum_values(v).is_empty())
                .filter_map(|v| v["description"].as_str().map(clean))
                .collect();
            parts.extend(other);
        }
    }
    if prop["description"].is_null()
        && let Some(p) = prop["pattern"].as_str()
    {
        parts.push(pattern_words(p));
    }
    let len = (prop["minLength"].as_u64(), prop["maxLength"].as_u64());
    if let (_, Some(max)) = len {
        parts.push(format!("At most {max} characters."));
    }
    if let Some(max) = prop["maxItems"].as_u64() {
        parts.push(format!("At most {max} items."));
    }
    match (prop["minimum"].as_f64(), prop["maximum"].as_f64()) {
        (Some(min), Some(max)) if max < 1e12 => parts.push(format!("{min} to {max}.")),
        (Some(min), _) if min > 0.0 => parts.push(format!("At least {min}.")),
        _ => {}
    }
    if let Some(d) = prop.get("default")
        && !(d.is_array() && d.as_array().is_some_and(Vec::is_empty))
    {
        parts.push(format!("Default `{d}`."));
    }
    parts.retain(|p| !p.is_empty());
    parts.join(" ")
}

/// `^T[1-9][0-9]*$` reads as "`T<n>`, e.g. `T1`".
fn pattern_words(pattern: &str) -> String {
    if let Some(letter) = pattern
        .strip_prefix('^')
        .and_then(|p| p.strip_suffix("[1-9][0-9]*$"))
        && letter.len() == 1
    {
        return format!("`{letter}<n>`, e.g. `{letter}1`.");
    }
    match pattern {
        r"^[^\r\n]*$" => "One line.".to_owned(),
        "^/" => "An absolute path.".to_owned(),
        _ => format!("Matches `{pattern}`."),
    }
}

/// Doc comments are written for the source: drop rustdoc links, a CLI flag prefix and milestone tags.
fn clean(text: &str) -> String {
    let mut text = text.replace("[`", "`").replace("`]", "`");
    if text.starts_with("`--")
        && let Some(i) = text.find("`: ")
    {
        text = text[i + 3..].to_owned();
    }
    if let Some(rest) = text.strip_prefix('M')
        && let Some((n, rest)) = rest.split_once(": ")
        && n.chars().all(|c| c.is_ascii_digit())
    {
        text = rest.to_owned();
    }
    if text.starts_with("https://") && !text.contains(' ') {
        return format!("Like `{text}`.");
    }
    let mut chars = text.chars();
    let text = match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => text,
    };
    if text.ends_with('.') || text.ends_with(')') {
        text
    } else {
        format!("{text}.")
    }
}

/// An example call per tool. Checked against the tool's schema when the page is generated.
fn example(role: Role, tool: &str) -> Option<Value> {
    Some(match (role, tool) {
        (Role::Lead, "spawn_agent") => json!({
            "workstreamId": "W3",
            "kind": "write",
            "title": "Rate-limit the upload API",
            "prompt": "Limit uploads to 10 a minute per API key. Over the limit, answer 429 with Retry-After.",
        }),
        (Role::Lead, "message_agent") => json!({
            "taskId": "T7",
            "message": "Keep the old endpoint working until the mobile client ships.",
        }),
        (Role::Lead, "agents") => json!({ "state": "running" }),
        (Role::Lead, "stop_agent") => json!({ "taskId": "T7", "reason": "T9 covers this now." }),
        (Role::Lead, "brief") => json!({
            "text": "Rate-limit the upload API",
            "brief": {
                "goal": "Uploads are rate-limited per API key.",
                "why": "One client's retry loop took the upload service down.",
                "pointers": ["api/src/upload.rs"],
                "constraints": ["No new service; use the existing Redis."],
                "doneWhen": ["A client past its limit gets 429 with Retry-After."],
            },
        }),
        (Role::Lead, "request_secret") => json!({
            "key": "stripe.test_key",
            "sink": "env:shop-box:/srv/shop/.env",
            "text": "The Stripe test key for checkout",
            "workstreamId": "W3",
        }),
        (Role::Lead, "request_withdraw") => json!({ "requestId": "Q4" }),
        (Role::Lead, "decide") => json!({
            "key": "api.pagination",
            "value": "cursor",
            "why": "Stable when rows are inserted mid-scroll.",
        }),
        (Role::Lead, "close") => json!({
            "workstreamId": "W3",
            "why": "The rate limit is merged and live.",
        }),
        (Role::Lead, "gated_run") => json!({
            "argv": ["fly", "deploy", "--app", "shop-prod"],
            "class": "irreversible",
            "reason": "Ship the upload rate limit to production.",
            "workstreamId": "W3",
        }),
        (_, "decisions_search") => json!({ "query": "pagination" }),
        (Role::Lead, "remember") => json!({
            "scope": "project",
            "text": "No npm here: use pnpm.",
            "replaces": "Use npm",
        }),
        (Role::Lead, "forget") => json!({
            "scope": "project",
            "entry": "Deploys freeze on Fridays",
            "reason": "The freeze ended with the launch.",
        }),
        (Role::Lead, "memory_read") => json!({ "topic": "deploys" }),
        (Role::Lead, "nudge") => json!({ "reason": "the new checkout page" }),
        (Role::Lead, "automation_create") => json!({
            "name": "Weekly dependency check",
            "prompt": "Check the dependencies for updates and open one PR with the safe ones.",
            "schedule": { "cron": "0 9 * * 1", "tz": "Europe/Berlin" },
        }),
        (Role::Lead, "automation_list") => json!({}),
        (Role::Lead, "automation_update") => json!({
            "automationId": "au_k3Jd8sQp2xYz",
            "schedule": { "cron": "0 9 * * 1-5", "tz": "Europe/Berlin" },
        }),
        (Role::Lead, "automation_pause") => json!({
            "automationId": "au_k3Jd8sQp2xYz",
            "paused": true,
        }),
        (Role::Lead, "automation_delete") => json!({ "automationId": "au_k3Jd8sQp2xYz" }),
        (Role::Lead, "automation_run") => json!({ "automationId": "au_k3Jd8sQp2xYz" }),
        (Role::Lead, "automation_runs") => json!({
            "automationId": "au_k3Jd8sQp2xYz",
            "runId": "ar_Qm7tZr1vBn4w",
        }),
        (Role::Lead, "checklist") => json!({
            "items": [
                { "id": 2, "state": "done" },
                { "id": 3, "state": "doing", "link": { "pr": "https://github.com/acme/shop/pull/42" } },
                { "text": "Ship the rate limit to production" },
            ],
        }),
        (Role::Lead, "skill_install") => {
            json!({ "source": "vercel-labs/agent-skills@web-design-guidelines", "scope": "project" })
        }
        (Role::Lead, "project_message") => json!({
            "project": "storefront",
            "text": "Please add gift cards at checkout; the person asked for it this morning.",
        }),
        (Role::Lead, "factory_status") => json!({ "project": "storefront" }),
        (Role::Lead, "usage_resume") => json!({ "machineId": "devbox" }),
        (Role::Lead, "change_enqueue") => json!({
            "prUrl": "https://github.com/acme/shop/pull/42",
            "workstreamId": "W3",
        }),
        (Role::Worker, "report") => json!({
            "blocking": 0,
            "nonBlocking": 2,
            "summary": "The limiter is correct. Two nits: a magic number and a missing test for the reset.",
        }),
        (Role::Worker, "ask_lead") => json!({
            "question": "Should the limit apply to admin keys too?",
        }),
        (Role::Worker, "brief_read") => json!({}),
        (_, "review_read") => json!({ "pr": "https://github.com/acme/storefront/pull/7" }),
        (_, "preview_suggest") => json!({
            "prUrl": "https://github.com/acme/storefront/pull/7",
            "why": "The checkout's buttons read differently in German and Dutch",
        }),
        (_, "preview_config_propose") => json!({
            "config": { "web": {
                "setup": ["pnpm install --frozen-lockfile"],
                "build": "pnpm build",
                "start": "pnpm preview --port $PORT --host 127.0.0.1",
                "inputs": ["pnpm-lock.yaml"],
            } },
            "why": "The storefront is a Vite app",
        }),
        (_, "preview_start") => json!({
            "of": { "kind": "pr", "repo": "acme/storefront", "number": 7 },
        }),
        (_, "session_start") => json!({
            "purpose": "Check that signup works on the staging site",
        }),
        (_, "session_end") => json!({}),
        (_, "request_takeover") => json!({
            "reason": "Solve the captcha on the signup page, then hand the browser back",
        }),
        (_, "fill_credential") => json!({
            "ref": "op://Staging/Shop admin/password",
            "target": "input[name=password]",
        }),
        (_, "desktop") => json!({
            "action": "left_click",
            "coordinate": [640, 412],
        }),
        _ => return None,
    })
}

/// The MCP server's own decoder accepts it, and every key is one the schema names (serde would drop an unknown one).
fn check_example(role: Role, tool: &Tool, arguments: &Value) -> Result<(), String> {
    agent_mcp::call_of(role, tool.name, arguments.clone())
        .map_err(|e| format!("agent tools: the example for {}: {e}", tool.name))?;
    unknown_keys(arguments, &(tool.schema)(), "").map_err(|key| {
        format!(
            "agent tools: the example for {} has {key}, which its schema doesn't",
            tool.name
        )
    })
}

fn unknown_keys(value: &Value, schema: &Value, at: &str) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            let variants: Vec<&Value> = schema["oneOf"]
                .as_array()
                .or_else(|| schema["anyOf"].as_array())
                .map(|v| v.iter().collect())
                .unwrap_or_else(|| vec![schema]);
            let fits = |s: &Value| {
                map.iter().all(|(k, v)| {
                    s["properties"]
                        .get(k)
                        .is_some_and(|p| unknown_keys(v, p, "").is_ok())
                })
            };
            if variants.iter().any(|s| fits(s)) {
                return Ok(());
            }
            let s = variants[0];
            for (k, v) in map {
                let Some(p) = s["properties"].get(k) else {
                    return Err(format!("{at}{k}"));
                };
                unknown_keys(v, p, &format!("{at}{k}."))?;
            }
            Ok(())
        }
        Value::Array(items) => items
            .iter()
            .try_for_each(|i| unknown_keys(i, &schema["items"], &format!("{at}[]."))),
        _ => Ok(()),
    }
}

/// Claude Code's built-in tools as the version fleetd is tested with lists them, from the `system/init` lines in the
/// runner's recorded fixtures.
fn recorded_tools(root: &Path) -> Result<BTreeSet<String>, String> {
    let dir = root.join("crates/fleetd/src/node/runner/fixtures");
    let prefix = format!("claude-{TESTED}-");
    let mut tools = BTreeSet::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&prefix) || !name.ends_with(".jsonl") {
            continue;
        }
        let text = std::fs::read_to_string(entry.path()).map_err(|e| format!("{name}: {e}"))?;
        for line in text.lines() {
            let Ok(frame) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let msg = &frame["msg"];
            if msg["type"] == "system" && msg["subtype"] == "init" {
                tools.extend(
                    msg["tools"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .filter(|t| !t.starts_with("mcp__"))
                        .map(str::to_owned),
                );
            }
        }
    }
    if tools.is_empty() {
        return Err(format!(
            "agent tools: no claude {TESTED} init in {}",
            dir.display()
        ));
    }
    Ok(tools)
}

fn builtins(root: &Path) -> Result<String, String> {
    let blocked: Vec<&str> = DISALLOWED_WHY.iter().map(|(t, _)| *t).collect();
    let allowed: Vec<String> = recorded_tools(root)?
        .into_iter()
        .filter(|t| !blocked.contains(&t.as_str()) && !conformance::agent_like(t))
        .collect();
    let mut md = format!(
        "## Claude Code tools\n\nListed for Claude Code \
         {TESTED}, the version fleetd is tested with.\n\n**Allowed:** {}.\n\nA project's policy file can deny more \
         with `tools.deny`.\n\n**Blocked**, in `--disallowedTools` and in the \
         `permissions.deny` of fleetd's settings, so your own settings can't turn them back on:\n\n| Tool | Why \
         |\n|---|---|\n",
        code_list(allowed.iter().map(String::as_str))
    );
    for (tools, why) in grouped(
        DISALLOWED_WHY
            .iter()
            .map(|(t, why)| (format!("`{t}`"), *why)),
    ) {
        md.push_str(&format!("| {} | {} |\n", tools.join(", "), cell(why)));
    }
    md.push_str(
        "\nfleetd also blocks any tool like these that a newer Claude Code adds: a session whose tool list still offers \
         one is stopped, and every later session on that machine blocks it.\n\n**Blocked for fleetd's agents**, in \
         `--disallowedTools`; threads you start keep them:\n\n| Tool | Sessions | Why |\n|---|---|---|\n",
    );
    for (list, who) in [
        (AGENT_DISALLOWED_WHY, "Leads and task agents"),
        (LEAD_DISALLOWED_WHY, "Leads"),
    ] {
        for (tools, why) in grouped(list.iter().map(|(t, why)| (format!("`{t}`"), *why))) {
            md.push_str(&format!(
                "| {} | {who} | {} |\n",
                tools.join(", "),
                cell(why)
            ));
        }
    }
    md.push_str(
        "\n**A Navi's lead** keeps `Edit`, `Write`, `WebFetch` and `WebSearch`, and runs in `manual` permission mode: \
         any tool not below asks first. Its file tools and fetches always ask, in its settings' `permissions.ask`, \
         whatever your own settings allow. The node answers a file tool: allowed inside the Navi's own folder, \
         refused outside it (and for its `.claude`, `.mcp.json` and `.fleetd`), whoever approves it. A policy file's \
         allow rules don't apply to it. The node also answers a shell command: it runs, held by the OS sandbox \
         (decision `navi.shell-unasked`, D208), unless it opens a site in the browser. A fetch or `agent-browser \
         open` goes through without asking to a site the person allowed at its first visit or linked in their own \
         chat message. Any other ask reaches the person as an approval in the Navi's chat, showing the tool and \
         exactly what it would get.\n\n| Allowed without asking | Why |\n|---|---|\n",
    );
    for (tools, why) in grouped(
        ASSISTANT_ALLOWED_WHY
            .iter()
            .map(|(t, why)| (format!("`{t}`"), *why)),
    ) {
        md.push_str(&format!("| {} | {} |\n", tools.join(", "), cell(why)));
    }
    md.push_str("\n| Always asked | Why |\n|---|---|\n");
    for (tools, why) in grouped(
        ASSISTANT_ASK_WHY
            .iter()
            .map(|(t, why)| (format!("`{t}`"), *why)),
    ) {
        md.push_str(&format!("| {} | {} |\n", tools.join(", "), cell(why)));
    }
    md.push('\n');
    Ok(md)
}

fn switches() -> Result<String, String> {
    let all = "Every claude fleetd starts";
    let cache: Vec<(String, String)> = PROMPT_CACHE_TTL_VARS
        .iter()
        .chain(WORKER_ENV.iter().map(|(k, _)| k))
        .map(|v| ((*v).to_owned(), String::new()))
        .collect();
    let overlay: Value = serde_json::from_str(&fleetd::node::sessions::settings_overlay(
        &cache,
        Default::default(),
        HELPER_MODEL_ENV.1,
        &[],
        false,
    ))
    .map_err(|e| format!("agent tools: the settings overlay: {e}"))?;
    let mut md = String::from(
        "## Settings fleetd forces\n\nSet in the claude process's environment. \"In settings\" marks the ones also \
         in fleetd's settings file for a session, which outranks the `env` in your own settings.\n\n| Variable | \
         Value | Where | In settings | Why |\n|---|---|---|---|---|\n",
    );
    let mut rows = |items: Vec<(String, &str)>, value: &str, where_: &str| {
        for (names, why) in grouped(items) {
            let in_settings = names
                .iter()
                .all(|n| overlay["env"].get(n.trim_matches('`')).is_some());
            md.push_str(&format!(
                "| {} | {value} | {where_} | {} | {} |\n",
                names.join(", "),
                if in_settings { "yes" } else { "no" },
                cell(why)
            ));
        }
    };
    for ((name, value), why) in SUBAGENTS_OFF_ENV_WHY {
        rows(vec![(format!("`{name}`"), why)], &format!("`{value}`"), all);
    }
    let named = |list: &[(&str, &'static str)]| -> Vec<(String, &'static str)> {
        list.iter()
            .map(|(n, why)| (format!("`{n}`"), *why))
            .collect()
    };
    rows(named(SUBAGENTS_ON_ENV_WHY), "removed", all);
    let (name, value) = AUTO_MEMORY_OFF_ENV;
    rows(
        vec![(format!("`{name}`"), AUTO_MEMORY_OFF_WHY)],
        &format!("`{value}`, and `autoMemoryEnabled: false`"),
        all,
    );
    let (name, value) = HELPER_MODEL_ENV;
    rows(
        vec![(format!("`{name}`"), HELPER_MODEL_WHY)],
        &format!("The high profile's model: `{value}` unless a setting chose another"),
        all,
    );
    for ((name, value), why) in SESSION_ENV_WHY {
        rows(
            vec![(format!("`{name}`"), why)],
            &format!("`{value}`"),
            "Sessions",
        );
    }
    for ((name, value), why) in DEFAULT_ENV_WHY {
        rows(
            vec![(format!("`{name}`"), why)],
            &format!("`{value}` unless your environment or `claude.env` sets it"),
            all,
        );
    }
    for ((role, ttl), why) in PROMPT_CACHE_TTL_WHY {
        let who = match role {
            SessionRole::Lead => "Leads",
            SessionRole::Assistant => "Navis' leads",
            SessionRole::Worker => "Task agents",
            SessionRole::Plain => "Threads you start",
        };
        rows(
            PROMPT_CACHE_TTL_VARS
                .iter()
                .map(|n| (format!("`{n}`"), *why))
                .collect(),
            &format!(
                "`{}` unless your environment or `claude.env` sets it",
                ttl.as_str()
            ),
            who,
        );
    }
    for ((name, value), why) in WORKER_ENV_WHY {
        rows(
            vec![(format!("`{name}`"), why)],
            &format!("`{value}` unless your environment or `claude.env` sets it"),
            "Task agents",
        );
    }
    rows(named(NESTING_VARS_WHY), "removed", "Sessions");
    md.push('\n');
    Ok(md)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    #[test]
    fn an_example_with_a_key_the_schema_lacks_is_refused() {
        let tool = agent_mcp::tools_for(Role::Lead)
            .find(|t| t.name == "agents")
            .unwrap();
        let bad = json!({ "taskId": "T1", "taskID": "T1" });
        let error = check_example(Role::Lead, tool, &bad).unwrap_err();
        assert!(error.contains("taskID"), "{error}");
        let wrong = json!({ "taskId": "seven" });
        assert!(check_example(Role::Lead, tool, &wrong).is_err());
    }

    #[test]
    fn every_blocked_tool_and_switch_is_on_the_page() {
        let page = page(&root()).unwrap();
        let blocked = page.split("**Blocked**").nth(1).unwrap();
        for (tool, _) in DISALLOWED_WHY {
            assert!(blocked.contains(&format!("`{tool}`")), "{tool}");
        }
        for ((name, _), _) in SUBAGENTS_OFF_ENV_WHY
            .iter()
            .chain(SESSION_ENV_WHY)
            .chain(DEFAULT_ENV_WHY)
        {
            assert!(page.contains(&format!("| `{name}` |")), "{name}");
        }
        let [own, helpers] = PROMPT_CACHE_TTL_VARS;
        assert_eq!(
            page.matches(&format!("| `{own}`, `{helpers}` |")).count(),
            PROMPT_CACHE_TTL_WHY.len()
        );
        // Allowed and blocked never overlap.
        let allowed = page
            .split("**Allowed:**")
            .nth(1)
            .unwrap()
            .split('\n')
            .next()
            .unwrap();
        for (tool, _) in DISALLOWED_WHY {
            assert!(!allowed.contains(&format!("`{tool}`")), "{tool}");
        }
        for (tool, _) in AGENT_DISALLOWED_WHY.iter().chain(LEAD_DISALLOWED_WHY) {
            assert!(blocked.contains(&format!("`{tool}`")), "{tool}");
        }
        assert!(allowed.contains("`Bash`") && allowed.contains("`Edit`"));
    }

    #[test]
    fn source_text_shows_literally() {
        assert_eq!(
            prose("done:<n> or `T<n>`, a*"),
            "done:&lt;n> or `T<n>`, a\\*"
        );
    }

    #[test]
    fn schema_words() {
        assert_eq!(pattern_words("^T[1-9][0-9]*$"), "`T<n>`, e.g. `T1`.");
        assert_eq!(
            clean("`--item P<n>`: the plan item this task works on"),
            "The plan item this task works on."
        );
        assert_eq!(clean("A [`Brief`] whose"), "A `Brief` whose.");
        assert_eq!(clean("M9: a research judge"), "A research judge.");
        assert_eq!(
            clean("https://github.com/<owner>/<name>/pull/<n>"),
            "Like `https://github.com/<owner>/<name>/pull/<n>`."
        );
    }
}
