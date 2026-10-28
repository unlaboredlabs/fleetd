//! What a session is given beyond its brief: its order's variables on top of its project's, the names of both in its
//! brief, a new claude at the next turn once its order's variables change, its worktree's setup commands before the
//! brief goes, and the masker its own fleetd calls pass through.
use fleetd_contracts::prim::NonEmpty;
use fleetd_contracts::project_settings::WorktreeSetup;
use fleetd_contracts::sessions::{
    FailureClass, ItemKind, ItemStatus, SendMode, SessionError, SessionRole, ThreadItem,
};

use super::super::browser::onepassword::TOKEN_ENV;
use super::super::mask::{Masker, Secrets};
use super::super::project_env::Vars;
use super::super::worktree_setup::{self, Ran};
use super::{
    EXIT_WAIT, REAP_GRACE, SessionCommand, SessionRow, SessionService, blocking, now, share,
};

/// The secret of the Claude account the session runs on, as the node holds it now, for masking what the session
/// reports: none for the machine's own login, or once the node no longer holds it. Lenient, as the project's are
/// there; its fleetd calls go through [`SessionService::call_secrets`], which fails closed on a file it can't read.
fn account_secrets(home: &std::path::Path, row: &SessionRow) -> super::super::project_env::Vars {
    row.local
        .claude_account
        .as_ref()
        .and_then(|account| super::super::claude_accounts::secrets_checked(home, account).ok())
        .unwrap_or_default()
}

/// A plain value shown in a brief: one line of at most this many characters.
const SHOWN_MAX: usize = 100;

impl SessionService {
    /// The session's order's variables, and their digest; none outside an order.
    pub(super) fn order_vars(&self, row: &SessionRow) -> (Vars, Option<String>) {
        match &row.local.order_id {
            Some(order) => super::super::order_env::for_spawn(
                &self.inner.config.home,
                row.summary.project_id.as_str(),
                order,
            ),
            None => (Vec::new(), None),
        }
    }

    /// The project's, the order's and the session's MCP servers' secrets as they are now.
    pub(super) fn secrets_now(&self, row: &SessionRow) -> Secrets {
        let home = &self.inner.config.home;
        let mut secrets = super::super::project_env::secrets(home, row.summary.project_id.as_str());
        secrets.extend(self.order_vars(row).0);
        secrets.extend(super::super::mcp_servers::secrets(
            home,
            &home.join("sessions").join(row.summary.session_id.as_str()),
        ));
        secrets.extend(account_secrets(home, row));
        Secrets(secrets)
    }

    /// For masking the fleetd calls a session makes (`report`, `ask_lead`, any agent tool) before they leave the
    /// machine: the secrets its process holds and its project's and order's now.
    ///
    /// Fails closed: when the session or a file of its secrets can't be read, there is no masker, and the caller
    /// sends nothing. The reason names the file, never a value.
    pub fn call_masker(&self, id: &str) -> Result<Masker, String> {
        Ok(Masker::new(&self.call_secrets(id)?.0))
    }

    /// The secrets of a session's calls: its project's and order's variables and its MCP servers', those its claude
    /// started with too.
    pub fn call_secrets(&self, id: &str) -> Result<Secrets, String> {
        let spawned = self.st().live.get(id).map(|l| l.spawned.clone());
        let row = match self.store().session(id) {
            Ok(Some(row)) => row,
            Ok(None) => return Err(format!("no session {id} on this machine")),
            Err(e) => return Err(format!("cannot read session {id}: {e}")),
        };
        let home = &self.inner.config.home;
        let project = row.summary.project_id.as_str();
        let mut secrets = super::super::project_env::secrets_checked(home, project)?;
        if let Some(order) = &row.local.order_id {
            secrets.extend(super::super::order_env::secrets_checked(
                home, project, order,
            )?);
        }
        // An MCP server whose secrets the node can't resolve is left out of the session, so it never had them.
        secrets.extend(super::super::mcp_servers::secrets(
            home,
            &home.join("sessions").join(id),
        ));
        // An account gone since the session started masks nothing new, and its fleetd calls go on: the value its
        // claude still holds is among what it spawned with, below.
        if let Some(account) = &row.local.claude_account {
            secrets.extend(super::super::claude_accounts::secrets_checked(
                home, account,
            )?);
        }
        let now = Secrets(secrets);
        let all = Secrets(
            spawned
                .iter()
                .flat_map(|s| s.0.iter())
                .chain(&now.0)
                .cloned()
                .collect(),
        );
        Ok(all)
    }

