//! A research order's budget: its brief gives a size (s, m or l), never hours, and the hub turns that into a cap on
//! agent turns, measured from finished research orders of the same size (twice their median, under a hard ceiling).
//! Spawning or messaging a task past the cap is refused with the reason, so the lead records the verdict with what
//! it has.
use fleetd_contracts::ledger::{Tier, Workstream};
use fleetd_contracts::time::SpanKind;
use rusqlite::{Connection, params};

/// No research order runs more agent turns than this, whatever its size or history.
pub const CEILING_TURNS: i64 = 300;
/// Finished orders of a size needed before their median sets the cap.
pub const MIN_SAMPLES: usize = 3;
const WINDOW_MS: i64 = 30 * 24 * 3_600_000;

/// The cap before any research order of the size has finished.
pub fn default_turns(size: Tier) -> i64 {
    match size {
        Tier::S => 20,
        Tier::M => 60,
        Tier::L => 150,
    }
}

/// Twice the measured median, or the default; never above the ceiling.
pub fn limit(size: Tier, measured_median: Option<i64>) -> i64 {
    measured_median
        .map_or_else(|| default_turns(size), |m| 2 * m)
        .clamp(1, CEILING_TURNS)
}

fn research_size(w: &Workstream) -> Option<Tier> {
    w.playbook
        .as_ref()
        .filter(|p| p.as_str().starts_with("research@"))?;
    w.brief.as_ref()?.budget.as_ref()?.size
}

fn tier_str(t: Tier) -> &'static str {
    match t {
        Tier::S => "S",
        Tier::M => "M",
        Tier::L => "L",
    }
}

/// Agent turns the order's tasks ran: one per run of a task thread.
pub fn spent(c: &Connection, workstream_id: &str) -> rusqlite::Result<i64> {
    c.prepare_cached(
        "SELECT COUNT(*) FROM time_spans WHERE workstream_id = ? AND kind = ? AND IFNULL(role, '') != 'lead'",
    )?
    .query_row(params![workstream_id, SpanKind::Run.code()], |r| r.get(0))
}

/// The median turns of research orders of `size` done in the last 30 days, with at least [`MIN_SAMPLES`] of them.
pub fn measured_median(c: &Connection, size: Tier, now_ms: i64) -> rusqlite::Result<Option<i64>> {
    let since = crate::hub::store::iso_ms(now_ms - WINDOW_MS);
    let mut runs: Vec<i64> = c
        .prepare_cached(
            "SELECT (SELECT COUNT(*) FROM time_spans s
                     WHERE s.workstream_id = 'W' || w.n AND s.kind = ? AND IFNULL(s.role, '') != 'lead')
             FROM workstreams w
             WHERE w.state = 'done' AND json_extract(w.data, '$.playbook') LIKE 'research@%'
               AND json_extract(w.data, '$.brief.budget.size') = ? AND json_extract(w.data, '$.updatedAt') >= ?",
        )?
        .query_map(params![SpanKind::Run.code(), tier_str(size), since], |r| {
            r.get(0)
        })?
        .collect::<rusqlite::Result<_>>()?;
    runs.retain(|n| *n > 0);
    if runs.len() < MIN_SAMPLES {
        return Ok(None);
    }
    runs.sort_unstable();
    Ok(Some(runs[runs.len() / 2]))
}

/// Why another agent turn for this order is refused: its research budget is spent. None for any other order.
pub fn refusal(c: &Connection, w: &Workstream, now_ms: i64) -> rusqlite::Result<Option<String>> {
    let Some(size) = research_size(w) else {
        return Ok(None);
    };
    let cap = limit(size, measured_median(c, size, now_ms)?);
    let used = spent(c, w.workstream_id.as_str())?;
    Ok((used >= cap).then(|| {
        format!(
            "{}'s research budget is spent: its tasks ran {used} agent turns, the cap for size {} is {cap}.",
            w.workstream_id,
            tier_str(size).to_lowercase()
        )
    }))
}

/// What the lead does when the budget is spent.
pub const FIX: &str =
    "Record the verdict with the numbers you have, or ask the human for a bigger budget size.";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::store::HubDb;
    use serde_json::json;

    fn order(c: &Connection, n: i64, state: &str, playbook: &str, size: &str) {
        let w = json!({
            "workstreamId": format!("W{n}"), "projectRef": { "machineId": "devbox", "projectId": "p" },
            "title": "t", "source": { "text": "t", "channel": "app", "by": "human", "at": "2026-10-19T08:00:00.000Z" },
            "brief": { "goal": "g", "why": "w", "pointers": [], "constraints": [], "tier": "M",
                "doneWhen": [{ "type": "http", "url": "http://localhost:3000/health", "status": 200 }], "budget": { "size": size } },
            "playbook": playbook, "state": state,
            "createdAt": "2026-10-19T08:00:00.000Z", "updatedAt": "2026-10-19T09:00:00.000Z",
        });
        c.execute(
            "INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (?, 'devbox', 'p', ?, ?)",
            params![n, state, w.to_string()],
        )
        .unwrap();
    }

    fn runs(c: &Connection, ws: &str, n: i64, role: &str) {
        for i in 0..n {
            c.execute(
                "INSERT INTO time_spans (src, src_key, kind, cat, start_ms, lane, status, workstream_id, role)
                 VALUES ('t', ?, 1, 0, 0, 'l', 0, ?, ?)",
                params![format!("{ws}-{role}-{i}"), ws, role],
            )
            .unwrap();
        }
    }

    const NOW: i64 = 1_792_400_000_000;
    const RESEARCH: &str = "research@0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn the_cap_is_twice_the_measured_median_under_a_ceiling() {
        assert_eq!(limit(Tier::M, None), 60);
        assert_eq!(limit(Tier::S, Some(7)), 14);
        assert_eq!(limit(Tier::L, Some(400)), CEILING_TURNS);
        let db = HubDb::open_memory().unwrap();
        db.with(|c| {
            for (n, turns) in [(1, 5), (2, 9), (3, 30)] {
                order(c, n, "done", RESEARCH, "S");
                runs(c, &format!("W{n}"), turns, "implementer");
            }
            assert_eq!(measured_median(c, Tier::S, NOW)?, Some(9));
            assert_eq!(
                measured_median(c, Tier::M, NOW)?,
                None,
                "no finished m research yet"
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_research_order_past_its_cap_is_refused_and_others_never_are() {
        let db = HubDb::open_memory().unwrap();
        db.with(|c| {
            order(c, 1, "running", RESEARCH, "S");
            runs(c, "W1", 19, "implementer");
            runs(c, "W1", 50, "lead");
            let w = |c: &Connection| -> Workstream {
                let d: String = c.query_row("SELECT data FROM workstreams WHERE n = 1", [], |r| r.get(0)).unwrap();
                serde_json::from_str(&d).unwrap()
            };
            assert_eq!(refusal(c, &w(c), NOW)?, None, "19 of 20; the lead's own turns don't count");
            runs(c, "W1", 1, "reviewer");
            assert_eq!(
                refusal(c, &w(c), NOW)?.as_deref(),
                Some("W1's research budget is spent: its tasks ran 20 agent turns, the cap for size s is 20.")
            );
            order(c, 2, "running", "feature@0123456789abcdef0123456789abcdef01234567", "S");
            runs(c, "W2", 500, "implementer");
            let d: String = c.query_row("SELECT data FROM workstreams WHERE n = 2", [], |r| r.get(0))?;
            assert_eq!(refusal(c, &serde_json::from_str(&d).unwrap(), NOW)?, None, "only research has a budget");
            Ok(())
        })
        .unwrap();
    }
}
