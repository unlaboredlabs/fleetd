//! `fleetd agent-mcp --role lead|worker`: the MCP server (stdio, one JSON-RPC message per line) the node puts in every
//! lead's and task's `--mcp-config`. Each tool is one lead-side call, sent through the node's socket with the session's
//! `FLEETD_THREAD_ID`; the hub decides who may make it (`hub/tasks/policy.rs`). The
//! role only picks which tools are listed. Results that take time (a task's result, an answer, an approval) arrive
//! in a later wake, never by polling.
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use fleetd_contracts::automations::{
    AutomationCreateCall, AutomationDeleteCall, AutomationListCall, AutomationPauseCall,
    AutomationRunCall, AutomationRunsCall, AutomationUpdateCall,
};
use fleetd_contracts::browser::{
    BrowserCall, DesktopCall, FillCredentialCall, RequestTakeoverCall, SessionEndCall,
    SessionStartCall,
};
use fleetd_contracts::chat::NudgeCall;
use fleetd_contracts::checklist::ChecklistCall;
use fleetd_contracts::lead_calls::{
    AskLeadCall, BriefCreateCall, BriefReadCall, ChangeEnqueueCall, CloseCall, DecideCall,
    DecisionsSearchCall, GatedRunCall, LeadCall, LeadSocketFrame, RequestSecretCall,
    RequestWithdrawCall, ReviewReadCall, TaskCancelCall, TaskListCall, TaskMessageCall,
    TaskSpawnCall, UsageResumeCall,
};
use fleetd_contracts::memory::{ForgetCall, MemoryReadCall, RememberCall};
use fleetd_contracts::navi::{ChatReadCall, ChatSearchCall, FactoryStatusCall, ProjectMessageCall};
use fleetd_contracts::preview::{PreviewConfigProposeCall, PreviewStartCall, PreviewSuggestCall};
use fleetd_contracts::schema::inline_schema;
use fleetd_contracts::skills::SkillInstallCall;
use fleetd_contracts::verification::ReviewVerdict;
use serde_json::{Value, json};

const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Lead,
    Worker,
}

/// The server's name in a session's `--mcp-config`; claude shows its tools as `mcp__fleetd__<name>`.
pub const SERVER_NAME: &str = "fleetd";

pub struct Tool {
    pub name: &'static str,
    /// The lead call's `op`, or the browser call's.
    pub op: &'static str,
    pub worker: bool,
    pub lead: bool,
    /// A browser call (`browser_call`), which the node answers itself: its broker runs the session's browser.
    pub browser: bool,
    pub description: &'static str,
    pub schema: fn() -> Value,
    /// What a person must do before the call takes effect; `None` when nothing.
    pub human: Option<&'static str>,
}

const fn lead(
    name: &'static str,
    op: &'static str,
    description: &'static str,
    schema: fn() -> Value,
) -> Tool {
    Tool {
        name,
        op,
        worker: false,
        lead: true,
        browser: false,
        description,
        schema,
        human: None,
    }
}

/// A browser tool, for leads and tasks alike.
const fn browser(name: &'static str, description: &'static str, schema: fn() -> Value) -> Tool {
    Tool {
        name,
        op: name,
        worker: true,
        lead: true,
        browser: true,
        description,
        schema,
        human: None,
    }
}

impl Tool {
    const fn needs(self, human: &'static str) -> Tool {
        Tool {
            human: Some(human),
            ..self
        }
    }
}

