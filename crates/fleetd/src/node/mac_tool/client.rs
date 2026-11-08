//! The agent's node's half of `fleetd mac`: each [`MacCall`] becomes steps sealed to the agents' Mac (`mac_where`
//! names it and its key), sent through the hub (`mac_send`), whose sealed answers only this node opens. Files go
//! between the agent's own worktree and its folder on the Mac, never anywhere else: `push` from the worktree, `pull`
//! into it. Each `mac run` goes to the agent's action log, its exit code too once a `logs` step sees it.
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::ids::{MachineId, ThreadId};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallFrame, LeadCallResult};
use fleetd_contracts::mac::{MacCall, MacDone, MacSendCall, MacWhereCall};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::prim::NonEmpty;
use fleetd_contracts::sessions::{ItemKind, ItemStatus, ThreadItem};

use super::{
    Answer, Done, Envelope, PIECE, PULL_MAX, PUSH_MAX, Step, now_ms, open_answer, seal_step,
};
use crate::node::desktop::WorktreeFor;
use crate::node::lead::{LeadRelay, MaskFor};

/// How long the node waits for one sealed step: past the hub's own wait (hub/mac_tool.rs `SEND_WAIT`).
pub const SEND_WAIT: Duration = Duration::from_secs(180);

/// How long a push or pull keeps sending a step again while the hub or the Mac is out of reach (a dropped link): past
/// it, the call fails as before. The waits between tries double from [`RESEND_FIRST`] up to [`RESEND_MOST`].
pub const RESEND_FOR: Duration = Duration::from_secs(300);
pub const RESEND_FIRST: Duration = Duration::from_secs(1);
pub const RESEND_MOST: Duration = Duration::from_secs(15);

/// Puts an item in the agent session's action log, under its run now.
pub type ActionLog = Arc<dyn Fn(&str, ThreadItem) + Send + Sync>;

fn refuse(message: impl Into<String>) -> McpToolError {
    McpToolError::new(ErrorCode::Invalid, message)
}

fn failed(message: impl Into<String>) -> McpToolError {
    McpToolError::new(ErrorCode::Failed, message)
}

#[derive(Clone)]
pub struct Client {
    pub relay: LeadRelay,
    pub worktree_of: WorktreeFor,
    pub mask_for: MaskFor,
    pub log: ActionLog,
    /// The node's home: a push's snapshot index and pack and a pull's pieces wait in its `tmp/`, and a session's
    /// forwarding `agent-device` goes there while it holds a simulator on the Mac.
    pub home: PathBuf,
    /// Each session's runs in its action log, by job: the item and its command line.
    runs: Runs,
}

/// A foreground `mac run`'s line in the action log, until it ends.
struct Run {
    id: String,
    command: String,
    started_at: fleetd_contracts::ids::Timestamp,
    /// The last `logs` step that followed it.
    followed: tokio::time::Instant,
}

/// (session, job) -> its line.
type Runs = Arc<Mutex<HashMap<(String, u32), Run>>>;

/// How often the node looks at its foreground runs nobody follows.
pub const RUN_CHECK: Duration = Duration::from_secs(30);
/// A foreground run nobody followed for this long (its `fleetd mac` stopped: a Bash timeout, Ctrl-C) gets its end
/// from the Mac's `ps`; the Mac ends such a job after 60 s (jobs.rs `FOREGROUND_IDLE`).
pub const UNFOLLOWED: Duration = Duration::from_secs(90);

/// The agents' Mac as `mac_where` named it.
struct Mac {
    machine_id: MachineId,
    key: [u8; 32],
}

impl Client {
    pub fn new(
        relay: LeadRelay,
        worktree_of: WorktreeFor,
        mask_for: MaskFor,
        log: ActionLog,
        home: PathBuf,
    ) -> Self {
        Self {
            relay,
            worktree_of,
            mask_for,
            log,
            home,
            runs: Arc::default(),
        }
    }

