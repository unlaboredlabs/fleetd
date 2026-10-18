//! T3 bearer sessions minted with T3's own CLI against this machine's T3 home, and the keeper that holds one live
//! session for the hub: mint once T3 is up, re-mint every 45 min and whenever T3 comes back from being down, and
//! revoke the old one 30 s after its replacement reached the hub (revoking first would drop the hub's T3 socket).
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::{mpsc, oneshot, watch};
use zeroize::Zeroizing;

use crate::node::supervisor::{T3Supervisor, exec};
use crate::node::util::{AbortOnDrop, tail_utf16};

pub struct T3Session {
    pub session_id: String,
    /// Never logged: it only goes to the hub in a `t3session` frame.
    pub bearer: Zeroizing<String>,
    pub expires_at: String,
}

/// Carries only T3's exit code and the tail of its stderr; stdout holds the bearer and is never kept.
#[derive(Debug)]
pub struct T3SessionError {
    pub exit_code: Option<i32>,
    pub stderr_tail: String,
}

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

pub trait T3Sessions: Send + Sync + 'static {
    fn mint(&self) -> BoxFuture<Result<T3Session, T3SessionError>>;
    fn revoke(&self, session_id: String) -> BoxFuture<Result<(), T3SessionError>>;
}

/// Mints with `--json` rather than `--token-only`: rotation has to revoke the previous session, and only the JSON
/// output carries the session id `auth session revoke` takes.
pub struct CliSessions {
    pub t3_cmd: Vec<String>,
    pub t3_home: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Issued {
    session_id: String,
    token: String,
    expires_at: String,
}

impl CliSessions {
    fn run(&self, args: &[&str]) -> BoxFuture<Result<String, T3SessionError>> {
        let mut argv = self.t3_cmd.clone();
        if argv.is_empty() {
            argv.push("t3".to_owned());
        }
        argv.extend(args.iter().map(|a| (*a).to_owned()));
        Box::pin(async move {
            let out = exec(&argv, Duration::from_secs(60)).await;
            match out.error {
                None => Ok(out.stdout),
                Some(_) => Err(T3SessionError {
                    exit_code: out.exit_code,
                    stderr_tail: tail_utf16(out.stderr.trim(), 300).to_owned(),
                }),
            }
        })
    }
}

impl T3Sessions for CliSessions {
    fn mint(&self) -> BoxFuture<Result<T3Session, T3SessionError>> {
        let run = self.run(&[
            "auth",
            "session",
            "issue",
            "--base-dir",
            &self.t3_home,
            "--ttl",
            "1h",
            "--label",
            "fleetd-node",
            "--json",
        ]);
        Box::pin(async move {
            let stdout = Zeroizing::new(run.await?);
            let json = stdout.find('{').map_or("", |at| &stdout[at..]);
            match serde_json::from_str::<Issued>(json) {
                Ok(issued) if !issued.session_id.is_empty() && !issued.token.is_empty() => {
                    Ok(T3Session {
                        session_id: issued.session_id,
                        bearer: Zeroizing::new(issued.token),
                        expires_at: issued.expires_at,
                    })
                }
                _ => Err(T3SessionError {
                    exit_code: Some(0),
                    stderr_tail: "output is not the expected JSON".to_owned(),
                }),
            }
        })
    }

    fn revoke(&self, session_id: String) -> BoxFuture<Result<(), T3SessionError>> {
        let run = self.run(&[
            "auth",
            "session",
            "revoke",
            "--base-dir",
            &self.t3_home,
            &session_id,
        ]);
        Box::pin(async move { run.await.map(|_| ()) })
    }
}

/// A minted session plus a signal the link raises once the hub has been sent it.
pub struct KeptSession {
    pub session: T3Session,
    delivered: watch::Sender<bool>,
}

impl KeptSession {
    pub fn mark_delivered(&self) {
        self.delivered.send_replace(true);
    }

