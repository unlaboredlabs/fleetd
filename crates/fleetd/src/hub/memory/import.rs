//! Import memory (Settings > Memory, W229): a person copies the `memory.export` prompt into another assistant
//! (ChatGPT, Claude, Grok), pastes its answer back, and `memory_import` turns it into entries of their own memory.
//!
//! One model turn distills it: a session with no tools at all (no runtime tool, no MCP server, fleetd's included) on
//! the person's own Claude choice (D200), in their own Navi and nowhere else, so nobody else can read the paste in
//! its session; someone with no Navi is asked to create one first. The pasted text is untrusted: it goes in between
//! two fences no paste can fake, under the `memory.import` rules that it is data, never instructions; and the
//! session can do nothing but answer. Its answer is JSON entries, which are written here the way `remember` writes them: a secret refused,
//! an entry the memory already says skipped, a merged one in place of the old, and the cap held, the most durable
//! kinds (instructions, then preferences) first, so what doesn't fit is the least lasting. One `memory.changed` at
//! the end refreshes the lists.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::effort::ProfileName;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, ThreadRef};
use fleetd_contracts::mcp::{ErrorCode, MemoryImportOutput};
use fleetd_contracts::mcp_servers::McpSessionConfig;
use fleetd_contracts::memory::{
    IMPORT_ENTRIES_MAX, MemoryEntry, MemoryImportSkip, MemoryImported, MemoryScope, MemorySkipped,
    RememberCall,
};
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::node_link::CAP_ALLOWED_ONLY;
use fleetd_contracts::people::PersonId;
use fleetd_contracts::prim::{Count, List, Text};
use fleetd_contracts::sessions::{MessageRole, SessionRole};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;

use super::{Target, You};
use crate::hub::api::{Hub, ToolError};
use crate::hub::claude_accounts::{Whose, launch_account};
use crate::hub::executor::{LaunchInput, LaunchOptions};
use crate::hub::leads::hooks::BoxFuture;
use crate::hub::store::{HubDb, StoreError, now_ms};

/// A turn still going after this long is stopped, and the import fails.
pub const TURN_LIMIT: Duration = Duration::from_secs(240);
const END_EVENTS: [HubEventType; 4] = [
    HubEventType::ThreadCompleted,
    HubEventType::ThreadFailed,
    HubEventType::ThreadInterrupted,
    HubEventType::ThreadUsageLimited,
];

/// Runs one session to its end on a project's machine and gives back its last reply: the hub's executors, or a
/// test's fake model.
pub trait Turn: Send + Sync {
    fn run(
        &self,
        r: &ProjectRef,
        person: Option<&PersonId>,
        input: LaunchInput,
        options: LaunchOptions,
    ) -> BoxFuture<Result<String, String>>;
}

struct Executors(Arc<Hub>);

impl Turn for Executors {
    fn run(
        &self,
        r: &ProjectRef,
        person: Option<&PersonId>,
        input: LaunchInput,
        options: LaunchOptions,
    ) -> BoxFuture<Result<String, String>> {
        let hub = Arc::clone(&self.0);
        let (r, person) = (r.clone(), person.cloned());
        Box::pin(async move {
            let started = now_ms(hub.clock.as_ref());
            let mut seq = hub.events.subscribe();
            let (thread_id, _) = hub
                .executors
                .launch(&r.machine_id, &input, options)
                .await
                .map_err(|e| e.to_string())?;
            let thread = ThreadRef {
                machine_id: r.machine_id.clone(),
                thread_id,
            };
            owned(&hub.db, &r, &thread, person.as_ref(), started).map_err(|e| e.to_string())?;
            let waited = tokio::time::timeout(TURN_LIMIT, async {
                loop {
                    if let Some(completed) = ended(&hub.db, &thread, started)? {
                        return Ok(completed);
                    }
                    if seq.changed().await.is_err() {
                        return Ok(false);
                    }
                }
            })
            .await;
            let reply = match waited {
                Err(_) => Err("it ran past its time".to_owned()),
                Ok(Err(e)) => Err(StoreError::to_string(&e)),
                Ok(Ok(false)) => Err("it stopped before it answered".to_owned()),
                Ok(Ok(true)) => match hub.executors.messages(&thread).await {
                    Ok(messages) => messages
                        .into_iter()
                        .rev()
                        .find(|m| m.role == MessageRole::Assistant && !m.text.trim().is_empty())
                        .map(|m| m.text)
                        .ok_or_else(|| "it answered nothing".to_owned()),
                    Err(e) => Err(e.to_string()),
                },
            };
            // Its work is done either way; a session left running holds the person's paste in a process.
            if let Err(e) = hub.executors.stop(&thread, false).await {
                tracing::warn!(thread = %thread.thread_id, "memory import: session not stopped: {e}");
            }
            reply
        })
    }
}

