//! Deterministic risk rules, ranked in table order, at most 5 per scope, each with its numbers. Pure: the status
//! view gathers the facts, these decide what is a risk and how it reads.
use fleetd_contracts::prim::Line;
use fleetd_contracts::status::{Risk, RiskLevel, RiskRule};

/// An open request is a risk after this long.
pub const BLOCKED_MS: i64 = 3_600_000;
/// Slots are a risk when something has queued this long.
pub const SLOTS_FULL_MS: i64 = 10 * 60_000;
/// An order with no plan items is a risk after running this long.
pub const NO_PLAN_MS: i64 = 30 * 60_000;
pub const DAY_MS: i64 = 24 * 3_600_000;
pub const USAGE_HIGH: f64 = 0.9;
pub const MAX_RISKS: usize = 5;

#[derive(Clone, Debug, Default)]
pub struct RiskFacts {
    /// (repo, failing check names, since)
    pub ci_red: Vec<(String, Vec<String>, String)>,
    /// (machine, "offline"/"degraded", age text, tasks waiting)
    pub machines_down: Vec<(String, String, String, i64)>,
    /// (what it waits on, order, open for ms)
    /// (what waits on the person, its order, open for ms) of every open request.
    pub blocked_requests: Vec<(String, String, i64)>,
    /// (item, title, size letter, failed attempts) of every open must item, plan order.
    pub open_must: Vec<(String, String, char, i64)>,
    /// (check name, distinct PRs it failed on in 24 h)
    pub ci_repeat: Vec<(String, i64)>,
    /// (machine, drops in 24 h, last at text, last duration text)
    pub flaky: Vec<(String, i64, String, String)>,
    /// ("5h"/"wk", utilization 0..1, rejected or warned, resets text)
    pub usage: Vec<(String, f64, bool, String)>,
    /// (queued for ms, queued, cap)
    pub slots_queued: Option<(i64, i64, i64)>,
    pub missed_webhooks_today: i64,
    /// (order, tier letter, running for ms)
    pub no_plan: Vec<(String, String, i64)>,
    /// (steer, who it went to, sent at clock text) of steers unacknowledged, or delivered past [`STEER_ACK_MS`].
    pub steers_unacked: Vec<(String, String, String)>,
    /// (item, where it is, measured time there) of items past 1.5× their stage's usual time, slowest first.
    pub slower: Vec<(String, String, String)>,
    /// (PR number, its machine, the train's last error) of PRs waiting for the train while that error holds them.
    pub train_stuck: Vec<(i64, String, String)>,
}

/// A delivered steer is a risk once it has gone this long without an acknowledgement.
pub const STEER_ACK_MS: i64 = 10 * 60_000;

fn risk(rule: RiskRule, level: RiskLevel, message: String) -> Risk {
    Risk {
        rule,
        level,
        message: Line::unchecked(crate::hub::plan::clip(&message, 200)),
    }
}

pub fn age(ms: i64) -> String {
    let m = ms.max(0) / 60_000;
    match m {
        0..60 => format!("{m}m"),
        60..1440 => format!("{}h{:02}m", m / 60, m % 60),
        _ => format!("{}d{}h", m / 1440, m % 1440 / 60),
    }
}

