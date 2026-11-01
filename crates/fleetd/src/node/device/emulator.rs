//! The emulators sessions get: `-read-only` copies of the node's virtual device, each booted from its Quick Boot
//! snapshot (about 8 s on a KVM host) and thrown away with everything done in it, and a warm pool of booted ones so a
//! session starts from one at once while the pool boots the next behind it.
use std::collections::{HashSet, VecDeque};
use std::net::{Ipv4Addr, TcpListener};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// scrcpy's server is on it already (the pool pushed it while the copy waited).
    pub pushed: bool,
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

/// The command that starts the emulator: itself, or through `sg kvm` where the node's process lacks the group its
/// user has joined since (sdk::Kvm::Sg). sg execs the shell, which execs the emulator: one process, its pid the
/// child's, so its process group is killed as ever.
fn command(sdk: &Sdk, args: Vec<String>, kvm: Option<super::sdk::Kvm>) -> Command {
    match kvm {
        Some(super::sdk::Kvm::Sg) => {
            let line = std::iter::once(sdk.emulator.to_string_lossy().into_owned())
                .chain(args)
                .map(|w| super::sdk::quoted(&w))
                .collect::<Vec<_>>()
                .join(" ");
            let mut command = Command::new("sg");
            command.args(["kvm", "-c", &format!("exec {line}")]);
            command
        }
        _ => {
            let mut command = Command::new(&sdk.emulator);
            command.args(args);
            command
        }
    }
}

pub fn spawn(sdk: &Sdk, port: u16, read_only: bool) -> Result<Emulator, String> {
    let mut child = command(sdk, args(port, read_only), super::sdk::kvm().ok())
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
        pushed: false,
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

/// Kills the emulators of this node's virtual device that run with no node holding them (one that died, or was
/// killed, leaves its copies running: about 2 GB each). Found by their command line: this SDK's emulator, this AVD.
/// Returns how many.
pub fn kill_leftovers(sdk: &Sdk) -> usize {
    let Ok(procs) = std::fs::read_dir("/proc") else {
        return 0;
    };
    let ours = sdk.root.join("emulator");
    let mut killed = 0;
    for entry in procs.filter_map(Result::ok) {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<i32>().ok())
        else {
            continue;
        };
        let Ok(cmdline) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        if is_leftover(&cmdline, &ours) {
            let _ = nix::sys::signal::kill(Pid::from_raw(pid), Signal::SIGKILL);
            killed += 1;
        }
    }
    killed
}

/// Whether a process's command line (NUL-separated) is an emulator of `ours` (the SDK's emulator directory) for the
/// node's AVD.
fn is_leftover(cmdline: &[u8], ours: &std::path::Path) -> bool {
    let args: Vec<&[u8]> = cmdline.split(|b| *b == 0).collect();
    let program = args.first().map(|a| String::from_utf8_lossy(a));
    program.is_some_and(|p| std::path::Path::new(p.as_ref()).starts_with(ours))
        && args
            .windows(2)
            .any(|w| w[0] == b"-avd" && w[1] == AVD.as_bytes())
}

/// Booted copies waiting for a session: taking one costs no boot, and the pool boots a new one behind it.
pub struct Pool {
    sdk: Sdk,
    size: usize,
    warm: Mutex<VecDeque<Emulator>>,
    /// The ports of every copy the pool started that still runs, waiting or in a session.
    ports: Arc<Mutex<HashSet<u16>>>,
    filling: tokio::sync::Mutex<()>,
    /// Drained (the node stops): a boot still under way kills its copy instead of keeping it.
    closed: AtomicBool,
}

/// A port taken for a boot, given back when dropped unless the copy booted (a start that goes away mid-boot frees it).
struct PortClaim {
    ports: Arc<Mutex<HashSet<u16>>>,
    port: Option<u16>,
}

impl PortClaim {
    fn keep(mut self) -> u16 {
        self.port.take().expect("a claimed port")
    }
}

