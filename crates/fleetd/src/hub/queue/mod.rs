//! The offline write queue. Additive writes (thread_send, wake firings) to a machine without a live T3 connection
//! wait here, in order, and go out when it comes back; each ends as one write.delivered or write.expired event.
//! Interrupts and launches are not additive, so they never come through here and still fail when offline.
pub mod ports;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::json;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::clock::Clock;
use crate::hub::api::{Hub, HubConfig};
use crate::hub::store::{EventLog, HubDb, NewEvent};
use crate::hub::sweep::{SweepCheck, WAKE_OVERDUE_MS};
use crate::hub::wakes::schedule::iso;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ThreadId, ThreadRef};
use ports::{DbRun, ExecutorError, ThreadWriter, emit, now_ms};

/// Default `--queue-ttl`.
pub const DEFAULT_TTL: Duration = Duration::from_secs(24 * 3600);
/// A send that takes longer is retried from the queue; the command id makes the retry harmless.
const SEND_TIMEOUT: Duration = Duration::from_secs(15);
const RETRY_DELAY: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// True when the message waits in this queue rather than having reached T3.
    pub queued: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued_until: Option<String>,
}

#[derive(Clone, Debug)]
struct Row {
    write_id: i64,
    target: ThreadRef,
    client_request_id: String,
    message: String,
    wake_id: Option<String>,
    queued_ms: i64,
    expires_ms: i64,
}

fn to_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        write_id: r.get("write_id")?,
        target: ThreadRef {
            machine_id: MachineId::unchecked(r.get::<_, String>("machine_id")?),
            thread_id: ThreadId::unchecked(r.get::<_, String>("thread_id")?),
        },
        client_request_id: r.get("client_request_id")?,
        message: r.get("message")?,
        wake_id: r.get("wake_id")?,
        queued_ms: r.get("queued_ms")?,
        expires_ms: r.get("expires_ms")?,
    })
}

/// JS `Math.round` for the non-negative values used here.
pub(crate) fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

fn ago(ms: i64) -> String {
    if ms < 90 * 60_000 {
        format!("{} min", js_round(ms as f64 / 60_000.0).max(1))
    } else {
        format!("{} h", js_round(ms as f64 / 3_600_000.0))
    }
}

enum Expiry {
    Ttl,
    Refused,
}

pub struct WriteQueue {
    db: Arc<HubDb>,
    writer: Arc<dyn ThreadWriter>,
    events: Arc<EventLog>,
    clock: Arc<dyn Clock>,
    ttl_ms: i64,
    /// Rows a flusher is sending right now; the expiry timer leaves them to it.
    in_flight: Mutex<HashSet<i64>>,
    flushers: Mutex<HashMap<String, JoinHandle<()>>>,
    changed: watch::Sender<u64>,
    expiry: Mutex<Option<JoinHandle<()>>>,
}

