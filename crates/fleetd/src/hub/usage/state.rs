//! The usage layer's state as a pure fold over the event log: parked threads, recent limit hits per machine and the
//! breaker. The service (`service.rs`) feeds it events and acts on what it returns.
use super::classify::{UsageClass, UsageParked, limit_of_event, parked_of};
use super::ports::{NewEvent, ThreadRef};
use super::time::plural;
use crate::hub::store::{iso_ms, parse_ms};
use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::node_link::LoginLimit;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const BREAKER_WINDOW_MS: i64 = 10 * 60_000;
/// How long after a limit that named no reset fleetd tries the login again, one step further each time it is still
/// limited: 1, 2, 5, 10, then every 15 minutes. A proxy resting its credentials after a 429 is usually back in one.
pub const CHECK_BACKOFF_MS: [i64; 5] = [60_000, 120_000, 300_000, 600_000, 900_000];

/// The wait before check `n` (0-based) of a limit with no reset.
pub fn check_after_ms(n: usize) -> i64 {
    CHECK_BACKOFF_MS[n.min(CHECK_BACKOFF_MS.len() - 1)]
}
const LAST_EVENTS: usize = 10;
/// Threads listed in one usage.resumed event; the event stays under the log's 2 KB data limit.
const RESUMED_LISTED: usize = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParkedKind {
    Lead,
    Review,
    Write,
    Read,
}

impl ParkedKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lead => "lead",
            Self::Review => "review",
            Self::Write => "write",
            Self::Read => "read",
        }
    }
    /// Resume order: leads first, then reviews, then writers.
    fn rank(self) -> u8 {
        self as u8
    }
}

/// Whose thread a limited one is: a task (with its kind) or a lead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub kind: ParkedKind,
    pub task_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParkedThread {
    pub thread: ThreadRef,
    pub kind: ParkedKind,
    pub task_id: Option<String>,
    pub parked: UsageParked,
    /// The model the limit was on, which a turn must share to prove the login has capacity again.
    pub model: Option<String>,
}

#[derive(Clone, Debug)]
struct Hit {
    thread_id: String,
    class: UsageClass,
    at_ms: i64,
    resume_at: Option<String>,
    model: Option<String>,
    proxy: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Breaker {
    pub class: UsageClass,
    pub since: String,
    /// The reset the limits named.
    pub until: Option<String>,
    /// No reset named (and not pool_exhausted): when fleetd next tries one parked thread.
    pub check_at: Option<String>,
    /// Checks sent so far, which sets the next one's wait ([`check_after_ms`]).
    pub checks: usize,
    /// The thread the latest check sent "continue" to.
    pub probe: Option<Probe>,
    pub model: Option<String>,
    pub proxy: bool,
    pub message: String,
}

/// One parked thread a check sent "continue" to, and what came of it so far.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Probe {
    pub thread_id: String,
    pub at_ms: i64,
    /// Its turn started on the login.
    pub started: bool,
    /// It hit the limit again.
    pub limited: bool,
}

impl Probe {
    /// Started and not limited by the next check: the login served the turn's requests.
    fn got_through(&self) -> bool {
        self.started && !self.limited
    }
}

#[derive(Clone, Debug, Default)]
pub struct MachineUsage {
    /// Limit hits inside the breaker window, one per thread.
    recent: Vec<Hit>,
    pub breaker: Option<Breaker>,
    pub last_events: Vec<HubEvent>,
    /// Per thread, its limits in a row that named no reset since a turn last completed on the login: the step of its
    /// next check.
    streaks: BTreeMap<String, usize>,
    /// Per thread whose turn is running, when it started (ms). A completed turn proves the login only for what
    /// started after it.
    started: BTreeMap<String, i64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParkedCounts {
    pub leads: usize,
    pub tasks: usize,
}

/// One machine's resume due now: everything a lapsed breaker held, or parks whose reset or check time has passed;
/// or, for a breaker with no reset, its check.
#[derive(Clone, Debug)]
pub struct Due {
    pub machine_id: String,
    pub threads: Vec<ParkedThread>,
    pub breaker_cleared: bool,
    /// A check of an open breaker: send one of `threads` "continue" (or, when `breaker_cleared`, the previous check
    /// got through and everything goes).
    pub check: bool,
}

/// What a completed turn on a machine's login lifts: the breaker, and the parks it proves over.
#[derive(Clone, Debug)]
pub struct Lifted {
    pub machine_id: String,
    pub threads: Vec<ParkedThread>,
    pub breaker_cleared: bool,
}

fn key_of(r: &ThreadRef) -> String {
    format!("{}/{}", r.machine_id, r.thread_id)
}

/// "Tue 09:00 UTC".
pub fn reset_text(iso: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(iso) {
        Ok(d) => format!("{} UTC", d.with_timezone(&chrono::Utc).format("%a %H:%M")),
        Err(_) => "Invalid Date UTC".to_string(),
    }
}

/// "12 tasks parked", "the lead and 3 tasks parked".
pub fn parked_text(counts: ParkedCounts) -> String {
    let leads = match counts.leads {
        0 => None,
        1 => Some("the lead".to_string()),
        n => Some(plural(n, "lead")),
    };
    let tasks = if counts.tasks == 0 && leads.is_some() {
        None
    } else {
        Some(plural(counts.tasks, "task"))
    };
    let parts: Vec<String> = [leads, tasks].into_iter().flatten().collect();
    format!("{} parked", parts.join(" and "))
}

fn limit_word(cls: UsageClass) -> &'static str {
    if cls == UsageClass::RateLimit {
        "rate limit"
    } else {
        "usage limit"
    }
}

