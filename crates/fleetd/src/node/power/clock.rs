//! How long this machine has spent asleep since boot, and the jump that tells the node it just woke.
//!
//! Linux: CLOCK_BOOTTIME counts suspend and CLOCK_MONOTONIC does not, so their difference grows by exactly the time
//! spent asleep. macOS: mach_continuous_time and mach_absolute_time, the same pair. Wall-clock jumps (NTP, a user
//! changing the time) move neither.

/// A span the machine spent asleep, in wall-clock epoch milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Slept {
    pub from_ms: i64,
    pub to_ms: i64,
}

impl Slept {
    pub fn ms(&self) -> i64 {
        self.to_ms - self.from_ms
    }
}

/// Shorter gaps are not reported: a dark-wake blip says nothing about agents.
pub const MIN_SLEEP_MS: i64 = 5_000;

/// One reading of both clocks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    /// Time asleep since boot.
    pub asleep_ms: i64,
    pub wall_ms: i64,
}

/// Turns successive samples into the sleeps between them.
#[derive(Default)]
pub struct SleepWatch {
    last: Option<Sample>,
}

impl SleepWatch {
    /// The sleep since the previous sample, if there was one worth reporting. It ended at most one poll ago, so it
    /// is placed ending now.
    pub fn observe(&mut self, now: Sample) -> Option<Slept> {
        let last = self.last.replace(now)?;
        let asleep = now.asleep_ms - last.asleep_ms;
        (asleep >= MIN_SLEEP_MS).then_some(Slept {
            from_ms: now.wall_ms - asleep,
            to_ms: now.wall_ms,
        })
    }
}

pub fn sample() -> Option<Sample> {
    Some(Sample {
        asleep_ms: asleep_ms()?,
        wall_ms: chrono::Utc::now().timestamp_millis(),
    })
}

#[cfg(target_os = "linux")]
fn asleep_ms() -> Option<i64> {
    use nix::time::{ClockId, clock_gettime};
    let ms = |id| {
        clock_gettime(id)
            .ok()
            .map(|t| t.tv_sec() * 1000 + t.tv_nsec() / 1_000_000)
    };
    Some(ms(ClockId::CLOCK_BOOTTIME)? - ms(ClockId::CLOCK_MONOTONIC)?)
}

#[cfg(target_os = "macos")]
fn asleep_ms() -> Option<i64> {
    use std::ffi::c_void;
    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }
    unsafe extern "C" {
        fn mach_absolute_time() -> u64;
        fn mach_timebase_info(info: *mut Timebase) -> i32;
    }
    type Continuous = unsafe extern "C" fn() -> u64;
    // Looked up at run time, like the IOKit calls: the cross-built darwin binary links only what zig's stubs have.
    static CONTINUOUS: std::sync::OnceLock<Option<Continuous>> = std::sync::OnceLock::new();
    let continuous = (*CONTINUOUS.get_or_init(|| {
        // SAFETY: a constant symbol name; the pointer, when found, has this signature.
        unsafe {
            let f = libc::dlsym(libc::RTLD_DEFAULT, c"mach_continuous_time".as_ptr());
            (!f.is_null()).then(|| std::mem::transmute::<*mut c_void, Continuous>(f))
        }
    }))?;
    let mut base = Timebase { numer: 0, denom: 0 };
    // SAFETY: plain libSystem calls; `base` is a valid out-pointer.
    let (continuous, absolute) = unsafe {
        if mach_timebase_info(&mut base) != 0 || base.denom == 0 {
            return None;
        }
        (continuous(), mach_absolute_time())
    };
    let ticks = continuous.saturating_sub(absolute) as u128;
    Some((ticks * base.numer as u128 / base.denom as u128 / 1_000_000) as i64)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn asleep_ms() -> Option<i64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(asleep_ms: i64, wall_ms: i64) -> Sample {
        Sample { asleep_ms, wall_ms }
    }

    #[test]
    fn a_jump_in_time_asleep_is_one_sleep_ending_now() {
        let mut watch = SleepWatch::default();
        assert_eq!(watch.observe(at(1_000, 100_000)), None);
        assert_eq!(watch.observe(at(1_000, 105_000)), None);
        // 10 m 46 s asleep between two polls 5 s apart (in awake time).
        let slept = watch.observe(at(1_000 + 646_000, 756_000)).unwrap();
        assert_eq!(
            slept,
            Slept {
                from_ms: 110_000,
                to_ms: 756_000
            }
        );
        assert_eq!(slept.ms(), 646_000);
        assert_eq!(watch.observe(at(647_000, 761_000)), None);
    }

    #[test]
    fn wall_clock_changes_and_blips_are_not_sleeps() {
        let mut watch = SleepWatch::default();
        watch.observe(at(0, 100_000));
        // NTP moved the wall clock an hour; time asleep did not move.
        assert_eq!(watch.observe(at(0, 3_700_000)), None);
        assert_eq!(watch.observe(at(MIN_SLEEP_MS - 1, 3_705_000)), None);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn reads_this_machines_clocks() {
        let first = sample().unwrap();
        assert!(first.asleep_ms >= 0);
        // The two clocks are read one after the other, so their difference can step back a millisecond or two.
        assert!(sample().unwrap().asleep_ms >= first.asleep_ms - 5);
    }
}
