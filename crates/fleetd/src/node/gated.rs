//! Approved commands that outlive their link. A `gated_run` with a `requestId` runs to its end whatever happens to the
//! link it came on, and its result is kept under its request in `<node home>/gated/<Q>.json` for the hub's
//! `gated_resume`: after a dropped link or the hub's own restart (an approved `fleetd update` restarts its hub) the
//! hub asks for it once the link is back. A record still without a result after the node restarted says the command
//! was cut off, so the hub tells the person it may have run.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::node_link::{GatedResult, GatedResume, GatedRun};
use fleetd_contracts::prim::{NonEmpty, Text};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::secrets::{SecretsContext, run_gated};

/// How long a kept result stays: well past any hub restart or link drop it waits out.
const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);

/// One request's run on disk: the hub it ran for, and its result once it ended.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    hub_id: String,
    result: Option<GatedResult>,
}

pub struct GatedRuns {
    dir: PathBuf,
    machine_id: String,
    /// The requests running in this process, each with its result once it ended.
    running: Mutex<HashMap<String, watch::Receiver<Option<GatedResult>>>>,
}

impl GatedRuns {
    pub fn new(node_home: &Path, machine_id: &str) -> Arc<Self> {
        Arc::new(Self {
            dir: node_home.join("gated"),
            machine_id: machine_id.to_owned(),
            running: Mutex::default(),
        })
    }

    /// Runs `frame` for `hub_id`, keeping its result under its request. A request running here already isn't started
    /// twice: it answers with that run's result.
    pub async fn run(
        &self,
        frame: GatedRun,
        hub_id: &str,
        ctx: &SecretsContext<'_>,
    ) -> GatedResult {
        let Some(request) = frame.request_id.as_ref().map(|r| r.to_string()) else {
            return run_gated(frame, ctx).await;
        };
        let id = frame.id.clone();
        let running = self.running.lock().unwrap().get(&request).cloned();
        if let Some(running) = running {
            return self.ended(running, id).await;
        }
        let (done, ended) = watch::channel(None);
        self.running.lock().unwrap().insert(request.clone(), ended);
        self.prune();
        self.write(
            &request,
            &Record {
                hub_id: hub_id.to_owned(),
                result: None,
            },
        );
        let result = run_gated(frame, ctx).await;
        self.write(
            &request,
            &Record {
                hub_id: hub_id.to_owned(),
                result: Some(result.clone()),
            },
        );
        let _ = done.send(Some(result.clone()));
        self.running.lock().unwrap().remove(&request);
        result
    }

    /// `gated_resume`: the result of the request's run, once it ends when it still runs; `unknown` says why there is
    /// none.
    pub async fn resume(&self, frame: GatedResume, hub_id: &str) -> GatedResult {
        let request = frame.request_id.to_string();
        let running = self.running.lock().unwrap().get(&request).cloned();
        if let Some(running) = running {
            return self.ended(running, frame.id).await;
        }
        let machine = &self.machine_id;
        match self.read(&request).filter(|r| r.hub_id == hub_id) {
            Some(Record {
                result: Some(result),
                ..
            }) => GatedResult {
                id: frame.id,
                ..result
            },
            Some(Record { result: None, .. }) => unknown(
                frame.id,
                format!("{machine}'s node restarted while it ran, which ended it"),
            ),
            None => unknown(
                frame.id,
                format!("{machine}'s node has no record of running it"),
            ),
        }
    }

    async fn ended(
        &self,
        mut running: watch::Receiver<Option<GatedResult>>,
        id: NonEmpty,
    ) -> GatedResult {
        match running.wait_for(Option::is_some).await {
            Ok(result) => GatedResult {
                id,
                ..result.clone().expect("waited for a result")
            },
            Err(_) => unknown(id, format!("{}'s node lost the run", self.machine_id)),
        }
    }

    fn path(&self, request: &str) -> PathBuf {
        self.dir.join(format!("{request}.json"))
    }

    fn read(&self, request: &str) -> Option<Record> {
        serde_json::from_slice(&std::fs::read(self.path(request)).ok()?).ok()
    }

