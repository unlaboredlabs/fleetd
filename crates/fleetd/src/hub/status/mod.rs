//! The status view: a verified progress figure, ETA, gates, headline, since-you-looked, risks and health for the
//! fleet, a project or an order, recomputed from the event log and never shown stale without saying so.
pub mod fresh;

use std::sync::Arc;

pub struct Status {
    pub fresh: Arc<fresh::Fresh>,
}

impl Status {
    pub fn new(fresh: Arc<fresh::Fresh>) -> Arc<Self> {
        Arc::new(Self { fresh })
    }
}