/// The usage.breaker notice.
pub fn breaker_message(
    machine_id: &str,
    cls: UsageClass,
    until: Option<&str>,
    model: Option<&str>,
    proxy: bool,
    counts: ParkedCounts,
) -> String {
    if cls == UsageClass::PoolExhausted {
        return format!(
            "your proxy has no account available for {}; fleetd paused work on {machine_id} — check your proxy, then run usage_resume",
            model.unwrap_or("the model")
        );
    }
    match until {
        Some(u) => format!(
            "The {} was reached on {machine_id}'s login; resets {}; {}",
            limit_word(cls),
            reset_text(u),
            parked_text(counts)
        ),
        None => format!(
            "{}; checking again shortly; {}",
            unknown_reset_text(machine_id, cls, proxy),
            parked_text(counts)
        ),
    }
}

/// A limit that named no reset: "Rate-limited by your proxy on forge", "The usage limit was reached on forge's login".
fn unknown_reset_text(machine_id: &str, cls: UsageClass, proxy: bool) -> String {
    if proxy {
        format!("Rate-limited by your proxy on {machine_id}")
    } else {
        format!(
            "The {} was reached on {machine_id}'s login",
            limit_word(cls)
        )
    }
}

fn gate_text(machine_id: &str, b: &Breaker) -> String {
    match (&b.until, b.class) {
        (Some(until), cls) if cls != UsageClass::PoolExhausted => {
            format!(
                "usage: paused until {} ({} on {machine_id}'s login)",
                reset_text(until),
                limit_word(cls)
            )
        }
        (None, cls) if cls != UsageClass::PoolExhausted => {
            if b.proxy {
                format!("usage: rate-limited by your proxy on {machine_id}, checking again shortly")
            } else {
                format!(
                    "usage: {} on {machine_id}'s login, checking again shortly",
                    limit_word(cls)
                )
            }
        }
        _ => format!(
            "usage: paused until usage_resume ({})",
            if b.class == UsageClass::PoolExhausted {
                format!(
                    "your proxy has no account for {}",
                    b.model.as_deref().unwrap_or("the model")
                )
            } else {
                format!("usage limit on {machine_id}'s login")
            }
        ),
    }
}

fn str_field(data: &Value, key: &str) -> Option<String> {
    data.get(key).and_then(Value::as_str).map(str::to_string)
}

#[derive(Debug, Default)]
pub struct UsageState {
    /// In first-parked order (a JS Map's insertion order), which breaks priority ties.
    parked: Vec<(String, ParkedThread)>,
    pub machines: BTreeMap<String, MachineUsage>,
}

impl UsageState {
    fn machine(&mut self, machine_id: &str) -> &mut MachineUsage {
        self.machines.entry(machine_id.to_string()).or_default()
    }

    fn remember(m: &mut MachineUsage, event: &HubEvent) {
        m.last_events.push(event.clone());
        let over = m.last_events.len().saturating_sub(LAST_EVENTS);
        m.last_events.drain(..over);
    }

    fn unpark(&mut self, key: &str) {
        self.parked.retain(|(k, _)| k != key);
    }

    pub fn parked_on(&self, machine_id: &str) -> Vec<ParkedThread> {
        self.parked
            .iter()
            .filter(|(_, p)| p.thread.machine_id == machine_id)
            .map(|(_, p)| p.clone())
            .collect()
    }

    pub fn all_parked(&self) -> impl Iterator<Item = &ParkedThread> {
        self.parked.iter().map(|(_, p)| p)
    }

