//! The headline: code builds the facts, `claude -p` (the hub's OneShot, through the `status.headline` prompt) only
//! phrases them. A reply that breaks a Code rule is discarded. The generated line shows only while its facts are
//! the current ones; otherwise the deterministic template shows, tagged as such.
use std::collections::HashMap;

use fleetd_contracts::status::HeadlineFacts;
use sha2::{Digest, Sha256};

pub const MAX_FACTS_BYTES: usize = 2048;
pub const MAX_REPLY_CHARS: usize = 160;
/// Wait this long after the last change before phrasing, but no longer than `MAX_WAIT_MS` after the first.
pub const DEBOUNCE_MS: i64 = 5_000;
pub const MAX_WAIT_MS: i64 = 30_000;
pub const PER_SCOPE_MS: i64 = 60_000;
pub const PER_DAY: u32 = 300;
/// A scope is viewed for this long after its last status_get or status_wait.
pub const VIEWED_MS: i64 = 10 * 60_000;

/// Canonical JSON, trimmed to fit 2 KB by dropping list tails.
pub fn canonical(facts: &HeadlineFacts) -> String {
    let mut f = facts.clone();
    loop {
        let s = serde_json::to_string(&f).unwrap_or_default();
        if s.len() <= MAX_FACTS_BYTES {
            return s;
        }
        if f.risks.pop().is_none() && f.waiting_on.pop().is_none() && f.doing.pop().is_none() {
            return s.chars().take(MAX_FACTS_BYTES).collect();
        }
    }
}

pub fn hash(canonical: &str) -> Vec<u8> {
    Sha256::digest(canonical.as_bytes()).to_vec()
}

/// `{doing joined | "nothing running"}{; waiting on …}. {needs you}.` The stale clause is prepended by the caller.
pub fn template(f: &HeadlineFacts) -> String {
    let doing = if f.doing.is_empty() {
        "Nothing running".to_owned()
    } else {
        let mut d = f
            .doing
            .iter()
            .take(2)
            .cloned()
            .collect::<Vec<_>>()
            .join(" and ");
        if let Some(first) = d.get(..1) {
            d = first.to_uppercase() + &d[1..];
        }
        d
    };
    let waiting = f
        .waiting_on
        .first()
        .map(|w| format!("; waiting on {w}"))
        .unwrap_or_default();
    let needs = match (f.needs_you, &f.first_ask) {
        (0, _) => "Nothing needs you".to_owned(),
        (1, Some(key)) => format!("1 needs you: {key}"),
        (n, _) => format!("{n} need you"),
    };
    format!("{doing}{waiting}. {needs}.")
}

/// The Code rules: one line of at most 160 characters, no quotes or preamble, and every digit run it contains
/// appears in the facts.
pub fn check_reply(reply: &str, facts_json: &str) -> Result<String, &'static str> {
    let line = reply.trim();
    if line.is_empty() {
        return Err("empty reply");
    }
    if line.contains('\n') {
        return Err("more than one line");
    }
    if line.chars().count() > MAX_REPLY_CHARS {
        return Err("longer than 160 characters");
    }
    if line.starts_with(['"', '\'', '`', '“'])
        || line.to_lowercase().starts_with("headline")
        || line.starts_with("Here")
    {
        return Err("quotes or a preamble");
    }
    let allowed: std::collections::HashSet<&str> = digit_runs(facts_json).collect();
    if digit_runs(line).any(|n| !allowed.contains(n)) {
        return Err("a number not in the facts");
    }
    Ok(line.to_owned())
}

/// Every maximal run of ASCII digits: "Thu 14:00, 72%" gives "14", "00", "72".
fn digit_runs(s: &str) -> impl Iterator<Item = &str> {
    s.split(|c: char| !c.is_ascii_digit())
        .filter(|r| !r.is_empty())
}

/// A scope whose facts changed and wants phrasing.
#[derive(Clone, Debug)]
struct Want {
    facts: String,
    hash: Vec<u8>,
    first_ms: i64,
    last_ms: i64,
}

/// When each scope may run next and the hub-wide budget. One run in flight at a time; the latest facts win.
#[derive(Default)]
pub struct Scheduler {
    wants: HashMap<String, Want>,
    last_run_ms: HashMap<String, i64>,
    day: i64,
    runs_today: u32,
    pub in_flight: bool,
}

pub enum Due {
    /// Run this scope's facts now.
    Run {
        scope: String,
        facts: String,
        hash: Vec<u8>,
    },
    /// Nothing due before this time.
    At(i64),
    Idle,
}

