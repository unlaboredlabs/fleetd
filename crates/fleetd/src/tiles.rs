//! Exclusive time: which interval owns each instant of a lane. The node uses it to give a run's spans their
//! exclusive time and fill the rest with `claude.other`; the hub uses the same rule to cut lanes into tiles for the
//! critical path. One rule in both places, so the numbers agree.

/// An interval that competes for the instants it covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Claim {
    pub start: u64,
    pub end: u64,
    /// The higher rank owns an instant; on a tie the later start (the inner span), then the later claim.
    pub rank: u8,
}

/// One piece of the cut: `owner` is the index of the winning claim, `None` where no claim covers `[start, end)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tile {
    pub owner: Option<usize>,
    pub start: u64,
    pub end: u64,
}

/// Cuts `[from, to)` into tiles, adjacent pieces with the same owner merged. The tiles cover `[from, to)` exactly,
/// so their lengths add up to `to - from`. Claims are clamped to the window; empty ones own nothing.
pub fn tile(claims: &[Claim], from: u64, to: u64) -> Vec<Tile> {
    if to <= from {
        return Vec::new();
    }
    // (time, is_start, index): ends sort before starts at the same instant, so a claim ending at t owns nothing at t.
    let mut edges: Vec<(u64, bool, usize)> = Vec::with_capacity(claims.len() * 2);
    for (i, c) in claims.iter().enumerate() {
        let (s, e) = (c.start.max(from), c.end.min(to));
        if s < e {
            edges.push((s, true, i));
            edges.push((e, false, i));
        }
    }
    edges.sort_unstable();
    let better = |a: usize, b: usize| {
        let (ca, cb) = (&claims[a], &claims[b]);
        (ca.rank, ca.start.max(from), a) > (cb.rank, cb.start.max(from), b)
    };
    let mut active: Vec<usize> = Vec::new();
    let mut out: Vec<Tile> = Vec::new();
    let mut at = from;
    let push = |owner: Option<usize>, start: u64, end: u64, out: &mut Vec<Tile>| {
        if start >= end {
            return;
        }
        match out.last_mut() {
            Some(last) if last.owner == owner && last.end == start => last.end = end,
            _ => out.push(Tile { owner, start, end }),
        }
    };
    let owner = |active: &[usize]| {
        active
            .iter()
            .copied()
            .reduce(|a, b| if better(a, b) { a } else { b })
    };
    let mut i = 0;
    while i < edges.len() {
        let t = edges[i].0;
        push(owner(&active), at, t, &mut out);
        at = t;
        while i < edges.len() && edges[i].0 == t {
            let (_, start, idx) = edges[i];
            if start {
                active.push(idx);
            } else if let Some(p) = active.iter().position(|&x| x == idx) {
                active.swap_remove(p);
            }
            i += 1;
        }
    }
    push(owner(&active), at, to, &mut out);
    out
}

/// Each claim's exclusive time under [`tile`], and the uncovered time.
pub fn exclusive(claims: &[Claim], from: u64, to: u64) -> (Vec<u64>, u64) {
    let mut excl = vec![0; claims.len()];
    let mut uncovered = 0;
    for t in tile(claims, from, to) {
        match t.owner {
            Some(i) => excl[i] += t.end - t.start,
            None => uncovered += t.end - t.start,
        }
    }
    (excl, uncovered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(start: u64, end: u64, rank: u8) -> Claim {
        Claim { start, end, rank }
    }

    #[test]
    fn tiles_cover_the_window_exactly() {
        let claims = [c(10, 50, 1), c(20, 30, 2), c(40, 80, 1), c(90, 95, 1)];
        let tiles = tile(&claims, 0, 100);
        assert_eq!(tiles.iter().map(|t| t.end - t.start).sum::<u64>(), 100);
        assert_eq!(
            tiles,
            vec![
                Tile {
                    owner: None,
                    start: 0,
                    end: 10
                },
                Tile {
                    owner: Some(0),
                    start: 10,
                    end: 20
                },
                Tile {
                    owner: Some(1),
                    start: 20,
                    end: 30
                },
                Tile {
                    owner: Some(0),
                    start: 30,
                    end: 40
                },
                // Same rank: the later start is the inner span.
                Tile {
                    owner: Some(2),
                    start: 40,
                    end: 80
                },
                Tile {
                    owner: None,
                    start: 80,
                    end: 90
                },
                Tile {
                    owner: Some(3),
                    start: 90,
                    end: 95
                },
                Tile {
                    owner: None,
                    start: 95,
                    end: 100
                },
            ]
        );
        let (excl, uncovered) = exclusive(&claims, 0, 100);
        assert_eq!(excl, vec![20, 10, 40, 5]);
        assert_eq!(uncovered, 25);
    }

    #[test]
    fn claims_outside_the_window_are_clamped() {
        let (excl, uncovered) = exclusive(&[c(0, 1000, 1)], 100, 200);
        assert_eq!((excl, uncovered), (vec![100], 0));
        assert!(tile(&[], 5, 5).is_empty());
    }
}
