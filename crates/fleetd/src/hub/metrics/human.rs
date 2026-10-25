//! The person's minutes from their touches, pure. Each touch is credited the least time its act could take (the
//! floors below, listed on the view's info sheet), as the interval before it was recorded. Touches less than
//! [`BRIDGE_MS`] apart join into one session, since someone answering three minutes after their last answer was most
//! likely there all along, and the minutes are the union of the sessions, so overlapping acts count once. The low
//! bound is the union of the credits alone, with no bridging. Both are computed the same way every time, so a trend
//! is honest even where the level is a little off.
use std::collections::BTreeSet;

use fleetd_contracts::metrics::{HumanSource, TouchKind};

use super::store::TouchRow;

pub const MINUTE_MS: i64 = 60_000;
/// Touches closer than this join one session; the gap between them counts.
pub const BRIDGE_MS: i64 = 5 * MINUTE_MS;
/// Typing speed for a message's or an order's floor: about 30 words a minute.
pub const CHARS_PER_MINUTE: i64 = 150;
/// A chat message or an order: at least a minute, more for a long one.
pub const TYPED_MIN_MS: i64 = MINUTE_MS;
/// A command approval or a secret answered inline.
pub const ITEM_MS: i64 = 30_000;
pub const STEER_MS: i64 = MINUTE_MS;
pub const DECISION_MS: i64 = MINUTE_MS;
/// A review on the git host: 3 minutes, a minute more per 100 changed lines, at most 20. Estimated: hosts keep
/// when a review was sent, not how long it took.
pub const REVIEW_BASE_MS: i64 = 3 * MINUTE_MS;
pub const REVIEW_PER_100_LINES_MS: i64 = MINUTE_MS;
pub const REVIEW_MAX_MS: i64 = 20 * MINUTE_MS;
/// A review comment or PR comment on the git host.
pub const COMMENT_MS: i64 = 30_000;
pub const MERGE_BY_HAND_MS: i64 = MINUTE_MS;
pub const COMMIT_MS: i64 = 2 * MINUTE_MS;
/// A fleetd call from the person's own Claude Code session.
pub const SESSION_CALL_MS: i64 = MINUTE_MS;

/// The floor of a typed message or order of `chars` characters.
pub fn typed_ms(chars: usize) -> i64 {
    (chars as i64 * MINUTE_MS / CHARS_PER_MINUTE).max(TYPED_MIN_MS)
}

/// The estimated credit of a review of a PR with `lines` changed (3 minutes when the host didn't say).
pub fn review_ms(lines: Option<i64>) -> i64 {
    (REVIEW_BASE_MS + lines.unwrap_or(0).max(0) / 100 * REVIEW_PER_100_LINES_MS).min(REVIEW_MAX_MS)
}

/// The credit of a kind whose credit doesn't depend on the act; `None` for typed acts, reviews and app use.
pub fn fixed_ms(kind: TouchKind) -> Option<i64> {
    Some(match kind {
        TouchKind::ItemAnswered => ITEM_MS,
        TouchKind::Steer => STEER_MS,
        TouchKind::Decision => DECISION_MS,
        TouchKind::Comment => COMMENT_MS,
        TouchKind::MergeByHand => MERGE_BY_HAND_MS,
        TouchKind::Commit => COMMIT_MS,
        TouchKind::SessionCall => SESSION_CALL_MS,
        _ => return None,
    })
}

/// The person's own logins and emails on the git host, lowercased. A repo can be shared, so a review, comment or
/// merge counts as the person's only when it was made by one of these; with none known, none does.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Identities(BTreeSet<String>);

impl Identities {
    /// From logins and emails. A GitHub noreply email (`12345+login@users.noreply.github.com`) names its login too.
    pub fn new<S: AsRef<str>>(ids: impl IntoIterator<Item = S>) -> Self {
        let mut out = BTreeSet::new();
        for id in ids {
            let id = id.as_ref().trim().to_lowercase();
            if id.is_empty() {
                continue;
            }
            if let Some(local) = id.strip_suffix("@users.noreply.github.com") {
                let login = local.split_once('+').map_or(local, |(_, l)| l);
                out.insert(login.to_owned());
            }
            out.insert(id);
        }
        Identities(out)
    }

    pub fn has(&self, who: &str) -> bool {
        self.0.contains(&who.trim().to_lowercase())
    }
}

/// Whether a touch is the person's own. Acts on fleetd's surfaces are, as they were made with the person's keys.
/// One read from the git host (a review, a comment, a merge by hand, a commit) is only when its account is one of
/// the person's identities; any other is unattributed and left out of the minutes.
pub fn attributed(t: &TouchRow, ids: &Identities) -> bool {
    let on_host = matches!(
        TouchKind::parse(&t.kind),
        Some(TouchKind::Review | TouchKind::Comment | TouchKind::MergeByHand | TouchKind::Commit)
    );
    !on_host || t.key_id.as_deref().is_some_and(|who| ids.has(who))
}

/// One touch's interval, cut to a range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: i64,
    pub end: i64,
    pub source: HumanSource,
}

/// A touch's interval: the credit before it was recorded, or an observed interval as it is.
pub fn span(t: &TouchRow) -> Span {
    let source = TouchKind::parse(&t.kind)
        .unwrap_or(TouchKind::Unknown)
        .source();
    match t.end_ms {
        Some(end) => Span {
            start: t.at_ms,
            end: end.max(t.at_ms),
            source,
        },
        None => Span {
            start: t.at_ms - t.credit_ms.max(0),
            end: t.at_ms,
            source,
        },
    }
}

/// Spans cut to `[since, until)`; those left empty go.
pub fn clip(spans: impl IntoIterator<Item = Span>, since: i64, until: i64) -> Vec<Span> {
    spans
        .into_iter()
        .map(|s| Span {
            start: s.start.max(since),
            end: s.end.min(until),
            ..s
        })
        .filter(|s| s.end > s.start)
        .collect()
}

/// The time spans add to the union, each credited to the source of the touch that added it: a bridged gap goes to
/// the touch after it. Their lengths sum to the union of the sessions.
pub fn sessions(spans: &[Span], bridge_ms: i64) -> Vec<Span> {
    let mut sorted = spans.to_vec();
    sorted.sort_by_key(|s| (s.start, s.end));
    let mut out = Vec::new();
    let mut end: Option<i64> = None;
    for s in sorted {
        match end {
            Some(e) if s.start - e < bridge_ms || s.start < e => {
                if s.end > e {
                    out.push(Span { start: e, ..s });
                    end = Some(s.end);
                }
            }
            _ => {
                out.push(s);
                end = Some(s.end);
            }
        }
    }
    out
}

pub fn total(pieces: &[Span]) -> i64 {
    pieces.iter().map(|p| p.end - p.start).sum()
}

/// The estimate and the low bound over the same spans.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Minutes {
    pub total_ms: i64,
    pub low_ms: i64,
}

pub fn minutes(spans: &[Span]) -> Minutes {
    Minutes {
        total_ms: total(&sessions(spans, BRIDGE_MS)),
        low_ms: total(&sessions(spans, 0)),
    }
}

/// The part of `pieces` inside `[from, to)`.
pub fn within(pieces: &[Span], from: i64, to: i64) -> i64 {
    pieces
        .iter()
        .map(|p| (p.end.min(to) - p.start.max(from)).max(0))
        .sum()
}