    /// The prompt with the names of the variables the session gets: a plain one's short value too, a secret's never.
    pub(super) fn with_env_note(&self, row: &SessionRow, prompt: String) -> String {
        if row.local.role == SessionRole::Plain {
            return prompt;
        }
        let home = &self.inner.config.home;
        let project = row.summary.project_id.as_str();
        let (mut vars, _) = super::super::project_env::for_spawn(home, project);
        let secret: Vec<String> = super::super::project_env::secrets(home, project)
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        let (mut order, _) = self.order_vars(row);
        // The 1Password token is the node's, never in an agent's environment (spawn leaves it out).
        let token = TOKEN_ENV;
        let has_token = vars.iter().chain(&order).any(|(n, _)| n == token);
        vars.retain(|(n, _)| n != token);
        order.retain(|(n, _)| n != token);
        let shown = |(name, value): &(String, String)| {
            if secret.contains(name)
                || value.contains(['\n', '\r'])
                || value.chars().count() > SHOWN_MAX
            {
                format!("`{name}`")
            } else {
                format!("`{name}={value}`")
            }
        };
        let mut lines = Vec::new();
        let project_vars: Vec<String> = vars
            .iter()
            .filter(|(n, _)| !order.iter().any(|(o, _)| o == n))
            .map(|v| {
                let named = shown(v);
                if secret.contains(&v.0) {
                    format!("{named} (secret)")
                } else {
                    named
                }
            })
            .collect();
        if !project_vars.is_empty() {
            lines.push(format!(
                "- Set for the project's agents: {}.",
                project_vars.join(", ")
            ));
        }
        if let Some(order_id) = &row.local.order_id
            && !order.is_empty()
        {
            let names: Vec<String> = order
                .iter()
                .map(|(n, _)| format!("`{n}` (secret)"))
                .collect();
            lines.push(format!(
                "- Set for order {order_id}'s agents: {}.",
                names.join(", ")
            ));
        }
        if has_token {
            lines.push(format!(
                "- `{token}` is set, for this machine's node only: it isn't in your environment. Fill a login from \
                 1Password with fill_credential in a browser session."
            ));
        }
        if lines.is_empty() {
            return prompt;
        }
        format!(
            "{}\n\n## Variables\n{}\n- A secret's value is masked as ***NAME*** in everything you report.\n",
            prompt.trim_end(),
            lines.join("\n")
        )
    }

    /// A new turn of a session whose order's variables changed since its claude started: that claude is closed now,
    /// while no run is active, so the send starts a new one with them. Its conversation resumes as it was.
    pub(super) async fn renew_env(&self, id: &str) {
        let Ok(row) = self.session(id) else { return };
        let Some(order) = row.local.order_id.as_deref() else {
            return;
        };
        if row.summary.active_run_id.is_some() {
            return;
        }
        let home = self.inner.config.home.clone();
        let (project, order) = (row.summary.project_id.to_string(), order.to_owned());
        let digest =
            blocking(move || super::super::order_env::digest_of(&home, &project, &order)).await;
        let closing = {
            let mut st = self.st();
            let Some(live) = st.live.get_mut(id) else {
                return;
            };
            if live.closing || live.order_digest == digest {
                return;
            }
            live.closing = true;
            (live.commands.clone(), live.exited.clone())
        };
        tracing::info!(
            session_id = id,
            "the order's variables changed: claude starts again with them"
        );
        let (commands, mut exited) = closing;
        let _ = commands
            .send(SessionCommand::Shutdown { grace: REAP_GRACE })
            .await;
        let _ = tokio::time::timeout(EXIT_WAIT, exited.wait_for(|e| *e)).await;
    }

    /// Records the session's first run, then runs the worktree's setup in the background and sends the brief once it
    /// is done: with what setup did added, or not at all when it failed and the project does not start agents anyway.
    pub(super) async fn begin_after_setup(
        &self,
        id: &str,
        run_id: &NonEmpty,
        prompt: String,
        setup: WorktreeSetup,
    ) -> Result<(), SessionError> {
        {
            let workspace = self.workspace_lock(id);
            let _workspace = workspace.lock().await;
            if self.record_run(id, run_id, &prompt, None)?.is_err() {
                return Ok(());
            }
        }
        self.set_up_then_send(id, run_id, prompt, SendMode::Plain, setup);
        Ok(())
    }

    /// The setup due before the session's claude next starts: one the node stopped in the middle of (or that failed),
    /// or one for a worktree that is gone and comes back first.
    pub(super) fn setup_due(&self, id: &str) -> Option<WorktreeSetup> {
        let row = self.session(id).ok()?;
        let lost = row.local.base_ref.is_some() && !row.local.cwd.exists();
        (row.local.setup_pending || lost)
            .then_some(row.local.setup)
            .flatten()
    }