    pub fn parked(&self, thread: &ThreadRef) -> Option<&UsageParked> {
        let key = key_of(thread);
        self.parked
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, p)| &p.parked)
    }

    pub fn counts_on(&self, machine_id: &str) -> ParkedCounts {
        let on = self.parked_on(machine_id);
        let leads = on.iter().filter(|p| p.kind == ParkedKind::Lead).count();
        ParkedCounts {
            leads,
            tasks: on.len() - leads,
        }
    }

    /// Folds one event into the state, for the replay at start and for live events alike. `owner` is whose thread a
    /// thread.usage_limited event is about; other threads count for the breaker but are not parked.
    pub fn apply(&mut self, event: &HubEvent, owner: Option<Owner>) {
        let Some(machine_id) = event.machine_id.as_ref().map(ToString::to_string) else {
            return;
        };
        let data = event.data.clone().unwrap_or(Value::Null);
        let at_ms = parse_ms(event.at.as_str()).unwrap_or(0);
        match event.r#type {
            HubEventType::ThreadUsageLimited => {
                let (Some(limit), Some(thread_id)) = (
                    limit_of_event(event),
                    event.thread_id.as_ref().map(ToString::to_string),
                ) else {
                    return;
                };
                let thread = ThreadRef {
                    machine_id: machine_id.clone(),
                    thread_id: thread_id.clone(),
                };
                let m = self.machine(&machine_id);
                Self::remember(m, event);
                m.started.remove(&thread_id);
                if let Some(p) = m
                    .breaker
                    .as_mut()
                    .and_then(|b| b.probe.as_mut())
                    .filter(|p| p.thread_id == thread_id && at_ms >= p.at_ms)
                {
                    p.limited = true;
                }
                // A limit that named no reset is tried again on the backoff, one step further each time.
                let check_at =
                    if limit.resume_at.is_none() && limit.class != UsageClass::PoolExhausted {
                        let streak = m.streaks.entry(thread_id.clone()).or_default();
                        let wait = check_after_ms(*streak);
                        *streak += 1;
                        Some(iso_ms(at_ms + wait))
                    } else {
                        m.streaks.remove(&thread_id);
                        None
                    };
                m.recent
                    .retain(|h| h.thread_id != thread_id && h.at_ms > at_ms - BREAKER_WINDOW_MS);
                m.recent.push(Hit {
                    thread_id,
                    class: limit.class,
                    at_ms,
                    resume_at: limit.resume_at,
                    model: limit.model.clone(),
                    proxy: limit.proxy,
                });
                if let (Some(owner), Some(parked)) = (owner, parked_of(event)) {
                    let key = key_of(&thread);
                    let p = ParkedThread {
                        thread,
                        kind: owner.kind,
                        task_id: owner.task_id,
                        parked: UsageParked { check_at, ..parked },
                        model: limit.model,
                    };
                    match self.parked.iter_mut().find(|(k, _)| *k == key) {
                        Some(slot) => slot.1 = p,
                        None => self.parked.push((key, p)),
                    }
                }
            }
            HubEventType::ThreadStarted => {
                if let Some(t) = &event.thread_id {
                    let t = t.to_string();
                    self.unpark(&format!("{machine_id}/{t}"));
                    let m = self.machine(&machine_id);
                    if let Some(p) = m
                        .breaker
                        .as_mut()
                        .and_then(|b| b.probe.as_mut())
                        .filter(|p| p.thread_id == t && at_ms >= p.at_ms)
                    {
                        p.started = true;
                    }
                    m.started.insert(t, at_ms);
                }
            }
            HubEventType::ThreadCompleted => {
                let m = self.machine(&machine_id);
                if let Some(t) = &event.thread_id
                    && m.started.remove(t.as_str()).is_some()
                {
                    // The login served a whole turn: limits with no reset start their backoff over.
                    m.streaks.clear();
                }
            }
            HubEventType::UsageBreaker => {
                let m = self.machine(&machine_id);
                Self::remember(m, event);
                m.breaker = Some(Breaker {
                    class: data
                        .get("class")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or(UsageClass::UsageLimit),
                    since: event.at.to_string(),
                    message: event.summary.to_string(),
                    until: str_field(&data, "until"),
                    check_at: str_field(&data, "checkAt"),
                    checks: 0,
                    probe: None,
                    model: str_field(&data, "model"),
                    proxy: data.get("proxy") == Some(&Value::Bool(true)),
                });
            }
            HubEventType::UsageResumed => {
                let m = self.machine(&machine_id);
                Self::remember(m, event);
                let listed: Vec<String> = data
                    .get("threads")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t.get("threadId").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect();
                if data.get("breakerCleared") == Some(&Value::Bool(true)) {
                    m.breaker = None;
                    m.recent.clear();
                } else if let (Some(b), Some(true)) = (
                    m.breaker.as_mut(),
                    data.get("check").and_then(Value::as_bool),
                ) {
                    b.probe = listed.first().map(|t| Probe {
                        thread_id: t.clone(),
                        at_ms,
                        started: false,
                        limited: false,
                    });
                    b.checks += 1;
                    b.check_at = Some(iso_ms(at_ms + check_after_ms(b.checks)));
                }
                for id in listed {
                    self.unpark(&format!("{machine_id}/{id}"));
                }
            }
            _ => {}
        }
    }

    /// What a thread.completed lifts, read before the event is applied: a turn that started on the login after a
    /// limit (on the limit's model, when both are known) proves the login has capacity again, so it closes the
    /// machine's breaker and resumes everything parked there, or, with no breaker, the parks it proves over.
    pub fn lifted_by(&self, event: &HubEvent) -> Option<Lifted> {
        if event.r#type != HubEventType::ThreadCompleted {
            return None;
        }
        let machine_id = event.machine_id.as_ref()?.to_string();
        let m = self.machines.get(&machine_id)?;
        let started = *m.started.get(event.thread_id.as_ref()?.as_str())?;
        let model = event
            .data
            .as_ref()
            .and_then(|d| d.get("model"))
            .and_then(Value::as_str);
        let proves = |since: &str, limited: Option<&str>| {
            parse_ms(since).is_some_and(|s| started >= s)
                && match (model, limited) {
                    (Some(a), Some(b)) => a == b,
                    _ => true,
                }
        };
        let breaker_cleared = m
            .breaker
            .as_ref()
            .is_some_and(|b| proves(&b.since, b.model.as_deref()));
        let threads: Vec<ParkedThread> = match &m.breaker {
            Some(_) if !breaker_cleared => Vec::new(),
            Some(_) => self.parked_on(&machine_id),
            None => self
                .parked_on(&machine_id)
                .into_iter()
                .filter(|p| proves(&p.parked.since, p.model.as_deref()))
                .collect(),
        };
        (breaker_cleared || !threads.is_empty()).then_some(Lifted {
            machine_id,
            threads,
            breaker_cleared,
        })
    }

    /// The usage.breaker event to emit when the machine's recent hits call for it: two of one class within 10
    /// minutes, or one pool_exhausted. Returns the event and when to look again: the reset the limits named, else
    /// the first check.
    pub fn trip(&self, machine_id: &str, at: &str) -> Option<(NewEvent, Option<String>)> {
        let m = self.machines.get(machine_id)?;
        let last = m.recent.last()?;
        if m.breaker.is_some() {
            return None;
        }
        let same: Vec<&Hit> = m.recent.iter().filter(|h| h.class == last.class).collect();
        if last.class != UsageClass::PoolExhausted && same.len() < 2 {
            return None;
        }
        let mut resets: Vec<&String> = same.iter().filter_map(|h| h.resume_at.as_ref()).collect();
        resets.sort();
        let pool = last.class == UsageClass::PoolExhausted;
        let until = if pool {
            None
        } else {
            resets.last().map(|s| s.to_string())
        };
        let check_at = (!pool && until.is_none())
            .then(|| parse_ms(at).map(|ms| iso_ms(ms + check_after_ms(0))))
            .flatten();
        let counts = self.counts_on(machine_id);
        let mut data = json!({ "class": last.class, "parked": counts });
        if let Some(u) = &until {
            data["until"] = json!(u);
        }
        if let Some(c) = &check_at {
            data["checkAt"] = json!(c);
        }
        if let Some(model) = &last.model {
            data["model"] = json!(model);
        }
        if last.proxy {
            data["proxy"] = json!(true);
        }
        let event = NewEvent {
            at: at.to_string(),
            kind: "usage.breaker".into(),
            machine_id: Some(machine_id.to_string()),
            attention: Some("loud".into()),
            summary: breaker_message(
                machine_id,
                last.class,
                until.as_deref(),
                last.model.as_deref(),
                last.proxy,
                counts,
            ),
            data: Some(data),
            ..Default::default()
        };
        Some((event, until.or(check_at)))
    }

    /// What is due at `now_ms`, per machine; unparks nothing (the service does, as it sends). A breaker past its
    /// reset clears and resumes everything. One with no reset is checked: when the thread the last check sent got
    /// through, it clears the same way; otherwise one parked thread is tried, and nothing else moves.
    pub fn due(&self, now_ms: i64) -> Vec<Due> {
        let at = |t: Option<&str>| t.and_then(parse_ms).is_some_and(|t| t <= now_ms);
        let mut out = Vec::new();
        for (machine_id, m) in &self.machines {
            let due = |threads, breaker_cleared, check| Due {
                machine_id: machine_id.clone(),
                threads,
                breaker_cleared,
                check,
            };
            match &m.breaker {
                Some(b) if at(b.until.as_deref()) => {
                    out.push(due(self.parked_on(machine_id), true, false));
                }
                Some(b) if at(b.check_at.as_deref()) => {
                    let through = b.probe.as_ref().is_some_and(Probe::got_through);
                    out.push(due(self.parked_on(machine_id), through, true));
                }
                Some(_) => {}
                None => {
                    let threads: Vec<ParkedThread> = self
                        .parked_on(machine_id)
                        .into_iter()
                        .filter(|p| {
                            at(p.parked.resume_at.as_deref()) || at(p.parked.check_at.as_deref())
                        })
                        .collect();
                    if !threads.is_empty() {
                        out.push(due(threads, false, false));
                    }
                }
            }
        }
        out
    }

    /// `list` in resume order: leads, then reviews, then writers, oldest park first.
    pub fn in_order(list: &[ParkedThread]) -> Vec<ParkedThread> {
        let mut ordered = list.to_vec();
        ordered.sort_by(|a, b| {
            a.kind
                .rank()
                .cmp(&b.kind.rank())
                .then_with(|| a.parked.since.cmp(&b.parked.since))
        });
        ordered
    }

    /// Takes `list` out of the parked set in resume order.
    pub fn take_in_order(&mut self, list: &[ParkedThread]) -> Vec<ParkedThread> {
        let ordered = Self::in_order(list);
        for p in &ordered {
            self.unpark(&key_of(&p.thread));
        }
        ordered
    }

    /// Takes one thread out of the parked set, as a check sends it.
    pub fn take(&mut self, thread: &ThreadRef) {
        self.unpark(&key_of(thread));
    }

    /// Why a new turn may not start on the machine now, as a queued reason.
    pub fn gate(&self, machine_id: &str, now_ms: i64) -> Option<String> {
        let b = self.machines.get(machine_id)?.breaker.as_ref()?;
        if b.until
            .as_deref()
            .and_then(parse_ms)
            .is_some_and(|u| u <= now_ms)
        {
            return None;
        }
        Some(gate_text(machine_id, b).chars().take(200).collect())
    }

    /// `gate`, or why this thread is parked.
    pub fn hold(&self, thread: &ThreadRef, now_ms: i64) -> Option<String> {
        if let Some(paused) = self.gate(&thread.machine_id, now_ms) {
            return Some(paused);
        }
        let p = self.parked(thread)?;
        Some(match (&p.resume_at, &p.check_at) {
            (Some(r), _) => format!("usage: parked until {}", reset_text(r)),
            (None, Some(_)) if p.proxy => {
                "usage: parked, rate-limited by your proxy, checking again shortly".to_string()
            }
            (None, Some(_)) => "usage: parked, checking again shortly".to_string(),
            (None, None) => "usage: parked until usage_resume".to_string(),
        })
    }
}

