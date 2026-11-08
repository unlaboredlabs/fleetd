//! The node's cost per agent, measured: many hosted sessions each playing a long tool-heavy turn through the real
//! host socket, mapper, masker, store and outlet. Ignored: run by hand, in release, to compare a change's before and
//! after (`cargo test --release -p fleetd --lib perf_tests -- --ignored --nocapture`).
use std::time::Instant;

use serde_json::Value;

use super::*;

/// `allowlisted-tool`'s turn with its tool step played `steps` times, each tool result `result_bytes` long, and its
/// closing text streamed in `text_deltas` deltas: an agent's turn of reads and commands.
fn long_turn(steps: usize, result_bytes: usize, text_deltas: usize) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/node/runner/fixtures/claude-2.1.302-allowlisted-tool.jsonl");
    let recs: Vec<Value> = std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let starts: Vec<usize> = recs
        .iter()
        .enumerate()
        .filter(|(_, r)| r["msg"]["event"]["type"] == "message_start")
        .map(|(i, _)| i)
        .collect();
    let (head, step, tail) = (
        &recs[..starts[0]],
        &recs[starts[0]..starts[1]],
        &recs[starts[1]..],
    );
    let output: String = "line of command output, as a build or a file read prints it\n"
        .repeat(result_bytes / 60 + 1)[..result_bytes]
        .to_owned();
    let mut uuids = 0u64;
    let mut fresh = || {
        uuids += 1;
        format!("00000000-0000-4000-8000-{uuids:012}")
    };
    let mut out: Vec<Value> = head.to_vec();
    for k in 0..steps {
        let text = serde_json::to_string(step)
            .unwrap()
            .replace("toolu_012s7DpFiFBMkB1q11Fq4NhH", &format!("toolu_{k:024}"))
            .replace("msg_011Cg9aFAR9S1hWJ94iWsvMt", &format!("msg_{k:024}"));
        let mut lines: Vec<Value> = serde_json::from_str(&text).unwrap();
        for line in &mut lines {
            if line["msg"]["uuid"].is_string() {
                line["msg"]["uuid"] = fresh().into();
            }
            if line["msg"]["type"] == "user" {
                line["msg"]["message"]["content"][0]["content"] = output.clone().into();
                line["msg"]["tool_use_result"]["stdout"] = output.clone().into();
            }
        }
        out.extend(lines);
    }
    for rec in tail {
        if rec["msg"]["event"]["delta"]["type"] == "text_delta" {
            for _ in 0..text_deltas {
                let mut delta = rec.clone();
                delta["msg"]["event"]["delta"]["text"] = "word ".into();
                delta["msg"]["uuid"] = fresh().into();
                out.push(delta);
            }
        } else {
            out.push(rec.clone());
        }
    }
    out.iter()
        .map(|r| format!("{r}\n"))
        .collect::<Vec<_>>()
        .concat()
}

fn cpu_ms() -> f64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage fills the struct it is given.
    let usage = unsafe {
        libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
        usage.assume_init()
    };
    let ms = |t: libc::timeval| t.tv_sec as f64 * 1000.0 + t.tv_usec as f64 / 1000.0;
    ms(usage.ru_utime) + ms(usage.ru_stime)
}

fn rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|v| v.trim().trim_end_matches(" kB").parse().ok())
        .unwrap_or(0)
}

