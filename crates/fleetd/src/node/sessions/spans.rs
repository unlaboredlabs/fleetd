//! The span outbox's delivery: spans wait in the node's `spans` table until the hub acks them. The hub asks for them
//! with `subscribe { spansAfter }` and acks after its commit; on a reconnect it asks again from its own cursor, so
//! nothing is lost and a resend is a no-op on the hub. No polling: the flusher sleeps until a span is pending, then
//! sends when a run ended, when [`FLUSH_AT`] spans wait, or [`FLUSH_AFTER`] after the oldest one.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::node_link::SpansFrame;
use fleetd_contracts::prim::List;
use tokio::sync::Notify;
use tokio::time::Instant;

use fleetd_contracts::ids::{ThreadId, Timestamp};
use fleetd_contracts::prim::{Count, Text};
use fleetd_contracts::sessions::RunStatus;
use fleetd_contracts::time::{SpanExtra, SpanKind, SpanStatus, SpanWire};

use super::SessionService;
use crate::node::wire::NodeToHub;

pub const FLUSH_AT: u64 = 200;
pub const FLUSH_AFTER: Duration = Duration::from_secs(5);
/// Spans per frame (about 40 KB).
pub const FRAME_SPANS: usize = 256;
/// Rows sent and not acked yet; past this the node waits for an ack.
const IN_FLIGHT: u64 = 16 * FRAME_SPANS as u64;

#[derive(Default)]
pub struct Outbox {
    /// The hub asked for spans on this link.
    pub enabled: bool,
    /// The newest row sent on this link, and the newest the hub acked.
    pub sent: u64,
    pub acked: u64,
    pub pending: u64,
    pub since: Option<Instant>,
    pub urgent: bool,
}

impl Outbox {
    pub fn due(&self) -> Option<Instant> {
        if !self.enabled || (self.pending == 0 && !self.urgent) {
            return None;
        }
        if self.sent.saturating_sub(self.acked) >= IN_FLIGHT {
            return None;
        }
        if self.urgent || self.pending >= FLUSH_AT {
            return Some(Instant::now());
        }
        self.since.map(|s| s + FLUSH_AFTER)
    }

    /// An ack, or a rewind: the hub stored rows only up to `upto`, so everything after it goes again, once
    /// [`FLUSH_AFTER`] has passed (the hub's writer was full; sending at once would only fill it again).
    /// Returns the rows the node may delete: never past what it sent on this link, so a hub cursor from before a
    /// reset of this outbox cannot delete rows the hub never got.
    pub fn acked(&mut self, upto: u64, rewind: bool) -> u64 {
        let upto = upto.min(self.sent);
        self.acked = self.acked.max(upto);
        if rewind {
            self.sent = upto.max(self.acked);
            self.pending = self.pending.max(1);
            self.since = Some(Instant::now());
            self.urgent = false;
        }
        upto
    }

    pub fn added(&mut self, n: u64, urgent: bool) {
        self.pending += n;
        self.since.get_or_insert_with(Instant::now);
        self.urgent |= urgent;
    }
}

