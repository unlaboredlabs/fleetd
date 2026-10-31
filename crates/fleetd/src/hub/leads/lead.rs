//! One lead per project: a thread on the project's machine, started with the lead prompt plus the digest. A Navi's
//! lead starts from `navi.start` in the assistant role, and not at all while the Navi is archived.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::chat::{ChatAuthor, ChatMessage};
use fleetd_contracts::effort::{Profile, ProfileName};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::ledger::{Lead, LeadState, WorkstreamState};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::model::{
    ProjectKind, ProjectSummary, RuntimeMode, ThreadStatus, ThreadSummary,
};
use fleetd_contracts::sessions::SessionRole;
use tokio::sync::Mutex;

use super::digest::clip;
use super::error::LeadError;
use super::prompt::{LeadStart, render_lead_start};
use super::records::{LeadRecords, StoredLead, WorkstreamFilter};
use super::wakes::{LeadWakes, Trigger, trigger_lines};
use super::{Ctx, now_iso};
use crate::hub::executor::LaunchInput;
use crate::hub::mcp_servers::LeadMcpSet;
use crate::hub::prompts::Audience;
use crate::hub::store::{HubDb, NewEvent, WaitInput, now_ms, parse_ms};

/// What an order for a project without a lead did about the lead.
#[derive(Debug, Clone)]
pub enum AutoStart {
    /// The project already had its lead.
    Running(Lead),
    /// This call started the lead; its first message lists the order and ends with the call's `first` text.
    Started(Lead),
    /// The lead could not start now (the runner is logged out or out of range, the machine is offline): why, and
    /// the fix. The order waits; the lead starts once the machine is online again.
    Held(LeadError),
}

/// The lead's state, read off its thread as the shell stream last reported it; stopped once the project was removed.
/// An archived project, now a repo checkout of another (W79), keeps its chat and history but its lead takes no turn:
/// refused at every start, resume and wake.
pub fn refuse_archived(db: &HubDb, r: &ProjectRef) -> Result<(), LeadError> {
    match crate::hub::repos::holder(db, r)? {
        Some((holder, repo)) => {
            let (message, fix) = crate::hub::repos::archived_note(&holder, &repo);
            Err(LeadError::new(ErrorCode::Invalid, message, fix))
        }
        None => Ok(()),
    }
}

pub fn lead_state(thread: Option<&ThreadSummary>, project_gone: bool) -> LeadState {
    if project_gone {
        return LeadState::Stopped;
    }
    match thread.map(|t| t.status) {
        None => LeadState::Starting,
        Some(ThreadStatus::Running) => LeadState::Working,
        Some(ThreadStatus::Waiting | ThreadStatus::Failed) => LeadState::Stalled,
        Some(_) => LeadState::Idle,
    }
}

pub struct Leads {
    ctx: Arc<Ctx>,
    records: Arc<LeadRecords>,
    wakes: Arc<LeadWakes>,
    /// Serializes start and restart, so two concurrent calls for one project launch one thread.
    lock: Mutex<()>,
}

impl Leads {
    pub fn new(ctx: Arc<Ctx>, records: Arc<LeadRecords>, wakes: Arc<LeadWakes>) -> Arc<Self> {
        Arc::new(Self {
            ctx,
            records,
            wakes,
            lock: Mutex::new(()),
        })
    }

    /// Launches the project's lead, or returns the one it already has.
    pub async fn start(&self, r: &ProjectRef) -> Result<Lead, LeadError> {
        Ok(self.start_with(r, None).await?.0)
    }

    /// The lead, and whether this call launched it (with `first` at the end of its first message).
    async fn start_with(
        &self,
        r: &ProjectRef,
        first: Option<&str>,
    ) -> Result<(Lead, bool), LeadError> {
        let _guard = self.lock.lock().await;
        // Its lead record stays with its history, but an archived project's lead is never handed out.
        refuse_archived(&self.ctx.db, r)?;
        if let Some(archived) = self.archived(r) {
            return Err(archived);
        }
        if let Some(existing) = self.records.lead_get(r)? {
            return Ok((self.with_state(existing)?, false));
        }
        let project = self.project_of(r)?;
        Ok((self.launch(r, &project, 0, first).await?, true))
    }