/// `FLEETD_PERF_SESSIONS` sessions (20) each play [`long_turn`] twice, `FLEETD_PERF_FOLLOWED` of them (5) followed,
/// as chats someone has open, and each with `FLEETD_PERF_RUNS` (0) runs behind it before the second, as a lead has
/// after a few days: what the node and its hosts spend on the second turns, and what goes to the hub.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "a measurement, run by hand in release"]
async fn many_agents_playing_long_turns() {
    let count = |name: &str, default: usize| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    };
    let sessions = count("FLEETD_PERF_SESSIONS", 20);
    let followed = count("FLEETD_PERF_FOLLOWED", 5);
    let steps = count("FLEETD_PERF_STEPS", 40);
    let history = count("FLEETD_PERF_RUNS", 0);
    let dir = tempfile::tempdir().unwrap();
    let turn = long_turn(steps, 16 * 1024, 400);
    let lines = turn
        .lines()
        .filter(|l| l.contains(r#""dir":"out""#))
        .count();
    let mut runner = FakeRunner::from_lines(&turn);
    runner.hosted = true;
    let store = NodeStore::open(&dir.path().join("sessions.sqlite")).unwrap();
    let mut hub = hub(dir.path(), store, runner).await;
    hub.project(dir.path()).await;
    let ids: Vec<String> = (0..sessions).map(|i| format!("s{i}")).collect();
    for id in &ids {
        hub.ok(launch(id, RuntimeMode::FullAccess, SessionWorkspace::Root))
            .await;
    }
    for id in ids.iter().take(followed) {
        hub.ok(SessionCall::Follow {
            session_id: ThreadId::unchecked(id),
        })
        .await;
    }
    drain_until_done(&mut hub, &ids, "r1").await;
    for id in &ids {
        hub.service
            .update(id, |c| {
                let done = c.runs[0].clone();
                c.runs.extend((0..history).map(|k| {
                    let mut run = done.clone();
                    run.id = NonEmpty::unchecked(format!("old{k}"));
                    run.ordinal = k as u64 + 2;
                    run
                }));
            })
            .unwrap();
    }
    let (rss, cpu, wall) = (rss_kb(), cpu_ms(), Instant::now());
    for id in &ids {
        hub.ok(send(id, "r2")).await;
    }
    let (frames, bytes) = drain_until_done(&mut hub, &ids, "r2").await;
    let (wall, cpu, rss_after) = (wall.elapsed(), cpu_ms() - cpu, rss_kb());
    println!(
        "perf: {sessions} sessions ({followed} followed, {history} runs before) x {lines} claude lines: wall {} ms, \
         cpu {cpu:.0} ms ({:.1} ms per session, {:.1} us per line), rss {rss} -> {rss_after} kB, to hub {frames} \
         frames {} kB",
        wall.as_millis(),
        cpu / sessions as f64,
        cpu * 1000.0 / (sessions * lines) as f64,
        bytes / 1024,
    );
    hub.service.shutdown().await;
}

/// Reads what the node sends until every session's `run` completed: how many frames, how many bytes.
async fn drain_until_done(hub: &mut Hub, ids: &[String], run: &str) -> (u64, u64) {
    let (mut frames, mut bytes) = (0u64, 0u64);
    let done = |hub: &Hub| {
        ids.iter().all(|id| {
            hub.service.session(id).is_ok_and(|row| {
                row.summary.active_run_id.is_none()
                    && row
                        .summary
                        .latest_run
                        .is_some_and(|r| r.id == run && r.status == RunStatus::Completed)
            })
        })
    };
    let started = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    while !done(hub) {
        tokio::select! {
            frame = hub.rx.recv() => {
                let frame = frame.expect("outlet closed");
                frames += 1;
                bytes += frame.len() as u64;
            }
            _ = tick.tick() => {}
        }
        assert!(
            started.elapsed() < Duration::from_secs(600),
            "the turns never ended"
        );
    }
    while let Ok(frame) = hub.rx.try_recv() {
        frames += 1;
        bytes += frame.len() as u64;
    }
    (frames, bytes)
}

/// What placing one socket caller costs: the whole process table, as before, or its ancestors alone.
#[test]
#[ignore = "a measurement, run by hand in release"]
fn placing_a_socket_caller() {
    use crate::node::runner::process;
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let pid = child.id() as i32;
    let roots = std::collections::HashMap::from([(std::process::id() as i32, "s1".to_owned())]);
    let runs = 200;
    let time = |f: &dyn Fn() -> process::PeerSession| {
        let (cpu, wall) = (cpu_ms(), Instant::now());
        for _ in 0..runs {
            assert_eq!(f(), process::PeerSession::Session("s1".into()));
        }
        (
            wall.elapsed().as_secs_f64() * 1000.0 / runs as f64,
            (cpu_ms() - cpu) / runs as f64,
        )
    };
    let table = time(&|| {
        let table = process::table();
        let parents: std::collections::HashMap<i32, i32> =
            table.iter().map(|p| (p.pid, p.ppid)).collect();
        process::peer_session(pid, &roots, |p| parents.get(&p).copied())
    });
    let walk = time(&|| process::peer_session(pid, &roots, process::parents()));
    let _ = child.kill();
    let _ = child.wait();
    println!(
        "perf: placing a caller among {} processes: table {:.3} ms wall {:.3} ms cpu; ancestors {:.3} ms wall {:.3} ms cpu",
        process::table().len(),
        table.0,
        table.1,
        walk.0,
        walk.1
    );
}

/// What a session's host spends decoding claude's stdout: each line of [`long_turn`] as claude prints it.
#[test]
#[ignore = "a measurement, run by hand in release"]
fn decoding_claude_lines() {
    use crate::node::runner::claude::protocol::Line;
    let turn = long_turn(40, 16 * 1024, 400);
    let lines: Vec<String> = turn
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|r| r["dir"] == "out")
        .map(|r| r["msg"].to_string())
        .collect();
    let bytes: usize = lines.iter().map(String::len).sum();
    let runs = 20;
    let cpu = cpu_ms();
    for _ in 0..runs {
        for line in &lines {
            std::hint::black_box(serde_json::from_str::<Line>(line).unwrap());
        }
    }
    let cpu = cpu_ms() - cpu;
    println!(
        "perf: decoding {} lines ({} kB): {:.1} ms cpu per turn, {:.2} us per line",
        lines.len(),
        bytes / 1024,
        cpu / runs as f64,
        cpu * 1000.0 / (runs * lines.len()) as f64
    );
}
