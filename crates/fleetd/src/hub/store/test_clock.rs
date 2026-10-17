//! A clock that only moves when a test advances it, like Effect's TestClock.
use crate::clock::Clock;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;

pub(crate) struct ManualClock {
    inner: Mutex<Inner>,
}

struct Inner {
    now_ms: u64,
    sleepers: Vec<(u64, oneshot::Sender<()>)>,
}

impl ManualClock {
    pub(crate) fn at(now_ms: u64) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                now_ms,
                sleepers: Vec::new(),
            }),
        })
    }

    /// Moves time forward and wakes every sleeper that is now due.
    pub(crate) fn advance(&self, by: Duration) {
        let mut inner = self.inner.lock().unwrap();
        inner.now_ms += by.as_millis() as u64;
        let now = inner.now_ms;
        let (due, pending) = std::mem::take(&mut inner.sleepers)
            .into_iter()
            .partition(|(at, _)| *at <= now);
        inner.sleepers = pending;
        for (_, wake) in due {
            let _ = wake.send(());
        }
    }
}

impl Clock for ManualClock {
    fn now(&self) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(self.inner.lock().unwrap().now_ms)
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let (wake, woken) = oneshot::channel();
        let mut inner = self.inner.lock().unwrap();
        let at = inner.now_ms + duration.as_millis() as u64;
        if duration.is_zero() {
            let _ = wake.send(());
        } else {
            inner.sleepers.push((at, wake));
        }
        Box::pin(async move {
            let _ = woken.await;
        })
    }
}
