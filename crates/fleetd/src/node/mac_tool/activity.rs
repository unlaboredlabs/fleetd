//! What agents do on the agents' Mac right now, for the person at it: the simulators lent to agents and the jobs they
//! run (`mac run`, builds most of all). Only this node knows either, as the hub passes the steps sealed. The node
//! rewrites [`file`] in its home whenever it changes (looked at every [`EVERY`]), and the app's menu bar on the Mac
//! reads it (app/desktop/src/main/menuBar.ts), as setup reads mac-health.json. It names agents by their folder (the
//! task's id, else the session's) and projects by id: the app, signed in to the hub, puts their names on them.
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How often the node looks for a change to write.
pub const EVERY: Duration = Duration::from_secs(2);
/// The most of a job's command line the file carries: the menu bar shows its start.
pub const COMMAND_MAX: usize = 200;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// The simulators agents hold, oldest first.
    pub simulators: Vec<SimActivity>,
    /// The jobs running, oldest first.
    pub jobs: Vec<JobActivity>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimActivity {
    /// The agent's folder on the Mac: its task's id, else its session's.
    pub agent: String,
    pub project_id: String,
    /// Its device type, as `mac sim start` said it ("iPhone 17").
    pub device: String,
    /// When it was lent (ms since the epoch).
    pub since_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobActivity {
    pub agent: String,
    pub project_id: String,
    pub job: u32,
    /// Its command line, masked of the agent's secrets as its log is, and clipped to [`COMMAND_MAX`].
    pub command: String,
    pub started_ms: i64,
}

pub fn file(home: &Path) -> PathBuf {
    home.join("mac-activity.json")
}

pub fn clip_command(command: &str) -> String {
    match command.char_indices().nth(COMMAND_MAX) {
        Some((at, _)) => format!("{}…", &command[..at]),
        None => command.to_owned(),
    }
}

/// Writes `activity` whole (a reader polls it), unless it is what `last` says was written.
pub fn write(home: &Path, activity: &Activity, last: &mut Option<Activity>) {
    if last.as_ref() == Some(activity) {
        return;
    }
    let Ok(json) = serde_json::to_vec(activity) else {
        return;
    };
    let tmp = home.join("mac-activity.json.tmp");
    match std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, file(home))) {
        Ok(()) => *last = Some(activity.clone()),
        Err(error) => tracing::debug!(%error, "the Mac's activity was not written"),
    }
}
