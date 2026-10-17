//! The value bar's spawn rules: writers say what they serve, a done workstream takes no more writes, and review stops
//! after one clean pass per commit. Pure; mod.rs feeds them the workstream, the PR head and its verdicts.
//! TS spec: apps/hub/src/valuebar/rules.ts. The train's review gate (reviews area) reuses `review_refusal` and `pr_key`.
use fleetd_contracts::ledger::{SERVES_FIX, Workstream, WorkstreamId, WorkstreamState, is_serves};
use fleetd_contracts::tasks::TaskKind;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq)]
pub struct SpawnRequest {
    pub workstream_id: WorkstreamId,
    pub kind: TaskKind,
    pub serves: Option<String>,
    pub pr: Option<String>,
    pub qa: bool,
}

/// A recorded verdict on one PR, newest first when listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrVerdict {
    pub task_id: String,
    pub sha: String,
    pub blocking: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpawnRefusal {
    pub message: String,
    pub fix: Option<String>,
    /// Set when the refusal is a polish loop, which is also recorded as an incident with these lines.
    pub polish_loop: Option<Vec<String>>,
}

impl SpawnRefusal {
    fn new(message: String, fix: Option<&str>) -> Self {
        Self {
            message,
            fix: fix.map(str::to_owned),
            polish_loop: None,
        }
    }
}

/// The hub spawning on its own behalf ("hub", "hub:judge"): its judge reviews criteria, not a PR.
pub fn is_hub_caller(by: &str) -> bool {
    by == "hub" || by.starts_with("hub:")
}

/// Write spawns: the workstream is not done, `serves` is well formed, and `done:<n>` names an existing done-when check.
pub fn write_refusal(request: &SpawnRequest, workstream: &Workstream) -> Option<SpawnRefusal> {
    if request.kind != TaskKind::Write {
        return None;
    }
    let id = &workstream.workstream_id;
    if workstream.state == WorkstreamState::Done {
        return Some(SpawnRefusal::new(
            format!("{id} is done; open a new intent if there's more to do"),
            None,
        ));
    }
    let serves = match &request.serves {
        None => {
            return Some(SpawnRefusal::new(
                "A write task must say what it serves.".into(),
                Some(SERVES_FIX),
            ));
        }
        Some(s) if !is_serves(s) => {
            return Some(SpawnRefusal::new(
                format!("--serves {s} is not valid."),
                Some(SERVES_FIX),
            ));
        }
        Some(s) => s,
    };
    let n: usize = serves.strip_prefix("done:")?.parse().ok()?;
    let checks = workstream.brief.as_ref().map_or(0, |b| b.done_when.len());
    if n < checks {
        return None;
    }
    let message = if checks == 0 {
        format!("{id} has no brief yet, so done:{n} names no done-when check.")
    } else {
        let range = if checks > 1 {
            format!(" to done:{}", checks - 1)
        } else {
            String::new()
        };
        format!("done:{n} is not a done-when check of {id}; it has {checks} (done:0{range}).")
    };
    Some(SpawnRefusal::new(message, Some(SERVES_FIX)))
}

fn short(sha: &str) -> &str {
    sha.get(..12).unwrap_or(sha)
}