static TOOLS: &[Tool] = &[
    lead(
        "spawn_agent",
        "task_spawn",
        "Start a fleetd agent (a task) with its own session, slot and lane. title is what the human sees: a short \
         plain outcome (\"Saved carts survive a sign-out\"), never an id, status or PR number. kind \
         write|read|review; a writer gets its own worktree and branch; a review task needs pr. repo names the \
         project's repo it works in when it has several (its worktree, branch, setup and PR are that repo's); without \
         it, an agent given pr works in the PR's repo, any other in the project's own. profile names one of the profiles your first message \
         lists, the default when left out; one the project doesn't allow is refused, and reviews always run on the \
         default. A full slot board queues it and it starts by itself. A writer is \
         checked against the work in flight on its repo: one that repeats it is refused (taken, or a possible \
         duplicate); if it is different work, call again with notDuplicateOf and notDuplicateWhy. A person's claim is \
         theirs: ask in chat. The result names the other writers running in its repo and the work elsewhere it may \
         overlap. Its result arrives in a later wake: end your turn instead of waiting.",
        inline_schema::<TaskSpawnCall>,
    ),
    lead(
        "message_agent",
        "task_message",
        "Steer a task: a running one takes the message at its next tool boundary (now: true stops its current step \
         first), a waiting one gets it as its answer, and an ended one continues in its own thread.",
        inline_schema::<TaskMessageCall>,
    ),
    lead(
        "agents",
        "task_list",
        "The project's tasks as stored (state, queued reason, thread, result), newest first: one by taskId, or \
         filtered by state or workstream.",
        inline_schema::<TaskListCall>,
    ),
    lead(
        "stop_agent",
        "task_cancel",
        "Stop a task: interrupts its thread and releases its slot.",
        inline_schema::<TaskCancelCall>,
    ),
    lead(
        "brief",
        "brief_create",
        "Open and start work. Without workstreamId it opens a new order from text (the human's words) and this \
         brief, and starts it: new work from the chat starts this way, even when every order is closed. With \
         workstreamId it sets that workstream's brief (goal, why, pointers, constraints, doneWhen lines) and starts \
         it, or edits it later. An order opened for a Navi's message gives asked, its N<n> handle, so the Navi hears \
         when it lands.",
        inline_schema::<BriefCreateCall>,
    ),
    lead(
        "request_secret",
        "request_secret",
        "Ask the human for a secret (a key, a token, a password). The app shows a masked field in the chat; the value \
         is sealed to the sink's machine and written there, and never enters a transcript. Only its fingerprint \
         arrives, in a later wake. For a variable an agent asked for, use sink order:<machine>:<its order>: only \
         that order's agents get it, at their next turn, until the order closes.",
        inline_schema::<RequestSecretCall>,
    )
    .needs("The human enters the value in chat; you see only its fingerprint."),
    lead(
        "request_withdraw",
        "request_withdraw",
        "Take back a secret request or a command approval you no longer need (the human said so in chat).",
        inline_schema::<RequestWithdrawCall>,
    ),
    lead(
        "decide",
        "decide",
        "Log a decision: one you made yourself, or the human's answer to a question you asked in chat (so you never \
         ask it twice).",
        inline_schema::<DecideCall>,
    ),
    lead(
        "close",
        "close",
        "The workstream is done: say why in one line. Its agents still queued, running or waiting are stopped; the merge \
         train's reviewers are left to the train.",
        inline_schema::<CloseCall>,
    ),
    lead(
        "gated_run",
        "gated_run",
        "A prod write, spend, delete or credential use: the chat shows the human exactly this argv with Approve / \
         Deny, and the node runs it only once approved; secrets come from the node's own sinks. The exit code and \
         output tail arrive in a later wake.",
        inline_schema::<GatedRunCall>,
    )
    .needs("A human approves the exact command in chat before the node runs it."),
    Tool {
        worker: true,
        ..lead(
            "decisions_search",
            "decisions_search",
            "Search this project's decisions (and the global ones) by words, or read one by its id (D12), whole. \
             Another project's decisions are refused.",
            inline_schema::<DecisionsSearchCall>,
        )
    },
    lead(
        "remember",
        "remember",
        "Keep one entry in memory, in plain words, for every later session: scope user for how the person whose \
         message you answer works everywhere (tone, taste, standing rules; their own memory), project for this project (MEMORY.md, or a topic file for detail). \
         With replaces (words of one entry, quoted exactly) it takes that entry's place: never keep two versions. A \
         write past a file's cap is refused: merge or replace entries, then call again. The chat shows the human what \
         you remembered, with Undo. Never a secret.",
        inline_schema::<RememberCall>,
    ),
    lead(
        "forget",
        "forget",
        "Remove one entry from memory: entry quotes words of exactly one entry, as it reads now; scope and topic as \
         for remember. For an entry that no longer holds (done, superseded, contradicted); say why in reason. To \
         change an entry, remember with replaces instead. The chat shows the human what you forgot, with Undo.",
        inline_schema::<ForgetCall>,
    ),
    lead(
        "memory_read",
        "memory_read",
        "Read one of this project's memory topic files (MEMORY.md lists them).",
        inline_schema::<MemoryReadCall>,
    ),
    lead(
        "nudge",
        "nudge",
        "Flag the chat message you just wrote for the human's look, with reason in a few words (\"the Machines page \
         redesign\"): the app shows it as something to look at, below your questions, until they have seen it, for \
         a day at most. Only for a showcase, something to try or a risk, never routine news; a project keeps only a \
         few, a newer one clearing the oldest. Write the message first, then call it. No notification goes out.",
        inline_schema::<NudgeCall>,
    ),
    lead(
        "automation_create",
        "automation_create",
        "Make an automation for this project: a name, the prompt each run gives you as a new order, and optionally a \
         schedule (5-field cron and an IANA tz, such as 0 9 * * 1-5 in Europe/Berlin). Runs start work on their own; \
         reviews, the train and approvals still apply. Only a person adds a webhook, in the app.",
        inline_schema::<AutomationCreateCall>,
    ),
    lead(
        "automation_list",
        "automation_list",
        "This project's automations with their schedule, next run, paused state and last run.",
        inline_schema::<AutomationListCall>,
    ),
    lead(
        "automation_update",
        "automation_update",
        "Change an automation's name, prompt or schedule (removeSchedule: true takes it off); fields left out stay.",
        inline_schema::<AutomationUpdateCall>,
    ),
    lead(
        "automation_pause",
        "automation_pause",
        "Pause (paused: true) or resume an automation. Paused, its schedule and webhook start nothing; resumed, the \
         schedule goes on from now.",
        inline_schema::<AutomationPauseCall>,
    ),
    lead(
        "automation_delete",
        "automation_delete",
        "Delete an automation and its run history; orders its runs opened stay.",
        inline_schema::<AutomationDeleteCall>,
    ),
    lead(
        "automation_run",
        "automation_run",
        "Run an automation now: it opens its order, which reaches you in a later wake. Skipped while its last run's \
         order is still open.",
        inline_schema::<AutomationRunCall>,
    ),
    lead(
        "automation_runs",
        "automation_runs",
        "An automation's runs, newest first, with the order each opened; with runId, that run and its whole webhook \
         body.",
        inline_schema::<AutomationRunsCall>,
    ),
    lead(
        "checklist",
        "checklist",
        "Keep the project's checklist: the to-dos the human sees beside the chat, each todo, doing or done. An \
         item's text is a short plain outcome (\"Gift cards apply before tax\"), never a status, id or PR number: \
         its state and link carry those. Add items without an id, change one by its id (text, state, link to its PR, agent or workstream), or \
         remove it; replace sets the whole list. Returns the list.",
        inline_schema::<ChecklistCall>,
    ),
    lead(
        "skill_install",
        "skill_install",
        "Install skills (SKILL.md workflows) from a skills.sh source (owner/repo, owner/repo@skill, a GitHub URL) \
         for this project (scope project; global skills take an admin, so the human installs those); pinned to the \
         commit fetched, and the human updates it from Settings > Skills. Agents list it as fleetd:<name> and run it \
         with the Skill tool.",
        inline_schema::<SkillInstallCall>,
    ),
    lead(
        "project_message",
        "project_message",
        "A Navi's call: write to another project's lead in its chat, as this Navi, never as the person: \
         \"please add X\", or a question. Its lead reads it as input, never as the person's answer or approval, and \
         may open an order for it. Returns a handle (N<n>); a later wake says when an order opened for it opens, \
         closes, merges or fails. project is a title or project id from factory_status. With hub (a linked hub's \
         label, from factory_status's hubs), it goes to that project on the other hub, as the person via this Navi. \
         Open an order this way only when the person asked for it in this conversation.",
        inline_schema::<ProjectMessageCall>,
    ),
    lead(
        "factory_status",
        "factory_status",
        "A Navi's call: the other projects in one read, or the one named: each one's state (working, waiting on the \
         person, blocked, idle), a red main, running agents, open orders, its checklist not done, its last merge and \
         merges over 7 days, and this Navi's asks to it with the orders opened for them, plus the hubs this Navi is \
         linked to. With hub, the projects the link reaches on that hub instead. Read-only.",
        inline_schema::<FactoryStatusCall>,
    ),
    lead(
        "chat_search",
        "chat_search",
        "A Navi's call: search your own chat, all of it, back to its start, for the messages holding every one of \
         words (any order and case), optionally from and to a day (2026-10-20) or time, in UTC. Newest first, 20 a \
         page, each with its id, time, author (human is the person, lead is you) and its text around the words; \
         before (the last id of a page) reads the next. Only this chat, never another's. Read-only.",
        inline_schema::<ChatSearchCall>,
    ),
    lead(
        "chat_read",
        "chat_read",
        "A Navi's call: read the messages around one of your own chat by its id from chat_search, oldest first: \
         before and after say how many on each side (5 when absent, at most 10). With both 0 it reads that one \
         message whole. Read-only.",
        inline_schema::<ChatReadCall>,
    ),
    lead(
        "usage_resume",
        "usage_resume",
        "Lift the usage pause on your project's machine now and send every agent parked there \"continue\": only once \
         you know its login has capacity again (the human says so, or a turn of yours just went through). At most \
         once per 10 minutes per machine; an agent whose login is still limited parks again with the real reset. \
         The human can also press Resume in the app or run fleetd usage resume <machine>.",
        inline_schema::<UsageResumeCall>,
    ),
    lead(
        "change_enqueue",
        "change_enqueue",
        "Put a PR no task's result put there on its repo's merge train; only the train merges. `after` names PRs, in \
         this repo or any other, that must merge first: the train holds this one until they have, and tells you \
         when one of them fails.",
        inline_schema::<ChangeEnqueueCall>,
    ),
    Tool {
        name: "report",
        op: "review_verdict",
        worker: true,
        lead: false,
        browser: false,
        description: "Record your review verdict once, before your final message: the number of blocking and \
                      non-blocking findings and a summary of each. fleetd fills in your task and the head you \
                      reviewed.",
        schema: report_schema,
        human: None,
    },
    Tool {
        name: "ask_lead",
        op: "ask_lead",
        worker: true,
        lead: false,
        browser: false,
        description: "Ask your lead a question. Carry on with what you can; the answer arrives as a message. If you \
                      can't go on without it, end your turn: the answer continues this thread. For a variable that \
                      is not set, name it and say why; never put a secret's value in the question.",
        schema: inline_schema::<AskLeadCall>,
        human: None,
    },
    Tool {
        name: "brief_read",
        op: "brief_read",
        worker: true,
        lead: false,
        browser: false,
        description: "Read your workstream's brief, whole: its goal, why, pointers, constraints and done-when.",
        schema: inline_schema::<BriefReadCall>,
        human: None,
    },
    Tool {
        worker: true,
        ..lead(
            "review_read",
            "review_read",
            "Read every finding of the latest reviews of your PRs, blocking and non-blocking, in full, each with \
             path:line. pr (its URL or number) picks one; without it, a task reads all its own PRs, a reviewer the PR \
             it reviews, and a lead its project's PRs in the merge queue. Another project's reviews are refused.",
            inline_schema::<ReviewReadCall>,
        )
    },
    Tool {
        worker: true,
        ..lead(
            "preview_suggest",
            "preview_suggest",
            "Suggest the person try a PR themselves, where a human test clearly matters (a UI change, copy in \
             several languages, a mobile build): one line with a Try it button in the chat and the PR, once per PR, \
             which the app also shows as something to look at until the person has seen it. why says what to look \
             at, in plain words. Nothing starts from it: only the person starts a preview.",
            inline_schema::<PreviewSuggestCall>,
        )
    },
    Tool {
        worker: true,
        ..lead(
            "preview_config_propose",
            "preview_config_propose",
            "Propose how Try it runs this project's web app, once you know: setup commands (install), build, a start \
             command that serves on 127.0.0.1:$PORT, the ready path and the lockfiles setup depends on. The person \
             sees it as an approval card; nothing is saved until they approve, and the outcome arrives in a wake.",
            inline_schema::<PreviewConfigProposeCall>,
        )
    }
    .needs("A person approves the proposed setting in chat before it is saved."),
    lead(
        "preview_start",
        "preview_start",
        "Start a preview of a PR (or an order's PRs merged together) for the person to try: only when the person \
         asked for it in the message you are answering, never on your own (use preview_suggest for that). It runs \
         on a machine that can host it and opens in the app; previews_list in the app shows it.",
        inline_schema::<PreviewStartCall>,
    ),
    browser(
        "session_start",
        "Open a browser session: a fresh Chrome with an empty profile, only yours, thrown away at session_end (a \
         Navi's browser instead keeps its own profile, so the sites it signed into stay signed in). It is recorded \
         (video, the page after each step, a line per agent-browser command) for the person to replay. Drive it \
         with the agent-browser CLI in Bash, which is already pointed at it: pass no --cdp and launch no browser of \
         your own. purpose: one line on what for. kind android instead opens a fresh Android emulator (Android \
         15), driven with the agent-device CLI, which is already pointed at it: pass no --serial or --platform. \
         kind ios opens a fresh iOS simulator on a Mac the same way: pass no --udid or --platform. kind \
         linux_desktop opens a fresh Linux desktop (1280x800, a window manager, xterm), driven with the desktop \
         tool.",
        inline_schema::<SessionStartCall>,
    ),
    browser(
        "desktop",
        "Act on your Linux desktop session (session_start kind linux_desktop), with computer-use actions plus \
         launch. screenshot returns the screen as an image; left_click, right_click, middle_click, double_click, triple_click and mouse_move at coordinate \
         [x, y] in the screenshot's pixels; left_click_drag from start_coordinate to coordinate; type text; key \
         with xdotool key names in text (Return, ctrl+s, alt+F4); scroll with scroll_direction and scroll_amount \
         at coordinate; wait duration seconds; cursor_position; launch: text is a shell command started on the \
         desktop (in your working directory where the desktop can see it). Take a screenshot after acting to see \
         what happened.",
        inline_schema::<DesktopCall>,
    ),
    browser(
        "session_end",
        "Close your browser session: the browser and its profile are thrown away (a Navi's profile stays, with its \
         sign-ins), and its recording goes to the hub.",
        inline_schema::<SessionEndCall>,
    ),
    browser(
        "request_takeover",
        "Ask a person to take your browser over, for what only they can do: a captcha, a login confirmation \
         only they can give, a judgement call. reason says what they should do, in one line; it shows under waiting on you \
         in the app, and they watch the page live. Carry on meanwhile: while they drive, your agent-browser commands \
         answer that a person has control; after they hand it back, your next command sees the page as they left it.",
        inline_schema::<RequestTakeoverCall>,
    ),
    browser(
        "fill_credential",
        "Fill a login field of your browser session from 1Password without seeing the value: ref is its secret \
         reference (op://<vault>/<item>/<field>, ?attribute=otp for a one-time code), target the field's CSS \
         selector. The node fills it only on the item's own website, then submits the field's form in the same step; \
         submit: false fills a field before the last of its form (a username before its password). From the first \
         fill on, the session refuses reading values back (agent-browser eval and get value among them). Ask your \
         lead for the reference; never ask anyone for a password.",
        inline_schema::<FillCredentialCall>,
    ),
];