/// Every risk that holds, ranked; the caller keeps the first [`MAX_RISKS`] and counts the rest.
pub fn risks(f: &RiskFacts) -> Vec<Risk> {
    use RiskLevel::{Danger, Warning};
    let mut out = Vec::new();
    for (repo, failing, since) in &f.ci_red {
        let what = if failing.is_empty() {
            "checks failing".to_owned()
        } else {
            failing.join(", ")
        };
        out.push(risk(
            RiskRule::CiRedMain,
            Danger,
            format!("main CI red on {repo}: {what} since {since}"),
        ));
    }
    for (m, status, age, waiting) in &f.machines_down {
        if *waiting > 0 {
            out.push(risk(
                RiskRule::MachineOffline,
                Danger,
                format!(
                    "{m} {status} {age} ({waiting} task{} waiting)",
                    if *waiting == 1 { "" } else { "s" }
                ),
            ));
        }
    }
    for (what, ws, open_ms) in &f.blocked_requests {
        if *open_ms >= BLOCKED_MS {
            out.push(risk(
                RiskRule::BlockedOnYou,
                Danger,
                format!("{what} has blocked {ws} for {}", age(*open_ms)),
            ));
        }
    }
    for (pr, machine, error) in &f.train_stuck {
        let error = error.strip_prefix("git: ").unwrap_or(error);
        let (level, message) = if error.starts_with(crate::hub::train::git::REFUSED_HERE) {
            (
                Danger,
                format!(
                    "#{pr} can't merge: its checkout on {machine} is outside the node's cmdRoots. Fix: add it to \"cmdRoots\" in node.json on {machine}, then restart the node"
                ),
            )
        } else if error.starts_with(crate::hub::train::git::BLOCKED) {
            (Danger, format!("#{pr} can't merge: {error}"))
        } else {
            (Warning, format!("#{pr} is held on the train: {error}"))
        };
        out.push(risk(RiskRule::TrainStuck, level, message));
    }
    for (item, stage, took) in f.slower.iter().take(2) {
        out.push(risk(
            RiskRule::SlowerThanUsual,
            Warning,
            format!("{item} is slower than usual {stage} ({took} so far)"),
        ));
    }
    if let Some(r) = riskiest(&f.open_must) {
        out.push(r);
    }
    for (name, n) in &f.ci_repeat {
        if *n >= 2 {
            out.push(risk(
                RiskRule::CiRedRepeat,
                Warning,
                format!("check `{name}` failed on {n} PRs today"),
            ));
        }
    }
    for (m, n, last, dur) in &f.flaky {
        if *n >= 2 {
            out.push(risk(
                RiskRule::MachineFlaky,
                Warning,
                format!("{m} went offline {n}× today (last {last}, {dur})"),
            ));
        }
    }
    for (label, u, flagged, resets) in &f.usage {
        if *u >= USAGE_HIGH || *flagged {
            out.push(risk(
                RiskRule::UsageHigh,
                if *u >= 1.0 { Danger } else { Warning },
                format!(
                    "claude {label} at {}%, resets {resets}",
                    (u * 100.0).round() as i64
                ),
            ));
        }
    }
    if let Some((for_ms, queued, cap)) = f.slots_queued
        && for_ms >= SLOTS_FULL_MS
    {
        out.push(risk(
            RiskRule::SlotsFull,
            Warning,
            format!("slots full {}, {queued} queued (cap {cap})", age(for_ms)),
        ));
    }
    if f.missed_webhooks_today >= 1 {
        out.push(risk(
            RiskRule::GithubDrift,
            Warning,
            format!(
                "webhooks missed {} change{} today; syncing every 60 s",
                f.missed_webhooks_today,
                if f.missed_webhooks_today == 1 {
                    ""
                } else {
                    "s"
                }
            ),
        ));
    }
    for (ws, tier, running_ms) in &f.no_plan {
        if *running_ms >= NO_PLAN_MS {
            out.push(risk(
                RiskRule::NoPlan,
                Warning,
                format!("{ws} has no plan; it counts as one {tier} item"),
            ));
        }
    }
    for (id, to, at) in &f.steers_unacked {
        out.push(risk(
            RiskRule::SteerUnacknowledged,
            Warning,
            format!("{id} to {to} was not acknowledged ({at})"),
        ));
    }
    out
}

