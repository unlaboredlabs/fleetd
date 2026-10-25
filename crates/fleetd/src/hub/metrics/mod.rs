//! Factory metrics' hub area: landed changes folded out of the event log (the train's merges, merges made outside
//! it, review stamps and order request times), kept past the event log's 30 days for as long as the retention says,
//! and read as merged per day, order to merged, the person's minutes per merged PR and the share through fleetd by
//! calendar day in the viewer's zone. The person's minutes come from their touches: acts on fleetd's surfaces, and
//! reviews and comments on the git host.
//! Repos are keyed by their remote, host first, so nothing here assumes one git host, CI or release cadence. The
//! projector wakes on the log's append notification; the host sweep reads every project's repo from its git host on a
//! slow timer and when a read asks; the prune runs hourly.
pub mod compute;
pub mod host_acts;
pub mod human;
pub mod project;
pub mod source;
pub mod store;
pub mod sweep;
pub mod tools;
pub mod touches;

#[cfg(test)]
mod sweep_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod touch_tests;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::Days;
use chrono_tz::Tz;
use rusqlite::Connection;

use crate::hub::api::Hub;
use crate::hub::store::{StoreError, now_ms};

const PRUNE_EVERY: Duration = Duration::from_secs(3600);

/// The area's state on the hub: the host sweep's sources and schedule.
pub struct Metrics {
    pub sweep: sweep::Sweep,
}

impl Metrics {
    pub fn new(sources: source::HostSources) -> Arc<Self> {
        Arc::new(Self {
            sweep: sweep::Sweep::new(sources),
        })
    }
}

/// The projector, the host sweep and the hourly prune. Call once.
pub fn start(hub: &Arc<Hub>) -> Vec<tokio::task::JoinHandle<()>> {
    let mut loops = vec![
        tokio::spawn(project::run(hub.clone())),
        tokio::spawn(sweep::run(hub.clone())),
    ];
    let hub = hub.clone();
    loops.push(tokio::spawn(async move {
        loop {
            tokio::select! {
                () = hub.shutdown.wait() => return,
                () = hub.clock.sleep(PRUNE_EVERY) => {}
            }
            let now = now_ms(hub.clock.as_ref());
            while matches!(hub.db.transaction(|c| store::prune(c, now)), Ok(true)) {
                tokio::task::yield_now().await;
            }
        }
    }));
    loops
}

/// A project's last 7 calendar days, for its Status row: landed changes on its repos by every route, and the share
/// the train landed (`None` when nothing landed).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Week {
    pub merged: i64,
    pub through_fleetd_pct: Option<f64>,
}

/// Each project's [`Week`] by "<machine>/<project>": the 7 calendar days in `tz` up to `now`, today included, counted
/// as `metrics_get` counts a project. A project none of whose repos the metrics know is absent, not zero.
pub fn weeks(c: &Connection, now: i64, tz: Tz) -> Result<HashMap<String, Week>, StoreError> {
    let today = compute::local_date(now, tz);
    let first = today.checked_sub_days(Days::new(6)).unwrap_or(today);
    let rows = store::merges(c, compute::day_start(first, tz), now, None)?;
    let mut repos: HashMap<String, Vec<String>> = HashMap::new();
    for (repo, refs) in tools::repo_projects(c)? {
        for (m, p) in refs {
            repos
                .entry(format!("{m}/{p}"))
                .or_default()
                .push(repo.clone());
        }
    }
    Ok(repos
        .into_iter()
        .map(|(pk, repos)| {
            let s = compute::Stats::of(rows.iter().filter(|r| repos.contains(&r.repo)));
            let week = Week {
                merged: s.n(),
                through_fleetd_pct: s.pct(),
            };
            (pk, week)
        })
        .collect())
}