/// Review spawns (QA runs included): a PR to review, no clean verdict on its current head yet, and not a third round
/// after two clean verdicts in a row on different heads. `head_sha` is None when GitHub could not be asked; `verdicts`
/// are this PR's, newest first. `max_rounds` is the playbook's maxReviewRounds: a lead's review of a head not reviewed
/// yet is refused once that many heads were. The train's own reviews are exempt, so it never stalls on it.
pub fn review_refusal(
    request: &SpawnRequest,
    by: &str,
    head_sha: Option<&str>,
    verdicts: &[PrVerdict],
    max_rounds: Option<u32>,
) -> Option<SpawnRefusal> {
    if request.kind != TaskKind::Review {
        return None;
    }
    let Some(pr) = &request.pr else {
        return if is_hub_caller(by) {
            None
        } else {
            Some(SpawnRefusal::new(
                "A review task needs the PR it reviews.".into(),
                Some("Pass --pr <PR URL>."),
            ))
        };
    };
    if let Some(head) = head_sha
        && verdicts.iter().any(|v| v.sha == head && v.blocking == 0)
    {
        return Some(SpawnRefusal::new(
            format!("already reviewed at {head} with 0 blocking findings"),
            Some(
                "Review stops after one clean pass per commit. Send it to the train, or push a fix and review the new head.",
            ),
        ));
    }
    if let [last, before, ..] = verdicts
        && last.blocking == 0
        && before.blocking == 0
        && last.sha != before.sha
    {
        let qa = if request.qa { "(QA) " } else { "" };
        return Some(SpawnRefusal {
            message: format!(
                "{pr} had two clean reviews in a row ({} by {}, {} by {}); a third review is a polish loop.",
                short(&before.sha),
                before.task_id,
                short(&last.sha),
                last.task_id
            ),
            fix: Some("Send the PR to the train. If you know of a blocking defect, fix it in a write task with --serves defect:<text>.".into()),
            polish_loop: Some(vec![
                format!("Review {qa}requested for {pr} after two consecutive clean verdicts on different heads."),
                format!("{}: 0 blocking at {}", before.task_id, before.sha),
                format!("{}: 0 blocking at {}", last.task_id, last.sha),
            ]),
        });
    }
    let rounds: HashSet<&str> = verdicts.iter().map(|v| v.sha.as_str()).collect();
    if let Some(max) = max_rounds
        && !is_hub_caller(by)
        && rounds.len() >= max as usize
        && head_sha.is_none_or(|h| !rounds.contains(h))
    {
        return Some(SpawnRefusal::new(
            format!(
                "{pr} has had {} review rounds, the most its playbook allows.",
                rounds.len()
            ),
            Some(
                "Send the PR to the train. If it still has a blocking defect, fix it with a write task (--serves defect:<text>) and let the train's review gate check it, or ask the human.",
            ),
        ));
    }
    None
}