    /// Runs setup in the background, then sends the recorded run's message; sends that come meanwhile wait for it.
    pub(super) fn set_up_then_send(
        &self,
        id: &str,
        run_id: &NonEmpty,
        text: String,
        mode: SendMode,
        setup: WorktreeSetup,
    ) {
        let (done, waiting) = tokio::sync::watch::channel(None);
        let (cancel, cancelled) = tokio::sync::watch::channel(false);
        {
            let mut st = self.st();
            st.setting_up.insert(id.to_owned(), waiting);
            st.setup_cancel
                .insert(id.to_owned(), (run_id.to_string(), cancel));
        }
        let (service, id, run_id) = (self.clone(), id.to_owned(), run_id.clone());
        tokio::spawn(async move {
            let started = service
                .set_up(&id, &run_id, text, mode, &setup, cancelled)
                .await;
            {
                let mut st = service.st();
                st.setting_up.remove(&id);
                st.setup_cancel.remove(&id);
            }
            done.send_replace(Some(started));
        });
    }

    /// Ends the session's running setup, if any, and when `run` is given only the setup for that run: its command is
    /// killed and no claude starts. Returns what to wait on for it to have ended.
    pub(super) fn cancel_setup(
        &self,
        id: &str,
        run: Option<&str>,
    ) -> Option<tokio::sync::watch::Receiver<Option<bool>>> {
        let st = self.st();
        let (for_run, cancel) = st.setup_cancel.get(id)?;
        if run.is_some_and(|r| r != for_run) {
            return None;
        }
        cancel.send_replace(true);
        st.setting_up.get(id).cloned()
    }

    fn run_active(&self, id: &str, run_id: &NonEmpty) -> bool {
        self.store()
            .runs(id)
            .is_ok_and(|runs| runs.iter().any(|r| r.id == *run_id && r.status.is_active()))
    }