/// A verdict without what the hub fills in from the session: its task and the head it reviewed.
fn report_schema() -> Value {
    let mut schema = inline_schema::<ReviewVerdict>();
    if let Some(props) = schema["properties"].as_object_mut() {
        props.remove("taskId");
        props.remove("prHeadSha");
    }
    schema
}

pub fn tools_for(role: Role) -> impl Iterator<Item = &'static Tool> {
    TOOLS.iter().filter(move |t| match role {
        Role::Lead => t.lead,
        Role::Worker => t.worker,
    })
}

/// The `tools/list` answer for `role`.
pub fn tool_list(role: Role) -> Value {
    let tools: Vec<Value> = tools_for(role)
        .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.schema)() }))
        .collect();
    json!({ "tools": tools })
}

/// The lead call a `tools/call` makes, or why its arguments are not one.
pub fn call_of(role: Role, name: &str, arguments: Value) -> Result<Value, String> {
    let Some(tool) = tools_for(role).find(|t| t.name == name) else {
        return Err(format!("No tool {name} here."));
    };
    let mut call = match arguments {
        Value::Object(map) => map,
        Value::Null => serde_json::Map::new(),
        _ => return Err("The arguments must be an object.".into()),
    };
    call.insert("op".into(), tool.op.into());
    let call = Value::Object(call);
    let checked = match tool.browser {
        true => serde_json::from_value::<BrowserCall>(call.clone()).map(drop),
        false => serde_json::from_value::<LeadCall>(call.clone()).map(drop),
    };
    checked.map_err(|e| format!("Invalid arguments for {name}: {e}."))?;
    Ok(call)
}

