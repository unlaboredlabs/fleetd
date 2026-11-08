//! Artifacts (W367, D292): the reports a lead, task or Navi publishes for the person with `artifact_publish`, a
//! Markdown or HTML document under a name in its project. Each publish keeps a version in `artifact_versions` (title,
//! format, who, when, the whole content), the newest [`ARTIFACT_VERSIONS_KEPT`] of a name; posts a system line with
//! the artifact as a card in the project's chat; and announces `artifacts.changed`. The app reads them with
//! `artifacts_list` (with the files sent in the chat, from the attachment store) and `artifact_get` for the chat's
//! Artifacts tab. The content is stored and served as written: the app renders Markdown itself and HTML only in its
//! sandboxed frame, never in its own page. A lead, task or Navi reads one of its own project's back with
//! `artifact_read`, cut at [`ARTIFACT_READ_CAP`].
#[cfg(test)]
mod tests;

use std::sync::{Arc, Weak};

use fleetd_contracts::artifacts::{
    ARTIFACT_READ_CAP, ARTIFACT_VERSIONS_KEPT, ARTIFACTS_LISTED, ArtifactFormat, ArtifactName,
    ArtifactPublishCall, ArtifactPublishResult, ArtifactPublished, ArtifactReadCall,
    ArtifactReadResult, ArtifactSummary, ArtifactVersion,
};
use fleetd_contracts::auth::Role;
use fleetd_contracts::chat::ChatAuthor;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{
    ArtifactGetInput, ArtifactGetOutput, ArtifactsListInput, ArtifactsListOutput, ErrorCode,
    McpToolError,
};
use fleetd_contracts::prim::{Count, Int, Line, List, Text};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use crate::hub::api::{Caller, Hub, Registry, ToolError, error, require};
use crate::hub::chat::NewMessage;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::{CallerAgent, LeadCallFuture, op_of};
use crate::hub::store::{HubDb, NewEvent, StoreError, iso_ms, now_ms};

pub const OPS: [&str; 2] = ["artifact_publish", "artifact_read"];

pub fn register(tools: &mut Registry) {
    tools.add("artifacts_list", artifacts_list);
    tools.add("artifact_get", artifact_get);
}

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                match call {
                    LeadCall::ArtifactPublish(call) => {
                        publish(&hub, &caller, call).map(LeadCallResult::ArtifactPublish)
                    }
                    LeadCall::ArtifactRead(call) => {
                        read(&hub, &caller, call).map(LeadCallResult::ArtifactRead)
                    }
                    other => Err(McpToolError::new(
                        ErrorCode::Invalid,
                        format!("{} is not an artifact call.", op_of(&other)),
                    )),
                }
            })
        },
    );
    for op in OPS {
        hub.lead_calls.register(op, handler.clone());
    }
}

fn format_name(f: ArtifactFormat) -> &'static str {
    match f {
        ArtifactFormat::Md => "md",
        ArtifactFormat::Html => "html",
    }
}

fn format_of(s: &str) -> ArtifactFormat {
    if s == "html" {
        ArtifactFormat::Html
    } else {
        ArtifactFormat::Md
    }
}

fn clip(s: &str, cap: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    one.chars().take(cap).collect()
}

const COLUMNS: &str = "version, title, format, by_name, at_ms, length(CAST(content AS BLOB))";

/// A version from the row's columns `COLUMNS`, from `at` on.
fn version_at(row: &rusqlite::Row<'_>, at: usize) -> rusqlite::Result<ArtifactVersion> {
    let title: String = row.get(at + 1)?;
    let by: String = row.get(at + 3)?;
    Ok(ArtifactVersion {
        version: Int::unchecked(row.get(at)?),
        title: Line::unchecked(if title.is_empty() {
            "Untitled".into()
        } else {
            title
        }),
        format: format_of(&row.get::<_, String>(at + 2)?),
        by: Line::unchecked(if by.is_empty() { "someone".into() } else { by }),
        at: Timestamp(iso_ms(row.get(at + 4)?)),
        bytes: Count::unchecked(row.get(at + 5)?),
    })
}

/// One publish, as `keep` stores it.
#[derive(Clone, Copy)]
struct NewVersion<'a> {
    title: &'a str,
    format: ArtifactFormat,
    by: &'a str,
    content: &'a str,
    at_ms: i64,
}

/// A new version of `name`; returns its number. Only the newest [`ARTIFACT_VERSIONS_KEPT`] stay.
fn keep(
    c: &Connection,
    r: &ProjectRef,
    name: &ArtifactName,
    new: &NewVersion<'_>,
) -> Result<i64, StoreError> {
    let NewVersion {
        title,
        format,
        by,
        content,
        at_ms,
    } = *new;
    let (m, p) = (r.machine_id.as_str(), r.project_id.as_str());
    let last: Option<i64> = c.query_row(
        "SELECT MAX(version) FROM artifact_versions WHERE machine_id = ? AND project_id = ? AND name = ?",
        params![m, p, name.as_str()],
        |row| row.get(0),
    )?;
    let version = last.unwrap_or(0) + 1;
    c.execute(
        "INSERT INTO artifact_versions (machine_id, project_id, name, version, title, format, by_name, content, at_ms) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            m,
            p,
            name.as_str(),
            version,
            clip(title, 120),
            format_name(format),
            clip(by, 200),
            content,
            at_ms
        ],
    )?;
    c.execute(
        "DELETE FROM artifact_versions WHERE machine_id = ? AND project_id = ? AND name = ? AND version <= ?",
        params![m, p, name.as_str(), version - ARTIFACT_VERSIONS_KEPT as i64],
    )?;
    Ok(version)
}