impl SessionService {
    /// Runs until the service is dropped; spawned once at start.
    pub(super) fn spawn_span_flusher(&self, wake: Arc<Notify>) {
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                let Some(inner) = weak.upgrade() else { return };
                let service = SessionService { inner };
                let due = service.st().outbox.due();
                match due {
                    Some(at) if at <= Instant::now() => {
                        service.flush_spans();
                        continue;
                    }
                    Some(at) => {
                        drop(service);
                        tokio::select! {
                            () = wake.notified() => {}
                            () = tokio::time::sleep_until(at) => {}
                        }
                    }
                    None => {
                        drop(service);
                        wake.notified().await;
                    }
                }
            }
        });
    }

    /// Sends every unsent row, a frame at a time, up to the in-flight bound.
    fn flush_spans(&self) {
        loop {
            let mut st = self.st();
            if !st.outbox.enabled || st.outlet.is_none() {
                return;
            }
            let after = st.outbox.sent;
            let rows = match self.store().spans_after(after, FRAME_SPANS) {
                Ok(rows) => rows,
                Err(e) => {
                    tracing::warn!(error = %e, "cannot read the span outbox");
                    st.outbox.urgent = false;
                    return;
                }
            };
            let Some(&(to_rid, _)) = rows.last() else {
                st.outbox.pending = 0;
                st.outbox.since = None;
                st.outbox.urgent = false;
                return;
            };
            let spans: Vec<_> = rows.into_iter().map(|(_, s)| s).collect();
            let n = spans.len() as u64;
            st.send(NodeToHub::Spans(SpansFrame {
                from_rid: after + 1,
                to_rid,
                spans: List::unchecked(spans),
            }));
            st.outbox.sent = to_rid;
            st.outbox.pending = st.outbox.pending.saturating_sub(n);
            if st.outbox.sent.saturating_sub(st.outbox.acked) >= IN_FLIGHT {
                return;
            }
        }
    }

    /// The hub stored every row up to `upto`; with `rewind`, nothing after it.
    pub fn spans_acked(&self, upto: u64, rewind: bool) {
        let upto = self.st().outbox.acked(upto, rewind);
        if let Err(e) = self.store().spans_acked(upto) {
            tracing::warn!(error = %e, "cannot clear acked spans");
        }
        self.inner.span_wake.notify_one();
    }

    /// A run's lifecycle started: the wait before it becomes `run.queued` (behind the session's previous run),
    /// `run.startup` (claude's process had to start) or `runner.other` (claude picking the message up), and a node
    /// retry's wait becomes `wait.retry.node`. Exclusive time leaves out what the previous run already covers.
    pub(super) fn run_began(
        &self,
        id: &str,
        run: &str,
        pre: Option<(RunStatus, Option<Timestamp>, Option<Timestamp>)>,
    ) {
        let now = crate::node::runner::claude::mapper::Now::system().ms;
        let (spawned, retry) = {
            let mut st = self.st();
            (st.spawned.remove(run), st.node_retry.remove(run))
        };
        let mut out = Vec::new();
        if let Some((status, Some(queued_at), prev_end)) = pre
            && let Some(start) = iso_ms(&queued_at)
        {
            let kind = match (status, spawned) {
                (RunStatus::Queued, _) => SpanKind::RunQueued,
                (_, true) => SpanKind::RunStartup,
                _ => SpanKind::RunnerOther,
            };
            let floor = prev_end.as_ref().and_then(iso_ms).unwrap_or(0).max(start);
            out.push(span(
                id,
                run,
                format!("{id}/{run}/pre"),
                kind,
                start,
                now,
                now.saturating_sub(floor),
                SpanExtra::default(),
            ));
        }
        if let Some((at, attempt, delay)) = retry {
            let extra = SpanExtra {
                attempt: count(u64::from(attempt)),
                stated_delay_ms: count(delay),
                ..SpanExtra::default()
            };
            let key = format!("{id}/{run}/noderetry/{attempt}");
            out.push(span(
                id,
                run,
                key,
                SpanKind::WaitRetryNode,
                at,
                now,
                now.saturating_sub(at),
                extra,
            ));
        }
        self.put_spans(&out, false);
    }

    /// Stores spans in the outbox and wakes the flusher; `urgent` when a run ended.
    pub(super) fn put_spans(&self, spans: &[SpanWire], urgent: bool) {
        if spans.is_empty() {
            return;
        }
        let now = crate::node::runner::claude::mapper::Now::system().ms as i64;
        if let Err(e) = self.store().put_spans(spans, now) {
            tracing::warn!(error = %e, "cannot store spans");
            return;
        }
        self.st().outbox.added(spans.len() as u64, urgent);
        self.inner.span_wake.notify_one();
    }
}

#[allow(clippy::too_many_arguments)]
fn span(
    session: &str,
    run: &str,
    key: String,
    kind: SpanKind,
    start: u64,
    end: u64,
    excl: u64,
    extra: SpanExtra,
) -> SpanWire {
    let end = end.max(start);
    SpanWire {
        key: Text::unchecked(key),
        kind,
        session_id: ThreadId::unchecked(session),
        run_id: Text::new(run).ok(),
        parent: None,
        start_ms: count(start).unwrap_or_default(),
        end_ms: count(end).unwrap_or_default(),
        excl_ms: count(excl.min(end - start)),
        label: None,
        exit_code: None,
        out_bytes: None,
        status: SpanStatus::Ok,
        extra: (extra != SpanExtra::default()).then_some(extra),
    }
}

fn count(n: u64) -> Option<Count> {
    i64::try_from(n).ok().and_then(|n| Count::try_from(n).ok())
}

pub fn iso_ms(at: &Timestamp) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(at.as_str())
        .ok()
        .and_then(|d| u64::try_from(d.timestamp_millis()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_rewind_sends_again_from_the_hub_s_cursor_after_a_pause() {
        let mut o = Outbox {
            enabled: true,
            sent: 1024,
            acked: 256,
            ..Outbox::default()
        };
        // A plain ack of an earlier frame while later ones are in flight changes nothing else.
        o.acked(512, false);
        assert_eq!((o.sent, o.acked), (1024, 512));
        o.acked(512, true);
        assert_eq!((o.sent, o.acked), (512, 512));
        // A reset outbox sent rows 1..=4; the hub's cursor from the old database must not delete past them.
        let mut reset = Outbox {
            enabled: true,
            sent: 4,
            ..Outbox::default()
        };
        assert_eq!(reset.acked(5_000, false), 4);
        assert_eq!(reset.acked(5_000, true), 4);
        assert_eq!(reset.sent, 4);
        let due = o.due().expect("rows to resend");
        assert!(due >= Instant::now() + FLUSH_AFTER - Duration::from_millis(100));
    }
}