/// A browser call's answer, in words that tell the agent what to do next.
pub fn browser_result(answer: &Value) -> Value {
    let result = &answer["result"];
    let text = match result["op"].as_str() {
        Some("session_start") if result["udid"].is_string() => format!(
            "iOS session {} is open ({} ms): a fresh iOS simulator, thrown away at session_end, recorded. Drive it \
             with agent-device in Bash; it is already pointed at this simulator, so pass no --udid or --platform. \
             Start with `agent-device open <app>` (`agent-device open com.apple.Preferences` for Settings); its \
             first command takes longer while its test runner starts. End it with session_end when done.",
            result["sessionId"].as_str().unwrap_or_default(),
            result["startMs"]
        ),
        Some("session_start") if result["serial"].is_string() => format!(
            "Android session {} is open ({} ms): a fresh Android emulator, thrown away at session_end, recorded. \
             Drive it with agent-device in Bash; it is already pointed at this emulator, so pass no --serial or \
             --platform. Start with `agent-device open <app>` (`agent-device open settings`). End it with \
             session_end when done.",
            result["sessionId"].as_str().unwrap_or_default(),
            result["startMs"]
        ),
        Some("session_start") if result["desktop"].is_string() => format!(
            "Desktop session {} is open ({} ms): a fresh Linux desktop ({}), thrown away at session_end, recorded. \
             Drive it with the desktop tool: start with a screenshot, launch apps with action launch. End it with \
             session_end when done.",
            result["sessionId"].as_str().unwrap_or_default(),
            result["startMs"],
            match (result["desktop"].as_str(), result["worktree"].as_str()) {
                (Some("container"), Some(worktree)) => format!(
                    "in a container of its own; your worktree {worktree} is in it read-only, so build on your \
                     machine and launch from there; write in /home/desktop or /tmp, which go with the container"
                ),
                (Some("container"), None) =>
                    "in a container of its own, without your worktree; write in \
                                              /home/desktop or /tmp, which go with the container"
                        .to_owned(),
                _ => "on a display of its own, with a fresh home directory".to_owned(),
            }
        ),
        Some("desktop") => {
            let message = result["message"].as_str().unwrap_or_default();
            let mut content = Vec::new();
            if let Some(jpeg) = result["jpegB64"].as_str() {
                content.push(json!({ "type": "image", "data": jpeg, "mimeType": "image/jpeg" }));
            }
            content.push(json!({ "type": "text", "text": message }));
            return json!({ "content": content, "isError": false });
        }
        Some("session_end") if result["kind"] == "linux_desktop" => format!(
            "Desktop session {} ended; the desktop and everything on it are gone. Its recording ({}) goes to the \
             hub.{}",
            result["sessionId"].as_str().unwrap_or_default(),
            result["files"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| f["file"].as_str())
                .collect::<Vec<_>>()
                .join(", "),
            result["note"]
                .as_str()
                .map(|note| format!(" Note: {note}."))
                .unwrap_or_default()
        ),
        Some("session_end") if result["kind"] == "android" || result["kind"] == "ios" => format!(
            "{} session {} ended; the {} and everything done in it are gone. Its recording ({}) goes to the hub.{}",
            if result["kind"] == "ios" {
                "iOS"
            } else {
                "Android"
            },
            result["sessionId"].as_str().unwrap_or_default(),
            if result["kind"] == "ios" {
                "simulator"
            } else {
                "emulator"
            },
            result["files"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| f["file"].as_str())
                .collect::<Vec<_>>()
                .join(", "),
            result["note"]
                .as_str()
                .map(|note| format!(" Note: {note}."))
                .unwrap_or_default()
        ),
        Some("session_start") => format!(
            "Browser session {} is open ({} ms): a Chrome of your own, recorded. Drive it with \
             agent-browser in Bash; it is already pointed at this session. If you haven't yet, run `agent-browser \
             skills get core` once for how. End it with session_end when done.",
            result["sessionId"].as_str().unwrap_or_default(),
            result["startMs"]
        ),
        Some("session_end") => {
            let files: Vec<&str> = result["files"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| f["file"].as_str())
                .collect();
            let mut text = format!(
                "Browser session {} ended; the browser and its profile are gone. Its recording ({}) goes to the hub.",
                result["sessionId"].as_str().unwrap_or_default(),
                files.join(", ")
            );
            if let Some(note) = result["note"].as_str() {
                text.push_str(&format!(" Note: {note}."));
            }
            text
        }
        Some(_) if result["message"].is_string() => {
            result["message"].as_str().unwrap_or_default().to_owned()
        }
        _ => return tool_result(answer),
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": false })
}

/// A node answer frame as an MCP tool result: compact JSON, since it stays in the caller's context for every later
/// request. A task frame (`spawn_agent`, `message_agent`, `stop_agent`) leaves out the task's prompt, which the lead
/// just wrote.
pub fn tool_result(answer: &Value) -> Value {
    if let Some(result) = answer.get("result") {
        let mut result = result.clone();
        if let Some(task) = result.get_mut("task").and_then(Value::as_object_mut) {
            task.remove("prompt");
        }
        let text = serde_json::to_string(&result).unwrap_or_default();
        return json!({ "content": [{ "type": "text", "text": text }], "isError": false });
    }
    let error = answer.get("error").cloned().unwrap_or_default();
    let mut text = format!(
        "Refused: {}",
        error["message"]
            .as_str()
            .unwrap_or("the hub refused the call")
    );
    if let Some(fix) = error["fix"].as_str() {
        text.push_str(&format!("\nNext: {fix}"));
    }
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

fn error_result(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

/// Under the fleetd dir.
pub const NODE_SOCKET_PATH: &str = "node/node.sock";

/// `path.normalize` for an absolute path: `.` and `..` resolved lexically, a trailing slash kept.
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    let mut out = format!("/{}", parts.join("/"));
    if path.ends_with('/') && out != "/" {
        out.push('/');
    }
    out
}

/// The working directory as the caller's shell names it. The node keeps workspace roots as written, symlinks included,
/// and starts agents there, so the shell's logical `PWD` matches a root where the kernel's resolved path may not.
pub fn caller_cwd(pwd: Option<&str>, physical: &Path) -> String {
    let physical_text = physical.to_string_lossy().into_owned();
    let Some(logical) = pwd.filter(|p| p.starts_with('/')) else {
        return physical_text;
    };
    match (
        std::fs::canonicalize(logical),
        std::fs::canonicalize(physical),
    ) {
        (Ok(a), Ok(b)) if a == b => normalize(logical),
        _ => physical_text,
    }
}

pub fn node_socket_path(env_sock: Option<&str>) -> PathBuf {
    match env_sock.filter(|s| !s.is_empty()) {
        Some(sock) => PathBuf::from(sock),
        None => crate::home::fleetd_dir().join(NODE_SOCKET_PATH),
    }
}

/// One frame out, one frame back over the node's socket. The node answers within ~35 s; `timeout` is a backstop.
/// `Err` is why the node could not be asked or did not answer.
pub fn send_to_node(socket: &Path, frame: &Value, timeout: Duration) -> Result<Value, String> {
    let shown = socket.display();
    let mut conn = UnixStream::connect(socket).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => format!(
            "fleetd hub unreachable: no fleetd node is listening at {shown} (set FLEETD_NODE_SOCK if it is elsewhere) — tell the human the node is down and carry on"
        ),
        _ => format!("cannot reach the fleetd node at {shown}: {error}"),
    })?;
    let started = Instant::now();
    let timed_out = || {
        format!(
            "the fleetd node did not answer within {} s; the call may or may not have gone through — try again shortly",
            timeout.as_secs()
        )
    };
    conn.write_all(format!("{frame}\n").as_bytes())
        .map_err(|error| format!("cannot reach the fleetd node at {shown}: {error}"))?;
    conn.set_read_timeout(Some(
        timeout
            .saturating_sub(started.elapsed())
            .max(Duration::from_millis(1)),
    ))
    .map_err(|error| format!("cannot reach the fleetd node at {shown}: {error}"))?;
    let mut line = String::new();
    match BufReader::new(conn).read_line(&mut line) {
        Ok(_) if line.ends_with('\n') => {}
        Ok(_) => {
            return Err(
                "the fleetd node closed the connection without answering — try again shortly"
                    .into(),
            );
        }
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            return Err(timed_out());
        }
        Err(error) => return Err(format!("cannot reach the fleetd node at {shown}: {error}")),
    }
    decode_result_frame(line.trim_end_matches('\n'))
        .ok_or_else(|| "the fleetd node sent an answer this CLI cannot read; check that node and CLI versions match".to_owned())
}

