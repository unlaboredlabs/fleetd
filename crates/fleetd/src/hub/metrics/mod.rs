//! Factory metrics' hub area: landed changes folded out of the event log (the train's merges, merges made outside
//! it, review stamps and order request times), kept past the event log's 30 days for as long as the retention says,
//! and read as merged per day, order to merged and the share through fleetd by calendar day in the viewer's zone.
//! Repos are keyed by their remote, host first, so nothing here assumes one git host, CI or release cadence. No
//! polling: the projector wakes on the log's append notification, and the prune runs hourly.
pub mod compute;
pub mod project;
pub mod store;
pub mod tools;

#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use crate::hub::api::Hub;
use crate::hub::store::now_ms;

const PRUNE_EVERY: Duration = Duration::from_secs(3600);

/// The projector and the hourly prune. Call once.
pub fn start(hub: &Arc<Hub>) -> Vec<tokio::task::JoinHandle<()>> {
    let mut loops = vec![tokio::spawn(project::run(hub.clone()))];
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
