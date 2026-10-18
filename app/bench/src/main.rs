//! Runs fleetd-app in its FLEETD_BENCH modes and prints a markdown table of the results.
//!
//! usage: fleetd-bench <path/to/fleetd-app> [--runs N] [--label TEXT] [--only live|keys]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "linux")]
mod xtest;

struct Args {
    app: String,
    runs: usize,
    label: String,
    /// `live` or `keys`: only the live board rows, or only the input latency rows.
    only: Option<String>,
}

fn main() {
    #[cfg(target_os = "linux")]
    match std::env::args().collect::<Vec<_>>().as_slice() {
        [_, cmd, path] if cmd == "screenshot" => return xtest::screenshot(path).expect("screenshot"),
        [_, cmd, x, y] if cmd == "click" => return xtest::click(x.parse().expect("x"), y.parse().expect("y")).expect("click"),
        [_, cmd, text] if cmd == "type" => return xtest::type_text(text).expect("type"),
        _ => {}
    }
    let mut it = std::env::args().skip(1);
    let mut args = Args { app: String::new(), runs: 10, label: String::new(), only: None };
    while let Some(a) = it.next() {
        match a.as_str() {
            "--runs" => args.runs = it.next().and_then(|v| v.parse().ok()).expect("--runs N"),
            "--label" => args.label = it.next().expect("--label TEXT"),
            "--only" => args.only = it.next(),
            _ => args.app = a,
        }
    }
    assert!(!args.app.is_empty(), "usage: fleetd-bench <fleetd-app> [--runs N] [--label TEXT]");

    let mut rows: Vec<(String, String)> = Vec::new();
    let mut row = |name: &str, value: String| {
        eprintln!("  {name}: {value}");
        rows.push((name.to_string(), value));
    };

    match args.only.as_deref() {
        Some("live") => live_rows(&args.app, &mut row),
        Some("keys") => key_rows(&args.app, &mut row),
        _ => {}
    }
    if args.only.is_some() {
        return print_table(&args.label, rows);
    }

    let size = std::fs::metadata(&args.app).expect("app binary").len();
    row("Binary size (release, stripped)", format!("{:.1} MiB", size as f64 / 1048576.0));

    eprintln!("idle RAM ...");
    let (empty, mapped) = idle_rss(&args.app, &[("FLEETD_HISTORY", "0"), ("FLEETD_STREAM", "0")]);
    row("Idle RSS, empty log, 10 s after first frame", mib(empty));
    let (loaded, _) = idle_rss(&args.app, &[("FLEETD_STREAM", "0")]);
    row("Idle RSS, 20k-line log loaded, 10 s after first frame", mib(loaded));
    let (streaming, _) = idle_rss(&args.app, &[]);
    row("RSS, 20k-line log + streaming 50 lines/s, after 10 s", mib(streaming));

    eprintln!("cold start ...");
    cold_start(&args.app, &[]); // warm-up, discarded
    let (warm, warm_draw): (Vec<f64>, Vec<f64>) = (0..args.runs).map(|_| cold_start(&args.app, &[])).unzip();
    row(&format!("Cold start, exec -> first frame presented, warm cache ({} runs)", args.runs), med_p90(&warm, "ms"));
    row("  of which: exec -> first frame draw starts", med_p90(&warm_draw, "ms"));
    #[cfg(target_os = "linux")]
    {
        let evicted: Vec<f64> = (0..args.runs)
            .map(|_| {
                evict(&mapped);
                cold_start(&args.app, &[]).0
            })
            .collect();
        row(&format!("Cold start, binary + {} mapped files evicted from page cache ({} runs)", mapped.len(), args.runs), med_p90(&evicted, "ms"));
    }
    let _ = mapped;

    key_rows(&args.app, &mut row);

    eprintln!("scroll ...");
    let (fps, worst) = scroll(&args.app);
    row("Scroll 20k-line log for 5 s: presented frames/s", format!("{fps:.1}"));
    row("Scroll 20k-line log for 5 s: worst frame interval", format!("{worst:.1} ms"));

    live_rows(&args.app, &mut row);
    print_table(&args.label, rows);
}

fn key_rows(app: &str, row: &mut impl FnMut(&str, String)) {
    eprintln!("input latency ...");
    let internal = keys_internal(app);
    row(&format!("Input latency in-app, key handler -> echo frame presented ({} keys, gpui dispatch)", internal.len()), med_p90(&internal, "ms"));
    #[cfg(target_os = "linux")]
    if std::env::var_os("DISPLAY").is_some() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        match keys_external(app) {
            Ok((in_app, external)) => {
                row(&format!("Input latency in-app, key handler -> echo frame presented ({} XTEST keys)", in_app.len()), med_p90(&in_app, "ms"));
                row(
                    &format!("Input latency external, XTEST send -> echo pixels readable from X ({} keys)", external.len()),
                    med_p90(&external, "ms"),
                );
            }
            Err(e) => row("Input latency external (XTEST)", format!("failed: {e}")),
        }
    }
}