/// The node's answer, checked against the contract (a `lead_result` or `browser_result` with exactly one of result
/// and error).
fn decode_result_frame(line: &str) -> Option<Value> {
    match serde_json::from_str::<LeadSocketFrame>(line).ok()? {
        LeadSocketFrame::LeadResult(_) | LeadSocketFrame::BrowserResult(_) => {
            serde_json::from_str(line).ok()
        }
        LeadSocketFrame::LeadCall(_) | LeadSocketFrame::BrowserCall(_) => None,
    }
}

/// Where the server runs and how it reaches the node; tests swap `send`.
pub struct LeadDeps<'a> {
    pub pwd: Option<String>,
    pub sock: Option<String>,
    /// `FLEETD_THREAD_ID`: set inside a fleetd session, so the hub knows which agent is calling.
    pub thread: Option<String>,
    pub cwd: PathBuf,
    pub send: &'a dyn Fn(&Path, &Value) -> Result<Value, String>,
}

/// One lead call (`{"op": …, …}`) to the hub through the node; the answer frame, or why the node could not be asked.
pub fn send_call(call: Value, deps: &LeadDeps) -> Result<Value, String> {
    let t = match serde_json::from_value::<BrowserCall>(call.clone()) {
        Ok(_) => "browser_call",
        Err(_) => "lead_call",
    };
    let mut frame = json!({
        "t": t,
        "id": format!("cli-{}", std::process::id()),
        "cwd": caller_cwd(deps.pwd.as_deref(), &deps.cwd),
        "call": call,
    });
    if let Some(thread) = deps.thread.as_deref().filter(|t| !t.is_empty()) {
        frame["threadId"] = thread.into();
    }
    (deps.send)(&node_socket_path(deps.sock.as_deref()), &frame)
}