/// A thread sent "continue", as usage.resumed lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resumed {
    pub thread_id: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

/// Why a usage.resumed went out, as its `by` says: "reset", "check", "turn", or who ran usage_resume.
fn resumed_why(by: &str) -> String {
    match by {
        "reset" => "the limit reset".to_string(),
        "check" => "a check got through".to_string(),
        "turn" => "a turn on its login succeeded".to_string(),
        who => format!("usage_resume by {who}"),
    }
}

/// The usage.resumed event for what went out; `None` when nothing changed. A `check` keeps the breaker open and
/// names the one thread it tried.
pub fn resumed_event(
    machine_id: &str,
    at: &str,
    sent: &[Resumed],
    breaker_cleared: bool,
    by: &str,
) -> Option<NewEvent> {
    if !breaker_cleared && sent.is_empty() {
        return None;
    }
    let what = format!(
        "sent \"continue\" to {}",
        plural(sent.len(), "parked thread")
    );
    let summary = if breaker_cleared {
        format!(
            "Usage pause on {machine_id} lifted ({}); {what}",
            resumed_why(by)
        )
    } else if by == "turn" {
        format!("A turn succeeded on {machine_id}'s login; {what}")
    } else if by == "check" {
        format!("Trying {machine_id}'s login again; {what}")
    } else {
        format!("Usage limit reset on {machine_id}; {what}")
    };
    let mut data = json!({ "breakerCleared": breaker_cleared, "by": by, "threads": &sent[..sent.len().min(RESUMED_LISTED)] });
    if by == "check" && !breaker_cleared {
        data["check"] = json!(true);
    }
    Some(NewEvent {
        at: at.to_string(),
        kind: "usage.resumed".into(),
        machine_id: Some(machine_id.to_string()),
        summary,
        data: Some(data),
        ..Default::default()
    })
}