/// One key per PR however its URL is written: host and path, lowercased, `/pulls/` as `/pull/`, no trailing slash.
pub fn pr_key(url: &str) -> String {
    let trimmed = url.trim();
    match url::Url::parse(trimmed) {
        Ok(u) if u.has_host() => {
            let host = match u.port() {
                Some(p) => format!("{}:{p}", u.host_str().unwrap_or_default()),
                None => u.host_str().unwrap_or_default().to_owned(),
            };
            format!("{host}{}", u.path())
                .to_lowercase()
                .replacen("/pulls/", "/pull/", 1)
                .trim_end_matches('/')
                .to_owned()
        }
        _ => trimmed.to_lowercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workstream(state: &str, brief: bool) -> Workstream {
        let mut w = json!({
            "workstreamId": "W1",
            "projectRef": { "machineId": "lab-a", "projectId": "p1" },
            "title": "docs",
            "source": { "text": "write docs", "channel": "app", "by": "human", "at": "2026-10-17T10:00:00.000Z" },
            "state": state,
            "createdAt": "2026-10-17T10:00:00.000Z",
            "updatedAt": "2026-10-17T10:00:00.000Z",
        });
        if brief {
            w["brief"] = json!({
                "goal": "a docs page", "why": "people ask", "pointers": [], "constraints": [], "tier": "S",
                "doneWhen": [{ "type": "pr_merged", "repo": "wynn-dev/lab" }, { "type": "human", "question": "does it read well?" }],
            });
        }
        serde_json::from_value(w).unwrap()
    }

    fn request(kind: TaskKind, serves: Option<&str>, pr: Option<&str>, qa: bool) -> SpawnRequest {
        SpawnRequest {
            workstream_id: WorkstreamId::unchecked("W1"),
            kind,
            serves: serves.map(Into::into),
            pr: pr.map(Into::into),
            qa,
        }
    }
    fn write(serves: Option<&str>) -> SpawnRequest {
        request(TaskKind::Write, serves, None, false)
    }

    #[test]
    fn write_refusal_table() {
        let cases: Vec<(&str, SpawnRequest, Workstream, Option<&str>)> = vec![
            (
                "done:0 on a running workstream",
                write(Some("done:0")),
                workstream("running", true),
                None,
            ),
            (
                "done:1, the last check",
                write(Some("done:1")),
                workstream("running", true),
                None,
            ),
            (
                "an issue ref",
                write(Some("issue:#12")),
                workstream("running", true),
                None,
            ),
            (
                "an issue URL",
                write(Some("issue:https://github.com/wynn-dev/lab/issues/3")),
                workstream("running", true),
                None,
            ),
            (
                "a defect",
                write(Some("defect:the digest drops answers")),
                workstream("running", true),
                None,
            ),
            (
                "an ask",
                write(Some("ask:A4")),
                workstream("running", true),
                None,
            ),
            (
                "a verifying workstream",
                write(Some("done:0")),
                workstream("verifying", true),
                None,
            ),
            (
                "no serves",
                write(None),
                workstream("running", true),
                Some("A write task must say what it serves."),
            ),
            (
                "an unknown kind of serves",
                write(Some("vibes:yes")),
                workstream("running", true),
                Some("--serves vibes:yes is not valid."),
            ),
            (
                "done:2 past the last check",
                write(Some("done:2")),
                workstream("running", true),
                Some("done:2 is not a done-when check of W1; it has 2 (done:0 to done:1)."),
            ),
            (
                "done:0 on a draft",
                write(Some("done:0")),
                workstream("draft", false),
                Some("W1 has no brief yet, so done:0 names no done-when check."),
            ),
            (
                "a done workstream",
                write(Some("done:0")),
                workstream("done", true),
                Some("W1 is done; open a new intent if there's more to do"),
            ),
            (
                "a done workstream, even without serves",
                write(None),
                workstream("done", true),
                Some("W1 is done; open a new intent if there's more to do"),
            ),
        ];
        for (name, req, ws, message) in cases {
            let refusal = write_refusal(&req, &ws);
            assert_eq!(
                refusal.as_ref().map(|r| r.message.as_str()),
                message,
                "{name}"
            );
            if let Some(m) = message
                && !m.contains("is done")
            {
                assert_eq!(refusal.unwrap().fix.as_deref(), Some(SERVES_FIX), "{name}");
            }
        }
        assert_eq!(
            write_refusal(
                &request(TaskKind::Read, None, None, false),
                &workstream("done", true)
            ),
            None
        );
        assert_eq!(
            write_refusal(
                &request(
                    TaskKind::Review,
                    None,
                    Some("https://github.com/o/r/pull/1"),
                    false
                ),
                &workstream("running", true)
            ),
            None
        );
    }

    const PR: &str = "https://github.com/wynn-dev/lab/pull/7";

    fn v(task: &str, sha: &str, blocking: u32) -> PrVerdict {
        PrVerdict {
            task_id: task.into(),
            sha: sha.into(),
            blocking,
        }
    }

    #[test]
    #[allow(clippy::type_complexity)]
    fn review_refusal_table() {
        let (a, b, c) = ("a".repeat(40), "b".repeat(40), "c".repeat(40));
        let review = || request(TaskKind::Review, None, Some(PR), false);
        let clean_at_a = format!("already reviewed at {a} with 0 blocking findings");
        let polish = format!(
            "{PR} had two clean reviews in a row ({} by T1, {} by T2); a third review is a polish loop.",
            &a[..12],
            &b[..12]
        );
        let cases: Vec<(
            &str,
            SpawnRequest,
            &str,
            Option<&str>,
            Vec<PrVerdict>,
            Option<String>,
            bool,
        )> = vec![
            (
                "a first review",
                review(),
                "lead:lab-a/p1",
                Some(&a),
                vec![],
                None,
                false,
            ),
            (
                "a review without a PR",
                request(TaskKind::Review, None, None, false),
                "lead:lab-a/p1",
                None,
                vec![],
                Some("A review task needs the PR it reviews.".into()),
                false,
            ),
            (
                "a hub-spawned judge review without a PR",
                request(TaskKind::Review, None, None, false),
                "hub:judge",
                None,
                vec![],
                None,
                false,
            ),
            (
                "re-review after blocking findings on the same head",
                review(),
                "lead",
                Some(&a),
                vec![v("T1", &a, 2)],
                None,
                false,
            ),
            (
                "review of the head after a clean one",
                review(),
                "lead",
                Some(&a),
                vec![v("T1", &a, 0)],
                Some(clean_at_a.clone()),
                false,
            ),
            (
                "QA on a head with a clean review",
                request(TaskKind::Review, None, Some(PR), true),
                "lead",
                Some(&a),
                vec![v("T1", &a, 0)],
                Some(clean_at_a.clone()),
                false,
            ),
            (
                "clean verdict further back on the same head",
                review(),
                "lead",
                Some(&a),
                vec![v("T2", &a, 1), v("T1", &a, 0)],
                Some(clean_at_a),
                false,
            ),
            (
                "a new head after one clean review",
                review(),
                "lead",
                Some(&b),
                vec![v("T1", &a, 0)],
                None,
                false,
            ),
            (
                "a new head after clean then blocking",
                review(),
                "lead",
                Some(&c),
                vec![v("T2", &b, 3), v("T1", &a, 0)],
                None,
                false,
            ),
            (
                "a new head after blocking then clean",
                review(),
                "lead",
                Some(&c),
                vec![v("T2", &b, 0), v("T1", &a, 2)],
                None,
                false,
            ),
            (
                "a third review after two clean on different heads",
                review(),
                "lead",
                Some(&c),
                vec![v("T2", &b, 0), v("T1", &a, 0)],
                Some(polish.clone()),
                true,
            ),
            (
                "a third review when GitHub is unreachable",
                review(),
                "lead",
                None,
                vec![v("T2", &b, 0), v("T1", &a, 0)],
                Some(polish),
                true,
            ),
            (
                "two clean verdicts on the same head are not a loop",
                review(),
                "lead",
                None,
                vec![v("T2", &a, 0), v("T1", &a, 0)],
                None,
                false,
            ),
        ];
        for (name, req, by, head, verdicts, message, polish_loop) in cases {
            let refusal = review_refusal(&req, by, head, &verdicts, None);
            assert_eq!(
                refusal.as_ref().map(|r| r.message.clone()),
                message,
                "{name}"
            );
            assert_eq!(
                refusal.is_some_and(|r| r.polish_loop.is_some()),
                polish_loop,
                "{name}"
            );
        }
        assert_eq!(
            review_refusal(
                &write(Some("done:0")),
                "lead",
                Some(&a),
                &[v("T1", &a, 0)],
                None
            ),
            None
        );
    }

    #[test]
    fn review_rounds_cap_counts_reviewed_heads() {
        let (a, b, c) = ("a".repeat(40), "b".repeat(40), "c".repeat(40));
        let review = request(TaskKind::Review, None, Some(PR), false);
        let two_rounds = [v("T2", &b, 1), v("T1", &a, 2)];
        let capped = format!("{PR} has had 2 review rounds, the most its playbook allows.");
        let msg = |by: &str, head: Option<&str>, max| {
            review_refusal(&review, by, head, &two_rounds, Some(max)).map(|r| r.message)
        };
        assert_eq!(msg("lead", Some(&c), 2), Some(capped.clone()));
        assert_eq!(msg("lead", None, 2), Some(capped));
        // Another reviewer on a head already in review is the same round.
        assert_eq!(msg("lead", Some(&b), 2), None);
        assert_eq!(msg("lead", Some(&c), 3), None);
        // The train's review gate is never capped.
        assert_eq!(msg("hub:reviews", Some(&c), 2), None);
    }

    #[test]
    fn pr_key_is_one_per_pr() {
        assert_eq!(
            pr_key("https://GitHub.com/Wynn-Dev/Lab/pull/7/"),
            "github.com/wynn-dev/lab/pull/7"
        );
        assert_eq!(
            pr_key("https://github.com/wynn-dev/lab/pulls/7?x=1#top"),
            "github.com/wynn-dev/lab/pull/7"
        );
    }
}