    async fn lead(
        &self,
        thread: &str,
        cwd: &Path,
        call: LeadCall,
        wait: Duration,
    ) -> Result<LeadCallResult, McpToolError> {
        let frame = LeadCallFrame {
            id: NonEmpty::unchecked("mac"),
            cwd: serde_json::from_value(serde_json::json!(cwd.to_string_lossy()))
                .map_err(|_| refuse("the worktree's path doesn't read"))?,
            call,
            thread_id: Some(ThreadId::unchecked(thread)),
        };
        let answer = self.relay.call_within(frame, wait).await;
        match (answer.result, answer.error) {
            (Some(result), _) => Ok(result),
            (None, Some(error)) => Err(error),
            (None, None) => Err(failed("the hub sent no answer")),
        }
    }

    async fn find(&self, thread: &str, cwd: &Path) -> Result<Mac, McpToolError> {
        match self
            .lead(thread, cwd, LeadCall::MacWhere(MacWhereCall {}), SEND_WAIT)
            .await?
        {
            LeadCallResult::MacWhere(r) => {
                let key = B64
                    .decode(r.box_pub_key.as_str())
                    .ok()
                    .and_then(|k| <[u8; 32]>::try_from(k).ok())
                    .ok_or_else(|| failed("the Mac's key is not 32 bytes"))?;
                Ok(Mac {
                    machine_id: r.machine_id,
                    key,
                })
            }
            _ => Err(failed(
                "the hub answered mac_where with another call's result",
            )),
        }
    }

    /// One step, sealed to the Mac, and its answer opened.
    async fn send(
        &self,
        thread: &str,
        cwd: &Path,
        mac: &Mac,
        step: Step,
    ) -> Result<Done, McpToolError> {
        self.send_with(thread, cwd, mac, step, &[])
            .await
            .map(|(done, _)| done)
    }

    /// [`Self::send`] with `raw` after the step, sent again while the hub or the Mac can't be reached (for
    /// [`RESEND_FOR`]): only for steps that do the same twice (`have`, `put`, `checkout`, `get`). The answer comes
    /// with the raw bytes after it.
    async fn send_again(
        &self,
        thread: &str,
        cwd: &Path,
        mac: &Mac,
        step: Step,
        raw: &[u8],
    ) -> Result<(Done, Vec<u8>), McpToolError> {
        let started = tokio::time::Instant::now();
        let mut wait = RESEND_FIRST;
        loop {
            match self.send_with(thread, cwd, mac, step.clone(), raw).await {
                Err(e) if e.code == ErrorCode::MachineOffline && started.elapsed() < RESEND_FOR => {
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(RESEND_MOST);
                }
                done => return done,
            }
        }
    }

    async fn send_with(
        &self,
        thread: &str,
        cwd: &Path,
        mac: &Mac,
        step: Step,
        raw: &[u8],
    ) -> Result<(Done, Vec<u8>), McpToolError> {
        let answer_key = zeroize::Zeroizing::new(rand::random::<[u8; 32]>());
        let envelope = Envelope {
            thread: thread.to_owned(),
            at_ms: now_ms(),
            nonce: B64.encode(rand::random::<[u8; 16]>()),
            answer_key: B64.encode(answer_key.as_slice()),
            step,
        };
        let sealed =
            seal_step(&mac.key, &envelope, raw).ok_or_else(|| failed("the step didn't seal"))?;
        let call = LeadCall::MacSend(MacSendCall {
            machine_id: mac.machine_id.clone(),
            thread_id: ThreadId::unchecked(thread),
            sealed: NonEmpty::unchecked(sealed),
        });
        let sealed = match self.lead(thread, cwd, call, SEND_WAIT).await? {
            LeadCallResult::MacSend(r) => r.sealed,
            _ => {
                return Err(failed(
                    "the hub answered mac_send with another call's result",
                ));
            }
        };
        match open_answer(&answer_key, sealed.as_str()) {
            Some((
                Answer {
                    done: Some(done), ..
                },
                raw,
            )) => Ok((done, raw)),
            Some((
                Answer {
                    error: Some(error), ..
                },
                _,
            )) => Err(error),
            _ => Err(failed("the Mac's answer did not open").with_fix("run the command again")),
        }
    }

