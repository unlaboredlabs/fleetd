//! Time for everything with timers, so the logic that matters can run on a test clock.
use std::time::{Duration, SystemTime};

pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> SystemTime;
    /// Resolves after `duration` of this clock's time.
    fn sleep(
        &self,
        duration: Duration,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;
}

#[derive(Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
    fn sleep(
        &self,
        duration: Duration,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(tokio::time::sleep(duration))
    }
}