/// The soft brake: new agents wait while a usage window of the machine's login is this used.
pub const BRAKE_PAUSE: f64 = 0.90;
/// A braked machine starts new agents again once every window is below this, or past its reset.
pub const BRAKE_LIFT: f64 = 0.85;
/// A reading with no usable reset time no longer counts once it is older than this, or when its age is unknown.
/// claude reports a window only while a session runs, so with none running such a reading would otherwise hold new
/// agents until the node restarts. One whose reset is still ahead holds until then, however old: an idle machine
/// braked near its 7-day limit must not start agents up to its cap and spend the rest of the window. The age is on
/// the node's own clock, so a hub and node that disagree on the time don't change it.
pub const BRAKE_STALE_MS: i64 = 15 * 60_000;

type Utc = chrono::DateTime<chrono::Utc>;

/// The window that holds new agents back: its name as claude sends it, how used it is (None: claude sent a warning
/// with no figure), when claude reported it (None from older nodes), and when it resets.
#[derive(Clone, Debug, PartialEq)]
pub struct Brake {
    pub limit_type: String,
    pub utilization: Option<f64>,
    pub observed: Option<Utc>,
    pub resets: Option<Utc>,
}

/// "5-hour", "7-day Opus"; other windows by claude's own name.
fn window_text(limit_type: &str) -> String {
    match limit_type {
        "five_hour" => "5-hour".into(),
        "seven_day" => "7-day".into(),
        "seven_day_opus" => "7-day Opus".into(),
        "seven_day_sonnet" => "7-day Sonnet".into(),
        other => other.replace('_', " "),
    }
}

impl Brake {
    /// "Paused new agents: 5-hour limit 91% on builder-1 as of Tue 13:42 UTC, resets Tue 14:00 UTC (pauses at 90%,
    /// lifts below 85%)".
    pub fn text(&self, machine: &str) -> String {
        let used = self
            .utilization
            .map_or_else(|| "warning".to_string(), |u| format!("{:.0}%", u * 100.0));
        let observed = self.observed.map_or_else(String::new, |o| {
            format!(" as of {}", o.format("%a %H:%M UTC"))
        });
        let resets = self.resets.map_or_else(String::new, |r| {
            format!(", resets {}", r.format("%a %H:%M UTC"))
        });
        format!(
            "Paused new agents: {} limit {used} on {machine}{observed}{resets} (pauses at {:.0}%, lifts below {:.0}%)",
            window_text(&self.limit_type),
            BRAKE_PAUSE * 100.0,
            BRAKE_LIFT * 100.0
        )
    }
}

fn utc(iso: &str) -> Option<Utc> {
    chrono::DateTime::from_timestamp_millis(parse_ms(iso)?)
}

