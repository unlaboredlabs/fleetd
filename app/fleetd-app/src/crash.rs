//! Panic reporting. Most of the app runs inside AppKit callbacks (`extern "C"`), where a Rust panic can't
//! unwind and the process aborts with only "panic in a function that cannot unwind". The hook runs before that
//! abort, so even a stripped release binary says what panicked and where.

use std::io::Write;
use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// `~/.fleetd/app.log`, beside the node's `~/.fleetd/node`. The app keeps no other state on disk.
pub fn log_path() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(|h| PathBuf::from(h).join(".fleetd").join("app.log"))
}

pub fn install_hook() {
    panic::set_hook(Box::new(|info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("(non-string panic payload)");
        let at = info.location().map_or_else(|| "unknown location".into(), |l| l.to_string());
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        // Honors RUST_BACKTRACE / RUST_LIB_BACKTRACE; empty otherwise.
        let backtrace = std::backtrace::Backtrace::capture();
        let backtrace = match backtrace.status() {
            std::backtrace::BacktraceStatus::Captured => format!("\n{backtrace}"),
            _ => String::new(),
        };
        let report = format!("fleetd-app {} panicked on thread '{thread}' at {at}: {msg}{backtrace}", crate::update::VERSION);
        eprintln!("{report}");
        if let Some(path) = log_path() {
            let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
            let written = path.parent().map(std::fs::create_dir_all).transpose().and_then(|_| {
                std::fs::OpenOptions::new().create(true).append(true).open(&path)?.write_all(format!("[unix {secs}] {report}\n").as_bytes())
            });
            match written {
                Ok(()) => eprintln!("fleetd-app: panic also written to {}", path.display()),
                Err(e) => eprintln!("fleetd-app: couldn't write {}: {e}", path.display()),
            }
        }
    }));
}

/// Runs `f`, which is called from a platform callback that can't unwind. A panic (already reported by the
/// hook) exits with status 1 instead of aborting the process.
pub fn guard<R>(what: &str, f: impl FnOnce() -> R) -> R {
    match panic::catch_unwind(AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(_) => {
            eprintln!("fleetd-app: {what} failed; exiting");
            std::process::exit(1)
        }
    }
}
