//! One tool-less model turn the hub runs for itself and reads the answer of: a memory import's distilling (W229), an
//! approval checker's verdict (W239). The session is launched on a project's machine, recorded as the hub's own (so the
//! sweep never reports it as a session nobody owns), waited on to its end, and stopped either way: a session left
//! running holds what it read in a process.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, ThreadRef};
use fleetd_contracts::people::PersonId;
use fleetd_contracts::sessions::MessageRole;
use rusqlite::{OptionalExtension, params};

use super::{LaunchInput, LaunchOptions};
use crate::hub::api::Hub;
use crate::hub::leads::hooks::BoxFuture;
use crate::hub::store::{HubDb, StoreError, now_ms};

const END_EVENTS: [HubEventType; 4] = [
    HubEventType::ThreadCompleted,
    HubEventType::ThreadFailed,
    HubEventType::ThreadInterrupted,
    HubEventType::ThreadUsageLimited,
];

/// What the hub runs a turn for: where it records the session, and how long it waits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    /// Import memory (`hub/memory/import`).
    MemoryImport,
    /// A Navi's approval checker (`hub/navi/checker`).
    ApprovalCheck,
}

impl Owner {
    /// A turn still going after this long is stopped, and fails.
    pub fn limit(self) -> Duration {
        match self {
            Owner::MemoryImport => Duration::from_secs(240),
            Owner::ApprovalCheck => Duration::from_secs(120),
        }
    }

    fn table(self) -> &'static str {
        match self {
            Owner::MemoryImport => "memory_imports",
            Owner::ApprovalCheck => "approval_checks",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Owner::MemoryImport => "memory import",
            Owner::ApprovalCheck => "approval check",
        }
    }
}

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

struct Executors(Arc<Hub>, Owner);

impl Turn for Executors {
    fn run(
        &self,
        r: &ProjectRef,
        person: Option<&PersonId>,
        input: LaunchInput,
        options: LaunchOptions,
    ) -> BoxFuture<Result<String, String>> {
        let (hub, owner) = (Arc::clone(&self.0), self.1);
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
            owned(&hub.db, owner, &r, &thread, person.as_ref(), started)
                .map_err(|e| e.to_string())?;
            let waited = tokio::time::timeout(owner.limit(), async {
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
            // Its work is done either way; a session left running holds what it read in a process.
            if let Err(e) = hub.executors.stop(&thread, false).await {
                tracing::warn!(thread = %thread.thread_id, "{}: session not stopped: {e}", owner.name());
            }
            reply
        })
    }
}

/// The hub's executors, which run `owner`'s turn on the project's machine.
pub fn executors(hub: &Arc<Hub>, owner: Owner) -> impl Turn + use<> {
    Executors(Arc::clone(hub), owner)
}

fn owned(
    db: &HubDb,
    owner: Owner,
    r: &ProjectRef,
    thread: &ThreadRef,
    person: Option<&PersonId>,
    started: i64,
) -> Result<(), StoreError> {
    db.with(|c| {
        c.execute(
            &format!(
                "INSERT OR IGNORE INTO {} (machine_id, thread_id, project_id, person_id, started_ms)
                 VALUES (?, ?, ?, ?, ?)",
                owner.table()
            ),
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