/// The real process's [`LeadDeps`].
pub fn env_deps<'a>(send: &'a dyn Fn(&Path, &Value) -> Result<Value, String>) -> LeadDeps<'a> {
    LeadDeps {
        pwd: std::env::var("PWD").ok(),
        sock: std::env::var("FLEETD_NODE_SOCK").ok(),
        thread: std::env::var("FLEETD_THREAD_ID").ok(),
        cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
        send,
    }
}

/// One JSON-RPC message in, its answer out (`None` for a notification).
pub fn handle(role: Role, message: &Value, deps: &LeadDeps) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message["method"].as_str().unwrap_or_default();
    let result = match method {
        "initialize" => json!({
            "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "fleetd", "version": crate::version() },
            "instructions": "fleetd's own tools: every agent is a fleetd task, started, steered and stopped here.",
        }),
        "ping" => json!({}),
        "tools/list" => tool_list(role),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or_default();
            let arguments = message["params"]["arguments"].clone();
            match call_of(role, name, arguments) {
                Err(why) => error_result(&why),
                Ok(call) => match send_call(call, deps) {
                    Ok(answer) if answer.get("result").is_some_and(|r| r.get("op").is_some()) => {
                        browser_result(&answer)
                    }
                    Ok(answer) => tool_result(&answer),
                    Err(unreachable) => error_result(&format!(
                        "{unreachable}. Carry on without this call and say so in your result."
                    )),
                },
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

/// `fleetd agent-mcp --role lead|worker`: serves stdin until it closes.
pub fn run(argv: &[String]) -> u8 {
    let role = match argv {
        [flag, role] if flag == "--role" && role == "lead" => Role::Lead,
        [flag, role] if flag == "--role" && role == "worker" => Role::Worker,
        _ => {
            eprintln!("usage: fleetd agent-mcp --role lead|worker");
            return 2;
        }
    };
    let send = |socket: &Path, frame: &Value| send_to_node(socket, frame, Duration::from_secs(60));
    let deps = env_deps(&send);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(message) => handle(role, &message, &deps),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn names(role: Role) -> Vec<String> {
        tool_list(role)["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect()
    }

    /// What the lead names an agent and a checklist item is what the human reads beside the chat: both tools ask for
    /// a short plain outcome, with no status, id or PR number in the text.
    #[test]
    fn the_lead_names_agents_and_to_dos_as_plain_outcomes() {
        let tools = tool_list(Role::Lead);
        let said = |name: &str| {
            tools["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == name)
                .and_then(|t| t["description"].as_str())
                .unwrap()
                .to_owned()
        };
        let spawn = said("spawn_agent");
        assert!(
            spawn.contains("title is what the human sees: a short plain outcome")
                && spawn.contains("never an id, status or PR number"),
            "{spawn}"
        );
        let checklist = said("checklist");
        assert!(
            checklist.contains("text is a short plain outcome")
                && checklist.contains("never a status, id or PR number"),
            "{checklist}"
        );
    }

    #[test]
    fn an_ios_session_tells_the_agent_to_drive_it_with_agent_device() {
        let said = |result: Value| {
            browser_result(&json!({ "id": "1", "result": result }))["content"][0]["text"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let started = said(json!({
            "op": "session_start", "sessionId": "B1", "udid": "8A1B2C3D-0000-4000-8000-000000000002", "startMs": 40,
        }));
        assert!(
            started.starts_with("iOS session B1 is open (40 ms)")
                && started.contains("pass no --udid"),
            "{started}"
        );
        let ended = said(json!({
            "op": "session_end", "sessionId": "B1", "kind": "ios",
            "files": [{ "file": "actions", "bytes": 10 }, { "file": "video_mp4", "bytes": 900 }],
        }));
        assert_eq!(
            ended,
            "iOS session B1 ended; the simulator and everything done in it are gone. Its recording (actions, \
             video_mp4) goes to the hub."
        );
    }

    #[test]
    fn a_worker_sees_only_report_ask_lead_its_brief_decisions_reviews_previews_and_browser() {
        assert_eq!(
            names(Role::Worker),
            [
                "decisions_search",
                "report",
                "ask_lead",
                "brief_read",
                "review_read",
                "preview_suggest",
                "preview_config_propose",
                "session_start",
                "desktop",
                "session_end",
                "request_takeover",
                "fill_credential"
            ]
        );
        let lead = names(Role::Lead);
        for tool in [
            "spawn_agent",
            "message_agent",
            "agents",
            "stop_agent",
            "request_secret",
            "decide",
            "brief",
            "close",
            "gated_run",
            "remember",
            "forget",
            "memory_read",
            "nudge",
            "checklist",
            "skill_install",
            "project_message",
            "factory_status",
            "chat_search",
            "chat_read",
            "review_read",
            "preview_suggest",
            "preview_config_propose",
            "preview_start",
        ] {
            assert!(lead.contains(&tool.to_owned()), "{tool}");
        }
        assert!(
            !names(Role::Worker).contains(&"preview_start".to_owned()),
            "a task never starts a preview"
        );
        assert!(!lead.contains(&"report".to_owned()) && !lead.contains(&"ask_lead".to_owned()));
        // A worker calling a lead's tool by name gets nothing sent.
        assert_eq!(
            call_of(Role::Worker, "spawn_agent", json!({})).unwrap_err(),
            "No tool spawn_agent here."
        );
    }

    #[test]
    fn every_tool_is_one_lead_call_with_an_object_schema() {
        for role in [Role::Lead, Role::Worker] {
            for tool in tool_list(role)["tools"].as_array().unwrap() {
                let schema = &tool["inputSchema"];
                assert_eq!(schema["type"], "object", "{}", tool["name"]);
                assert!(
                    !schema.to_string().contains("$ref"),
                    "{} has a $ref",
                    tool["name"]
                );
            }
        }
        let spawn = call_of(
            Role::Lead,
            "spawn_agent",
            json!({ "workstreamId": "W1", "title": "t", "prompt": "p" }),
        )
        .unwrap();
        assert_eq!(spawn["op"], "task_spawn");
        let bad = call_of(Role::Lead, "spawn_agent", json!({ "workstreamId": "W1" })).unwrap_err();
        assert!(
            bad.starts_with("Invalid arguments for spawn_agent"),
            "{bad}"
        );
        let brief = json!({ "goal": "g", "why": "w", "pointers": [], "constraints": [], "doneWhen": ["d"] });
        let unopened = call_of(Role::Lead, "brief", json!({ "brief": brief })).unwrap_err();
        assert!(unopened.contains("or text to open one"), "{unopened}");
        assert_eq!(
            call_of(Role::Worker, "ask_lead", json!({ "question": "Postgres?" })).unwrap(),
            json!({ "op": "ask_lead", "question": "Postgres?" })
        );
        assert_eq!(
            call_of(Role::Worker, "brief_read", json!({})).unwrap(),
            json!({ "op": "brief_read" })
        );
        assert_eq!(
            call_of(Role::Worker, "review_read", json!({ "pr": "#7" })).unwrap(),
            json!({ "op": "review_read", "pr": "#7" })
        );
        assert_eq!(
            call_of(Role::Worker, "decisions_search", json!({ "query": "D152" })).unwrap(),
            json!({ "op": "decisions_search", "query": "D152" })
        );
    }

    #[test]
    fn report_is_a_verdict_the_hub_completes() {
        let verdict = json!({ "blocking": 0, "nonBlocking": 1, "summary": "ok" });
        assert_eq!(
            call_of(Role::Worker, "report", verdict).unwrap(),
            json!({ "op": "review_verdict", "blocking": 0, "nonBlocking": 1, "summary": "ok" })
        );
        let schema = report_schema();
        for field in ["taskId", "prHeadSha"] {
            assert!(schema["properties"].get(field).is_none(), "{field}");
        }
    }

    #[test]
    fn a_result_is_compact_and_never_echoes_the_prompt_back() {
        let answer = json!({ "t": "lead_result", "id": "x", "result": {
            "op": "task_spawn", "task": { "taskId": "T3", "prompt": "a long brief", "state": "running" },
            "next": "T2 is writing too." } });
        let text = tool_result(&answer)["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(!text.contains('\n') && !text.contains("prompt"), "{text}");
        let back: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back["task"]["taskId"], "T3");
        assert_eq!(back["next"], "T2 is writing too.");
    }

    #[test]
    fn calls_go_through_the_node_socket_with_the_session_named() {
        let sent = std::cell::RefCell::new(Vec::new());
        let send = |_: &Path, frame: &Value| {
            sent.borrow_mut().push(frame.clone());
            Ok(json!({ "t": "lead_result", "id": "x", "error": {
                "code": "forbidden", "message": "T3 is a task, and a task's agent can't start agents.",
                "fix": "Do this work yourself." } }))
        };
        let deps = LeadDeps {
            pwd: None,
            sock: Some("/n.sock".into()),
            thread: Some("s1".into()),
            cwd: "/work/p".into(),
            send: &send,
        };
        let message = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": { "name": "ask_lead", "arguments": { "question": "Which DB?" } } });
        let answer = handle(Role::Worker, &message, &deps).unwrap();
        assert_eq!(sent.borrow()[0]["threadId"], "s1");
        assert_eq!(sent.borrow()[0]["call"]["op"], "ask_lead");
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "Refused: T3 is a task, and a task's agent can't start agents.\nNext: Do this work yourself."
        );
        assert!(
            handle(
                Role::Worker,
                &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
                &deps
            )
            .is_none()
        );
    }

    #[test]
    fn talks_to_a_node_socket_and_says_when_none_listens() {
        let dir = std::env::temp_dir().join(format!("fleetd-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("node.sock");
        let _ = std::fs::remove_file(&socket);
        let down = send_to_node(&socket, &json!({}), Duration::from_secs(5)).unwrap_err();
        assert!(down.starts_with(&format!(
            "fleetd hub unreachable: no fleetd node is listening at {}",
            socket.display()
        )));

        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let server = std::thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(&conn).read_line(&mut line).unwrap();
            let frame: Value = serde_json::from_str(&line).unwrap();
            let answer = json!({ "t": "lead_result", "id": frame["id"], "result": { "op": "decisions_search", "decisions": [] } });
            (&conn).write_all(format!("{answer}\n").as_bytes()).unwrap();
            frame
        });
        let frame = json!({ "t": "lead_call", "id": "cli-1", "cwd": "/w", "call": { "op": "decisions_search", "query": "health" } });
        let answer = send_to_node(&socket, &frame, Duration::from_secs(5)).unwrap();
        assert_eq!(server.join().unwrap(), frame);
        assert_eq!(answer["result"]["op"], "decisions_search");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn caller_cwd_keeps_the_shells_logical_path() {
        let dir = std::env::temp_dir().join(format!("fleetd-cwd-{}", std::process::id()));
        let real = dir.join("real");
        let link = dir.join("link");
        std::fs::create_dir_all(real.join("src")).unwrap();
        let _ = std::os::unix::fs::symlink(&real, &link);
        let real_src = std::fs::canonicalize(real.join("src")).unwrap();
        let link_src = format!("{}/src", link.display());
        assert_eq!(caller_cwd(Some(&link_src), &real_src), link_src);
        assert_eq!(
            caller_cwd(Some(&format!("{}/./src/", link.display())), &real_src),
            format!("{link_src}/")
        );
        assert_eq!(caller_cwd(None, &real_src), real_src.display().to_string());
        assert_eq!(
            caller_cwd(Some("link"), &real_src),
            real_src.display().to_string()
        );
        assert_eq!(
            caller_cwd(Some(&link.display().to_string()), &real_src),
            real_src.display().to_string()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_desktop_screenshot_comes_back_as_an_image() {
        let shot = browser_result(&json!({ "result": {
            "op": "desktop", "message": "The screen, 1280x800.", "jpegB64": "/9j/AA==",
            "width": 1280, "height": 800,
        } }));
        assert_eq!(shot["isError"], false);
        assert_eq!(shot["content"][0]["type"], "image");
        assert_eq!(shot["content"][0]["mimeType"], "image/jpeg");
        assert_eq!(shot["content"][0]["data"], "/9j/AA==");
        assert_eq!(shot["content"][1]["text"], "The screen, 1280x800.");
        let clicked = browser_result(
            &json!({ "result": { "op": "desktop", "message": "left_click at (1, 2)." } }),
        );
        assert_eq!(clicked["content"].as_array().unwrap().len(), 1);
        let started = browser_result(&json!({ "result": {
            "op": "session_start", "sessionId": "B0", "desktop": "xvfb", "startMs": 2,
        } }));
        let text = started["content"][0]["text"].as_str().unwrap();
        assert!(
            text.starts_with("Desktop session B0 is open (2 ms)"),
            "{text}"
        );
        assert!(text.contains("desktop tool"), "{text}");
        let contained = browser_result(&json!({ "result": {
            "op": "session_start", "sessionId": "B1", "desktop": "container", "worktree": "/work/app",
            "startMs": 900,
        } }));
        let text = contained["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("your worktree /work/app is in it read-only"),
            "{text}"
        );
        assert!(text.contains("write in /home/desktop or /tmp"), "{text}");
    }
}
