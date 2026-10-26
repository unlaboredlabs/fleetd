//! One preview, from `preview_run` to its end: check out, set up, build, start, wait until it answers, open it on the
//! tailnet, then watch it until it is stopped, idle or at its cap, and throw it away. Every step is reported as it
//! starts and ends; a stop ends it at any step.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::preview::{
    PREVIEW_CAP_MIN, PreviewEndReason, PreviewReport, PreviewRunFrame, PreviewState, PreviewStep,
    PreviewStepState, WebPreview,
};
use fleetd_contracts::prim::{Count, Line, List, Text};
use fleetd_contracts::project_settings::WorktreeSetup;
use tokio::sync::watch;

use super::super::cmd::{ConfinedRun, run_confined};
use super::super::util::scrubbed_env;
use super::super::{project_env, worktree_setup};
use super::serve::{Server, free_port};
use super::{Previews, proxy, slots};

pub struct Run {
    pub frame: PreviewRunFrame,
    pub web: WebPreview,
    pub root: PathBuf,
    pub key: String,
}

/// A step's words and detail are lines of at most 300 characters.
fn line(text: &str) -> Line<1, 300> {
    let text = text.trim();
    let text = if text.is_empty() { "…" } else { text };
    let cut: String = if text.chars().count() > 300 {
        text.chars().take(299).chain(['…']).collect()
    } else {
        text.to_owned()
    };
    Line::unchecked(cut)
}

/// A preview's note is a line of at most 500 characters.
fn note_line(text: &str) -> Line<1, 500> {
    let text = text.trim();
    let text = if text.is_empty() { "…" } else { text };
    Line::unchecked(if text.chars().count() > 500 {
        text.chars().take(499).chain(['…']).collect()
    } else {
        text.to_owned()
    })
}

fn iso_in(d: Duration) -> Timestamp {
    let at = chrono::Utc::now() + chrono::Duration::from_std(d).unwrap_or_default();
    Timestamp(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// What the run has reported so far; each change is reported whole.
struct Progress {
    steps: Vec<PreviewStep>,
    head: Option<String>,
    url: Option<String>,
    idle_until: Option<Timestamp>,
    started: Vec<Option<Instant>>,
}

struct Reporter<'a> {
    me: &'a Previews,
    run: &'a Run,
    p: Mutex<Progress>,
}

impl Reporter<'_> {
    fn send(
        &self,
        state: PreviewState,
        end_reason: Option<PreviewEndReason>,
        note: Option<String>,
    ) {
        let p = self.p.lock().unwrap();
        self.me.report(PreviewReport {
            preview_id: self.run.frame.preview_id.clone(),
            state,
            head: p.head.as_deref().map(Line::unchecked),
            steps: List::unchecked(p.steps.clone()),
            url: p.url.as_deref().map(line),
            session_id: None,
            idle_until: p.idle_until.clone(),
            end_reason,
            note: note.as_deref().map(note_line),
        });
    }

    fn starting(&self) {
        self.send(PreviewState::Starting, None, None);
    }

    fn begin(&self, i: usize) {
        {
            let mut p = self.p.lock().unwrap();
            p.steps[i].state = PreviewStepState::Running;
            p.started[i] = Some(Instant::now());
        }
        self.starting();
    }

    /// Ends step `i` as `state`, with a new detail and a failed step's output.
    fn end(&self, i: usize, state: PreviewStepState, detail: Option<&str>, output: Option<&str>) {
        let mut p = self.p.lock().unwrap();
        let took = p.started[i].map(|t| Count::unchecked(t.elapsed().as_millis() as i64));
        let step = &mut p.steps[i];
        step.state = state;
        if let Some(detail) = detail {
            step.detail = Some(line(detail));
        }
        step.took_ms = took;
        step.output_tail = output
            .map(str::trim)
            .filter(|o| !o.is_empty())
            .map(|o| Text::unchecked(super::super::util::tail_utf16(o, 3990).to_owned()));
    }

    fn fail(&self, i: usize, detail: Option<&str>, output: Option<&str>, note: &str) {
        self.end(i, PreviewStepState::Failed, detail, output);
        self.send(PreviewState::Failed, None, Some(note.to_owned()));
    }
}

fn step(words: String, detail: Option<String>) -> PreviewStep {
    PreviewStep {
        words: line(&words),
        state: PreviewStepState::Queued,
        detail: detail.as_deref().map(line),
        took_ms: None,
        output_tail: None,
    }
}

/// Indexes of the steps, in order.
struct Plan {
    checkout: usize,
    setup: std::ops::Range<usize>,
    build: Option<usize>,
    start: usize,
    open: usize,
}

