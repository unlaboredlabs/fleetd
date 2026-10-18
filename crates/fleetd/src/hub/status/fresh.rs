//! Which status sources are live. A source is touched on every good answer (`touch`) and told of failures
//! (`fail`, which keeps the reason but flips nothing). Staleness is decided only here, by deadlines: a source with a
//! cadence is stale once `asOf + stale_after` passes untouched. The status task sleeps until [`Fresh::next_deadline`]
//! and calls [`Fresh::check`]; nothing polls.
use std::collections::BTreeMap;
use std::sync::Mutex;

use tokio::sync::Notify;

/// GitHub answers for a repo, from any `gh api` call (`FLEETD_STATUS_GITHUB_STALE_SEC`).
pub const GITHUB_STALE_MS: i64 = 180_000;
/// The end of a train pass for a repo.
pub const TRAIN_STALE_MS: i64 = 120_000;
/// A `missed_webhook` drift keeps the webhook source stale this long.
pub const WEBHOOK_STALE_MS: i64 = 30 * 60_000;

pub fn github_stale_ms() -> i64 {
    std::env::var("FLEETD_STATUS_GITHUB_STALE_SEC")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|s| *s > 0)
        .map_or(GITHUB_STALE_MS, |s| s * 1000)
}

pub fn github(repo: &str) -> String {
    format!("github:{repo}")
}
pub fn train(repo: &str) -> String {
    format!("train:{repo}")
}
pub fn webhook(repo: &str) -> String {
    format!("webhook:{repo}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stale {
    pub since_ms: i64,
    pub reason: String,
}

#[derive(Clone, Debug)]
struct Source {
    stale_after_ms: i64,
    /// The last good answer; absent until the first one since the hub started.
    as_of_ms: Option<i64>,
    /// When the source was first expected, for "not checked since the hub started".
    expected_ms: i64,
    last_error: Option<String>,
    stale: Option<Stale>,
    /// Held stale until then regardless of touches (webhook drift).
    held_until_ms: Option<i64>,
}

/// A source's state as the view shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceView {
    pub as_of_ms: Option<i64>,
    pub stale: Option<Stale>,
}

/// A flip the status task turns into `source.stale` / `source.fresh`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Flip {
    Stale {
        source: String,
        since_ms: i64,
        reason: String,
    },
    Fresh {
        source: String,
        stale_ms: i64,
    },
}

#[derive(Default)]
pub struct Fresh {
    sources: Mutex<BTreeMap<String, Source>>,
    /// Flips to fresh, made by `touch`, waiting for the status task.
    pending: Mutex<Vec<Flip>>,
    /// Fired when a source turns fresh or a new deadline is earlier than the task's sleep.
    pub notify: Notify,
}

fn age_text(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    match s {
        0..60 => format!("{s}s"),
        60..3600 => format!("{}m", s / 60),
        _ => format!("{}h{:02}m", s / 3600, s % 3600 / 60),
    }
}

impl Fresh {
    /// Registers a source with its cadence. Until its first touch it reads stale: "not checked since the hub started".
    pub fn expect(&self, source: &str, stale_after_ms: i64, now_ms: i64) {
        let mut sources = self.sources.lock().unwrap();
        let fresh = !sources.contains_key(source);
        let entry = sources.entry(source.to_owned()).or_insert(Source {
            stale_after_ms,
            as_of_ms: None,
            expected_ms: now_ms,
            last_error: None,
            stale: None,
            held_until_ms: None,
        });
        entry.stale_after_ms = stale_after_ms;
        drop(sources);
        if fresh {
            self.notify.notify_one();
        }
    }

    /// Stops tracking a source (its repo left the train).
    pub fn forget(&self, source: &str) {
        self.sources.lock().unwrap().remove(source);
    }