fn print_table(label: &str, rows: Vec<(String, String)>) {
    println!("{label}");
    println!();
    println!("| Metric | Value |\n|---|---|");
    for (k, v) in rows {
        println!("| {k} | {v} |");
    }
}

/// The live board (`FLEETD_BENCH=live`): 50 orders and 200 lanes under the scripted feed at its maximum rate, with
/// motion on and with reduce-motion.
fn live_rows(app: &str, row: &mut impl FnMut(&str, String)) {
    eprintln!("live board ...");
    let full = live(app, &[]);
    let n = |line: &str, k: &str| field(line, k).unwrap_or("?").to_string();
    let us = |line: &str, k: &str| field(line, k).and_then(|v| v.parse::<f64>().ok()).map_or("?".into(), |v| format!("{:.1} ms", v / 1000.0));
    let scope = format!("{} orders, {} lanes", n(&full, "orders"), n(&full, "lanes"));
    row(&format!("Live board ({scope}, virtualized), feed at 4 Hz for 5 s: presented frames/s"), n(&full, "fps"));
    row("  inside sparkline shifts (180 ms, every lane at once): presented frames/s, median", n(&full, "anim_fps"));
    row("  inside sparkline shifts: worst frame interval", us(&full, "anim_worst_us"));
    row(
        &format!("  frame draw, layout + paint ({} frames)", n(&full, "frames")),
        format!("median {}, p99 {}, max {}", us(&full, "draw_p50_us"), us(&full, "draw_p99_us"), us(&full, "draw_max_us")),
    );
    row("Live board, before the feed starts: presented frames/s", n(&full, "idle_fps"));
    row("Live board, feed paused (after its holds and exits): presented frames/s", n(&full, "paused_fps"));
    let reduced = live(app, &[("FLEETD_MOTION", "reduced")]);
    row("Live board with reduce-motion, feed at 4 Hz: presented frames/s", n(&reduced, "fps"));
    row(
        "  frame draw, layout + paint",
        format!("median {}, p99 {}, max {}", us(&reduced, "draw_p50_us"), us(&reduced, "draw_p99_us"), us(&reduced, "draw_max_us")),
    );
}

fn live(app: &str, env: &[(&str, &str)]) -> String {
    let run = Run::start(app, "live", env);
    focus(&run.expect("first_present"));
    let line = run.expect("live");
    run.finish();
    line
}

fn mib(kib: u64) -> String {
    format!("{:.1} MiB", kib as f64 / 1024.0)
}

fn med_p90(samples: &[f64], unit: &str) -> String {
    if samples.is_empty() {
        return "no samples".into();
    }
    let mut s = samples.to_vec();
    s.sort_by(f64::total_cmp);
    let pick = |q: f64| s[((s.len() - 1) as f64 * q).round() as usize];
    format!("median {:.1} {unit}, p90 {:.1} {unit}, max {:.1} {unit}", pick(0.5), pick(0.9), s[s.len() - 1])
}

struct Run {
    child: Child,
    lines: Receiver<String>,
}

impl Run {
    fn start(app: &str, mode: &str, env: &[(&str, &str)]) -> Self {
        let mut cmd = Command::new(app);
        cmd.env("FLEETD_BENCH", mode).stdout(Stdio::piped()).stderr(Stdio::null());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("spawn fleetd-app");
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("FLEETD_BENCH ")
                    && tx.send(rest.to_string()).is_err()
                {
                    return;
                }
            }
        });
        Run { child, lines }
    }

    /// Next bench line whose `event=` is `event`; panics after 60 s or if the app exits first.
    fn expect(&self, event: &str) -> String {
        let want = format!("event={event}");
        loop {
            let line = self.lines.recv_timeout(Duration::from_secs(60)).unwrap_or_else(|e| match e {
                mpsc::RecvTimeoutError::Timeout => panic!("timed out waiting for {want}"),
                mpsc::RecvTimeoutError::Disconnected => {
                    panic!("fleetd-app exited before {want}; its panic report, if any, is in ~/.fleetd/app.log")
                }
            });
            if line.split(' ').next() == Some(want.as_str()) {
                return line;
            }
        }
    }

    fn finish(mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        self.kill();
    }

    fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.split(' ').find_map(|kv| kv.strip_prefix(key)?.strip_prefix('='))
}

fn unix_ns() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
}

/// (exec -> first frame presented to the visible window, exec -> first draw started), in ms.
fn cold_start(app: &str, env: &[(&str, &str)]) -> (f64, f64) {
    let t0 = unix_ns();
    let run = Run::start(app, "cold", env);
    let line = run.expect("first_present");
    let at = |key: &str| (field(&line, key).unwrap().parse::<u128>().unwrap() - t0) as f64 / 1e6;
    let result = (at("unix_ns"), at("first_draw_unix_ns"));
    run.finish();
    result
}

