//! The frames one /app connection has waiting for its socket, bounded so a client that stops reading (a phone
//! suspended with its socket open, a stalled link) can't grow the hub's memory without end. Frames wait as their JSON
//! text, not as `Value` trees, which take several times as much.
//!
//! Answers to calls and the event stream wait for room before they queue: the client asked for them, or reads them by
//! cursor, so a slow client still gets every one, in order, only later. Frames pushed as they happen (chat deltas,
//! replies to the client's own frames) never wait: one that finds more than [`MAX_QUEUED_BYTES`] of them waiting
//! marks the connection behind, the hub closes it, and the app reconnects and reads again (a snapshot, events from its
//! cursor, the chat page).
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use tokio::sync::{Notify, Semaphore, mpsc};

/// Bytes of each kind of frame one connection may have waiting. An answer larger than this (an attachment, up to
/// 33 MB as base64) waits until nothing else of its kind does.
pub const MAX_QUEUED_BYTES: usize = 8 << 20;

struct Frame {
    text: String,
    /// Room it took: answer room (a semaphore's permits) or pushed bytes.
    waited: bool,
    bytes: usize,
}

struct Shared {
    room: Semaphore,
    pushed: AtomicUsize,
    behind: AtomicBool,
    behind_now: Notify,
}

/// The sending side, cloned into each task that writes to the connection.
#[derive(Clone)]
pub struct Outbox {
    tx: mpsc::UnboundedSender<Frame>,
    shared: Arc<Shared>,
}

/// The receiving side, read by the connection's socket loop.
pub struct Frames {
    rx: mpsc::UnboundedReceiver<Frame>,
    shared: Arc<Shared>,
}

pub fn outbox() -> (Outbox, Frames) {
    let (tx, rx) = mpsc::unbounded_channel();
    let shared = Arc::new(Shared {
        room: Semaphore::new(MAX_QUEUED_BYTES),
        pushed: AtomicUsize::new(0),
        behind: AtomicBool::new(false),
        behind_now: Notify::new(),
    });
    (
        Outbox {
            tx,
            shared: shared.clone(),
        },
        Frames { rx, shared },
    )
}

impl Outbox {
    /// Queues a frame pushed as it happens. False when the connection is gone, or is too far behind to take it (it
    /// closes then).
    pub fn push(&self, text: String) -> bool {
        let bytes = text.len();
        let waiting = self.shared.pushed.fetch_add(bytes, Ordering::SeqCst);
        if waiting > 0 && waiting + bytes > MAX_QUEUED_BYTES {
            self.shared.pushed.fetch_sub(bytes, Ordering::SeqCst);
            if !self.shared.behind.swap(true, Ordering::SeqCst) {
                self.shared.behind_now.notify_one();
            }
            return false;
        }
        self.tx
            .send(Frame {
                text,
                waited: false,
                bytes,
            })
            .is_ok()
    }

    /// Queues an answer once there is room for it. False when the connection is gone.
    pub async fn send(&self, text: String) -> bool {
        let bytes = text.len().min(MAX_QUEUED_BYTES);
        let Ok(permit) = self.shared.room.acquire_many(bytes as u32).await else {
            return false;
        };
        permit.forget();
        self.tx
            .send(Frame {
                text,
                waited: true,
                bytes,
            })
            .is_ok()
    }
}

impl Frames {
    fn take(&self, frame: Frame) -> String {
        if frame.waited {
            self.shared.room.add_permits(frame.bytes);
        } else {
            self.shared.pushed.fetch_sub(frame.bytes, Ordering::SeqCst);
        }
        frame.text
    }

    /// The next frame, its room given back. None once every sender is gone.
    pub async fn recv(&mut self) -> Option<String> {
        let frame = self.rx.recv().await?;
        Some(self.take(frame))
    }

    pub fn try_recv(&mut self) -> Option<String> {
        let frame = self.rx.try_recv().ok()?;
        Some(self.take(frame))
    }