/// The open must item with the most `size × (1 + failures)`; ties go to the earlier one.
fn riskiest(items: &[(String, String, char, i64)]) -> Option<Risk> {
    let points = |c: char| match c {
        's' => 1,
        'l' => 8,
        _ => 3,
    };
    let mut best: Option<&(String, String, char, i64)> = None;
    for i in items {
        if best.is_none_or(|b| points(i.2) * (1 + i.3) > points(b.2) * (1 + b.3)) {
            best = Some(i);
        }
    }
    let (id, title, size, failures) = best?;
    Some(risk(
        RiskRule::RiskiestItem,
        RiskLevel::Warning,
        format!(
            "riskiest: {id} {title} ({size}, {failures} failed attempt{})",
            if *failures == 1 { "" } else { "s" }
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_fire_at_their_thresholds_in_table_order() {
        let mut f = RiskFacts {
            ci_red: vec![(
                "acme/storefront".into(),
                vec!["rust (macos)".into()],
                "13:40".into(),
            )],
            machines_down: vec![("buildbox".into(), "offline".into(), "4m".into(), 0)],
            blocked_requests: vec![(
                "the secret `stripe.key`".into(),
                "W41".into(),
                BLOCKED_MS - 1,
            )],
            flaky: vec![("devbox".into(), 2, "11:02".into(), "11m".into())],
            usage: vec![
                ("5h".into(), 0.58, false, "14:00".into()),
                ("wk".into(), 0.93, false, "Thu".into()),
            ],
            slots_queued: Some((SLOTS_FULL_MS, 1, 40)),
            no_plan: vec![("W42".into(), "M".into(), NO_PLAN_MS)],
            steers_unacked: vec![("S12".into(), "the lead".into(), "14:02".into())],
            open_must: vec![
                ("P3".into(), "runner".into(), 'm', 1),
                ("P4".into(), "lab".into(), 'l', 0),
                ("P5".into(), "docs".into(), 's', 3),
            ],
            ..Default::default()
        };
        let rules: Vec<RiskRule> = risks(&f).iter().map(|r| r.rule).collect();
        assert_eq!(
            rules,
            vec![
                RiskRule::CiRedMain,
                RiskRule::RiskiestItem,
                RiskRule::MachineFlaky,
                RiskRule::UsageHigh,
                RiskRule::SlotsFull,
                RiskRule::NoPlan,
                RiskRule::SteerUnacknowledged
            ]
        );
        let all = risks(&f);
        assert_eq!(
            all[0].message.as_str(),
            "main CI red on acme/storefront: rust (macos) since 13:40"
        );
        assert_eq!(
            all[1].message.as_str(),
            "riskiest: P4 lab (l, 0 failed attempts)",
            "8 beats 3×2 and 1×4"
        );
        assert_eq!(all[3].message.as_str(), "claude wk at 93%, resets Thu");
        f.blocked_requests[0].2 = BLOCKED_MS;
        f.machines_down[0].3 = 2;
        let rules: Vec<RiskRule> = risks(&f).iter().map(|r| r.rule).take(3).collect();
        assert_eq!(
            rules,
            vec![
                RiskRule::CiRedMain,
                RiskRule::MachineOffline,
                RiskRule::BlockedOnYou
            ]
        );
        assert_eq!(
            risks(&f)[1].message.as_str(),
            "buildbox offline 4m (2 tasks waiting)"
        );
    }

    #[test]
    fn a_pr_held_by_the_train_is_a_risk_with_its_fix() {
        let f = RiskFacts {
            train_stuck: vec![
                (
                    151,
                    "fe7".into(),
                    format!(
                        "git: {}/tmp/w/lab is outside cmdRoots, the directories this node runs commands in (/home/a) on fe7. Fix: …",
                        crate::hub::train::git::REFUSED_HERE
                    ),
                ),
                (
                    152,
                    "fe7".into(),
                    "GitHub refused the merge (HTTP 405): no".into(),
                ),
            ],
            ..Default::default()
        };
        let all = risks(&f);
        assert_eq!(
            all.iter().map(|r| (r.rule, r.level)).collect::<Vec<_>>(),
            [
                (RiskRule::TrainStuck, RiskLevel::Danger),
                (RiskRule::TrainStuck, RiskLevel::Warning)
            ]
        );
        assert_eq!(
            all[0].message.as_str(),
            "#151 can't merge: its checkout on fe7 is outside the node's cmdRoots. Fix: add it to \"cmdRoots\" in node.json on fe7, then restart the node"
        );
        assert_eq!(
            all[1].message.as_str(),
            "#152 is held on the train: GitHub refused the merge (HTTP 405): no"
        );
    }

    #[test]
    fn the_riskiest_item_weighs_size_by_failures_and_ties_go_first() {
        let items = vec![
            ("P1".to_owned(), "a".to_owned(), 'm', 1),
            ("P2".to_owned(), "b".to_owned(), 's', 5),
        ];
        assert!(
            riskiest(&items)
                .unwrap()
                .message
                .starts_with("riskiest: P1"),
            "6 = 6: earlier wins"
        );
        assert!(riskiest(&[]).is_none());
    }
}