    /// Starts the project's lead for its waiting orders. The lead's first message carries the digest, which lists
    /// every draft, so the orders reach it with the start. `first`, the chat message that starts it, ends that
    /// message.
    pub async fn auto_start(&self, r: &ProjectRef, first: Option<&str>) -> AutoStart {
        // An archived project's lead, record and all, takes nothing: held chat messages and automation runs included.
        if let Err(e) = refuse_archived(&self.ctx.db, r) {
            return AutoStart::Held(e);
        }
        if let Some(archived) = self.archived(r) {
            return AutoStart::Held(archived);
        }
        match self.get(r) {
            Ok(Some(lead)) => return AutoStart::Running(lead),
            Ok(None) => {}
            Err(e) => return AutoStart::Held(e),
        }
        match self.start_with(r, first).await {
            Ok((lead, true)) => AutoStart::Started(lead),
            Ok((lead, false)) => AutoStart::Running(lead),
            Err(e) => AutoStart::Held(e),
        }
    }

    /// Why an archived Navi's lead doesn't start or take a message; none for any other project.
    fn archived(&self, r: &ProjectRef) -> Option<LeadError> {
        let project = self.ctx.store.project_get(r).ok().flatten()?;
        project.archived_at.as_ref()?;
        Some(LeadError::new(
            ErrorCode::Invalid,
            format!("{} is archived: its lead doesn't start.", project.title),
            "Bring it back with navi_archive (archived false) or in the app; a message waits until then.",
        ))
    }

    /// Starts the lead of each project on `machine_id` that has orders waiting as drafts and no lead.
    pub async fn start_waiting(&self, machine_id: &MachineId) -> Result<(), LeadError> {
        for project in self.ctx.store.projects_shown(Some(machine_id), None)? {
            let r = ProjectRef {
                machine_id: project.machine_id.clone(),
                project_id: project.project_id.clone(),
            };
            if self.records.lead_get(&r)?.is_some() {
                continue;
            }
            let open = self.records.workstreams_list(&WorkstreamFilter {
                project_ref: Some(r.clone()),
                state: Some(WorkstreamState::Open),
                limit: 100,
            })?;
            if open.iter().all(|w| w.brief.is_some()) {
                continue;
            }
            match self.auto_start(&r, None).await {
                AutoStart::Held(e) => {
                    tracing::info!(project = %project.title, reason = %e.message, "waiting orders: lead still not started")
                }
                AutoStart::Running(_) | AutoStart::Started(_) => {}
            }
        }
        Ok(())
    }

    /// A machine comes online once its runner is usable (a login, an update, a reconnect): then the leads its waiting
    /// orders need start. Follows the event log from the hub's start; the nodes' reconnects after a hub restart
    /// cover the orders that waited across it.
    pub async fn run_waiting(self: Arc<Self>) {
        let events = Arc::clone(&self.ctx.events);
        let mut cursor = events.head();
        loop {
            let page = match events
                .wait(WaitInput {
                    cursor: Some(cursor),
                    types: Some(vec![HubEventType::MachineOnline]),
                    machine_id: None,
                    timeout_sec: 3600,
                })
                .await
            {
                Ok(page) => page,
                Err(error) => {
                    tracing::warn!(%error, "waiting orders: event log read failed");
                    self.ctx
                        .clock
                        .sleep(std::time::Duration::from_secs(1))
                        .await;
                    continue;
                }
            };
            cursor = page.cursor;
            for machine_id in page.events.into_iter().filter_map(|e| e.machine_id) {
                if let Err(error) = self.start_waiting(&machine_id).await {
                    tracing::warn!(%error, "waiting orders: leads not started");
                }
            }
        }
    }

