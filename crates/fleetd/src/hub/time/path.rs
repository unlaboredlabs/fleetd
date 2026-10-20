//! The critical path of an order: a backward last-finisher walk over the order's lanes, cut into exclusive tiles
//! (spec §5). Deterministic: no clock, no randomness; the same input gives the same path.
use std::collections::BTreeMap;

use fleetd_contracts::prim::{Count, List, Text};
use fleetd_contracts::time::{
    Category, CategoryMs, CriticalPath, KindTotal, PathSegment, SpanKind,
};

use super::model::{PathInput, Row, is_detail, rank};
use crate::tiles::{Claim, tile};

/// The most segments a path returns; the totals still cover every one.
pub const MAX_SEGMENTS: usize = 400;

/// One exclusive piece of one lane.
#[derive(Clone, Debug)]
struct Piece {
    start: i64,
    end: i64,
    span_id: i64,
    kind: SpanKind,
    cat: Category,
    label: Option<String>,
}

/// Rows the walk may step on: leaves, plus `run` envelopes whose uncovered time is `claude.other`.
fn steps_on(row: &Row) -> bool {
    row.kind == SpanKind::Run || !(is_detail(row.kind) || row.kind == SpanKind::Idle)
}

/// Cuts one lane's rows into exclusive pieces, oldest first. A run envelope ranks below every leaf, so it owns
/// only the run's time no leaf covers, which becomes `claude.other`.
fn lane_pieces(rows: &[&Row]) -> Vec<Piece> {
    let Some(base) = rows.iter().map(|r| r.start_ms).min() else {
        return Vec::new();
    };
    let to = rows.iter().map(|r| r.end_ms).max().unwrap_or(base);
    let off = |ms: i64| (ms - base).max(0) as u64;
    let claims: Vec<Claim> = rows
        .iter()
        .map(|r| Claim {
            start: off(r.start_ms),
            end: off(r.end_ms),
            rank: if r.kind == SpanKind::Run {
                0
            } else {
                rank(r.kind).max(1)
            },
        })
        .collect();
    tile(&claims, 0, off(to))
        .into_iter()
        .filter_map(|t| {
            let row = rows[t.owner?];
            let kind = if row.kind == SpanKind::Run {
                SpanKind::ClaudeOther
            } else {
                row.kind
            };
            Some(Piece {
                start: base + t.start as i64,
                end: base + t.end as i64,
                span_id: row.id,
                kind,
                cat: kind.category(),
                label: row.label.clone(),
            })
        })
        .collect()
}