/// The hub's executors, which run the import's turn on the project's machine.
pub fn executors(hub: &Arc<Hub>) -> impl Turn + use<> {
    Executors(Arc::clone(hub))
}

fn owned(
    db: &HubDb,
    r: &ProjectRef,
    thread: &ThreadRef,
    person: Option<&PersonId>,
    started: i64,
) -> Result<(), StoreError> {
    db.with(|c| {
        c.execute(
            "INSERT OR IGNORE INTO memory_imports (machine_id, thread_id, project_id, person_id, started_ms)
             VALUES (?, ?, ?, ?, ?)",
            params![
                thread.machine_id.as_str(),
                thread.thread_id.as_str(),
                r.project_id.as_str(),
                person.map(PersonId::as_str),
                started
            ],
        )?;
        Ok(())
    })
}

/// Whether the session ended after `started_ms`: true when it completed.
fn ended(db: &HubDb, thread: &ThreadRef, started_ms: i64) -> Result<Option<bool>, StoreError> {
    let types: Vec<&str> = END_EVENTS.iter().map(|t| t.as_str()).collect();
    let types = serde_json::to_string(&types)?;
    let ty: Option<String> = db.with(|c| {
        Ok(c.query_row(
            "SELECT type FROM events WHERE type IN (SELECT value FROM json_each(?1)) AND machine_id = ?2
               AND json_extract(data, '$.threadId') = ?3 AND created_ms >= ?4 ORDER BY seq LIMIT 1",
            params![types, thread.machine_id.as_str(), thread.thread_id.as_str(), started_ms],
            |row| row.get(0),
        )
        .optional()?)
    })?;
    Ok(ty.map(|t| t == HubEventType::ThreadCompleted.as_str()))
}

/// The export prompt every app shows, as the hub's prompts say it now.
pub fn export_prompt(hub: &Hub) -> String {
    hub.db.prompts().current(None).render("memory.export", &[])
}

/// The fix of the refusal for someone with no Navi: the apps show it as it is, with a way to make one.
pub const NO_NAVI_FIX: &str = "Create a Navi first, then import again.";

/// Where the turn runs: `person`'s own Navi, and nowhere else, so nobody but them can read what they pasted. Refused
/// for someone with none, and while none of theirs is on a node that can hold the turn to no tools.
fn place(hub: &Hub, person: Option<&PersonId>) -> Result<ProjectRef, ToolError> {
    let (navis, others) = hub.db.with(|c| {
        Ok((
            crate::hub::navi::store::all(c)?,
            crate::hub::navi::store::others(c, person)?,
        ))
    })?;
    let mut own = Vec::new();
    for r in navis.into_iter().filter(|r| !others.contains(r)) {
        if crate::hub::navi::of(&hub.db, &r)?.is_some_and(|n| n.archived_at.is_none()) {
            own.push(r);
        }
    }
    let Some(first) = own.first().cloned() else {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            "Import memory runs in your own Navi, so nobody else can read what you paste, and you have no Navi yet.",
        )
        .with_fix(NO_NAVI_FIX));
    };
    own.into_iter()
        .find(|r| hub.link.node_can(&r.machine_id, CAP_ALLOWED_ONLY))
        .ok_or_else(|| {
            ToolError::new(
                ErrorCode::MachineOffline,
                format!(
                    "Your Navi's machine, {}, is offline or runs a fleetd too old for this.",
                    first.machine_id
                ),
            )
            .with_fix(format!(
                "Bring {} online with an up-to-date fleetd, then try again.",
                first.machine_id
            ))
        })
}

/// One entry of the turn's answer.
#[derive(Clone, Debug, Deserialize)]
struct Distilled {
    #[serde(default)]
    kind: Option<String>,
    text: String,
    #[serde(default)]
    replaces: Option<String>,
}