    /// A fresh lead thread from the current digest; bumps `sessionGeneration`. The old thread stays on the node.
    pub async fn restart(&self, r: &ProjectRef) -> Result<Lead, LeadError> {
        let _guard = self.lock.lock().await;
        let Some(existing) = self.records.lead_get(r)? else {
            return Err(LeadError::not_found(
                format!(
                    "Project {} on {} has no lead to restart.",
                    r.project_id, r.machine_id
                ),
                "Call lead_start first.",
            ));
        };
        let project = self.project_of(r)?;
        self.launch(r, &project, existing.session_generation + 1, None)
            .await
    }

    /// The project's lead and when its thread last moved, while it is idle: a turn in progress is never cut short.
    fn idle(&self, r: &ProjectRef) -> Option<(StoredLead, Option<i64>)> {
        let lead = self.records.lead_get(r).ok()??;
        let thread = ThreadRef {
            machine_id: r.machine_id.clone(),
            thread_id: lead.thread_id.clone(),
        };
        let thread = self.ctx.store.thread_get(&thread).ok()??;
        let since = parse_ms(thread.thread.last_progress_at.as_str());
        (lead_state(Some(&thread.thread), false) == LeadState::Idle).then_some((lead, since))
    }

    /// Whether the project's lead is idle and has been since before [`LEAD_FRESH_AFTER`]: its prompt cache is gone, so
    /// its next turn would write its whole history to the cache again.
    pub fn cold(&self, r: &ProjectRef) -> bool {
        self.idle(r).is_some_and(|(_, since)| {
            since.is_some_and(|at| {
                now_ms(self.ctx.clock.as_ref()) - at > LEAD_FRESH_AFTER.as_millis() as i64
            })
        })
    }

    /// While the project's lead is idle and its project's MCP servers for it differ from those its session started
    /// with (one added, edited, removed, or its key replaced): those it started with, and those it would get now. A
    /// running claude keeps the servers it started with, so only a fresh session gets them. A session started before
    /// fleetd kept them takes the current ones as its own.
    fn mcp_changed(&self, r: &ProjectRef) -> Option<(LeadMcpSet, LeadMcpSet)> {
        let lead = self.records.lead_get(r).ok()??;
        let now = self.ctx.db.mcp_servers().lead_set(r).ok()?;
        let Some(before) = self.records.lead_mcp_get(r, &lead.thread_id).ok()? else {
            let _ = self.records.lead_mcp_put(r, &lead.thread_id, &now);
            return None;
        };
        (before != now && self.idle(r).is_some()).then_some((before, now))
    }

    /// Whether the lead's next turn starts a fresh session: it is [`Self::cold`], or its MCP servers changed.
    pub fn fresh_due(&self, r: &ProjectRef) -> bool {
        self.cold(r) || self.mcp_changed(r).is_some()
    }

    /// When [`Self::fresh_due`]: a fresh lead session instead, from the digest (and memory) like any start, then the
    /// chat's tail and `first`. The lead coordinates from state and memory, not from an unbounded history. None when
    /// it isn't due, or there is no lead. A server it gets now that it didn't before gets one line in the chat.
    pub async fn fresh_if_due(
        &self,
        r: &ProjectRef,
        first: &str,
    ) -> Result<Option<Lead>, LeadError> {
        let _guard = self.lock.lock().await;
        let changed = self.mcp_changed(r);
        let Some(existing) = self
            .records
            .lead_get(r)?
            .filter(|_| changed.is_some() || self.cold(r))
        else {
            return Ok(None);
        };
        let project = self.project_of(r)?;
        // A digest as of no wake, as at any start: the ended tasks and their results, not only those since the old
        // session's last wake.
        self.records.lead_put(&StoredLead {
            last_wake_at: None,
            ..existing.clone()
        })?;
        let first = match recent_chat(&self.ctx.db, r) {
            Some(chat) => format!("{chat}\n\n{}", first.trim()),
            None => first.trim().to_owned(),
        };
        let lead = self
            .launch(r, &project, existing.session_generation + 1, Some(&first))
            .await?;
        if let Some((before, now)) = changed
            && let Some(line) = connected_line(&now.new_since(&before))
            && let Some(chat) = self.ctx.hooks.chat.get()
            && let Err(error) = chat.system_line(r, &line)
        {
            tracing::warn!(%error, "the lead's new MCP servers were not said in the chat");
        }
        Ok(Some(lead))
    }