    /// The agent's `fleetd mac` call, for its session `thread`.
    pub async fn call(&self, thread: &str, call: MacCall) -> Result<MacDone, McpToolError> {
        let worktree = (self.worktree_of)(thread).ok_or_else(|| {
            refuse("fleetd mac runs in an agent's session, and this one has no worktree")
        })?;
        let mac = self.find(thread, &worktree).await?;
        let step = |s| self.send(thread, &worktree, &mac, s);
        match call {
            MacCall::Push => self.push(thread, &worktree, &mac).await,
            MacCall::Run {
                args,
                env,
                background,
            } => {
                let command = args.join(" ");
                let done = step(Step::Run {
                    args,
                    env,
                    background,
                })
                .await?;
                let Done::Run { job } = done else {
                    return Err(failed("the Mac answered run with another step's"));
                };
                self.log_run(thread, job, &command, background);
                Ok(MacDone::Run { job })
            }
            MacCall::Logs { job, offset } => match step(Step::Logs { job, offset }).await? {
                Done::Logs {
                    data_b64,
                    offset,
                    done,
                    exit_code,
                } => {
                    if done {
                        self.ended(thread, job, exit_code);
                    } else if let Some(run) = self
                        .runs
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get_mut(&(thread.to_owned(), job))
                    {
                        run.followed = tokio::time::Instant::now();
                    }
                    Ok(MacDone::Logs {
                        data_b64,
                        offset,
                        done,
                        exit_code,
                    })
                }
                _ => Err(failed("the Mac answered logs with another step's")),
            },
            MacCall::Ps => match step(Step::Ps).await? {
                Done::Ps { jobs } => Ok(MacDone::Ps { jobs }),
                _ => Err(failed("the Mac answered ps with another step's")),
            },
            MacCall::Kill { job } => match step(Step::Kill { job }).await? {
                Done::Kill { job, killed } => Ok(MacDone::Kill { job, killed }),
                _ => Err(failed("the Mac answered kill with another step's")),
            },
            MacCall::Pull { path, to } => {
                self.pull(thread, &worktree, &mac, &path, to.as_deref())
                    .await
            }
            // While it holds a simulator, the session's `agent-device` runs on the Mac (`fleetd mac agent-device`).
            MacCall::SimStart { device, wait } => match step(Step::SimStart { device, wait })
                .await?
            {
                Done::SimStart { udid, device } => {
                    install_forwarder(&self.home, thread, &crate::node::sessions::self_command())
                        .map_err(|e| failed(format!("agent-device wasn't put on your PATH: {e}")))?;
                    Ok(MacDone::SimStart { udid, device })
                }
                Done::SimQueued { place, secs, why } => Ok(MacDone::SimQueued { place, secs, why }),
                _ => Err(failed("the Mac answered sim start with another step's")),
            },
            MacCall::SimEnd => {
                let done = step(Step::SimEnd).await;
                crate::node::device::remote::remove_forwarder(&self.home, thread);
                match done? {
                    Done::SimEnd { ended } => Ok(MacDone::SimEnd { ended }),
                    _ => Err(failed("the Mac answered sim end with another step's")),
                }
            }
        }
    }