    /// A good answer at `at_ms`. A stale source turns fresh at once and the status task is woken.
    pub fn touch(&self, source: &str, at_ms: i64) {
        let mut sources = self.sources.lock().unwrap();
        let Some(s) = sources.get_mut(source) else {
            return;
        };
        let first = s.as_of_ms.is_none();
        s.as_of_ms = Some(s.as_of_ms.map_or(at_ms, |a| a.max(at_ms)));
        s.last_error = None;
        if first {
            // "Not checked since the hub started" ends here: a flip like any other, so docs re-render.
            self.pending.lock().unwrap().push(Flip::Fresh {
                source: source.to_owned(),
                stale_ms: (at_ms - s.expected_ms).max(0),
            });
            drop(sources);
            self.notify.notify_one();
            return;
        }
        if s.held_until_ms.is_some_and(|h| at_ms < h) {
            return;
        }
        s.held_until_ms = None;
        if let Some(stale) = s.stale.take() {
            self.pending.lock().unwrap().push(Flip::Fresh {
                source: source.to_owned(),
                stale_ms: at_ms - stale.since_ms,
            });
            drop(sources);
            self.notify.notify_one();
        }
    }

    /// A failed call: the reason shows once the source goes stale. Flips nothing by itself.
    pub fn fail(&self, source: &str, reason: &str) {
        if let Some(s) = self.sources.lock().unwrap().get_mut(source) {
            s.last_error = Some(reason.chars().take(160).collect());
        }
    }

    /// Holds a source stale until `until_ms` with `reason` (a missed webhook), touched or not.
    pub fn hold_stale(&self, source: &str, reason: &str, now_ms: i64, until_ms: i64) {
        let mut sources = self.sources.lock().unwrap();
        let Some(s) = sources.get_mut(source) else {
            return;
        };
        s.held_until_ms = Some(until_ms);
        if s.stale.is_none() {
            s.stale = Some(Stale {
                since_ms: now_ms,
                reason: reason.to_owned(),
            });
            self.pending.lock().unwrap().push(Flip::Stale {
                source: source.to_owned(),
                since_ms: now_ms,
                reason: reason.to_owned(),
            });
        }
        drop(sources);
        self.notify.notify_one();
    }

    /// The earliest moment a source could flip stale (or a hold ends); the status task sleeps until it.
    pub fn next_deadline(&self) -> Option<i64> {
        let sources = self.sources.lock().unwrap();
        sources
            .values()
            .filter_map(|s| match (&s.stale, s.held_until_ms) {
                (Some(_), Some(held)) => Some(held),
                (Some(_), None) => None,
                (None, _) => s.as_of_ms.map(|a| a + s.stale_after_ms),
            })
            .min()
    }

    /// Flips every source whose deadline passed; returns those flips plus the fresh flips `touch` made since the last
    /// call. A source touched since its deadline was computed is simply not due.
    pub fn check(&self, now_ms: i64) -> Vec<Flip> {
        let mut flips = std::mem::take(&mut *self.pending.lock().unwrap());
        let mut sources = self.sources.lock().unwrap();
        for (name, s) in sources.iter_mut() {
            if let Some(held) = s.held_until_ms
                && now_ms >= held
            {
                s.held_until_ms = None;
                if s.as_of_ms.is_some_and(|a| now_ms - a <= s.stale_after_ms)
                    && let Some(stale) = s.stale.take()
                {
                    flips.push(Flip::Fresh {
                        source: name.clone(),
                        stale_ms: now_ms - stale.since_ms,
                    });
                }
                continue;
            }
            let Some(as_of) = s.as_of_ms else { continue };
            if s.stale.is_some() || now_ms - as_of <= s.stale_after_ms {
                continue;
            }
            let reason = reason_for(name, now_ms - as_of, s.last_error.as_deref());
            s.stale = Some(Stale {
                since_ms: as_of,
                reason: reason.clone(),
            });
            flips.push(Flip::Stale {
                source: name.clone(),
                since_ms: as_of,
                reason,
            });
        }
        flips
    }

