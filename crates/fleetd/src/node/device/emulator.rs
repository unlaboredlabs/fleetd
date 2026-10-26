//! The emulators sessions get: `-read-only` copies of the node's virtual device, each booted from its Quick Boot
//! snapshot (about 8 s on a KVM host) and thrown away with everything done in it, and a warm pool of booted ones so a
//! session starts from one at once while the pool boots the next behind it.
use std::collections::{HashSet, VecDeque};
use std::net::{Ipv4Addr, TcpListener};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::sdk::{AVD, Sdk};

/// A copy from the snapshot boots in about 8 s; this allows a loaded machine.
pub const BOOT_TIMEOUT: Duration = Duration::from_secs(120);

/// The console ports adb finds emulators on by itself: 5554, 5556, ... 5584 (adb on each one's next port).
const PORTS: std::ops::RangeInclusive<u16> = 5554..=5584;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// One running emulator in its own process group (the emulator starts qemu as a child): killed with it when dropped.
pub struct Emulator {
    child: Child,
    pgid: Option<i32>,
    pub port: u16,
    pub serial: String,
    /// The emulator's first lines, to say why a boot failed.
    said: Arc<Mutex<Vec<String>>>,
}

impl Emulator {
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn kill(&mut self) {
        if let Some(pgid) = self.pgid.take() {
            let _ = killpg(Pid::from_raw(pgid), Signal::SIGKILL);
        }
        let _ = self.child.start_kill();
    }

    fn said(&self) -> String {
        lock(&self.said).join(" / ")
    }
}

impl Drop for Emulator {
    fn drop(&mut self) {
        self.kill();
    }
}

/// An even console port no emulator of the node's holds (`taken`) and nothing else listens on.
pub fn free_port(taken: &HashSet<u16>) -> Option<u16> {
    PORTS.step_by(2).find(|port| {
        !taken.contains(port)
            && TcpListener::bind((Ipv4Addr::LOCALHOST, *port)).is_ok()
            && TcpListener::bind((Ipv4Addr::LOCALHOST, port + 1)).is_ok()
    })
}