fn plan(run: &Run) -> (Plan, Vec<PreviewStep>) {
    let f = &run.frame;
    let mut steps = Vec::new();
    let checkout = match (&f.base, f.heads.as_slice()) {
        (None, [one]) => step(
            format!("Check out {}", one.branch.as_str()),
            Some(format!("at {}", slots::short(one.sha.as_str()))),
        ),
        (Some(base), heads) => step(
            format!("Merge {} PRs onto {}", heads.len(), base.as_str()),
            None,
        ),
        (None, _) => step("Check out".to_owned(), None),
    };
    steps.push(checkout);
    let checkout = 0;
    let first = steps.len();
    for command in run.web.setup.iter() {
        steps.push(step(format!("Setup: {}", command.as_str()), None));
    }
    let setup = first..steps.len();
    let build = run.web.build.as_ref().map(|b| {
        steps.push(step(format!("Build: {}", b.as_str()), None));
        steps.len() - 1
    });
    steps.push(step(format!("Start: {}", run.web.start.as_str()), None));
    let start = steps.len() - 1;
    steps.push(step("Open to your devices".to_owned(), None));
    let open = steps.len() - 1;
    (
        Plan {
            checkout,
            setup,
            build,
            start,
            open,
        },
        steps,
    )
}

/// Waits for `fut` unless the preview is stopped first; then the stop's reason.
async fn or_stop<T>(
    stopped: &mut watch::Receiver<Option<PreviewEndReason>>,
    fut: impl std::future::Future<Output = T>,
) -> Result<T, PreviewEndReason> {
    if let Some(reason) = *stopped.borrow() {
        return Err(reason);
    }
    tokio::select! {
        out = fut => Ok(out),
        reason = async {
            loop {
                if stopped.changed().await.is_err() {
                    return PreviewEndReason::Lost;
                }
                if let Some(reason) = *stopped.borrow() {
                    return reason;
                }
            }
        } => Err(reason),
    }
}