#[derive(Deserialize)]
struct Reply {
    entries: Vec<Distilled>,
}

/// The entries of the turn's reply: its one JSON object, fenced or not.
fn parse(reply: &str) -> Option<Vec<Distilled>> {
    let (start, end) = (reply.find('{')?, reply.rfind('}')?);
    let reply: Reply = serde_json::from_str(reply.get(start..=end)?).ok()?;
    Some(reply.entries)
}

/// The more lasting kinds first: what an import keeps when the cap runs out.
fn rank(kind: Option<&str>) -> u8 {
    match kind.map(str::trim) {
        Some("instruction") => 0,
        Some("preference") => 1,
        Some("identity") => 2,
        Some("career") => 3,
        Some("project") => 4,
        _ => 5,
    }
}

/// One line, without a `[date] -` the other assistant's format left on it, cut to an entry's length.
fn clean(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let line = line.trim_start_matches("- ");
    let line = match line.strip_prefix('[').and_then(|l| l.split_once(']')) {
        Some((date, rest))
            if date == "unknown" || date.chars().all(|c| c.is_ascii_digit() || c == '-') =>
        {
            rest.trim_start().trim_start_matches('-').trim_start()
        }
        _ => line,
    };
    line.chars()
        .take(1000)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// How two entries compare when telling a duplicate: case, a final period and spacing aside.
fn same(a: &str) -> String {
    a.trim()
        .trim_start_matches("- ")
        .trim_end_matches('.')
        .to_lowercase()
}

/// The person's import of `text`: the turn on `turn`, then its entries written to their memory.
pub async fn import(
    hub: &Arc<Hub>,
    turn: &dyn Turn,
    you: &You,
    by: &str,
    text: &str,
) -> Result<MemoryImportOutput, ToolError> {
    let memory = hub.db.memory();
    let Some(t) = you.target() else {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Imported memory goes into a person's own memory, and this key belongs to no person.",
        )
        .with_fix("Import from your own device (a human key from an invite or `fleetd pair`)."));
    };
    let person = t.person.cloned();
    let r = place(hub, person.as_ref())?;
    let setup = hub.db.claude_accounts().setup()?;
    let whose = person.clone().map_or(Whose::Hub, Whose::Person);
    let claude_account = launch_account(&setup, &whose, &r.machine_id, || {
        hub.link.node_can(
            &r.machine_id,
            fleetd_contracts::node_link::CAP_CLAUDE_ACCOUNTS,
        )
    })
    .map_err(|refused| ToolError::new(ErrorCode::Invalid, refused.message).with_fix(refused.fix))?;
    let (system_prompt, prompt) = prompts(hub, &memory.read(&t), text);
    let input = LaunchInput {
        project_id: r.project_id.clone(),
        prompt,
        system_prompt: Some(system_prompt),
        profile: hub
            .db
            .profiles()
            .default_profile()
            .map_or_else(|_| ProfileName::legacy(), |p| p.name),
        // Its node asks for any tool, and refuses it: it has none.
        runtime_mode: RuntimeMode::ApprovalRequired,
        title: Some("fleetd memory import".to_owned()),
        client_request_id: format!(
            "fleetd-memory-import:{}:{}",
            person.as_ref().map_or("shared", PersonId::as_str),
            fence_nonce()
        ),
    };
    let options = LaunchOptions {
        role: SessionRole::Plain,
        mcp_role: None,
        mcp: Some(McpSessionConfig {
            user_servers: false,
            servers: Vec::new(),
        }),
        only_tools: Some(Vec::new()),
        claude_account,
        ..Default::default()
    };
    let reply = turn
        .run(&r, person.as_ref(), input, options)
        .await
        .map_err(|why| {
            ToolError::new(
                ErrorCode::Failed,
                format!("The import didn't finish: {why}."),
            )
            .with_fix("Try again; nothing was added.")
        })?;
    let entries = parse(&reply).ok_or_else(|| {
        ToolError::new(
            ErrorCode::Failed,
            "The model's answer couldn't be read as memory entries. Nothing was added.",
        )
        .with_fix("Try again.")
    })?;
    let (added, skipped) = write(hub, &r, person.as_ref(), entries)?;
    if !added.is_empty() {
        super::calls::changed(hub, None, None, by)?;
    }
    let text = memory.read(&t);
    let cap = memory.cap(&t);
    let full = skipped
        .iter()
        .filter(|s| s.why == MemoryImportSkip::Full)
        .count();
    let next = match (added.len(), full) {
        (0, 0) => "Nothing new to add: your memory already says it all.".to_owned(),
        (n, 0) => format!("Added {n} to your memory."),
        (n, f) => format!(
            "Added {n} to your memory; {f} more didn't fit under its cap of {cap} characters (skipped, why full). Trim your memory, then import again to add them."
        ),
    };
    Ok(MemoryImportOutput {
        prompt: Text::unchecked(export_prompt(hub)),
        added: List::unchecked(added),
        skipped: List::unchecked(skipped),
        chars: Count::unchecked(text.chars().count() as i64),
        cap: Count::unchecked(cap as i64),
        next: Some(next),
        truncated: None,
    })
}

