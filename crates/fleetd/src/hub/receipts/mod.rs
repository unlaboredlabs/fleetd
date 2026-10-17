//! Receipts for a task, read from its thread's turn items through the executor.
//! TS spec: apps/hub/src/receipts/Receipts.ts.
pub mod count;

use crate::hub::checks::ports::Ports;
use count::{claims_unverified, count_receipts};
use fleetd_contracts::{Receipts as ReceiptsData, TaskId, TaskResult, ThreadRef};
use std::sync::Arc;

pub use count::receipts_line;

/// Every action of a task thread, as far as T3's bounded thread snapshot reaches.
const MAX_ACTIONS: usize = 1000;

pub struct Receipts {
    ports: Arc<dyn Ports>,
}

impl Receipts {
    pub fn new(ports: Arc<dyn Ports>) -> Self {
        Self { ports }
    }

    async fn count(&self, thread: &ThreadRef) -> Option<ReceiptsData> {
        match self.ports.thread_actions(thread, MAX_ACTIONS).await {
            Ok(actions) => Some(count_receipts(&actions)),
            Err(error) => {
                tracing::warn!(thread_id = %thread.thread_id, %error, "receipts: thread not readable");
                None
            }
        }
    }

    /// Counted now from the task's thread; None for a task that never got one or whose machine is unreachable.
    pub async fn for_task(&self, task_id: &TaskId) -> Option<ReceiptsData> {
        let thread = self.ports.task(task_id)?.thread_ref?;
        self.count(&thread).await
    }

    /// `result` with its receipts and `claimsUnverified`; unchanged when the thread cannot be read.
    pub async fn attach(&self, thread: &ThreadRef, result: TaskResult) -> TaskResult {
        match self.count(thread).await {
            None => result,
            Some(receipts) => {
                let unverified = claims_unverified(&result.tail, &receipts);
                TaskResult { receipts: Some(receipts), claims_unverified: Some(unverified), ..result }
            }
        }
    }
}