/// The order's critical path from `input.end_ms` back to `input.start_ms`. Its segments add up to the order's wall
/// time exactly; time with nothing running becomes a `gap` segment (`nothing_running_ms`).
pub fn critical_path(input: &PathInput) -> CriticalPath {
    let (start, end) = (input.start_ms, input.end_ms.max(input.start_ms));
    let mut by_lane: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for row in input
        .rows
        .iter()
        .filter(|r| steps_on(r) && r.end_ms > r.start_ms)
    {
        by_lane.entry(row.lane.as_str()).or_default().push(row);
    }
    // Pieces in a lane never overlap, so their starts and ends both ascend: one binary search per lane finds the
    // lane's last finisher before `t`.
    let lanes: Vec<(&str, Vec<Piece>)> = by_lane
        .into_iter()
        .map(|(lane, rows)| (lane, lane_pieces(&rows)))
        .filter(|(_, p)| !p.is_empty())
        .collect();

    // (lane index or None for a gap, piece, start, end), newest first while walking.
    let mut walked: Vec<(Option<usize>, Option<Piece>, i64, i64)> = Vec::new();
    let mut t = end;
    let mut current: Option<usize> = None;
    while t > start {
        let mut best: Option<(i64, usize, usize)> = None; // (min(end, t), lane, piece)
        for (li, (lane, pieces)) in lanes.iter().enumerate() {
            let k = pieces.partition_point(|p| p.start < t);
            if k == 0 {
                continue;
            }
            let piece = &pieces[k - 1];
            let reach = piece.end.min(t);
            let better = match best {
                None => true,
                Some((br, bl, bk)) => {
                    let other = &lanes[bl].1[bk];
                    if reach != br {
                        reach > br
                    } else {
                        let causal = |l: &str| {
                            current.is_some_and(|c| {
                                input
                                    .waits_on
                                    .get(lanes[c].0)
                                    .is_some_and(|w| w.iter().any(|x| x == l))
                            })
                        };
                        let key = |p: &Piece, l: &str| (!causal(l), p.cat.path_rank(), p.span_id);
                        key(piece, lane) < key(other, lanes[bl].0)
                    }
                }
            };
            if better {
                best = Some((reach, li, k - 1));
            }
        }
        let Some((reach, li, k)) = best.filter(|(reach, ..)| *reach > start) else {
            walked.push((None, None, start, t));
            break;
        };
        if reach < t {
            walked.push((None, None, reach, t));
        }
        let piece = lanes[li].1[k].clone();
        let seg_start = piece.start.max(start);
        walked.push((Some(li), Some(piece.clone()), seg_start, reach));
        current = Some(li);
        t = piece.start;
    }
    walked.reverse();

    type ByKind = BTreeMap<SpanKind, (i64, i64)>;
    let mut totals: BTreeMap<Category, (i64, ByKind)> = BTreeMap::new();
    let mut nothing_running = 0;
    let mut segments: Vec<PathSegment> = Vec::new();
    for (li, piece, s, e) in &walked {
        let ms = e - s;
        let segment = match (li, piece) {
            (Some(li), Some(p)) => PathSegment {
                span_id: Some(Count::unchecked(p.span_id)),
                lane: Text::unchecked(lanes[*li].0),
                kind: p.kind,
                cat: p.cat,
                start_ms: Count::unchecked(*s),
                end_ms: Count::unchecked(*e),
                label: p.label.as_deref().map(|l| Text::unchecked(clip(l, 500))),
            },
            _ => {
                nothing_running += ms;
                PathSegment {
                    span_id: None,
                    lane: Text::unchecked("none"),
                    kind: SpanKind::Gap,
                    cat: Category::Idle,
                    start_ms: Count::unchecked(*s),
                    end_ms: Count::unchecked(*e),
                    label: None,
                }
            }
        };
        let t = totals.entry(segment.cat).or_default();
        t.0 += ms;
        let k = t.1.entry(segment.kind).or_default();
        k.0 += ms;
        // Adjacent pieces of the same lane, kind and label are one step of the path (tiles of one span).
        match segments.last_mut() {
            Some(last)
                if last.lane == segment.lane
                    && last.kind == segment.kind
                    && last.label == segment.label
                    && last.end_ms == segment.start_ms =>
            {
                last.end_ms = segment.end_ms;
            }
            _ => {
                k.1 += 1;
                segments.push(segment);
            }
        }
    }
    let on_path = (end - start) - nothing_running;
    let agent: i64 = input
        .rows
        .iter()
        .filter(|r| !is_detail(r.kind))
        .map(|r| r.excl_ms)
        .sum();
    CriticalPath {
        start_ms: Count::unchecked(start),
        end_ms: Count::unchecked(end),
        // Every segment: what is stored and what the rules read. `for_output` cuts it for the wire.
        segments: List::unchecked(segments),
        segments_truncated: false,
        totals: List::unchecked(
            Category::ALL
                .iter()
                .filter_map(|c| {
                    let (ms, kinds) = totals.get(c)?;
                    (*ms > 0).then(|| CategoryMs {
                        cat: *c,
                        ms: Count::unchecked(*ms),
                        kinds: Some(List::unchecked(
                            kinds
                                .iter()
                                .map(|(kind, (ms, n))| KindTotal {
                                    kind: *kind,
                                    ms: Count::unchecked(*ms),
                                    n: Count::unchecked(*n),
                                })
                                .collect(),
                        )),
                    })
                })
                .collect(),
        ),
        nothing_running_ms: Count::unchecked(nothing_running),
        off_path_ms: Count::unchecked((agent - on_path).max(0)),
    }
}

/// The path as a tool returns it: at most [`MAX_SEGMENTS`] segments, the longest ones in time order, so the stages
/// that took the time survive whatever their position. Totals are unchanged and still cover every segment.
pub fn for_output(path: &CriticalPath) -> CriticalPath {
    let mut out = path.clone();
    if path.segments.len() <= MAX_SEGMENTS {
        return out;
    }
    let mut keep: Vec<&PathSegment> = path.segments.iter().collect();
    keep.sort_by_key(|s| {
        (
            std::cmp::Reverse(s.end_ms.get() - s.start_ms.get()),
            s.start_ms.get(),
        )
    });
    keep.truncate(MAX_SEGMENTS);
    keep.sort_by_key(|s| s.start_ms.get());
    out.segments = List::unchecked(keep.into_iter().cloned().collect());
    out.segments_truncated = true;
    out
}

/// A stored path: the same JSON as [`CriticalPath`], read back without the wire's segment bound.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    start_ms: Count,
    end_ms: Count,
    segments: Vec<PathSegment>,
    totals: Vec<CategoryMs>,
    nothing_running_ms: Count,
    off_path_ms: Count,
}

pub fn decode_stored(json: &str) -> Option<CriticalPath> {
    let s: Stored = serde_json::from_str(json).ok()?;
    Some(CriticalPath {
        start_ms: s.start_ms,
        end_ms: s.end_ms,
        segments: List::unchecked(s.segments),
        segments_truncated: false,
        totals: List::unchecked(s.totals),
        nothing_running_ms: s.nothing_running_ms,
        off_path_ms: s.off_path_ms,
    })
}

fn clip(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    for c in s.chars() {
        n += c.len_utf16();
        if n > max {
            break;
        }
        out.push(c);
    }
    out
}