impl WriteQueue {
    pub fn new(
        db: Arc<HubDb>,
        writer: Arc<dyn ThreadWriter>,
        events: Arc<EventLog>,
        clock: Arc<dyn Clock>,
        ttl: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            writer,
            events,
            clock,
            ttl_ms: ttl.as_millis() as i64,
            in_flight: Mutex::new(HashSet::new()),
            flushers: Mutex::new(HashMap::new()),
            changed: watch::channel(0).0,
            expiry: Mutex::new(None),
        })
    }

    /// The hub's queue over the executor: `--queue-ttl` sets the TTL, and `thread_send` goes through it.
    pub fn from_config(
        config: &HubConfig,
        db: &Arc<HubDb>,
        events: &Arc<EventLog>,
        clock: &Arc<dyn Clock>,
        executors: &Arc<crate::hub::executor::Executors>,
    ) -> Arc<Self> {
        let ttl = config
            .queue_ttl_sec
            .map_or(DEFAULT_TTL, Duration::from_secs);
        let queue = Self::new(
            db.clone(),
            executors.clone(),
            events.clone(),
            clock.clone(),
            ttl,
        );
        executors.set_offline_writer(Arc::new(ports::QueueWriter(queue.clone())));
        queue
    }

    pub fn is_connected(&self, machine_id: &MachineId) -> bool {
        self.writer.is_connected(machine_id)
    }

    /// Resumes delivery of writes queued before a restart and starts the expiry timer.
    pub fn start(self: &Arc<Self>) {
        let machines: Vec<MachineId> = {
            self.db.run(|db| {
                let mut stmt = db
                    .prepare("SELECT DISTINCT machine_id FROM queued_writes")
                    .expect("sql");
                stmt.query_map([], |r| r.get::<_, String>(0))
                    .expect("sql")
                    .filter_map(Result::ok)
                    .map(MachineId::unchecked)
                    .collect()
            })
        };
        for machine in machines {
            self.start_flusher(&machine);
        }
        let me = self.clone();
        *self.expiry.lock().expect("lock") =
            Some(tokio::spawn(async move { me.expiry_loop().await }));
    }

    /// Stops every loop (a hub shutdown); queued rows stay for the next start.
    pub fn stop(&self) {
        if let Some(h) = self.expiry.lock().expect("lock").take() {
            h.abort();
        }
        for (_, h) in self.flushers.lock().expect("lock").drain() {
            h.abort();
        }
    }

    /// Sends now when the machine is connected and nothing is queued for it; otherwise queues the message until it
    /// is. `client_request_id` is the T3 command id, so a retried or re-queued send is delivered once. The error is
    /// ThreadNotFound or T3RequestFailed, never MachineNotConnected.
    pub async fn send(
        self: &Arc<Self>,
        target: &ThreadRef,
        message: &str,
        client_request_id: &str,
        wake_id: Option<&str>,
    ) -> Result<SendResult, ExecutorError> {
        let behind: i64 = self.db.run(|db| {
            db.query_row(
                "SELECT COUNT(*) FROM queued_writes WHERE machine_id = ?",
                [target.machine_id.as_str()],
                |r| r.get(0),
            )
            .unwrap_or(0)
        });
        if behind > 0 || !self.writer.is_connected(&target.machine_id) {
            return Ok(self.enqueue(target, message, client_request_id, wake_id));
        }
        match tokio::time::timeout(
            SEND_TIMEOUT,
            self.writer.send(target, message, client_request_id),
        )
        .await
        {
            Err(_) | Ok(Err(ExecutorError::MachineNotConnected { .. })) => {
                Ok(self.enqueue(target, message, client_request_id, wake_id))
            }
            Ok(Err(e)) => Err(e),
            Ok(Ok(run_id)) => Ok(SendResult {
                run_id,
                queued: false,
                queued_until: None,
            }),
        }
    }

    fn signal(&self) {
        self.changed.send_modify(|v| *v = v.wrapping_add(1));
    }

    fn enqueue(
        self: &Arc<Self>,
        target: &ThreadRef,
        message: &str,
        client_request_id: &str,
        wake_id: Option<&str>,
    ) -> SendResult {
        let now = now_ms(&*self.clock);
        let expires_ms: i64 = {
            self.db.run(|db| {
            db.execute(
                "INSERT INTO queued_writes (machine_id, thread_id, client_request_id, message, wake_id, queued_ms, expires_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (client_request_id) DO NOTHING",
                params![target.machine_id.as_str(), target.thread_id.as_str(), client_request_id, message, wake_id, now, now + self.ttl_ms],
            )
            .expect("sql");
            db.query_row(
                "SELECT expires_ms FROM queued_writes WHERE client_request_id = ?",
                [client_request_id],
                |r| r.get(0),
            )
            .unwrap_or(now + self.ttl_ms)
        })
        };
        self.start_flusher(&target.machine_id);
        self.signal();
        SendResult {
            run_id: None,
            queued: true,
            queued_until: Some(iso(expires_ms)),
        }
    }

    fn head(&self, machine_id: &MachineId) -> Option<Row> {
        self.db.run(|db| {
            db.query_row(
                "SELECT * FROM queued_writes WHERE machine_id = ? ORDER BY write_id LIMIT 1",
                [machine_id.as_str()],
                to_row,
            )
            .optional()
            .expect("sql")
        })
    }

    /// Removes the row and reports whether this call did, so each write ends in exactly one event.
    fn take(&self, row: &Row) -> bool {
        self.db.run(|db| {
            db.execute(
                "DELETE FROM queued_writes WHERE write_id = ?",
                [row.write_id],
            )
            .unwrap_or(0)
                == 1
        })
    }

    fn fields(row: &Row) -> serde_json::Map<String, serde_json::Value> {
        let mut m = serde_json::Map::new();
        m.insert("clientRequestId".into(), json!(row.client_request_id));
        m.insert("queuedAt".into(), json!(iso(row.queued_ms)));
        if let Some(w) = &row.wake_id {
            m.insert("wakeId".into(), json!(w));
        }
        m
    }

    fn delivered(&self, row: &Row, run_id: Option<String>) {
        if !self.take(row) {
            return;
        }
        let now = now_ms(&*self.clock);
        let mut data = Self::fields(row);
        if let Some(run_id) = run_id {
            data.insert("runId".into(), json!(run_id));
        }
        emit(
            &self.events,
            NewEvent {
                at: iso(now).into(),
                r#type: HubEventType::WriteDelivered,
                machine_id: Some(row.target.machine_id.clone()),
                project_id: None,
                thread_id: Some(row.target.thread_id.clone()),
                summary: format!(
                    "Queued message to thread {} on {} delivered after {}",
                    row.target.thread_id,
                    row.target.machine_id,
                    ago(now - row.queued_ms)
                ),
                data: Some(data.into()),
                attention: None,
            },
        );
    }

    fn expired(&self, row: &Row, reason: Expiry) {
        if !self.take(row) {
            return;
        }
        let now = now_ms(&*self.clock);
        let (t, m) = (&row.target.thread_id, &row.target.machine_id);
        let (summary, reason) = match reason {
            Expiry::Ttl => (
                format!(
                    "Queued message to thread {t} on {m} expired undelivered after {}",
                    ago(now - row.queued_ms)
                ),
                "ttl",
            ),
            Expiry::Refused => (
                format!("Queued message to thread {t} on {m} dropped: T3 refused it"),
                "refused",
            ),
        };
        let mut data = Self::fields(row);
        data.insert("reason".into(), json!(reason));
        emit(
            &self.events,
            NewEvent {
                at: iso(now).into(),
                r#type: HubEventType::WriteExpired,
                machine_id: Some(m.clone()),
                project_id: None,
                thread_id: Some(t.clone()),
                summary,
                data: Some(data.into()),
                attention: None,
            },
        );
    }

    fn start_flusher(self: &Arc<Self>, machine_id: &MachineId) {
        let mut flushers = self.flushers.lock().expect("lock");
        if flushers
            .get(machine_id.as_str())
            .is_some_and(|h| !h.is_finished())
        {
            return;
        }
        let me = self.clone();
        let machine = machine_id.clone();
        flushers.insert(
            machine_id.to_string(),
            tokio::spawn(async move { me.flush(machine).await }),
        );
    }

    /// Delivers one machine's queue in order, waiting for its connection as needed. Ends when the queue is empty.
    async fn flush(self: Arc<Self>, machine_id: MachineId) {
        loop {
            let Some(row) = self.head(&machine_id) else {
                // Checked again under the flushers lock, so an enqueue racing this exit starts a new flusher.
                let mut flushers = self.flushers.lock().expect("lock");
                if self.head(&machine_id).is_none() {
                    flushers.remove(machine_id.as_str());
                    return;
                }
                continue;
            };
            if row.expires_ms <= now_ms(&*self.clock) {
                self.expired(&row, Expiry::Ttl);
                continue;
            }
            if !self.writer.is_connected(&machine_id) {
                // The head may expire meanwhile, so it is read again once the machine is back.
                self.writer.await_live(&machine_id).await;
                continue;
            }
            self.in_flight.lock().expect("lock").insert(row.write_id);
            let result = tokio::time::timeout(
                SEND_TIMEOUT,
                self.writer
                    .send(&row.target, &row.message, &row.client_request_id),
            )
            .await;
            self.in_flight.lock().expect("lock").remove(&row.write_id);
            match result {
                Ok(Ok(run_id)) => self.delivered(&row, run_id),
                Err(_) => self.clock.sleep(RETRY_DELAY).await,
                // Lost the connection mid-send: wait for it again. Refused on a live connection: retrying won't help.
                Ok(Err(ExecutorError::MachineNotConnected { .. })) => {}
                Ok(Err(_)) if !self.writer.is_connected(&machine_id) => {}
                Ok(Err(error)) => {
                    tracing::warn!(machine_id = %machine_id, thread_id = %row.target.thread_id, error = error.tag(), "write queue: T3 refused a queued message");
                    self.expired(&row, Expiry::Refused);
                }
            }
        }
    }

    /// Expires rows as their TTL passes, so a write to a machine that stays away is reported on time.
    async fn expiry_loop(self: Arc<Self>) {
        let mut changed = self.changed.subscribe();
        loop {
            changed.borrow_and_update();
            let now = now_ms(&*self.clock);
            let (due, next): (Vec<Row>, Option<i64>) =
                {
                    self.db.run(|db| {
                        let mut stmt = db
                    .prepare("SELECT * FROM queued_writes WHERE expires_ms <= ? ORDER BY write_id")
                    .expect("sql");
                        let due = stmt
                            .query_map([now], to_row)
                            .expect("sql")
                            .filter_map(Result::ok)
                            .collect();
                        let next = db
                            .query_row(
                                "SELECT MIN(expires_ms) FROM queued_writes WHERE expires_ms > ?",
                                [now],
                                |r| r.get(0),
                            )
                            .unwrap_or(None);
                        (due, next)
                    })
                };
            for row in due {
                if !self.in_flight.lock().expect("lock").contains(&row.write_id) {
                    self.expired(&row, Expiry::Ttl);
                }
            }
            match next {
                None => {
                    let _ = changed.changed().await;
                }
                Some(at) => {
                    tokio::select! {
                        () = self.clock.sleep(Duration::from_millis((at - now).max(0) as u64)) => {}
                        _ = changed.changed() => {}
                    }
                }
            }
        }
    }
}