    async fn push(
        &self,
        thread: &str,
        worktree: &Path,
        mac: &Mac,
    ) -> Result<MacDone, McpToolError> {
        let scratch = self.home.join("tmp").join(format!("mac-{}", short(thread)));
        std::fs::create_dir_all(&scratch)
            .map_err(|e| failed(format!("the node's scratch folder wasn't made: {e}")))?;
        let (haves, raw) = match self
            .send_again(thread, worktree, mac, Step::Have, &[])
            .await?
        {
            (Done::Have { snapshots, raw }, _) => (snapshots, raw),
            _ => return Err(failed("the Mac answered have with another step's")),
        };
        let (dir, tmp) = (worktree.to_path_buf(), scratch.clone());
        let (snapshot, known) = tokio::task::spawn_blocking(move || {
            let known = super::push::known(&dir, &haves);
            super::push::snapshot(&dir, &tmp, known.first().map(String::as_str)).map(|s| (s, known))
        })
        .await
        .map_err(|e| failed(e.to_string()))?
        .map_err(|e| failed(format!("the worktree's snapshot wasn't made: {e}")))?;
        let mut sent = 0u64;
        let pack = if known.contains(&snapshot) {
            None
        } else {
            let (dir, tmp, snap) = (worktree.to_path_buf(), scratch.clone(), snapshot.clone());
            let path =
                tokio::task::spawn_blocking(move || super::push::pack(&dir, &tmp, &snap, &known))
                    .await
                    .map_err(|e| failed(e.to_string()))?
                    .map_err(|e| failed(format!("the push's pack wasn't made: {e}")))?;
            let sending = self.put(thread, worktree, mac, &path, raw).await;
            let _ = std::fs::remove_file(&path);
            sent = sending?;
            Some("push.pack".to_owned())
        };
        match self
            .send_again(
                thread,
                worktree,
                mac,
                Step::Checkout { snapshot, pack },
                &[],
            )
            .await?
        {
            (Done::Checkout { folder }, _) => Ok(MacDone::Push {
                folder,
                sent_bytes: sent,
            }),
            _ => Err(failed("the Mac answered checkout with another step's")),
        }
    }

    /// The pack, a piece at a time: `raw` after each step where the Mac takes that, else in base64.
    async fn put(
        &self,
        thread: &str,
        worktree: &Path,
        mac: &Mac,
        path: &Path,
        raw: bool,
    ) -> Result<u64, McpToolError> {
        use std::io::Read;
        let mut file = std::fs::File::open(path)
            .map_err(|e| failed(format!("the pack can't be read: {e}")))?;
        let total = file.metadata().map(|m| m.len()).unwrap_or(0);
        if total > PUSH_MAX {
            return Err(refuse(format!(
                "the push is {} MB, more than the Mac takes ({} MB)",
                total >> 20,
                PUSH_MAX >> 20
            ))
            .with_fix(
                "add what doesn't belong (build output, downloads) to .gitignore and push again",
            ));
        }
        let mut offset = 0u64;
        loop {
            let mut piece = Vec::with_capacity(PIECE);
            (&mut file)
                .take(PIECE as u64)
                .read_to_end(&mut piece)
                .map_err(|e| failed(format!("the pack can't be read: {e}")))?;
            let last = piece.is_empty() || offset + piece.len() as u64 >= total;
            let step = Step::Put {
                name: "push.pack".into(),
                offset,
                data_b64: if raw {
                    String::new()
                } else {
                    B64.encode(&piece)
                },
            };
            let after: &[u8] = if raw { &piece } else { &[] };
            match self.send_again(thread, worktree, mac, step, after).await? {
                (Done::Put { bytes }, _) => offset = bytes,
                _ => return Err(failed("the Mac answered put with another step's")),
            }
            if last {
                return Ok(offset);
            }
        }
    }