/// The soft brake over the windows the machine's login last reported: the most used window at `BRAKE_PAUSE` or
/// more (`BRAKE_LIFT` once `braked`), or None. A window past its reset (by the hub's clock, `now_ms`) no longer
/// counts. One with no reset that parses counts only while read at most `BRAKE_STALE_MS` before `node_now_ms`, the
/// node's clock at the heartbeat that carried it. A warning or rejection with no figure counts as full; with a figure, the figure decides, so claude's
/// own warning level never pauses early. Running agents are not its business: the caller holds new ones only.
pub fn brake(limits: &[LoginLimit], braked: bool, now_ms: i64, node_now_ms: i64) -> Option<Brake> {
    let at = if braked { BRAKE_LIFT } else { BRAKE_PAUSE };
    limits
        .iter()
        .filter_map(|l| {
            let resets = l.resets_at.as_ref().and_then(|r| utc(r.as_str()));
            if resets.is_some_and(|r| r.timestamp_millis() <= now_ms) {
                return None;
            }
            let observed = l.observed_at.as_ref().and_then(|o| utc(o.as_str()));
            if resets.is_none()
                && observed.is_none_or(|o| node_now_ms - o.timestamp_millis() > BRAKE_STALE_MS)
            {
                return None;
            }
            let used = match &l.utilization {
                Some(u) => u.get(),
                None if l.status.as_str() != "allowed" => f64::INFINITY,
                None => return None,
            };
            (used >= at).then(|| {
                let brake = Brake {
                    limit_type: l.limit_type.as_str().to_string(),
                    utilization: l.utilization.as_ref().map(|u| u.get()),
                    observed,
                    resets,
                };
                (used, brake)
            })
        })
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, brake)| brake)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::store::iso_ms;

    const HOUR: i64 = 3_600_000;
    const USAGE: (&str, &str) = (
        "usage_limit",
        "Claude usage limit reached. Send the message again once the limit resets.",
    );
    const PROXY_400: (&str, &str) = (
        "pool_exhausted",
        r#"API Error: 400 {"error":{"message":"unknown provider for model claude-opus-5-5","type":"invalid_request_error","code":"model_not_found","param":"model"}}"#,
    );

    /// thread.usage_limited as the executor builds it from a failed summary.
    fn limited(
        seq: u64,
        at_ms: i64,
        thread: &str,
        (class, message): (&str, &str),
        reset: Option<i64>,
    ) -> HubEvent {
        let mut data = json!({ "error": { "class": class, "message": message } });
        let limit =
            crate::hub::usage::classify::classify_limit(&crate::hub::usage::classify::LimitInput {
                error_class: Some(class),
                reset_at: reset.map(iso_ms).as_deref(),
                at: &iso_ms(at_ms),
                model: Some("claude-opus-5-5"),
                failure_model: None,
            })
            .unwrap();
        for (k, v) in crate::hub::usage::classify::limit_data(&limit) {
            data[k] = v;
        }
        serde_json::from_value(json!({
            "seq": seq, "at": iso_ms(at_ms), "type": "thread.usage_limited", "machineId": "lab-a", "threadId": thread,
            "summary": format!("{thread} hit a usage limit"), "data": data,
        }))
        .unwrap()
    }

    fn appended(seq: u64, e: NewEvent) -> HubEvent {
        serde_json::from_value(json!({
            "seq": seq, "at": e.at, "type": e.kind, "machineId": e.machine_id, "projectId": e.project_id,
            "threadId": e.thread_id, "summary": e.summary, "data": e.data, "attention": e.attention,
        }))
        .unwrap()
    }

    fn owner(kind: ParkedKind, task: Option<&str>) -> Option<Owner> {
        Some(Owner {
            kind,
            task_id: task.map(str::to_string),
        })
    }

    #[test]
    fn trips_one_breaker_on_two_same_class_limits_within_10_minutes_and_resumes_lead_review_write_at_the_reset()
     {
        let mut s = UsageState::default();
        let reset = 2 * HOUR;
        s.apply(
            &limited(1, 0, "t2", USAGE, Some(reset)),
            owner(ParkedKind::Write, Some("T1")),
        );
        assert!(s.trip("lab-a", &iso_ms(0)).is_none());
        assert!(s.gate("lab-a", 0).is_none());
        s.apply(
            &limited(2, 60_000, "t1", USAGE, Some(reset)),
            owner(ParkedKind::Lead, None),
        );
        let (event, until) = s.trip("lab-a", &iso_ms(60_000)).expect("trips");
        assert_eq!(
            event.summary,
            "The usage limit was reached on lab-a's login; resets Thu 02:00 UTC; the lead and 1 task parked"
        );
        assert_eq!(until, Some(iso_ms(reset)));
        assert_eq!(
            event.data.as_ref().unwrap()["parked"],
            json!({ "leads": 1, "tasks": 1 })
        );
        s.apply(&appended(3, event), None);
        assert!(s.trip("lab-a", &iso_ms(60_000)).is_none(), "one breaker");
        s.apply(
            &limited(4, 120_000, "t3", USAGE, Some(reset)),
            owner(ParkedKind::Review, Some("T2")),
        );
        assert_eq!(s.counts_on("lab-a"), ParkedCounts { leads: 1, tasks: 2 });
        assert_eq!(
            s.gate("lab-a", 120_000).as_deref(),
            Some("usage: paused until Thu 02:00 UTC (usage limit on lab-a's login)")
        );
        assert!(
            s.hold(
                &ThreadRef {
                    machine_id: "lab-a".into(),
                    thread_id: "t9".into()
                },
                120_000
            )
            .is_some()
        );

        assert!(s.due(reset - 1).is_empty());
        let due = s.due(reset);
        assert_eq!(due.len(), 1);
        assert!(due[0].breaker_cleared);
        let order: Vec<String> = s
            .take_in_order(&due[0].threads)
            .into_iter()
            .map(|p| p.thread.thread_id)
            .collect();
        assert_eq!(order, ["t1", "t3", "t2"]);
        assert!(s.gate("lab-a", reset).is_none());
    }

    #[test]
    fn does_not_trip_on_two_limits_more_than_10_minutes_apart() {
        let mut s = UsageState::default();
        s.apply(
            &limited(1, 0, "t2", USAGE, Some(3 * HOUR)),
            owner(ParkedKind::Write, Some("T1")),
        );
        s.apply(
            &limited(2, 11 * 60_000, "t1", USAGE, Some(3 * HOUR)),
            owner(ParkedKind::Lead, None),
        );
        assert!(s.trip("lab-a", &iso_ms(11 * 60_000)).is_none());
    }

    #[test]
    fn a_second_limit_on_the_same_thread_does_not_count_twice() {
        let mut s = UsageState::default();
        s.apply(
            &limited(1, 0, "t2", USAGE, Some(HOUR)),
            owner(ParkedKind::Write, Some("T1")),
        );
        s.apply(
            &limited(2, 60_000, "t2", USAGE, Some(HOUR)),
            owner(ParkedKind::Write, Some("T1")),
        );
        assert!(s.trip("lab-a", &iso_ms(60_000)).is_none());
        assert_eq!(s.counts_on("lab-a"), ParkedCounts { leads: 0, tasks: 1 });
    }

    #[test]
    fn one_pool_exhausted_pauses_until_usage_resume() {
        let mut s = UsageState::default();
        s.apply(
            &limited(1, 0, "t2", PROXY_400, None),
            owner(ParkedKind::Write, Some("T1")),
        );
        let (event, until) = s.trip("lab-a", &iso_ms(0)).expect("trips on one");
        assert_eq!(
            event.summary,
            "your proxy has no account available for claude-opus-5-5; fleetd paused work on lab-a — check your proxy, then run usage_resume"
        );
        assert_eq!(until, None);
        s.apply(&appended(2, event), None);
        assert_eq!(
            s.gate("lab-a", 24 * HOUR).as_deref(),
            Some(
                "usage: paused until usage_resume (your proxy has no account for claude-opus-5-5)"
            )
        );
        assert!(s.due(24 * HOUR).is_empty(), "no reset to wait for");
        let parked = s.parked_on("lab-a");
        let taken = s.take_in_order(&parked);
        let sent: Vec<Resumed> = taken
            .iter()
            .map(|p| Resumed {
                thread_id: p.thread.thread_id.clone(),
                kind: p.kind.as_str(),
                task_id: p.task_id.clone(),
            })
            .collect();
        let resumed = resumed_event("lab-a", &iso_ms(24 * HOUR), &sent, true, "ada").unwrap();
        assert_eq!(
            resumed.summary,
            "Usage pause on lab-a lifted (usage_resume by ada); sent \"continue\" to 1 parked thread"
        );
        s.apply(&appended(3, resumed), None);
        assert!(s.gate("lab-a", 24 * HOUR).is_none());
    }

    #[test]
    fn a_park_alone_resumes_at_its_reset_without_a_breaker() {
        let mut s = UsageState::default();
        s.apply(
            &limited(1, 0, "t2", USAGE, Some(HOUR)),
            owner(ParkedKind::Write, Some("T1")),
        );
        assert!(s.due(HOUR - 1).is_empty());
        let due = s.due(HOUR);
        assert_eq!(
            (due.len(), due[0].breaker_cleared, due[0].threads.len()),
            (1, false, 1)
        );
        let sent = [Resumed {
            thread_id: "t2".into(),
            kind: "write",
            task_id: Some("T1".into()),
        }];
        let e = resumed_event("lab-a", &iso_ms(HOUR), &sent, false, "reset").unwrap();
        assert_eq!(
            e.summary,
            "Usage limit reset on lab-a; sent \"continue\" to 1 parked thread"
        );
        assert!(resumed_event("lab-a", &iso_ms(HOUR), &[], false, "reset").is_none());
    }

    /// The brake with the hub's and the node's clocks agreeing at `now_ms`.
    fn agreed(limits: &[LoginLimit], braked: bool, now_ms: i64) -> Option<Brake> {
        brake(limits, braked, now_ms, now_ms)
    }

    /// A window as the heartbeat carries it, read at 0 and resetting at `reset_ms`.
    fn window(kind: &str, used: Option<f64>, status: &str, reset_ms: i64) -> LoginLimit {
        serde_json::from_value(json!({
            "limitType": kind, "utilization": used, "resetsAt": iso_ms(reset_ms), "status": status,
            "observedAt": iso_ms(0),
        }))
        .unwrap()
    }

    #[test]
    fn the_soft_brake_pauses_at_90_percent_and_lifts_below_85_or_at_the_reset() {
        let reset = 14 * HOUR;
        let at = |used: f64, braked: bool| {
            agreed(
                &[window("five_hour", Some(used), "allowed", reset)],
                braked,
                0,
            )
        };
        assert_eq!(at(0.89, false), None);
        let paused = at(0.91, false).expect("pauses at 90%");
        assert_eq!(
            paused.text("builder-1"),
            "Paused new agents: 5-hour limit 91% on builder-1 as of Thu 00:00 UTC, resets Thu 14:00 UTC (pauses at 90%, lifts below 85%)"
        );
        assert!(
            at(0.87, true).is_some(),
            "between the two a braked machine stays braked"
        );
        assert_eq!(at(0.84, true), None);
        assert_eq!(
            agreed(
                &[window("five_hour", Some(0.95), "allowed", reset)],
                true,
                reset
            ),
            None,
            "a window past its reset no longer holds anyone"
        );
    }

    #[test]
    fn the_most_used_window_brakes_and_a_warning_counts_only_without_a_figure() {
        let reset = 14 * HOUR;
        let both = [
            window("five_hour", Some(0.92), "allowed", reset),
            window("seven_day", Some(0.97), "allowed_warning", 100 * HOUR),
        ];
        assert_eq!(
            agreed(&both, false, 0).unwrap().text("mbp"),
            "Paused new agents: 7-day limit 97% on mbp as of Thu 00:00 UTC, resets Mon 04:00 UTC (pauses at 90%, lifts below 85%)"
        );
        assert_eq!(
            agreed(
                &[window("seven_day", Some(0.75), "allowed_warning", reset)],
                false,
                0
            ),
            None,
            "claude's own warning level never pauses below 90%"
        );
        let warned = agreed(
            &[window("seven_day_opus", None, "allowed_warning", reset)],
            true,
            0,
        );
        assert_eq!(
            warned.unwrap().text("mbp"),
            "Paused new agents: 7-day Opus limit warning on mbp as of Thu 00:00 UTC, resets Thu 14:00 UTC (pauses at 90%, lifts below 85%)"
        );
        assert_eq!(
            agreed(&[window("five_hour", None, "allowed", reset)], false, 0),
            None
        );
        assert_eq!(
            agreed(&[], true, 0),
            None,
            "API keys and gateways report no windows"
        );
    }

    #[test]
    fn a_reading_older_than_15_minutes_or_of_unknown_age_no_longer_brakes() {
        // A warning with no figure and no reset: only its age can end it.
        let mut warned: LoginLimit = serde_json::from_value(json!({
            "limitType": "seven_day", "status": "allowed_warning", "observedAt": iso_ms(0),
        }))
        .unwrap();
        let fresh = agreed(std::slice::from_ref(&warned), true, BRAKE_STALE_MS);
        assert_eq!(
            fresh.unwrap().text("mbp"),
            "Paused new agents: 7-day limit warning on mbp as of Thu 00:00 UTC (pauses at 90%, lifts below 85%)"
        );
        assert_eq!(
            agreed(std::slice::from_ref(&warned), true, BRAKE_STALE_MS + 1),
            None
        );
        warned.observed_at = None;
        assert_eq!(
            agreed(&[warned], true, 0),
            None,
            "an older node's reading has no age, so it can't hold anyone"
        );
    }

    #[test]
    fn a_reading_with_its_reset_ahead_holds_until_the_reset_however_old() {
        // Braked near the 7-day limit and idle since: the reading stays the last word until the window resets.
        let mut read = window("seven_day", Some(0.95), "allowed", 3 * 24 * HOUR);
        let later = 20 * 60_000;
        assert_eq!(
            agreed(std::slice::from_ref(&read), true, later)
                .unwrap()
                .text("mbp"),
            "Paused new agents: 7-day limit 95% on mbp as of Thu 00:00 UTC, resets Sun 00:00 UTC (pauses at 90%, lifts below 85%)"
        );
        assert_eq!(
            agreed(std::slice::from_ref(&read), true, 3 * 24 * HOUR),
            None
        );
        read.observed_at = None;
        assert_eq!(
            agreed(&[read], true, later).unwrap().text("mbp"),
            "Paused new agents: 7-day limit 95% on mbp, resets Sun 00:00 UTC (pauses at 90%, lifts below 85%)",
            "an older node's reading with a reset holds too, with no time to show"
        );
    }

    #[test]
    fn a_reading_s_age_is_on_the_node_s_clock_whatever_the_hub_s_says() {
        // No reset, so only its age can end it.
        let read: LoginLimit = serde_json::from_value(json!({
            "limitType": "five_hour", "utilization": 0.95, "status": "allowed", "observedAt": iso_ms(0),
        }))
        .unwrap();
        // The node's clock is an hour behind the hub's: a reading it took a minute ago still brakes.
        let behind = brake(std::slice::from_ref(&read), false, HOUR + 60_000, 60_000);
        assert_eq!(
            behind.unwrap().text("mbp"),
            "Paused new agents: 5-hour limit 95% on mbp as of Thu 00:00 UTC (pauses at 90%, lifts below 85%)"
        );
        // An hour ahead: a reading 20 minutes old by its own clock no longer counts, though the hub's clock calls it
        // 40 minutes in the future.
        assert_eq!(brake(&[read], true, 20 * 60_000 - HOUR, 20 * 60_000), None);
    }

    #[test]
    fn a_reset_time_that_does_not_parse_is_left_out_of_the_line() {
        let mut read = window("five_hour", Some(0.95), "allowed", 0);
        read.resets_at = Some("soon".into());
        assert_eq!(
            agreed(&[read], false, 0).unwrap().text("mbp"),
            "Paused new agents: 5-hour limit 95% on mbp as of Thu 00:00 UTC (pauses at 90%, lifts below 85%)"
        );
    }
}