/// RSS in KiB 10 s after the first frame, plus the files the process had mapped.
fn idle_rss(app: &str, env: &[(&str, &str)]) -> (u64, Vec<String>) {
    let run = Run::start(app, "idle", env);
    run.expect("first_present");
    std::thread::sleep(Duration::from_secs(10));
    let pid = run.child.id();
    let rss = rss_kib(pid);
    let mapped = mapped_files(pid);
    run.kill();
    (rss, mapped)
}

#[cfg(target_os = "linux")]
fn rss_kib(pid: u32) -> u64 {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    let line = status.lines().find(|l| l.starts_with("VmRSS:")).unwrap();
    line.split_whitespace().nth(1).unwrap().parse().unwrap()
}

#[cfg(not(target_os = "linux"))]
fn rss_kib(pid: u32) -> u64 {
    let out = Command::new("ps").args(["-o", "rss=", "-p", &pid.to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
}

#[cfg(target_os = "linux")]
fn mapped_files(pid: u32) -> Vec<String> {
    let maps = std::fs::read_to_string(format!("/proc/{pid}/maps")).unwrap_or_default();
    let mut files: Vec<String> = maps
        .lines()
        .filter_map(|l| l.split_whitespace().nth(5))
        .filter(|p| p.starts_with('/') && !p.starts_with("/dev/") && !p.starts_with("/memfd"))
        .map(str::to_string)
        .collect();
    files.sort();
    files.dedup();
    files
}

#[cfg(not(target_os = "linux"))]
fn mapped_files(_pid: u32) -> Vec<String> {
    Vec::new()
}

/// Drops clean page-cache pages for these files (no root needed). Pages another process has
/// mapped and in use, e.g. libc's, stay resident, so this is "cold for our files", not a reboot.
#[cfg(target_os = "linux")]
fn evict(files: &[String]) {
    use std::os::fd::AsRawFd;
    for f in files {
        if let Ok(file) = std::fs::File::open(f) {
            unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
        }
    }
}

fn key_samples(line: &str) -> Option<f64> {
    let key = field(line, "key")?;
    (key.len() == 1 && key.as_bytes()[0].is_ascii_lowercase()).then(|| field(line, "latency_ns").unwrap().parse::<f64>().unwrap() / 1e6)
}

/// Focus the app's X11 window (no-op elsewhere). `first_present` carries its id.
fn focus(first_present: &str) {
    #[cfg(target_os = "linux")]
    if let Some(window) = field(first_present, "x11_window").and_then(|w| w.parse::<u32>().ok()).filter(|&w| w != 0) {
        xtest::focus(window).expect("focus app window");
    }
    let _ = first_present;
}

/// The app lifts gpui's unfocused-window frame cap in bench mode, so an inactive window still measures
/// rendering; say so, since a real user's window would be focused.
fn check_active(line: &str) {
    if field(line, "active") != Some("true") {
        eprintln!("  note: app window was not focused during this measurement");
    }
}

fn keys_internal(app: &str) -> Vec<f64> {
    let run = Run::start(app, "keys-internal", &[]);
    focus(&run.expect("first_present"));
    let mut samples = Vec::new();
    loop {
        let line = run.lines.recv_timeout(Duration::from_secs(60)).expect("keys-internal output");
        if line.starts_with("event=keys") {
            check_active(&line);
            break;
        }
        samples.extend(key_samples(&line));
    }
    run.finish();
    samples
}

#[cfg(target_os = "linux")]
fn keys_external(app: &str) -> Result<(Vec<f64>, Vec<f64>), String> {
    let run = Run::start(app, "keys-external", &[]);
    focus(&run.expect("first_present"));
    let ready = run.expect("ready");
    let window: u32 = field(&ready, "x11_window").unwrap().parse().unwrap();
    if window == 0 {
        run.kill();
        return Err("app is not on X11".into());
    }
    let external = xtest::type_and_watch(window, 200, field(&ready, "field")).map_err(|e| e.to_string());
    std::thread::sleep(Duration::from_millis(300));
    let mut in_app = Vec::new();
    while let Ok(line) = run.lines.try_recv() {
        in_app.extend(key_samples(&line));
    }
    run.kill();
    Ok((in_app, external?))
}

fn scroll(app: &str) -> (f64, f64) {
    let run = Run::start(app, "scroll", &[]);
    focus(&run.expect("first_present"));
    let line = run.expect("scroll");
    check_active(&line);
    run.finish();
    let fps: f64 = field(&line, "fps").unwrap().parse().unwrap();
    let worst: f64 = field(&line, "worst_frame_us").unwrap().parse::<f64>().unwrap() / 1000.0;
    (fps, worst)
}