pub async fn run(
    me: &Arc<Previews>,
    run: Run,
    slot: &Path,
    mut stopped: watch::Receiver<Option<PreviewEndReason>>,
) {
    let (plan, steps) = plan(&run);
    let started = vec![None; steps.len()];
    let r = Reporter {
        me,
        run: &run,
        p: Mutex::new(Progress {
            steps,
            head: None,
            url: None,
            idle_until: None,
            started,
        }),
    };
    r.starting();
    let ended = |reason: PreviewEndReason| r.send(PreviewState::Ended, Some(reason), None);
    // Stopped before it began (a stop right behind its run): nothing runs at all.
    if let Some(reason) = *stopped.borrow() {
        return ended(reason);
    }

    // Check out.
    r.begin(plan.checkout);
    let mut checkout = {
        let (root, slot, frame) = (run.root.clone(), slot.to_owned(), run.frame.clone());
        tokio::task::spawn_blocking(move || check_out(&root, &slot, &frame))
    };
    match or_stop(&mut stopped, &mut checkout).await {
        // git can't be stopped from here: it ends (a fetch within its limit) before the slot is free again, so the
        // next preview never finds its lock or a merge half done. The slot no longer counts as holding these commits.
        Err(reason) => {
            let _ = checkout.await;
            slots::set_key(slot, None);
            return ended(reason);
        }
        Ok(Ok(Ok(head))) => {
            slots::set_key(slot, Some(&run.key));
            r.p.lock().unwrap().head = Some(head.clone());
            let n = run.frame.heads.len();
            let detail = if n == 1 {
                format!(
                    "at {}, in preview worktree {} on this machine",
                    slots::short(&head),
                    slot_name(slot)
                )
            } else {
                format!(
                    "at {}, {n} PRs merged, in preview worktree {}",
                    slots::short(&head),
                    slot_name(slot)
                )
            };
            r.end(plan.checkout, PreviewStepState::Done, Some(&detail), None);
        }
        Ok(Ok(Err(why))) => {
            slots::set_key(slot, None);
            return r.fail(plan.checkout, None, None, &why);
        }
        Ok(Err(e)) => {
            slots::set_key(slot, None);
            return r.fail(
                plan.checkout,
                None,
                None,
                &format!("The checkout stopped: {e}"),
            );
        }
    }
    // The project's variables for every command, its secrets masked in all they print.
    let project = run.frame.project_id.as_str().to_owned();
    let (vars, secrets) = project_env::for_spawn(&me.home, &project);
    let mut env = scrubbed_env();
    env.extend(vars);
    let scrub: Vec<String> = secrets.into_iter().map(|(_, v)| v).collect();

    // Set up.
    if !plan.setup.is_empty() {
        let setup = WorktreeSetup {
            commands: List::unchecked(run.web.setup.iter().cloned().collect()),
            inputs: run.web.inputs.clone(),
            ..WorktreeSetup::default()
        };
        let base = plan.setup.start;
        let outcome = or_stop(
            &mut stopped,
            worktree_setup::run(
                &setup,
                slot,
                &env,
                &scrub,
                |i| r.begin(base + i),
                |i, ran| {
                    let detail = if ran.ok() {
                        None
                    } else {
                        Some(ran.how(setup.timeout_sec.get() as u64))
                    };
                    let state = if ran.ok() {
                        PreviewStepState::Done
                    } else {
                        PreviewStepState::Failed
                    };
                    r.end(
                        base + i,
                        state,
                        detail.as_deref(),
                        (!ran.ok()).then_some(ran.output_tail.as_str()),
                    );
                    r.starting();
                },
            ),
        )
        .await;
        match outcome {
            Err(reason) => return ended(reason),
            Ok(worktree_setup::Outcome::Reused) => {
                let why = if run.web.inputs.is_empty() {
                    "reused: the same commands ran here before".to_owned()
                } else {
                    let names: Vec<&str> = run.web.inputs.iter().map(|i| i.as_str()).collect();
                    format!("reused: {} unchanged", names.join(", "))
                };
                for i in plan.setup.clone() {
                    r.end(i, PreviewStepState::Reused, Some(&why), None);
                }
                r.starting();
            }
            Ok(worktree_setup::Outcome::Done(_)) => {}
            Ok(worktree_setup::Outcome::Failed { ran, .. }) => {
                let last = ran
                    .last()
                    .map(|ran| ran.command.clone())
                    .unwrap_or_default();
                let note = format!("Setup failed: {last}");
                return r.send(PreviewState::Failed, None, Some(note));
            }
        }
    }

    // Build, unless this slot built the same commit with the same command.
    let head = r.p.lock().unwrap().head.clone().unwrap_or_default();
    if let (Some(i), Some(build)) = (plan.build, run.web.build.as_ref()) {
        let key = slots::build_key(&head, build.as_str());
        if slots::built(slot, &key) {
            r.end(
                i,
                PreviewStepState::Reused,
                Some(&format!("reused: built at {} before", slots::short(&head))),
                None,
            );
            r.starting();
        } else {
            r.begin(i);
            slots::set_built(slot, None);
            let cwd = slot.to_string_lossy().into_owned();
            let argv = ["sh".to_owned(), "-c".to_owned(), build.as_str().to_owned()];
            let roots = [cwd.clone()];
            let built = or_stop(
                &mut stopped,
                run_confined(
                    ConfinedRun {
                        cwd: &cwd,
                        argv: &argv,
                        timeout_sec: me.timing.build_timeout.as_secs().max(1),
                        env: Some(env.clone()),
                        scrub: &scrub,
                    },
                    &roots,
                ),
            )
            .await;
            match built {
                Err(reason) => return ended(reason),
                Ok(out) if out.exit_code == Some(0) => {
                    slots::set_built(slot, Some(&key));
                    r.end(i, PreviewStepState::Done, None, None);
                    r.starting();
                }
                Ok(out) => {
                    let how = match out.exit_code {
                        _ if out.timed_out => format!(
                            "passed its {} min limit",
                            me.timing.build_timeout.as_secs() / 60
                        ),
                        Some(code) => format!("exited {code}"),
                        None => out
                            .not_run
                            .clone()
                            .unwrap_or_else(|| "ended by a signal".to_owned()),
                    };
                    let output = out.not_run.unwrap_or(out.output_tail);
                    return r.fail(
                        i,
                        Some(&how),
                        Some(&output),
                        &format!("The build failed: it {how}."),
                    );
                }
            }
        }
    }

    // Start, and wait until it answers.
    r.begin(plan.start);
    let started = free_port().and_then(|port| {
        Server::start(
            run.web.start.as_str(),
            slot,
            &env,
            port,
            &slots::log_file(slot),
            &slots::pid_file(slot),
        )
    });
    let mut server = match started {
        Ok(server) => server,
        Err(e) => {
            return r.fail(
                plan.start,
                None,
                None,
                &format!("The app didn't start: {e}"),
            );
        }
    };
    let ready = run.web.ready.as_str().to_owned();
    match or_stop(
        &mut stopped,
        server.wait_ready(&ready, me.timing.ready_within),
    )
    .await
    {
        Err(reason) => {
            server.stop().await;
            return ended(reason);
        }
        Ok(true) => {
            let detail = format!("on 127.0.0.1:{}; it answered at {ready}", server.port);
            r.end(plan.start, PreviewStepState::Done, Some(&detail), None);
        }
        Ok(false) => {
            let tail = server.log_tail(&scrub);
            let note = if server.exited() {
                "The app stopped before it answered.".to_owned()
            } else {
                format!(
                    "The app didn't answer at {ready} within {} s.",
                    me.timing.ready_within.as_secs()
                )
            };
            server.stop().await;
            return r.fail(plan.start, None, Some(&tail), &note);
        }
    }

    // Open it to the person's devices.
    r.begin(plan.open);
    let owner = run
        .frame
        .owner_login
        .as_ref()
        .map(|o| o.as_str().to_owned());
    let proxied = match (me.detect)(owner).await {
        Ok(config) => proxy::Proxy::start(&config, server.port).await,
        Err(e) => Err(e),
    };
    let (proxy, note) = match proxied {
        Ok(proxy) => {
            let url = proxy.url().to_owned();
            r.p.lock().unwrap().url = Some(url.clone());
            r.end(plan.open, PreviewStepState::Done, Some(&url), None);
            (Some(proxy), None)
        }
        Err(e) => {
            let why = format!("not on the tailnet here: {e}");
            r.end(plan.open, PreviewStepState::Failed, Some(&why), None);
            (
                None,
                Some(
                    "Your own devices can't open it: this machine isn't on the tailnet.".to_owned(),
                ),
            )
        }
    };

    // Ready: watch it until it ends.
    let idle = me.timing.minute * run.frame.idle_minutes.get() as u32;
    let cap = me.timing.minute * PREVIEW_CAP_MIN as u32;
    let ready_at = Instant::now();
    let idle_until = |last: Instant| iso_in(idle.saturating_sub(last.elapsed()));
    let mut shown_last = ready_at;
    r.p.lock().unwrap().idle_until = Some(idle_until(ready_at));
    r.send(PreviewState::Ready, None, note.clone());
    let reason = loop {
        if let Err(reason) = or_stop(&mut stopped, tokio::time::sleep(me.timing.tick)).await {
            break Some(reason);
        }
        if server.exited() {
            break None;
        }
        if ready_at.elapsed() >= cap {
            break Some(PreviewEndReason::Cap);
        }
        // In use while a connection is open; otherwise idle since the last one closed (or since it was ready).
        let last = match proxy.as_ref().map(proxy::Proxy::idle_since) {
            Some(None) => Instant::now(),
            Some(Some(since)) => since.max(ready_at),
            None => ready_at,
        };
        if last.elapsed() >= idle {
            break Some(PreviewEndReason::Idle);
        }
        // Said again only when it moved by a minute or more, so a busy page doesn't send a report a tick.
        if last.duration_since(shown_last) >= me.timing.minute {
            shown_last = last;
            r.p.lock().unwrap().idle_until = Some(idle_until(last));
            r.send(PreviewState::Ready, None, note.clone());
        }
    };

    // Throw it away: the port, then the app. The worktree stays as the next preview's cache.
    if let Some(proxy) = proxy {
        proxy.stop().await;
    }
    let tail = reason.is_none().then(|| server.log_tail(&scrub));
    server.stop().await;
    {
        let mut p = r.p.lock().unwrap();
        p.url = None;
        p.idle_until = None;
    }
    match reason {
        Some(reason) => ended(reason),
        None => {
            let note = match tail.as_deref() {
                Some(t) if !t.is_empty() => format!(
                    "The app stopped by itself. Its last words: {}",
                    last_line(t)
                ),
                _ => "The app stopped by itself.".to_owned(),
            };
            r.send(PreviewState::Failed, None, Some(note));
        }
    }
}