/// Starts the queue, wakes and webhooks loops and stops them when the hub shuts down.
pub fn start_loops(hub: &Arc<Hub>) -> JoinHandle<()> {
    // Sweep order: its own built-in checks, then webhooks', then overdue wakes.
    let webhooks = hub.webhooks.clone();
    hub.sweep.register(SweepCheck {
        name: "webhooks".into(),
        run: Arc::new(move || {
            webhooks.check_failing();
            Box::pin(async { Ok(()) })
        }),
    });
    let wakes = hub.wakes.clone();
    hub.sweep.register(SweepCheck {
        name: "wakes".into(),
        run: Arc::new(move || {
            wakes.sweep_overdue(Duration::from_millis(WAKE_OVERDUE_MS));
            Box::pin(async { Ok(()) })
        }),
    });
    hub.queue.start();
    hub.wakes.start();
    hub.webhooks.start();
    let hub = hub.clone();
    tokio::spawn(async move {
        hub.shutdown.wait().await;
        hub.webhooks.stop();
        hub.wakes.stop();
        hub.queue.stop();
    })
}

#[cfg(test)]
pub(crate) mod test_kit;

#[cfg(test)]
mod tests {
    use super::test_kit::*;
    use super::*;

    fn t1() -> ThreadRef {
        tref("lab-a", "t1")
    }
    fn t2() -> ThreadRef {
        tref("lab-a", "t2")
    }