    async fn pull(
        &self,
        thread: &str,
        worktree: &Path,
        mac: &Mac,
        path: &str,
        to: Option<&str>,
    ) -> Result<MacDone, McpToolError> {
        let dest = destination(worktree, path, to)?;
        let scratch = self.home.join("tmp").join(format!("mac-{}", short(thread)));
        std::fs::create_dir_all(&scratch)
            .map_err(|e| failed(format!("the node's scratch folder wasn't made: {e}")))?;
        let piece_path = scratch.join("pull.part");
        let mut file = std::fs::File::create(&piece_path)
            .map_err(|e| failed(format!("the pull wasn't started: {e}")))?;
        let mut offset = 0u64;
        let mut folder = false;
        let mut restarted = false;
        loop {
            use std::io::{Seek, Write};
            let step = Step::Get {
                path: path.to_owned(),
                offset,
                raw: true,
            };
            let (data_b64, raw, total) =
                match self.send_again(thread, worktree, mac, step, &[]).await {
                    Ok((
                        Done::Get {
                            data_b64,
                            total,
                            folder: is_folder,
                        },
                        raw,
                    )) => {
                        folder = is_folder;
                        (data_b64, raw, total)
                    }
                    Ok(_) => return Err(failed("the Mac answered get with another step's")),
                    // A folder's last piece asked for again (its answer was lost): the Mac let its tar.gz go once it sent
                    // it, so the folder comes again from the start, once.
                    Err(e)
                        if e.code != ErrorCode::MachineOffline
                            && folder
                            && offset > 0
                            && !restarted =>
                    {
                        restarted = true;
                        offset = 0;
                        file.set_len(0)
                            .and_then(|_| file.rewind())
                            .map_err(|e| failed(format!("the pull wasn't started: {e}")))?;
                        continue;
                    }
                    Err(e) => return Err(e),
                };
            // An older Mac sends the piece in base64.
            let data = if data_b64.is_empty() {
                raw
            } else {
                B64.decode(data_b64)
                    .map_err(|_| failed("the piece is not base64"))?
            };
            if total > PULL_MAX || offset + data.len() as u64 > PULL_MAX {
                return Err(refuse("the pull is larger than the node takes"));
            }
            file.write_all(&data)
                .map_err(|e| failed(format!("the pull wasn't written: {e}")))?;
            offset += data.len() as u64;
            if offset >= total || data.is_empty() {
                break;
            }
        }
        drop(file);
        let (part, into) = (piece_path.clone(), dest.clone());
        let placed = tokio::task::spawn_blocking(move || place(&part, &into, folder))
            .await
            .map_err(|e| failed(e.to_string()))?;
        let _ = std::fs::remove_file(&piece_path);
        placed.map_err(|e| failed(format!("the pull wasn't placed: {e}")))?;
        Ok(MacDone::Pull {
            path: dest.to_string_lossy().into_owned(),
            bytes: offset,
        })
    }

    fn item(
        id: &str,
        command: &str,
        status: ItemStatus,
        started_at: fleetd_contracts::ids::Timestamp,
        exit_code: Option<i32>,
    ) -> ThreadItem {
        let at = fleetd_contracts::ids::Timestamp(crate::node::util::now_iso());
        ThreadItem {
            id: NonEmpty::unchecked(id),
            run_id: None,
            completed_at: (status != ItemStatus::Running).then(|| at.clone()),
            status,
            title: crate::node::util::head_utf16(&format!("Mac: {command}"), 200).to_owned(),
            started_at,
            updated_at: at,
            kind: ItemKind::Command {
                command: format!("mac run {command}"),
                timeout_ms: None,
                output: None,
                output_omitted: false,
                exit_code: exit_code.map(i64::from),
            },
        }
    }