/// The emulator's flags: no window, no audio; a copy (`read_only`) loads the snapshot and saves nothing, while the
/// node's one cold boot (sdk.rs) skips loading it so it can save it.
pub fn args(port: u16, read_only: bool) -> Vec<String> {
    let mut args: Vec<String> = ["-avd", AVD, "-no-window", "-no-audio", "-no-boot-anim"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    args.extend([
        "-no-metrics".to_owned(),
        "-port".to_owned(),
        port.to_string(),
    ]);
    if read_only {
        args.extend(["-read-only", "-no-snapshot-save"].map(str::to_owned));
    } else {
        args.push("-no-snapshot-load".to_owned());
    }
    args
}

pub fn spawn(sdk: &Sdk, port: u16, read_only: bool) -> Result<Emulator, String> {
    let mut child = Command::new(&sdk.emulator)
        .args(args(port, read_only))
        .envs(sdk.env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", sdk.emulator.display()))?;
    let pgid = child.id().map(|id| id as i32);
    let said = Arc::new(Mutex::new(Vec::new()));
    // Keep draining its output, or the emulator blocks once a pipe fills; its errors say why a boot failed.
    for out in [
        child
            .stdout
            .take()
            .map(|o| Box::new(o) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
        child
            .stderr
            .take()
            .map(|o| Box::new(o) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
    ]
    .into_iter()
    .flatten()
    {
        let said = said.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.contains("ERROR") || line.contains("FATAL") {
                    let mut said = lock(&said);
                    if said.len() < 3 {
                        said.push(line.trim().to_owned());
                    }
                }
            }
        });
    }
    Ok(Emulator {
        child,
        pgid,
        port,
        serial: format!("emulator-{port}"),
        said,
    })
}

/// Waits until Android says it finished booting, or the emulator quits, or `timeout` passes.
pub async fn wait_booted(
    sdk: &Sdk,
    serial: &str,
    emulator: &mut Emulator,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if !emulator.alive() {
            let said = emulator.said();
            return Err(if said.is_empty() {
                "the emulator quit".to_owned()
            } else {
                format!("the emulator quit: {said}")
            });
        }
        let booted = tokio::time::timeout(
            Duration::from_secs(5),
            sdk.adb_async(serial)
                .args(["shell", "getprop", "sys.boot_completed"])
                .output(),
        )
        .await;
        if let Ok(Ok(out)) = booted
            && String::from_utf8_lossy(&out.stdout).trim() == "1"
        {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!(
                "Android did not finish booting in {} s",
                timeout.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Booted copies waiting for a session: taking one costs no boot, and the pool boots a new one behind it.
pub struct Pool {
    sdk: Sdk,
    size: usize,
    warm: Mutex<VecDeque<Emulator>>,
    /// The ports of every copy the pool started that still runs, waiting or in a session.
    ports: Arc<Mutex<HashSet<u16>>>,
    filling: tokio::sync::Mutex<()>,
}

/// A copy a session holds: its port goes back to the pool when it is dropped, with the emulator.
pub struct Lent {
    pub emulator: Emulator,
    ports: Arc<Mutex<HashSet<u16>>>,
}

impl Drop for Lent {
    fn drop(&mut self) {
        self.emulator.kill();
        lock(&self.ports).remove(&self.emulator.port);
    }
}

impl Pool {
    pub fn new(sdk: Sdk, size: usize) -> Arc<Self> {
        Arc::new(Self {
            sdk,
            size,
            warm: Mutex::default(),
            ports: Arc::default(),
            filling: tokio::sync::Mutex::new(()),
        })
    }

    pub fn sdk(&self) -> &Sdk {
        &self.sdk
    }

    /// Boots a copy now.
    async fn boot(&self) -> Result<Emulator, String> {
        let port = {
            let mut ports = lock(&self.ports);
            let port = free_port(&ports).ok_or_else(|| {
                "every emulator port adb watches (5554-5584) is in use".to_owned()
            })?;
            ports.insert(port);
            port
        };
        let booted = async {
            let mut emulator = spawn(&self.sdk, port, true)?;
            let serial = emulator.serial.clone();
            wait_booted(&self.sdk, &serial, &mut emulator, BOOT_TIMEOUT).await?;
            Ok(emulator)
        }
        .await;
        if booted.is_err() {
            lock(&self.ports).remove(&port);
        }
        booted
    }

    /// A booted copy, or one booted now when none waits; the pool refills behind it.
    pub async fn take(self: &Arc<Self>) -> Result<Lent, String> {
        let warm = loop {
            let next = lock(&self.warm).pop_front();
            match next {
                Some(mut emulator) => {
                    if emulator.alive() {
                        break Some(emulator);
                    }
                    // One that died while it waited goes; try the next.
                    lock(&self.ports).remove(&emulator.port);
                }
                None => break None,
            }
        };
        let emulator = match warm {
            Some(emulator) => emulator,
            None => self.boot().await?,
        };
        self.refill();
        Ok(Lent {
            emulator,
            ports: self.ports.clone(),
        })
    }

    /// Boots copies in the background until the pool holds its size.
    pub fn refill(self: &Arc<Self>) {
        let pool = self.clone();
        tokio::spawn(async move {
            let Ok(_filling) = pool.filling.try_lock() else {
                return;
            };
            while lock(&pool.warm).len() < pool.size {
                match pool.boot().await {
                    Ok(emulator) => lock(&pool.warm).push_back(emulator),
                    Err(e) => {
                        tracing::warn!(error = %e, "emulator pool not refilled");
                        return;
                    }
                }
            }
        });
    }

    pub fn warm(&self) -> usize {
        lock(&self.warm).len()
    }

    /// Kills every waiting copy.
    pub fn drain(&self) {
        let drained: Vec<Emulator> = lock(&self.warm).drain(..).collect();
        let mut ports = lock(&self.ports);
        for emulator in drained {
            ports.remove(&emulator.port);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copy_loads_the_snapshot_and_saves_nothing() {
        let copy = args(5556, true);
        assert!(copy.windows(2).any(|w| w == ["-avd", AVD]));
        assert!(copy.windows(2).any(|w| w == ["-port", "5556"]));
        assert!(copy.contains(&"-read-only".to_owned()));
        assert!(copy.contains(&"-no-snapshot-save".to_owned()));
        assert!(copy.contains(&"-no-window".to_owned()));
        let golden = args(5554, false);
        assert!(!golden.contains(&"-read-only".to_owned()));
        assert!(golden.contains(&"-no-snapshot-load".to_owned()));
    }

    #[test]
    fn ports_are_even_ones_adb_watches_that_nobody_holds() {
        let first = free_port(&HashSet::new()).expect("a free port");
        assert!(PORTS.contains(&first) && first.is_multiple_of(2), "{first}");
        let taken: HashSet<u16> = [first].into();
        let next = free_port(&taken).expect("another");
        assert_ne!(next, first);
        // One something else listens on is skipped too.
        let _held = TcpListener::bind((Ipv4Addr::LOCALHOST, next + 1));
        if _held.is_ok() {
            assert_ne!(free_port(&taken), Some(next));
        }
    }
}
