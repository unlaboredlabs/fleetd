//! The agent time inspector's hub area: spans from the nodes (their outboxes, acked after commit) and from the hub's
//! own choke points (the train, CI, checks, intake) through one [`TimeSink`], plus spans the projector folds
//! out of the event log. One writer task commits them in batches with their labels, roll-ups and cursors; reads
//! give breakdowns, critical paths and insights. No polling: the writer and the projector wake on channels.
pub mod ingest;
pub mod model;
pub mod path;
pub mod project;
pub mod rules;
pub mod store;
pub mod tools;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::node_link::SpansFrame;
use tokio::sync::mpsc;

use crate::clock::Clock;
use crate::hub::store::{HubDb, now_ms, parse_ms};
pub use store::{Ids, NewSpan};

/// Node batches waiting for the writer; past this a batch is not acked and the node resends it on reconnect.
pub const NODE_BATCHES: usize = 64;
/// Hub spans waiting for the writer; past this they are counted into one `gap` span.
pub const HUB_SPANS: usize = 10_000;
/// Clock offsets are the minimum over this window of heartbeats.
const OFFSET_WINDOW_MS: i64 = 10 * 60 * 1000;
const PRUNE_EVERY: Duration = Duration::from_secs(3600);

/// Where the hub's areas write spans. Cheap to clone; a full writer drops the span and counts it.
#[derive(Clone)]
pub struct TimeSink {
    tx: mpsc::Sender<HubMsg>,
    dropped: Arc<AtomicU64>,
}

/// What the hub's areas send the writer.
pub enum HubMsg {
    Span(Box<NewSpan>),
    /// Close every open hub span whose key starts with `prefix` at `end_ms` (a state's span ends when the next
    /// state's begins).
    Close {
        prefix: String,
        end_ms: i64,
    },
}

impl TimeSink {
    pub fn span(&self, mut span: NewSpan) {
        span.src = "h".into();
        self.send(HubMsg::Span(Box::new(span)));
    }

    pub fn close(&self, prefix: impl Into<String>, end_ms: i64) {
        self.send(HubMsg::Close {
            prefix: prefix.into(),
            end_ms,
        });
    }

    fn send(&self, msg: HubMsg) {
        if self.tx.try_send(msg).is_err() && !self.tx.is_closed() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub struct NodeBatch {
    pub machine_id: String,
    pub frame: SpansFrame,
    /// Called once: with the node's stored cursor after a commit, or with `rewind` when the frame was not stored.
    pub ack: Box<dyn FnOnce(Ack) + Send>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ack {
    pub upto: u64,
    pub rewind: bool,
}

pub struct Time {
    pub db: Arc<HubDb>,
    pub clock: Arc<dyn Clock>,
    sink: TimeSink,
    node_tx: mpsc::Sender<NodeBatch>,
    rx: Mutex<Option<(mpsc::Receiver<HubMsg>, mpsc::Receiver<NodeBatch>)>>,
    /// Per machine: (hub ms, hub receive time minus the node's heartbeat stamp), newest last.
    offsets: Mutex<HashMap<String, VecDeque<(i64, i64)>>>,
    /// Ingested and not acked because the writer was full.
    pub node_dropped: AtomicU64,
    pub paths: tools::PathCache,
}

impl Time {
    pub fn new(db: Arc<HubDb>, clock: Arc<dyn Clock>) -> Arc<Self> {
        let (tx, rx) = mpsc::channel(HUB_SPANS);
        let (node_tx, node_rx) = mpsc::channel(NODE_BATCHES);
        Arc::new(Self {
            db,
            clock,
            sink: TimeSink {
                tx,
                dropped: Arc::new(AtomicU64::new(0)),
            },
            node_tx,
            rx: Mutex::new(Some((rx, node_rx))),
            offsets: Mutex::default(),
            node_dropped: AtomicU64::new(0),
            paths: tools::PathCache::default(),
        })
    }

    pub fn sink(&self) -> TimeSink {
        self.sink.clone()
    }

    pub fn now_ms(&self) -> i64 {
        now_ms(self.clock.as_ref())
    }

    /// A heartbeat from `machine` stamped `node_at` (its clock) arrived now.
    pub fn heartbeat(&self, machine: &str, node_at: &str) {
        let Some(node_ms) = parse_ms(node_at) else {
            return;
        };
        let now = self.now_ms();
        let mut offsets = self.offsets.lock().unwrap();
        let q = offsets.entry(machine.to_owned()).or_default();
        q.push_back((now, now - node_ms));
        while q
            .front()
            .is_some_and(|(at, _)| *at < now - OFFSET_WINDOW_MS)
        {
            q.pop_front();
        }
    }

    /// Add this to a node stamp to get hub time: the minimum of `hub_rx - heartbeat.at` over the window, which is
    /// the clock difference plus the smallest one-way latency seen. 0 before the first heartbeat.
    pub fn offset(&self, machine: &str) -> i64 {
        self.offsets
            .lock()
            .unwrap()
            .get(machine)
            .and_then(|q| q.iter().map(|(_, d)| *d).min())
            .unwrap_or(0)
    }

    /// A node's `spans` frame; acked after commit. When the writer is full the frame is not stored, and the node is
    /// told to send again from the stored cursor, so a later frame can never ack past the lost rows.
    pub fn node_spans(&self, batch: NodeBatch) {
        if let Err(e) = self.node_tx.try_send(batch) {
            self.node_dropped.fetch_add(1, Ordering::Relaxed);
            let batch = match e {
                mpsc::error::TrySendError::Full(b) | mpsc::error::TrySendError::Closed(b) => b,
            };
            let upto = self.node_cursor(&batch.machine_id);
            (batch.ack)(Ack { upto, rewind: true });
        }
    }

    /// The outbox row the hub has stored up to for `machine`: `spansAfter` on every (re)subscribe.
    pub fn node_cursor(&self, machine: &str) -> u64 {
        self.db
            .with(|c| store::cursor(c, &format!("node:{machine}")))
            .ok()
            .flatten()
            .map_or(0, |v| v.max(0) as u64)
    }

    /// The writer, the event-log projector and the hourly prune. Call once.
    pub fn start(
        self: &Arc<Self>,
        hub: &Arc<crate::hub::api::Hub>,
    ) -> Vec<tokio::task::JoinHandle<()>> {
        let Some((hub_rx, node_rx)) = self.rx.lock().unwrap().take() else {
            return Vec::new();
        };
        let mut loops = vec![tokio::spawn(ingest::write_loop(
            self.clone(),
            hub_rx,
            node_rx,
            hub.shutdown.clone(),
        ))];
        loops.push(tokio::spawn(project::run(self.clone(), hub.clone())));
        let (this, shutdown) = (self.clone(), hub.shutdown.clone());
        loops.push(tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = shutdown.wait() => return,
                    () = this.clock.sleep(PRUNE_EVERY) => {}
                }
                let now = this.now_ms();
                while matches!(this.db.transaction(|c| store::prune(c, now)), Ok(true)) {
                    tokio::task::yield_now().await;
                }
            }
        }));
        loops
    }

    /// Spans dropped at the sink since the last call.
    fn take_dropped(&self) -> u64 {
        self.sink.dropped.swap(0, Ordering::Relaxed)
    }
}