    pub fn get(&self, r: &ProjectRef) -> Result<Option<Lead>, LeadError> {
        self.records
            .lead_get(r)?
            .map(|lead| self.with_state(lead))
            .transpose()
    }

    /// The profiles the project's tasks may run on, the default first. Read at each spawn, so a change applies to the
    /// next one.
    pub fn allowed_profiles(&self, r: &ProjectRef) -> Result<Vec<ProfileName>, LeadError> {
        Ok(self.ctx.db.profiles().allowed(r)?)
    }

    /// `project_set`: saves what the project allows besides the default and tells the clients (`project.settings`).
    /// The profiles it allows now.
    pub fn set_allowed_profiles(
        &self,
        r: &ProjectRef,
        title: &str,
        names: &[ProfileName],
    ) -> Result<Vec<ProfileName>, LeadError> {
        self.ctx.db.profiles().set_allowed(r, names)?;
        let allowed = self.allowed_profiles(r)?;
        let names: Vec<&str> = allowed.iter().map(ProfileName::as_str).collect();
        let summary = format!("{title}: agents may run on {}", names.join(", "));
        self.ctx.events.append(NewEvent {
            at: now_iso(&self.ctx).into(),
            r#type: HubEventType::ProjectSettings,
            machine_id: Some(r.machine_id.clone()),
            project_id: Some(r.project_id.clone()),
            thread_id: None,
            summary,
            data: Some(serde_json::json!({ "profiles": allowed })),
            attention: None,
        })?;
        Ok(allowed)
    }

    fn with_state(&self, lead: StoredLead) -> Result<Lead, LeadError> {
        let thread_ref = ThreadRef {
            machine_id: lead.project_ref.machine_id.clone(),
            thread_id: lead.thread_id.clone(),
        };
        let thread = self.ctx.store.thread_get(&thread_ref)?.map(|t| t.thread);
        // M4 usage: a lead whose thread hit a limit shows it is parked and until when.
        let parked = self.ctx.hooks.parked_of(&thread_ref);
        let gone = self.ctx.store.project_get(&lead.project_ref)?.is_none();
        Ok(Lead {
            state: lead_state(thread.as_ref(), gone),
            project_ref: lead.project_ref,
            thread_id: lead.thread_id,
            started_at: lead.started_at,
            last_wake_at: lead.last_wake_at,
            session_generation: fleetd_contracts::prim::Count::unchecked(lead.session_generation),
            parked,
        })
    }

    fn project_of(&self, r: &ProjectRef) -> Result<ProjectSummary, LeadError> {
        self.ctx
            .store
            .project_get(r)?
            .ok_or_else(|| LeadError::no_project(r))
    }

    /// The drafts waiting for this lead whose order says more than its title (an automation's prompt, trigger and
    /// body), oldest first, as a wake says a new order: the digest names a draft by its title only, and a wake for one
    /// made before the lead started is dropped (`LeadWakes::flush`).
    fn waiting_orders(&self, r: &ProjectRef) -> Result<Option<String>, LeadError> {
        let open = self.records.workstreams_list(&WorkstreamFilter {
            project_ref: Some(r.clone()),
            state: Some(WorkstreamState::Open),
            limit: 100,
        })?;
        let triggers: Vec<Trigger> = open
            .into_iter()
            .rev()
            .filter(|w| w.brief.is_none() && w.source.text.trim() != w.title.trim())
            .map(|w| Trigger::Intent {
                workstream_id: w.workstream_id,
                text: w.source.text.to_string(),
            })
            .collect();
        if triggers.is_empty() {
            return Ok(None);
        }
        Ok(Some(format!(
            "Orders waiting for you:\n{}",
            trigger_lines(&triggers).join("\n")
        )))
    }