/// The project's artifacts, each with its newest version, the newest published first.
pub fn list(db: &HubDb, r: &ProjectRef) -> Result<Vec<ArtifactSummary>, StoreError> {
    db.with(|c| {
        let mut st = c.prepare_cached(&format!(
            "SELECT name, {COLUMNS} FROM artifact_versions a WHERE machine_id = ?1 AND project_id = ?2 \
             AND version = (SELECT MAX(version) FROM artifact_versions b \
                            WHERE b.machine_id = a.machine_id AND b.project_id = a.project_id AND b.name = a.name) \
             ORDER BY at_ms DESC, rowid DESC LIMIT ?3"
        ))?;
        let rows = st.query_map(
            params![r.machine_id.as_str(), r.project_id.as_str(), ARTIFACTS_LISTED as i64],
            |row| {
                Ok(ArtifactSummary {
                    name: ArtifactName::unchecked(row.get::<_, String>(0)?),
                    newest: version_at(row, 1)?,
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// The artifact's versions, newest first, without their content.
pub fn versions(
    db: &HubDb,
    r: &ProjectRef,
    name: &ArtifactName,
) -> Result<Vec<ArtifactVersion>, StoreError> {
    db.with(|c| {
        let mut st = c.prepare_cached(&format!(
            "SELECT {COLUMNS} FROM artifact_versions WHERE machine_id = ? AND project_id = ? AND name = ? \
             ORDER BY version DESC"
        ))?;
        let rows = st.query_map(
            params![r.machine_id.as_str(), r.project_id.as_str(), name.as_str()],
            |row| version_at(row, 0),
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// One version with its content: `version`, or the newest.
pub fn get(
    db: &HubDb,
    r: &ProjectRef,
    name: &ArtifactName,
    version: Option<i64>,
) -> Result<Option<(ArtifactVersion, String)>, StoreError> {
    db.with(|c| {
        Ok(c.query_row(
            &format!(
                "SELECT {COLUMNS}, content FROM artifact_versions WHERE machine_id = ?1 AND project_id = ?2 \
                 AND name = ?3 AND (?4 IS NULL OR version = ?4) ORDER BY version DESC LIMIT 1"
            ),
            params![r.machine_id.as_str(), r.project_id.as_str(), name.as_str(), version],
            |row| Ok((version_at(row, 0)?, row.get::<_, String>(6)?)),
        )
        .optional()?)
    })
}

/// Who a version names: a task by its title, a Navi by its name, a project's lead as "Lead".
fn publisher(hub: &Hub, caller: &LeadCaller) -> String {
    let r = &caller.project_ref;
    if let CallerAgent::Task(task) = &caller.agent
        && let Ok(Some(task)) = hub.tasks.get(task)
    {
        return task.title.as_str().to_owned();
    }
    match crate::hub::navi::of(&hub.db, r) {
        Ok(Some(_)) => crate::hub::skills::calls::title_of(hub, r),
        _ => "Lead".to_owned(),
    }
}

fn failed(e: StoreError) -> McpToolError {
    tracing::error!(error = %e, "artifact_publish store");
    McpToolError::new(ErrorCode::Failed, "The hub failed to keep the artifact.")
}

fn publish(
    hub: &Hub,
    caller: &LeadCaller,
    call: ArtifactPublishCall,
) -> Result<ArtifactPublishResult, McpToolError> {
    let Some(content) = call.content else {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            "The artifact has no content: give content, or path from your own session's publish_artifact tool, which reads the file.",
        )
        .with_fix("Call publish_artifact with content, or with path to a file it can read."));
    };
    let r = &caller.project_ref;
    let format = call.format.unwrap_or_else(|| {
        call.path
            .as_ref()
            .map_or(ArtifactFormat::Md, |p| ArtifactFormat::of_path(p.as_str()))
    });
    let by = publisher(hub, caller);
    let at_ms = now_ms(hub.clock.as_ref());
    let version = hub
        .db
        .transaction(|c| {
            let new = NewVersion {
                title: call.title.as_str(),
                format,
                by: &by,
                content: content.as_str(),
                at_ms,
            };
            keep(c, r, &call.name, &new)
        })
        .map_err(failed)?;
    let title = call.title.as_str();
    let text = if version == 1 {
        format!("{by} published {title}")
    } else {
        format!("{by} published {title}, version {version}")
    };
    let published = ArtifactPublished {
        name: call.name.clone(),
        version: Int::unchecked(version),
        title: call.title.clone(),
        format,
        by: Line::unchecked(clip(&by, 200)),
    };
    hub.chat
        .add(
            r,
            NewMessage {
                author: Some(ChatAuthor::System),
                text,
                artifact: Some(published),
                ..Default::default()
            },
        )
        .map_err(failed)?;
    hub.events
        .append(NewEvent {
            at: iso_ms(at_ms).into(),
            r#type: HubEventType::ArtifactsChanged,
            machine_id: Some(r.machine_id.clone()),
            project_id: Some(r.project_id.clone()),
            thread_id: None,
            summary: format!(
                "artifact {} of {}/{} published, version {version}",
                call.name, r.machine_id, r.project_id
            ),
            data: Some(
                json!({ "projectRef": r, "name": call.name, "version": version, "by": caller.by }),
            ),
            attention: None,
        })
        .map_err(failed)?;
    let link = format!("[{title}](artifact:{})", call.name);
    let next = match caller.agent {
        CallerAgent::Task(_) => format!(
            "Published as version {version}: the chat shows a card and its Artifacts tab has it. Put {link} in your \
             result, so your lead can link to it."
        ),
        _ => format!(
            "Published as version {version}: the chat shows a card and its Artifacts tab has it. Link to it in any \
             message as {link} (artifact:{}@{version} for this version). Publish the same name again for a new \
             version; older ones stay.",
            call.name
        ),
    };
    Ok(ArtifactPublishResult {
        name: call.name,
        version: Int::unchecked(version),
        next: Some(next),
    })
}

/// `content`, whole when it fits in `cap` UTF-16 units, else its first `cap` and a last line saying where it was cut.
fn cut(content: &str, cap: usize) -> (String, bool) {
    let units = content.encode_utf16().count();
    if units <= cap {
        return (content.to_owned(), false);
    }
    let mut kept = 0;
    let head: String = content
        .chars()
        .take_while(|c| {
            kept += c.len_utf16();
            kept <= cap
        })
        .collect();
    let note = format!(
        "\n\n[cut at {} KB of {} KB]",
        cap / 1024,
        units.div_ceil(1024)
    );
    (head + &note, true)
}

/// `artifact_read`: one of the caller's own project's artifacts, `version` or the newest, as published.
fn read(
    hub: &Hub,
    caller: &LeadCaller,
    call: ArtifactReadCall,
) -> Result<ArtifactReadResult, McpToolError> {
    let r = &caller.project_ref;
    let version = call.version.map(|v| v.get());
    let read_failed = |e: StoreError| {
        tracing::error!(error = %e, "artifact_read store");
        McpToolError::new(ErrorCode::Failed, "The hub failed to read the artifact.")
    };
    let Some((artifact, content)) = get(&hub.db, r, &call.name, version).map_err(read_failed)?
    else {
        let names = list(&hub.db, r)
            .map_err(read_failed)?
            .into_iter()
            .take(20)
            .map(|a| a.name.as_str().to_owned())
            .collect::<Vec<_>>();
        let fix = if names.is_empty() {
            "This project has no artifacts yet: only its own are readable here.".to_owned()
        } else {
            format!("This project's newest artifacts: {}.", names.join(", "))
        };
        return Err(McpToolError::new(
            ErrorCode::NotFound,
            match version {
                Some(v) => format!("{} has no version {v} in this project.", call.name),
                None => format!("No artifact {} in this project.", call.name),
            },
        )
        .with_fix(fix));
    };
    let versions = versions(&hub.db, r, &call.name)
        .map_err(read_failed)?
        .into_iter()
        .map(|v| v.version)
        .collect();
    let (content, truncated) = cut(&content, ARTIFACT_READ_CAP);
    Ok(ArtifactReadResult {
        name: call.name,
        artifact,
        content: Text::unchecked(content),
        truncated: truncated.then_some(true),
        versions,
        next: None,
    })
}

async fn artifacts_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: ArtifactsListInput,
) -> Result<ArtifactsListOutput, ToolError> {
    let r = &input.project_ref;
    require(&caller, Role::Read, Some(&r.machine_id))?;
    let artifacts = list(&hub.db, r)?;
    let files = crate::hub::intake::attachments::of_chat(&hub, r)?;
    Ok(ArtifactsListOutput {
        truncated: (artifacts.len() >= ARTIFACTS_LISTED).then_some(true),
        artifacts: List::unchecked(artifacts),
        files: List::unchecked(files),
        next: None,
    })
}

async fn artifact_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: ArtifactGetInput,
) -> Result<ArtifactGetOutput, ToolError> {
    let r = &input.project_ref;
    require(&caller, Role::Read, Some(&r.machine_id))?;
    let version = input.version.map(|v| v.get());
    let Some((artifact, content)) = get(&hub.db, r, &input.name, version)? else {
        return Err(error(
            ErrorCode::NotFound,
            match version {
                Some(v) => format!("{} has no version {v}.", input.name),
                None => format!("No artifact {} here.", input.name),
            },
            "Pick one from the chat's Artifacts.",
        ));
    };
    let versions = versions(&hub.db, r, &input.name)?;
    Ok(ArtifactGetOutput {
        name: input.name,
        artifact,
        content: Text::unchecked(content),
        versions: List::unchecked(versions),
        next: None,
        truncated: None,
    })
}