    /// A `mac run`, in the agent's action log. One in the foreground stays running there until a `logs` step sees it
    /// end, or, once nobody follows it, until the Mac's `ps` says how it ended ([`Self::watch`]).
    pub fn log_run(&self, thread: &str, job: u32, command: &str, background: bool) {
        let command = match (self.mask_for)(thread) {
            Ok(masker) => masker.text(command).into_owned(),
            // No masker, no line: a value might show.
            Err(_) => "(a command fleetd couldn't mask)".to_owned(),
        };
        let id = format!("mac-run-{}-{job}", now_ms());
        let at = fleetd_contracts::ids::Timestamp(crate::node::util::now_iso());
        if background {
            let shown = format!("--bg {command}");
            (self.log)(
                thread,
                Self::item(&id, &shown, ItemStatus::Completed, at, None),
            );
            return;
        }
        (self.log)(
            thread,
            Self::item(&id, &command, ItemStatus::Running, at.clone(), None),
        );
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).insert(
            (thread.to_owned(), job),
            Run {
                id,
                command,
                started_at: at,
                followed: tokio::time::Instant::now(),
            },
        );
        let (client, thread) = (self.clone(), thread.to_owned());
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move { client.watch(&thread, job).await });
        }
    }

    /// Closes the line of a foreground run whose `fleetd mac` stopped following it, with the exit code the Mac's `ps`
    /// gives once the job ended there, or as cancelled when the Mac can't say.
    async fn watch(&self, thread: &str, job: u32) {
        let key = (thread.to_owned(), job);
        loop {
            tokio::time::sleep(RUN_CHECK).await;
            let followed = match self
                .runs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&key)
            {
                Some(run) => run.followed,
                None => return,
            };
            if followed.elapsed() < UNFOLLOWED {
                continue;
            }
            let Some(worktree) = (self.worktree_of)(thread) else {
                return self.ended(thread, job, None);
            };
            let listed = match self.find(thread, &worktree).await {
                Ok(mac) => self.send(thread, &worktree, &mac, Step::Ps).await,
                Err(e) => Err(e),
            };
            match listed {
                Ok(Done::Ps { jobs }) => match jobs.iter().find(|j| j.job == job) {
                    Some(j) if j.running => continue,
                    Some(j) => return self.ended(thread, job, j.exit_code),
                    // The Mac's node restarted: the job went with it.
                    None => return self.ended(thread, job, None),
                },
                _ => return self.ended(thread, job, None),
            }
        }
    }

    /// A foreground run ended: its line in the action log gets its exit code, or is cancelled without one.
    fn ended(&self, thread: &str, job: u32, exit_code: Option<i32>) {
        let Some(run) = self
            .runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&(thread.to_owned(), job))
        else {
            return;
        };
        let status = match exit_code {
            Some(0) => ItemStatus::Completed,
            Some(_) => ItemStatus::Failed,
            None => ItemStatus::Cancelled,
        };
        (self.log)(
            thread,
            Self::item(&run.id, &run.command, status, run.started_at, exit_code),
        );
    }
}

fn short(thread: &str) -> String {
    thread
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect()
}

/// Where a pull lands, as `cp` would put it: `to` (into it, when it's a folder there), else the path's last part, inside
/// the worktree only: never the worktree itself, nor anything in a `.git`.
pub fn destination(worktree: &Path, path: &str, to: Option<&str>) -> Result<PathBuf, McpToolError> {
    let leaf = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| refuse(format!("{path} names no file")))?;
    let named = to.map_or_else(|| leaf.clone(), str::to_owned);
    let rel = Path::new(&named);
    let rel = rel.strip_prefix(worktree).unwrap_or(rel);
    let plain = rel
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if !plain {
        return Err(refuse(format!("{named} is outside your worktree"))
            .with_fix("name a path inside your worktree, relative to it"));
    }
    let parts: PathBuf = rel
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .collect();
    let mut dest = worktree.join(&parts);
    if to.is_some() && dest.is_dir() {
        dest.push(&leaf);
    }
    let inner = dest.strip_prefix(worktree).unwrap_or(&dest);
    if inner.as_os_str().is_empty() {
        return Err(refuse("a pull can't replace your worktree itself")
            .with_fix("name a file or folder inside it, such as out/"));
    }
    if inner.components().any(|c| c.as_os_str() == ".git") {
        return Err(refuse(format!("{named} is inside .git")));
    }
    Ok(dest)
}