    async fn launch(
        &self,
        r: &ProjectRef,
        project: &ProjectSummary,
        session_generation: i64,
        first: Option<&str>,
    ) -> Result<Lead, LeadError> {
        refuse_archived(&self.ctx.db, r)?;
        // Every start comes here (a first start, a restart, a fresh start of a cold lead): an archived Navi gets none.
        if let Some(archived) = self.archived(r) {
            return Err(archived);
        }
        // M4 usage: no lead turn goes into a login fleetd knows is exhausted.
        if let Some(paused) = self.ctx.hooks.usage_gate(r) {
            return Err(LeadError::new(
                ErrorCode::Invalid,
                format!("The lead was not started: {paused}."),
                "It goes on by itself at the reset. Once the login has capacity, the human can press Resume in the app \
                 or run fleetd usage resume on the hub machine.",
            ));
        }
        // Taken before the digest is read: every intent made before it is in the first message (`LeadWakes::flush`).
        let at = now_iso(&self.ctx);
        let set = self.ctx.db.prompts().current(Some(r));
        let profiles = self.ctx.db.profiles();
        let default = profiles.default_profile()?;
        let names = profiles.allowed(r)?;
        let allowed: Vec<Profile> = profiles
            .list()?
            .into_iter()
            .filter(|p| names.contains(&p.name))
            .collect();
        let (digest, idle) = self.wakes.digest_to_send(r).await?;
        // A Navi's lead runs from `navi.start` in the assistant role: manual permission mode, so every tool off its
        // read allow-list asks a person first (approvals/permissions.rs).
        let navi = project.kind == Some(ProjectKind::Assistant);
        let you = crate::hub::memory::You::for_lead(&self.ctx.db, r)
            .unwrap_or(crate::hub::memory::You::Nobody);
        let start = render_lead_start(
            &set,
            r,
            &project.title,
            &allowed,
            &digest,
            &self.ctx.db.memory().injected(r, true, &you),
            &crate::hub::people::lead_people(&self.ctx.db),
            navi.then_some(project.workspace_root.as_str()),
        );
        let mut prompt = start.first.clone();
        if let Some(repos) = super::prompt::repos_block(r, &project.repos) {
            prompt = format!("{}\n\n{repos}", prompt.trim_end());
        }
        if let Some(waiting) = self.waiting_orders(r)? {
            prompt = format!("{}\n\n{waiting}", prompt.trim_end());
        }
        if let Some(first) = first {
            prompt = format!("{}\n\n{}", prompt.trim_end(), first.trim_end());
        }
        let launched_ms = now_ms(self.ctx.clock.as_ref());
        let title: String = format!("fleetd lead: {}", project.title)
            .chars()
            .take(80)
            .collect();
        // The lead always runs on the default.
        let input = LaunchInput {
            project_id: r.project_id.clone(),
            prompt: prompt.clone(),
            system_prompt: Some(start.system.clone()),
            profile: default.name.clone(),
            runtime_mode: if navi {
                RuntimeMode::ApprovalRequired
            } else {
                RuntimeMode::FullAccess
            },
            title: Some(title),
            // The node's launch is idempotent on the id, so the id names this launch: a hub started on a fresh
            // database must get a new thread, not the one an earlier hub launched for the same project.
            client_request_id: format!(
                "fleetd-lead:{}/{}:{session_generation}:{launched_ms}",
                r.machine_id, r.project_id
            ),
        };
        let role = if navi {
            SessionRole::Assistant
        } else {
            SessionRole::Lead
        };
        // Read before the launch: a change that lands meanwhile starts the next turn fresh again.
        let mcp = self.ctx.db.mcp_servers().lead_set(r);
        let thread_id = self.ctx.ports().launch(&r.machine_id, input, role).await?;
        self.wakes.idle_sent(r, idle);
        match mcp.map(|set| self.records.lead_mcp_put(r, &thread_id, &set)) {
            Ok(Ok(())) => {}
            Ok(Err(error)) | Err(error) => {
                tracing::warn!(%error, "the lead's MCP servers were not kept")
            }
        }
        let at: Timestamp = at.into();
        // Every later message to this thread renders from the texts it starts with.
        let text_sha = self
            .ctx
            .db
            .prompts()
            .pin(
                &set,
                Audience::Lead,
                r,
                &thread_id,
                &at,
                &LeadStart {
                    first: prompt,
                    ..start
                }
                .whole(),
            )
            .unwrap_or_else(|error| {
                // The lead runs either way; its wakes then follow the current texts.
                tracing::warn!(%error, "lead prompts not pinned");
                String::new()
            });
        let lead = StoredLead {
            project_ref: r.clone(),
            thread_id: thread_id.clone(),
            started_at: at.clone(),
            last_wake_at: None,
            session_generation,
        };
        self.records.lead_put(&lead)?;
        self.ctx.events.append(NewEvent {
            at,
            r#type: HubEventType::LeadStarted,
            machine_id: Some(r.machine_id.clone()),
            project_id: Some(r.project_id.clone()),
            thread_id: Some(thread_id),
            summary: format!("Lead of {} started (session {session_generation})", project.title),
            data: Some(serde_json::json!({ "sessionGeneration": session_generation, "profile": default.name, "promptRef": set.get(super::prompt::start_prompt(navi)).r#ref, "textSha": text_sha })),
            attention: None,
        })?;
        self.with_state(lead)
    }
}

/// The chat's line for the MCP servers a fresh lead session gets that its last one didn't: none for none.
fn connected_line(names: &[&str]) -> Option<String> {
    let (last, rest) = names.split_last()?;
    Some(match rest {
        [] => format!("{last} is connected: I can use it now."),
        _ => format!(
            "{} and {last} are connected: I can use them now.",
            rest.join(", ")
        ),
    })
}

/// A lead idle this long has lost its prompt cache (1 hour for leads): starting it fresh costs a few thousand tokens,
/// resuming it its whole history.
pub const LEAD_FRESH_AFTER: Duration = Duration::from_secs(3600);
/// The chat messages a fresh lead session reads, newest last; each cut to [`RECENT_CHAT_CHARS`].
const RECENT_CHAT: usize = 12;
const RECENT_CHAT_CHARS: usize = 500;

/// The project's last few chat messages between the human, the lead and agents, for a fresh lead session; None when
/// there are none. System lines are left out (the digest has the state), and so are held messages: the one that
/// starts the session follows on its own.
fn recent_chat(db: &HubDb, r: &ProjectRef) -> Option<String> {
    let rows: Vec<String> = db
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND held = 0
                 ORDER BY seq DESC LIMIT 200",
            )?;
            let rows = stmt
                .query_map([r.machine_id.as_str(), r.project_id.as_str()], |row| {
                    row.get(0)
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
        .ok()?;
    let mut lines: Vec<String> = rows
        .iter()
        .filter_map(|data| serde_json::from_str::<ChatMessage>(data).ok())
        .filter(|m| !m.text.as_str().trim().is_empty())
        .filter_map(|m| {
            let who = match m.author {
                ChatAuthor::Human => "Human".to_owned(),
                ChatAuthor::Lead => "You".to_owned(),
                ChatAuthor::Agent => format!("Agent {}", m.by.as_ref().map_or("", |b| b.as_str())),
                ChatAuthor::System => return None,
            };
            Some(format!(
                "{}: {}",
                who.trim(),
                clip(m.text.as_str().trim(), RECENT_CHAT_CHARS)
            ))
        })
        .take(RECENT_CHAT)
        .collect();
    if lines.is_empty() {
        return None;
    }
    lines.reverse();
    Some(format!(
        "## Recent chat\nYour session started fresh; the chat before this is not in it.\n{}",
        lines.join("\n")
    ))
}