    /// Brings a lost worktree back, runs the setup commands, each shown as an item of the run, and sends the run's
    /// message with what setup did; true once it went to claude. Setup is due again until it has run to its end.
    async fn set_up(
        &self,
        id: &str,
        run_id: &NonEmpty,
        text: String,
        mode: SendMode,
        setup: &WorktreeSetup,
        mut cancelled: tokio::sync::watch::Receiver<bool>,
    ) -> bool {
        let Ok(mut row) = self.session(id) else {
            return false;
        };
        let rebuilt = match self.restore_worktree(id, &mut row, None).await {
            Ok((true, note)) => {
                let frame = {
                    let st = self.st();
                    let frame = self.store().commit(&row, &[], true);
                    if let Ok(Some(frame)) = &frame {
                        st.machine(frame.clone());
                    }
                    frame
                };
                if let Err(e) = frame {
                    self.fail_run(id, run_id, FailureClass::Other, &e.to_string());
                    return false;
                }
                note
            }
            Ok((false, _)) => None,
            Err(e) => {
                self.fail_run(id, run_id, FailureClass::Other, e.message.as_str());
                return false;
            }
        };
        let first = self
            .store()
            .runs(id)
            .ok()
            .and_then(|runs| runs.first().map(|r| r.id == *run_id))
            .unwrap_or(false);
        let env = self.setup_env(&row).await;
        let secrets = self.secrets_now(&row);
        let masker = Masker::new(&secrets.0);
        let scrub: Vec<String> = secrets.0.iter().map(|(_, v)| v.clone()).collect();
        let timeout_sec = setup.timeout_sec.get() as u64;
        let started_at = std::sync::Mutex::new(Vec::new());
        let item = |i: usize, command: &str, ran: Option<&Ran>| {
            let at = now();
            let started = started_at
                .lock()
                .ok()
                .and_then(|s| s.get(i).cloned())
                .unwrap_or_else(|| at.clone());
            let (status, output, exit_code) = match ran {
                None => (ItemStatus::Running, None, None),
                Some(r) => (
                    if r.ok() {
                        ItemStatus::Completed
                    } else {
                        ItemStatus::Failed
                    },
                    Some(masker.text(&r.output_tail).into_owned()),
                    r.exit_code.map(i64::from),
                ),
            };
            let item = ThreadItem {
                id: NonEmpty::unchecked(format!("setup-{run_id}-{i}")),
                run_id: Some(run_id.clone()),
                status,
                title: super::super::util::head_utf16(
                    &format!("Setup: {}", masker.text(command)),
                    200,
                )
                .to_owned(),
                started_at: started,
                completed_at: ran.map(|_| at.clone()),
                updated_at: at,
                kind: ItemKind::Command {
                    command: masker.text(command).into_owned(),
                    timeout_ms: Some(timeout_sec * 1000),
                    output,
                    output_omitted: false,
                    exit_code,
                },
            };
            if let Err(e) = self.update(id, |c| c.put_item(item)) {
                tracing::warn!(session_id = id, error = %e.message, "a setup item not recorded");
            }
        };
        let commands: Vec<String> = setup.commands.iter().map(|c| c.to_string()).collect();
        let running = worktree_setup::run(
            setup,
            &row.local.cwd,
            &env,
            &scrub,
            |i| {
                if let Ok(mut s) = started_at.lock() {
                    s.push(now());
                }
                item(i, &commands[i], None);
            },
            |i, ran| item(i, &commands[i], Some(ran)),
        );
        // An interrupt or stop ends setup: dropping it kills the command's process group. Setup stays due.
        let outcome = tokio::select! {
            outcome = running => outcome,
            _ = cancelled.wait_for(|c| *c) => {
                let at = started_at.lock().map(|s| s.len()).unwrap_or(0);
                if let Some(i) = at.checked_sub(1) {
                    let stopped = ThreadItem {
                        id: NonEmpty::unchecked(format!("setup-{run_id}-{i}")),
                        run_id: Some(run_id.clone()),
                        status: ItemStatus::Cancelled,
                        title: super::super::util::head_utf16(
                            &format!("Setup: {}", masker.text(&commands[i])),
                            200,
                        )
                        .to_owned(),
                        started_at: started_at
                            .lock()
                            .ok()
                            .and_then(|s| s.get(i).cloned())
                            .unwrap_or_else(now),
                        completed_at: Some(now()),
                        updated_at: now(),
                        kind: ItemKind::Command {
                            command: masker.text(&commands[i]).into_owned(),
                            timeout_ms: Some(timeout_sec * 1000),
                            output: None,
                            output_omitted: false,
                            exit_code: None,
                        },
                    };
                    let _ = self.update(id, |c| c.put_item(stopped));
                }
                tracing::info!(session_id = id, "worktree setup stopped: the agent does not start");
                return false;
            }
        };
        if !setup.run_anyway
            && let Some(why) = worktree_setup::failure(&outcome, timeout_sec)
        {
            tracing::info!(
                session_id = id,
                "worktree setup failed: the agent does not start"
            );
            self.fail_run(id, run_id, FailureClass::Other, &masker.text(&why));
            return false;
        }
        if let Err(e) = self.update(id, |c| c.row.local.setup_pending = false) {
            tracing::warn!(session_id = id, error = %e.message, "setup's end not recorded");
        }
        let note = worktree_setup::note(&outcome, timeout_sec, !first)
            .map(|n| masker.text(&n).into_owned());
        let text = match (&note, first) {
            (None, _) => text,
            // The brief: what setup did goes after it, and the stored message is what claude is sent, so a resend of
            // the brief sends the same.
            (Some(note), true) => {
                let text = format!("{}\n\n## Setup\n{note}\n", text.trim_end());
                let stored = self.store().message(id, run_id.as_str()).ok().flatten();
                if let Some(mut message) = stored {
                    message.text = text.clone();
                    if let Err(e) = self.update(id, |c| c.put_message(message)) {
                        tracing::warn!(session_id = id, error = %e.message, "the brief's setup note not recorded");
                    }
                }
                text
            }
            (Some(note), false) => format!("{note}\n\n{text}"),
        };
        let text = match rebuilt {
            Some(rebuilt) => format!("{rebuilt}\n\n{text}"),
            None => text,
        };
        // Ended while setup ran (an interrupt, a stop, the watchdog): no claude for it.
        if *cancelled.borrow() || !self.run_active(id, run_id) {
            return false;
        }
        self.send_run(id, run_id, &text, mode).await.is_ok()
    }

    /// What setup commands run with: the node's plain environment and git's SSH agent, the project's and order's
    /// variables, the build jobs and the session's scratch dir.
    async fn setup_env(&self, row: &SessionRow) -> Vec<(String, String)> {
        let home = self.inner.config.home.clone();
        let mut env = super::super::util::git_command_env();
        let (mut vars, _) =
            super::super::project_env::for_spawn(&home, row.summary.project_id.as_str());
        let (order, _) = self.order_vars(row);
        vars.retain(|(p, _)| !order.iter().any(|(o, _)| o == p));
        vars.extend(order);
        vars.retain(|(k, _)| !env.iter().any(|(e, _)| e == k) && k != TOKEN_ENV);
        env.extend(vars);
        let jobs_home = home.clone();
        let n = blocking(move || super::super::load::build_jobs_here(&jobs_home)).await;
        env.extend(share::jobs_env(&env, n));
        let scratch = share::scratch_dir(&home, row.summary.session_id.as_str());
        if super::super::config::mkdir_private(&scratch).is_ok() {
            let scratch = share::scratch_env(&scratch);
            env.retain(|(k, _)| !scratch.iter().any(|(s, _)| s == k));
            env.extend(scratch);
        }
        env
    }
}