/// The pulled file moved to `dest`, or the pulled folder (a tar.gz) unpacked there: one holding links, or paths that
/// climb out, is refused. Nothing there is deleted: a file goes over the file of its name, a folder's files over theirs,
/// as `cp -R` would; a file where a folder is is refused.
pub fn place(part: &Path, dest: &Path, folder: bool) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if !folder {
        if dest.is_dir() {
            return Err(format!("{} is a folder", dest.display()));
        }
        return std::fs::rename(part, dest)
            .or_else(|_| std::fs::copy(part, dest).map(|_| ()))
            .map_err(|e| e.to_string());
    }
    let listed = std::process::Command::new("tar")
        .arg("-tvzf")
        .arg(part)
        .output()
        .map_err(|e| format!("tar didn't run: {e}"))?;
    if !listed.status.success() {
        return Err("the folder's archive doesn't read".into());
    }
    let names = std::process::Command::new("tar")
        .arg("-tzf")
        .arg(part)
        .output()
        .map_err(|e| format!("tar didn't run: {e}"))?;
    let names = String::from_utf8_lossy(&names.stdout);
    let linked = String::from_utf8_lossy(&listed.stdout)
        .lines()
        .any(|l| matches!(l.chars().next(), Some('l' | 'h')));
    let climbs = names.lines().any(|n| {
        n.starts_with('/') || Path::new(n).components().any(|c| c == Component::ParentDir)
    });
    if linked || climbs {
        return Err("the folder's archive holds links or paths outside it".into());
    }
    let parent = dest.parent().ok_or("no folder to unpack into")?;
    let unpack = tempfile::Builder::new()
        .prefix(".mac-pull-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    let out = std::process::Command::new("tar")
        .args(["-xzf"])
        .arg(part)
        .arg("-C")
        .arg(unpack.path())
        .arg("--no-same-owner")
        .output()
        .map_err(|e| format!("tar didn't run: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "tar failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let top = std::fs::read_dir(unpack.path())
        .map_err(|e| e.to_string())?
        .flatten()
        .next()
        .ok_or("the folder came back empty")?;
    merge(&top.path(), dest)
}

/// `from`'s files moved into `to`, over the files of their names; folders are merged, never removed.
fn merge(from: &Path, to: &Path) -> Result<(), String> {
    if !to.exists() {
        return std::fs::rename(from, to).map_err(|e| e.to_string());
    }
    if !to.is_dir() {
        return Err(format!("{} is a file, and a folder came", to.display()));
    }
    for entry in std::fs::read_dir(from)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let (from, to) = (entry.path(), to.join(entry.file_name()));
        if from.is_dir() {
            merge(&from, &to)?;
        } else if to.is_dir() {
            return Err(format!("{} is a folder, and a file came", to.display()));
        } else {
            std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The folder on every agent session's PATH that holds `mac`.
pub fn bin_dir(home: &Path) -> PathBuf {
    home.join("mac").join("bin")
}

/// `mac`: `exe` (this node's binary) as `fleetd mac`.
pub fn shim(exe: &str) -> String {
    format!(
        "#!/bin/sh\n\
         # fleetd's: the agents' Mac, for this session (fleetd mac --help).\n\
         exec '{}' mac \"$@\"\n",
        exe.replace('\'', r"'\''")
    )
}

/// Writes `mac` at the node's start, for the binary running now.
pub fn install_shim(home: &Path, exe: &str) -> std::io::Result<()> {
    let dir = bin_dir(home);
    std::fs::create_dir_all(&dir)?;
    let bin = dir.join("mac");
    crate::node::secrets::write_atomic(&bin, shim(exe).as_bytes())?;
    std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o755))
}

/// The forwarding `agent-device` while the session holds a simulator on the Mac: each command runs there.
pub fn forwarder(exe: &str) -> String {
    format!(
        "#!/bin/sh\n\
         # fleetd's: agent-device commands for your iOS simulator on the agents' Mac (mac sim).\n\
         exec '{}' mac agent-device \"$@\"\n",
        exe.replace('\'', r"'\''")
    )
}

/// Puts the forwarder first on the session's PATH, where an iOS screen elsewhere put its own.
pub fn install_forwarder(home: &Path, thread: &str, exe: &str) -> std::io::Result<()> {
    let dir = crate::node::device::remote::bin_dir(home, thread);
    crate::node::config::mkdir_private(&dir)?;
    let bin = dir.join("agent-device");
    crate::node::secrets::write_atomic(&bin, forwarder(exe).as_bytes())?;
    std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o700))
}