impl Scheduler {
    /// Facts for `scope` changed (or still differ from what was generated).
    pub fn want(&mut self, scope: &str, facts: String, hash: Vec<u8>, now: i64) {
        match self.wants.get_mut(scope) {
            Some(w) if w.hash == hash => {}
            Some(w) => {
                w.facts = facts;
                w.hash = hash;
                w.last_ms = now;
            }
            None => {
                self.wants.insert(
                    scope.to_owned(),
                    Want {
                        facts,
                        hash,
                        first_ms: now,
                        last_ms: now,
                    },
                );
            }
        }
    }

    /// The generated line is current again; nothing to do for the scope.
    pub fn settled(&mut self, scope: &str) {
        self.wants.remove(scope);
    }

    pub fn daily_limit_hit(&self, now: i64) -> bool {
        now.div_euclid(86_400_000) == self.day && self.runs_today >= PER_DAY
    }

    pub fn next(&mut self, now: i64) -> Due {
        let today = now.div_euclid(86_400_000);
        if today != self.day {
            self.day = today;
            self.runs_today = 0;
        }
        if self.in_flight || self.wants.is_empty() || self.runs_today >= PER_DAY {
            return Due::Idle;
        }
        let mut earliest: Option<(i64, String)> = None;
        for (scope, w) in &self.wants {
            let settle = (w.last_ms + DEBOUNCE_MS).min(w.first_ms + MAX_WAIT_MS);
            let budget = self
                .last_run_ms
                .get(scope)
                .map_or(i64::MIN, |t| t + PER_SCOPE_MS);
            let at = settle.max(budget);
            if earliest.as_ref().is_none_or(|(e, _)| at < *e) {
                earliest = Some((at, scope.clone()));
            }
        }
        let Some((at, scope)) = earliest else {
            return Due::Idle;
        };
        if at > now {
            return Due::At(at);
        }
        let w = self.wants.remove(&scope).expect("chosen from wants");
        self.in_flight = true;
        self.runs_today += 1;
        self.last_run_ms.insert(scope.clone(), now);
        Due::Run {
            scope,
            facts: w.facts,
            hash: w.hash,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> HeadlineFacts {
        HeadlineFacts {
            scope: "project fleetd".into(),
            pct: 72,
            was: Some(80),
            doing: vec!["switching to the new runner".into()],
            waiting_on: vec!["the full lab run".into()],
            ..Default::default()
        }
    }

    #[test]
    fn the_template_says_what_runs_what_waits_and_who_is_needed() {
        assert_eq!(
            template(&facts()),
            "Switching to the new runner; waiting on the full lab run. Nothing needs you."
        );
        let f = HeadlineFacts {
            needs_you: 1,
            first_ask: Some("api.path".into()),
            ..Default::default()
        };
        assert_eq!(template(&f), "Nothing running. 1 needs you: api.path.");
        let f = HeadlineFacts {
            needs_you: 3,
            ..Default::default()
        };
        assert_eq!(template(&f), "Nothing running. 3 need you.");
    }

    #[test]
    fn replies_must_keep_to_one_line_and_the_facts_numbers() {
        let json = canonical(&facts());
        assert_eq!(
            check_reply(
                " Switching runners at 72%, waiting on the lab run. Nothing needs you.\n",
                &json
            )
            .unwrap(),
            "Switching runners at 72%, waiting on the lab run. Nothing needs you."
        );
        assert_eq!(
            check_reply("At 73%, almost there.", &json),
            Err("a number not in the facts")
        );
        assert_eq!(check_reply("one\ntwo", &json), Err("more than one line"));
        assert_eq!(
            check_reply("\"Quoted.\"", &json),
            Err("quotes or a preamble")
        );
        assert!(check_reply(&"a".repeat(161), &json).is_err());
    }

    #[test]
    fn runs_are_debounced_bounded_per_scope_and_one_at_a_time() {
        let mut s = Scheduler::default();
        s.want("fleet", "{}".into(), vec![1], 0);
        assert!(matches!(s.next(1_000), Due::At(5_000)));
        s.want("fleet", "{1}".into(), vec![2], 4_000);
        assert!(
            matches!(s.next(5_000), Due::At(9_000)),
            "debounced from the last change"
        );
        for t in (8_000..30_000).step_by(4_000) {
            s.want("fleet", format!("{{{t}}}"), vec![t as u8], t);
        }
        assert!(
            matches!(s.next(30_000), Due::Run { .. }),
            "at most 30 s after the first change"
        );
        s.want("fleet", "{x}".into(), vec![9], 31_000);
        assert!(matches!(s.next(40_000), Due::Idle), "one in flight");
        s.in_flight = false;
        assert!(
            matches!(s.next(40_000), Due::At(90_000)),
            "one run per scope per minute"
        );
        assert!(matches!(s.next(90_000), Due::Run { .. }));
    }
}