    async fn await_delivered(&self) {
        let _ = self.delivered.subscribe().wait_for(|sent| *sent).await;
    }
}

const REMINT_AFTER: Duration = Duration::from_secs(45 * 60);
const REVOKE_GRACE: Duration = Duration::from_secs(30);

pub struct SessionKeeper {
    current: watch::Receiver<Option<Arc<KeptSession>>>,
    kicks: mpsc::UnboundedSender<oneshot::Sender<()>>,
    _task: AbortOnDrop,
}

impl SessionKeeper {
    pub fn start(t3: Arc<dyn T3Sessions>, supervisor: T3Supervisor) -> Self {
        let (tx, current) = watch::channel(None);
        let (kicks, kicks_rx) = mpsc::unbounded_channel();
        let task = AbortOnDrop(tokio::spawn(keep(t3, supervisor, tx, kicks_rx)));
        Self {
            current,
            kicks,
            _task: task,
        }
    }

    /// The current session first (once one exists), then each replacement.
    pub fn subscribe(&self) -> watch::Receiver<Option<Arc<KeptSession>>> {
        let mut rx = self.current.clone();
        rx.mark_changed();
        rx
    }

    pub fn remint_handle(&self) -> RemintHandle {
        RemintHandle {
            kicks: self.kicks.clone(),
        }
    }
}

#[derive(Clone)]
pub struct RemintHandle {
    kicks: mpsc::UnboundedSender<oneshot::Sender<()>>,
}

impl RemintHandle {
    /// Mints a fresh session now (once T3 is up) and returns once the hub has been sent it.
    pub fn remint_now(&self) -> impl Future<Output = ()> + Send + 'static {
        let (done, wait) = oneshot::channel();
        let _ = self.kicks.send(done);
        async move {
            // A keeper that is gone never answers.
            if wait.await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }
}

async fn mint(t3: &Arc<dyn T3Sessions>) -> Arc<KeptSession> {
    let mut delay = Duration::from_secs(5);
    let session = loop {
        match t3.mint().await {
            Ok(session) => break session,
            Err(error) => {
                tracing::warn!(exit_code = ?error.exit_code, stderr = %error.stderr_tail, "t3 session mint failed; retrying");
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(300));
            }
        }
    };
    tracing::info!(session_id = %session.session_id, expires_at = %session.expires_at, "t3 session minted");
    Arc::new(KeptSession {
        session,
        delivered: watch::Sender::new(false),
    })
}

async fn revoke_after_switch(
    t3: Arc<dyn T3Sessions>,
    previous: Arc<KeptSession>,
    next: Arc<KeptSession>,
) {
    next.await_delivered().await;
    tokio::time::sleep(REVOKE_GRACE).await;
    let id = previous.session.session_id.clone();
    match t3.revoke(id.clone()).await {
        Ok(()) => tracing::info!(session_id = %id, "t3 session revoked"),
        Err(error) => {
            tracing::warn!(session_id = %id, exit_code = ?error.exit_code, "t3 session revoke failed; it expires on its own")
        }
    }
}

async fn keep(
    t3: Arc<dyn T3Sessions>,
    supervisor: T3Supervisor,
    current: watch::Sender<Option<Arc<KeptSession>>>,
    mut kicks: mpsc::UnboundedReceiver<oneshot::Sender<()>>,
) {
    // Revocations and kick answers end with the keeper.
    let mut side = tokio::task::JoinSet::new();
    let mut kept: Option<Arc<KeptSession>> = None;
    let mut waiting: Vec<oneshot::Sender<()>> = Vec::new();
    loop {
        supervisor.await_up().await;
        let next = mint(&t3).await;
        current.send_replace(Some(next.clone()));
        if let Some(previous) = kept.take() {
            side.spawn(revoke_after_switch(t3.clone(), previous, next.clone()));
        }
        kept = Some(next.clone());
        // Requests made while this one was minting are answered by it.
        while let Ok(kick) = kicks.try_recv() {
            waiting.push(kick);
        }
        if !waiting.is_empty() {
            let answered = std::mem::take(&mut waiting);
            let next = next.clone();
            side.spawn(async move {
                next.await_delivered().await;
                for done in answered {
                    let _ = done.send(());
                }
            });
        }
        while side.try_join_next().is_some() {}
        tokio::select! {
            () = tokio::time::sleep(REMINT_AFTER) => {}
            () = supervisor.await_down() => {}
            // Back in line, so the next mint answers it with the others.
            Some(kick) = kicks.recv() => waiting.push(kick),
        }
    }
}