    pub fn view(&self, source: &str, now_ms: i64) -> Option<SourceView> {
        let sources = self.sources.lock().unwrap();
        let s = sources.get(source)?;
        let stale = match (&s.stale, s.as_of_ms) {
            (Some(stale), _) => Some(Stale {
                since_ms: stale.since_ms,
                // The age in the reason grows with time; recompute it so it is never stale itself.
                reason: match s.as_of_ms {
                    Some(a) if s.held_until_ms.is_none() => {
                        reason_for(source, now_ms - a, s.last_error.as_deref())
                    }
                    _ => stale.reason.clone(),
                },
            }),
            (None, None) => Some(Stale {
                since_ms: s.expected_ms,
                reason: "not checked since the hub started".into(),
            }),
            (None, Some(_)) => None,
        };
        Some(SourceView {
            as_of_ms: s.as_of_ms,
            stale,
        })
    }

    /// Every stale source, with its reason, oldest first.
    pub fn stale_sources(&self, now_ms: i64) -> Vec<(String, Stale)> {
        let names: Vec<String> = self.sources.lock().unwrap().keys().cloned().collect();
        let mut out: Vec<(String, Stale)> = names
            .into_iter()
            .filter_map(|n| {
                let stale = self.view(&n, now_ms)?.stale?;
                Some((n, stale))
            })
            .collect();
        out.sort_by_key(|(_, s)| s.since_ms);
        out
    }
}

fn reason_for(source: &str, age_ms: i64, last_error: Option<&str>) -> String {
    let age = age_text(age_ms);
    let (kind, name) = source.split_once(':').unwrap_or((source, ""));
    match kind {
        "github" => match last_error {
            Some(e) => format!("GitHub not reached for {age}: {e}"),
            None => format!("GitHub not reached for {age}"),
        },
        "train" => format!("the {name} train hasn't run for {age}"),
        _ => format!("{source} silent for {age}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_flips_stale_at_its_deadline_and_fresh_on_touch() {
        let f = Fresh::default();
        f.expect("github:acme/storefront", 180_000, 0);
        assert_eq!(
            f.view("github:acme/storefront", 1_000)
                .unwrap()
                .stale
                .unwrap()
                .reason,
            "not checked since the hub started"
        );
        assert_eq!(
            f.next_deadline(),
            None,
            "no deadline before the first answer"
        );
        f.touch("github:acme/storefront", 10_000);
        assert_eq!(
            f.check(10_000),
            vec![Flip::Fresh {
                source: "github:acme/storefront".into(),
                stale_ms: 10_000
            }],
            "the first answer after a start turns the source live"
        );
        assert_eq!(f.next_deadline(), Some(190_000));
        assert!(f.check(190_000).is_empty(), "due only past the deadline");
        f.touch("github:acme/storefront", 100_000);
        assert!(f.check(190_001).is_empty(), "touched since: not due");
        f.fail(
            "github:acme/storefront",
            "gh: connect: network is unreachable",
        );
        let flips = f.check(280_001);
        assert_eq!(flips.len(), 1);
        let Flip::Stale {
            since_ms, reason, ..
        } = &flips[0]
        else {
            panic!()
        };
        assert_eq!(*since_ms, 100_000, "since the last good answer");
        assert!(reason.contains("unreachable"), "{reason}");
        assert!(f.check(400_000).is_empty(), "flips once");
        assert_eq!(f.next_deadline(), None);
        f.touch("github:acme/storefront", 400_000);
        assert_eq!(
            f.check(400_000),
            vec![Flip::Fresh {
                source: "github:acme/storefront".into(),
                stale_ms: 300_000
            }]
        );
        assert!(
            f.view("github:acme/storefront", 400_000)
                .unwrap()
                .stale
                .is_none()
        );
    }

    #[test]
    fn a_hold_keeps_a_touched_source_stale_until_it_ends() {
        let f = Fresh::default();
        f.expect("webhook:acme/storefront", 600_000, 0);
        f.touch("webhook:acme/storefront", 0);
        f.check(0);
        f.hold_stale(
            "webhook:acme/storefront",
            "webhooks missed 1 change",
            10,
            1_000,
        );
        assert!(matches!(f.check(10)[0], Flip::Stale { .. }));
        f.touch("webhook:acme/storefront", 500);
        assert!(f.check(500).is_empty());
        assert_eq!(f.next_deadline(), Some(1_000));
        assert!(matches!(f.check(1_000)[0], Flip::Fresh { .. }));
    }
}