    /// The connection's falling-behind signal, apart from the frames so a loop can wait on both.
    pub fn behind(&self) -> Behind {
        Behind(self.shared.clone())
    }
}

/// Whether a pushed frame found the connection too far behind.
pub struct Behind(Arc<Shared>);

impl Behind {
    /// Resolves once it has.
    pub async fn wait(&self) {
        while !self.is() {
            self.0.behind_now.notified().await;
        }
    }

    pub fn is(&self) -> bool {
        self.0.behind.load(Ordering::SeqCst)
    }

    /// Bytes waiting, both kinds.
    pub fn waiting(&self) -> usize {
        MAX_QUEUED_BYTES - self.0.room.available_permits() + self.0.pushed.load(Ordering::SeqCst)
    }
}

impl Drop for Frames {
    /// Answers still waiting for room give up.
    fn drop(&mut self) {
        self.shared.room.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn answers_wait_for_room_and_lose_nothing() {
        let (out, mut frames) = outbox();
        let big = "a".repeat(MAX_QUEUED_BYTES / 2 + 1);
        assert!(out.send(big.clone()).await);
        // The second half doesn't fit beside the first: it waits until the socket takes the first.
        let second = tokio::spawn({
            let out = out.clone();
            let big = big.clone();
            async move { out.send(big).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!second.is_finished());
        assert_eq!(frames.recv().await.as_deref(), Some(big.as_str()));
        assert!(second.await.unwrap());
        assert_eq!(frames.recv().await.as_deref(), Some(big.as_str()));
        assert_eq!(frames.behind().waiting(), 0);
    }

    #[tokio::test]
    async fn an_answer_larger_than_the_room_waits_for_all_of_it() {
        let (out, mut frames) = outbox();
        assert!(out.send("small".into()).await);
        let huge = "b".repeat(MAX_QUEUED_BYTES * 3);
        let sent = tokio::spawn({
            let out = out.clone();
            let huge = huge.clone();
            async move { out.send(huge).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!sent.is_finished());
        assert_eq!(frames.recv().await.as_deref(), Some("small"));
        assert!(sent.await.unwrap());
        assert_eq!(frames.recv().await.map(|t| t.len()), Some(huge.len()));
    }

    #[tokio::test]
    async fn a_push_over_the_limit_marks_the_connection_behind() {
        let (out, mut frames) = outbox();
        // One frame passes whatever its size, so a large reply to an idle client is never refused.
        assert!(out.push("c".repeat(MAX_QUEUED_BYTES + 1)));
        assert!(!out.push("d".into()));
        tokio::time::timeout(Duration::from_secs(1), frames.behind().wait())
            .await
            .expect("behind");
        // The frames already queued are still there; nothing more is.
        assert_eq!(
            frames.recv().await.map(|t| t.len()),
            Some(MAX_QUEUED_BYTES + 1)
        );
        assert_eq!(frames.try_recv(), None);
    }

    #[tokio::test]
    async fn pushes_within_the_limit_pass_and_give_their_room_back() {
        let (out, mut frames) = outbox();
        let chunk = "e".repeat(MAX_QUEUED_BYTES / 4);
        for _ in 0..4 {
            assert!(out.push(chunk.clone()));
        }
        for _ in 0..4 {
            frames.recv().await.unwrap();
        }
        for _ in 0..4 {
            assert!(out.push(chunk.clone()));
        }
        assert_eq!(frames.behind().waiting(), MAX_QUEUED_BYTES);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), frames.behind().wait())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn waiting_answers_give_up_when_the_connection_ends() {
        let (out, frames) = outbox();
        assert!(out.send("f".repeat(MAX_QUEUED_BYTES)).await);
        let waiting = tokio::spawn({
            let out = out.clone();
            async move { out.send("g".into()).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(frames);
        assert!(!waiting.await.unwrap());
    }
}