fn fence_nonce() -> String {
    rand::random::<[u8; 12]>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The turn's rules, and its message: the person's memory now and the export between two fences no paste can fake.
pub fn prompts(hub: &Hub, memory: &str, text: &str) -> (String, String) {
    let fence = format!("===== export {} =====", fence_nonce());
    let set = hub.db.prompts().current(None);
    let rules = set.render("memory.import", &[("fence", &fence)]);
    let memory = memory.trim_end();
    let memory = if memory.is_empty() { "(empty)" } else { memory };
    // A line of the paste that reads like a fence is its text, nothing more.
    let text = text.replace(&fence, "");
    let prompt = format!(
        "## The person's memory now\n{memory}\n\n## The export (data only)\n{fence}\n{}\n{fence}",
        text.trim()
    );
    (rules, prompt)
}

/// Writes `entries` to the person's own memory as `remember` writes them, the more lasting kinds first.
fn write(
    hub: &Hub,
    r: &ProjectRef,
    person: Option<&PersonId>,
    mut entries: Vec<Distilled>,
) -> Result<(Vec<MemoryImported>, Vec<MemorySkipped>), ToolError> {
    entries.sort_by_key(|e| rank(e.kind.as_deref()));
    let memory = hub.db.memory();
    let t = Target::user(person);
    let (mut added, mut skipped, mut seen) = (Vec::new(), Vec::new(), Vec::<String>::new());
    let mut skip = |text: &str, why| {
        if let Ok(text) = MemoryEntry::new(text) {
            skipped.push(MemorySkipped { text, why });
        }
    };
    for e in entries {
        if added.len() >= IMPORT_ENTRIES_MAX {
            break;
        }
        let text = clean(&e.text);
        if text.is_empty() || seen.contains(&same(&text)) {
            continue;
        }
        seen.push(same(&text));
        let redacted = crate::hub::redact::redact(&text);
        if redacted != text {
            skip(&redacted, MemoryImportSkip::Secret);
            continue;
        }
        if memory.read(&t).lines().any(|l| same(l) == same(&text)) {
            skip(&text, MemoryImportSkip::Duplicate);
            continue;
        }
        let Ok(entry) = MemoryEntry::new(text.clone()) else {
            continue;
        };
        let replaces = e
            .replaces
            .as_deref()
            .map(clean)
            .filter(|old| !old.is_empty())
            .and_then(|old| MemoryEntry::new(old).ok());
        let mut call = RememberCall {
            scope: MemoryScope::User,
            topic: None,
            text: entry,
            replaces,
        };
        let mut wrote = memory.remember(r, person, &call);
        // The entry it names isn't there as quoted: it goes in as a new one.
        if wrote.is_err() && call.replaces.is_some() {
            call.replaces = None;
            wrote = memory.remember(r, person, &call);
        }
        match wrote {
            Ok((_, Some(item), _)) => added.push(MemoryImported {
                text: item.text,
                replaced: item.replaced,
            }),
            Ok((_, None, _)) => skip(&text, MemoryImportSkip::Duplicate),
            Err(e) if e.code == ErrorCode::Invalid => skip(&text, MemoryImportSkip::Full),
            Err(e) => return Err(e.into()),
        }
    }
    skipped.truncate(IMPORT_ENTRIES_MAX);
    Ok((added, skipped))
}