impl Drop for PortClaim {
    fn drop(&mut self) {
        if let Some(port) = self.port {
            lock(&self.ports).remove(&port);
        }
    }
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
            closed: AtomicBool::new(false),
        })
    }

    pub fn sdk(&self) -> &Sdk {
        &self.sdk
    }

    /// Boots a copy now, and puts scrcpy's server on it for its session's stream.
    async fn boot(&self) -> Result<Emulator, String> {
        let claim = {
            let mut ports = lock(&self.ports);
            let port = free_port(&ports).ok_or_else(|| {
                "every emulator port adb watches (5554-5584) is in use".to_owned()
            })?;
            ports.insert(port);
            PortClaim {
                ports: self.ports.clone(),
                port: Some(port),
            }
        };
        let port = claim.port.expect("a claimed port");
        let t = Instant::now();
        let mut emulator = spawn(&self.sdk, port, true)?;
        let serial = emulator.serial.clone();
        wait_booted(&self.sdk, &serial, &mut emulator, BOOT_TIMEOUT).await?;
        let boot_ms = t.elapsed().as_millis() as u64;
        let t = Instant::now();
        match super::scrcpy::push_server(&self.sdk, &serial).await {
            Ok(()) => emulator.pushed = true,
            Err(why) => {
                tracing::warn!(serial, error = %why, "scrcpy's server not pushed ahead; the session pushes it")
            }
        }
        tracing::debug!(
            kind = "android",
            serial,
            boot_ms,
            push_ms = t.elapsed().as_millis() as u64,
            "screen timing: a warm emulator"
        );
        claim.keep();
        Ok(emulator)
    }

    /// A booted copy, or one booted now when none waits; the pool refills behind it.
    pub async fn take(self: &Arc<Self>) -> Result<Lent, String> {
        let t = Instant::now();
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
        let cold = warm.is_none();
        let emulator = match warm {
            Some(emulator) => emulator,
            None => self.boot().await?,
        };
        tracing::debug!(
            kind = "android",
            serial = %emulator.serial,
            cold,
            take_ms = t.elapsed().as_millis() as u64,
            "screen timing: an emulator taken"
        );
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
                if pool.closed.load(Ordering::Relaxed) {
                    return;
                }
                match pool.boot().await {
                    Ok(emulator) if pool.closed.load(Ordering::Relaxed) => {
                        lock(&pool.ports).remove(&emulator.port);
                    }
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
        self.closed.store(true, Ordering::Relaxed);
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
    use std::path::Path;

    #[test]
    fn a_user_who_joined_kvm_since_the_node_started_runs_the_emulator_through_sg() {
        let sdk = Sdk {
            emulator: "/opt/sdk/emulator/emulator".into(),
            ..Sdk::at(Path::new("/nonexistent"))
        };
        let words = |c: &Command| {
            let std = c.as_std();
            std::iter::once(std.get_program().to_string_lossy().into_owned())
                .chain(std.get_args().map(|a| a.to_string_lossy().into_owned()))
                .collect::<Vec<_>>()
        };
        let direct = command(
            &sdk,
            vec!["-port".into(), "5554".into()],
            Some(super::super::sdk::Kvm::Direct),
        );
        assert_eq!(
            words(&direct),
            ["/opt/sdk/emulator/emulator", "-port", "5554"]
        );
        let through = command(
            &sdk,
            vec!["-port".into(), "5554".into()],
            Some(super::super::sdk::Kvm::Sg),
        );
        assert_eq!(
            words(&through),
            [
                "sg",
                "kvm",
                "-c",
                "exec '/opt/sdk/emulator/emulator' '-port' '5554'"
            ]
        );
    }

    /// On a machine whose user joined kvm after its login (as fleetd's own devbox), the command sg runs is the child
    /// itself: its pid and process group are the ones the node kills.
    #[tokio::test]
    async fn through_sg_the_emulator_is_the_child_itself() {
        if super::super::sdk::kvm() != Ok(super::super::sdk::Kvm::Sg) {
            return;
        }
        let sdk = Sdk {
            emulator: "/bin/sh".into(),
            ..Sdk::at(Path::new("/nonexistent"))
        };
        let mut child = command(
            &sdk,
            vec!["-c".into(), "echo $$; id -nG; exec sleep 30".into()],
            Some(super::super::sdk::Kvm::Sg),
        )
        .stdout(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
        let pid = child.id().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let said = lines.next_line().await.unwrap().unwrap();
        let groups = lines.next_line().await.unwrap().unwrap();
        assert_eq!(said, pid.to_string(), "sg and its shell exec: one process");
        assert!(groups.split(' ').any(|g| g == "kvm"), "{groups}");
        let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
        assert!(child.wait().await.is_ok());
    }

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
    fn leftovers_are_this_sdks_emulators_of_this_avd() {
        let ours = std::path::Path::new("/n/device/sdk/emulator");
        let line = |args: &[&str]| args.join("\0").into_bytes();
        assert!(is_leftover(
            &line(&["/n/device/sdk/emulator/emulator", "-avd", AVD, "-read-only"]),
            ours
        ));
        assert!(is_leftover(
            &line(&[
                "/n/device/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64",
                "-avd",
                AVD
            ]),
            ours
        ));
        assert!(
            !is_leftover(
                &line(&["/opt/android/emulator/emulator", "-avd", AVD]),
                ours
            ),
            "a person's own emulator"
        );
        assert!(
            !is_leftover(
                &line(&["/n/device/sdk/emulator/emulator", "-avd", "Pixel_9"]),
                ours
            ),
            "another AVD"
        );
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