fn last_line(text: &str) -> &str {
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
}

fn slot_name(slot: &Path) -> String {
    slot.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Puts the slot at what the frame asks for, and answers the commit it is at. The refs its fetches made go after.
fn check_out(root: &Path, slot: &Path, frame: &PreviewRunFrame) -> Result<String, String> {
    let out = check_out_with(root, slot, frame);
    slots::drop_refs(root, frame.preview_id.as_str());
    out
}

fn check_out_with(root: &Path, slot: &Path, frame: &PreviewRunFrame) -> Result<String, String> {
    let id = frame.preview_id.as_str();
    for (n, h) in frame.heads.iter().enumerate() {
        slots::fetch(root, id, n, h.branch.as_str(), h.sha.as_str())?;
    }
    match &frame.base {
        None => {
            let sha = frame
                .heads
                .first()
                .map(|h| h.sha.as_str())
                .unwrap_or_default();
            slots::checkout(root, slot, sha)?;
        }
        Some(base) => {
            let base_sha = slots::fetch_base(root, id, base.as_str())?;
            slots::checkout(root, slot, &base_sha)?;
            for h in frame.heads.iter() {
                slots::merge(slot, h.branch.as_str(), h.sha.as_str())?;
            }
        }
    }
    slots::head(slot).ok_or_else(|| "the preview worktree has no commit".to_owned())
}