    #[tokio::test(start_paused = true)]
    async fn sends_at_once_to_a_connected_machine_with_nothing_queued() {
        let kit = Kit::new();
        kit.writer.go_live("lab-a");
        let q = kit.queue(DEFAULT_TTL);
        assert_eq!(
            q.send(&t1(), "hi", "r1", None).await.unwrap(),
            SendResult {
                run_id: Some("run-1".into()),
                queued: false,
                queued_until: None
            }
        );
        assert_eq!(kit.writer.messages(), vec!["hi"]);
        assert!(kit.events.all().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn queues_offline_and_delivers_in_order_when_back() {
        let kit = Kit::new();
        let q = kit.queue(DEFAULT_TTL);
        assert_eq!(
            q.send(&t1(), "one", "r1", None).await.unwrap(),
            SendResult {
                run_id: None,
                queued: true,
                queued_until: Some(iso(NOW + 86_400_000))
            }
        );
        q.send(&t2(), "two", "r2", None).await.unwrap();
        q.send(&t1(), "three", "r3", Some("wk_x")).await.unwrap();
        settle().await;
        assert!(kit.writer.messages().is_empty());

        kit.advance(Duration::from_secs(600)).await;
        kit.writer.go_live("lab-a");
        settle().await;
        assert_eq!(kit.writer.messages(), vec!["one", "two", "three"]);
        let delivered: Vec<_> = kit
            .events
            .all()
            .into_iter()
            .filter(|e| e.r#type == HubEventType::WriteDelivered)
            .collect();
        let pairs: Vec<_> = delivered
            .iter()
            .map(|e| {
                (
                    e.thread_id.clone().unwrap().to_string(),
                    e.data.as_ref().unwrap()["clientRequestId"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("t1".to_string(), "r1".to_string()),
                ("t2".into(), "r2".into()),
                ("t1".into(), "r3".into())
            ]
        );
        assert_eq!(
            delivered[0].summary.as_str(),
            "Queued message to thread t1 on lab-a delivered after 10 min"
        );
        assert_eq!(delivered[0].data.as_ref().unwrap()["queuedAt"], iso(NOW));
        assert_eq!(delivered[0].data.as_ref().unwrap()["runId"], "run-1");
        assert_eq!(delivered[2].data.as_ref().unwrap()["wakeId"], "wk_x");
        assert_eq!(delivered[2].seq.get(), 3);
        // Drained: the next send goes straight out again.
        assert_eq!(
            q.send(&t1(), "four", "r4", None)
                .await
                .unwrap()
                .run_id
                .as_deref(),
            Some("run-4")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_one_entry_for_a_retried_client_request_id() {
        let kit = Kit::new();
        let q = kit.queue(DEFAULT_TTL);
        let first = q.send(&t1(), "hi", "r1", None).await.unwrap();
        kit.advance(Duration::from_secs(60)).await;
        assert_eq!(q.send(&t1(), "hi", "r1", None).await.unwrap(), first);
        kit.writer.go_live("lab-a");
        settle().await;
        assert_eq!(kit.writer.messages(), vec!["hi"]);
    }

    #[tokio::test(start_paused = true)]
    async fn expires_a_write_at_its_ttl_never_delivering_it() {
        let kit = Kit::new();
        let q = kit.queue(Duration::from_secs(40));
        q.send(&t1(), "stale", "r1", None).await.unwrap();
        kit.advance(Duration::from_secs(20)).await;
        q.send(&t1(), "fresh", "r2", None).await.unwrap();
        kit.advance(Duration::from_secs(19)).await;
        assert!(kit.events.all().is_empty());
        kit.advance(Duration::from_secs(1)).await;
        let all = kit.events.all();
        assert_eq!(all.len(), 1);
        let expired = &all[0];
        assert_eq!(
            (expired.r#type, expired.at.as_str()),
            (HubEventType::WriteExpired, iso(NOW + 40_000).as_str())
        );
        assert_eq!(
            expired.summary.as_str(),
            "Queued message to thread t1 on lab-a expired undelivered after 1 min"
        );
        assert_eq!(expired.data.as_ref().unwrap()["reason"], "ttl");
        assert_eq!(expired.data.as_ref().unwrap()["clientRequestId"], "r1");
        kit.writer.go_live("lab-a");
        settle().await;
        assert_eq!(kit.writer.messages(), vec!["fresh"]);
        assert_eq!(kit.events.all()[1].r#type, HubEventType::WriteDelivered);
    }

    #[tokio::test(start_paused = true)]
    async fn drops_a_write_t3_refuses_and_goes_on() {
        let kit = Kit::new();
        kit.writer.refuse("r1");
        let q = kit.queue(DEFAULT_TTL);
        q.send(&t1(), "bad", "r1", None).await.unwrap();
        q.send(&t1(), "good", "r2", None).await.unwrap();
        kit.writer.go_live("lab-a");
        settle().await;
        let got: Vec<_> = kit
            .events
            .all()
            .iter()
            .map(|e| {
                (
                    e.r#type,
                    e.data
                        .as_ref()
                        .unwrap()
                        .get("reason")
                        .and_then(|r| r.as_str())
                        .map(String::from),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                (HubEventType::WriteExpired, Some("refused".to_string())),
                (HubEventType::WriteDelivered, None)
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_the_queue_across_a_restart() {
        let kit = Kit::new();
        let first = kit.queue(DEFAULT_TTL);
        first.send(&t1(), "survives", "r1", None).await.unwrap();
        first.stop();
        kit.writer.go_live("lab-a");
        let _second = kit.queue(DEFAULT_TTL);
        settle().await;
        assert_eq!(kit.writer.messages(), vec!["survives"]);
    }
}