    /// A failure costs only the result after a restart, so it is logged.
    fn write(&self, request: &str, record: &Record) {
        let wrote = std::fs::create_dir_all(&self.dir)
            .and_then(|()| serde_json::to_vec(record).map_err(std::io::Error::other))
            .and_then(|json| crate::update::replace_file(&self.path(request), &json));
        if let Err(e) = wrote {
            tracing::warn!(%request, "couldn't keep an approved command's result: {e}");
        }
    }

    /// Drops the records older than [`KEEP`].
    fn prune(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > KEEP);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

fn unknown(id: NonEmpty, why: String) -> GatedResult {
    GatedResult {
        id,
        exit_code: None,
        output_tail: Text::unchecked(""),
        timed_out: false,
        error: None,
        unknown: Some(Text::unchecked(why)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(roots: &'a [String], home: &'a Path) -> SecretsContext<'a> {
        SecretsContext {
            machine_id: "devbox",
            roots,
            home,
            box_key: None,
        }
    }

    fn frame(id: &str, argv: &[&str], cwd: &str) -> GatedRun {
        serde_json::from_value(serde_json::json!({
            "id": id, "argv": argv, "cwd": cwd, "timeoutSec": 60, "requestId": "Q4",
        }))
        .unwrap()
    }

    fn resume(id: &str) -> GatedResume {
        serde_json::from_value(serde_json::json!({ "id": id, "requestId": "Q4", "timeoutSec": 60 }))
            .unwrap()
    }

    /// The link a command came on drops while it runs (the hub restarting): it runs on, and the hub's `gated_resume`
    /// on the next link gets its real result, once it ends.
    #[tokio::test]
    async fn a_run_whose_link_dropped_answers_the_next_links_resume_with_its_result() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let roots = [root
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()];
        let runs = GatedRuns::new(home.path(), "devbox");
        let gate = root.path().join("go");
        let script = format!(
            "while [ ! -e {} ]; do sleep 0.05; done; echo updated; exit 3",
            gate.display()
        );
        let run = {
            let (runs, roots, home) = (runs.clone(), roots.clone(), home.path().to_owned());
            // Not the link's task: the dropped link's answer goes nowhere, the result is kept.
            tokio::spawn(async move {
                runs.run(
                    frame("1", &["sh", "-c", &script], &roots[0]),
                    "hub-a",
                    &ctx(&roots, &home),
                )
                .await
            })
        };
        while runs.running.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        let asked = {
            let runs = runs.clone();
            tokio::spawn(async move { runs.resume(resume("2"), "hub-a").await })
        };
        std::fs::write(&gate, "").unwrap();
        let answered = asked.await.unwrap();
        assert_eq!(answered.id.as_str(), "2");
        assert_eq!(answered.exit_code, run.await.unwrap().exit_code);
        assert_eq!(serde_json::to_value(answered.exit_code).unwrap(), 3);
        assert_eq!(answered.output_tail.as_str().trim(), "updated");
        assert_eq!(answered.unknown, None);
        // Kept on disk: a node restarted since still has it.
        let again = GatedRuns::new(home.path(), "devbox")
            .resume(resume("3"), "hub-a")
            .await;
        assert_eq!(again.output_tail.as_str().trim(), "updated");
        assert_eq!(again.id.as_str(), "3");
    }

    /// The node restarted while the command ran: its record has no result, so the hub hears it was cut off, never a
    /// made-up result. Another hub's record, or none, is no result either.
    #[tokio::test]
    async fn a_run_the_node_lost_answers_unknown() {
        let home = tempfile::tempdir().unwrap();
        let runs = GatedRuns::new(home.path(), "devbox");
        runs.write(
            "Q4",
            &Record {
                hub_id: "hub-a".into(),
                result: None,
            },
        );
        let cut = runs.resume(resume("1"), "hub-a").await;
        assert_eq!(
            cut.unknown.unwrap().as_str(),
            "devbox's node restarted while it ran, which ended it"
        );
        assert_eq!((cut.exit_code, cut.error), (None, None));
        for hub in ["hub-b", "hub-a"] {
            if hub == "hub-a" {
                std::fs::remove_file(runs.path("Q4")).unwrap();
            }
            let none = runs.resume(resume("2"), hub).await;
            assert_eq!(
                none.unknown.unwrap().as_str(),
                "devbox's node has no record of running it"
            );
        }
    }
}
