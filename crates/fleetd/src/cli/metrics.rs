//! `fleetd metrics`: the factory's numbers over the hub's MCP endpoint (metrics_get, metrics_retention_set): PRs
//! merged per day, time from order to merged, the person's minutes per merged PR and the share through fleetd, by
//! calendar day in this machine's zone. It only lays out what the hub computed; `--json` prints it as the hub sent it.
//! A figure the hub doesn't have reads "—" with why, never as a zero.

use std::collections::BTreeMap;

use chrono::{DateTime, Days, SecondsFormat, Utc};
use chrono_tz::Tz;
use fleetd_contracts::mcp::MetricsGetOutput;
use fleetd_contracts::metrics::{GitHost, HumanTile, MergeRoute, MetricsMerge, SkipWhy};
use serde_json::json;

use super::args::{self, Kind, Spec};
use super::time::{Hub, dur, local, one_line, resolve_project, table};

pub const METRICS_USAGE: &str = r#"  metrics [--project <p>] [--days 30] [--json] [--hub <url> --key-file <path> | --home <dir>]
             what the factory turned out: PRs merged per day by route, time from order to
             merged, your minutes per merged PR and the share through fleetd, over the last
             --days calendar days (1-400, today included) in this machine's zone; one project by
             id or title (<machine>/<project> when two machines have one), the whole fleet
             without one. On the hub machine it needs no --hub or --key-file
  metrics --retention <days> [--hub <url> --key-file <path> | --home <dir>]
             keep 30-400 days of landed changes (admin key on every machine)
"#;

/// Landed changes printed under the figures, newest first; `--json` has them all.
const LISTED: usize = 10;

#[derive(Debug, PartialEq)]
pub struct MetricsArgs {
    /// Both, or neither for the hub on this machine.
    pub hub: Option<(String, String)>,
    /// That hub's home, when it isn't the default.
    pub home: Option<String>,
    /// The project as given; empty for the fleet.
    pub project: String,
    pub days: u32,
    /// The first of those days' midnight in the zone, as an ISO time.
    pub since: String,
    pub json: bool,
    pub retention: Option<u32>,
}

/// The midnight that starts the last `days` calendar days in `zone`, today included.
pub fn since_of(days: u32, now: DateTime<Utc>, zone: Tz) -> String {
    let today = now.with_timezone(&zone).date_naive();
    let first = today
        .checked_sub_days(Days::new(u64::from(days.saturating_sub(1))))
        .unwrap_or(today);
    let start = crate::hub::metrics::compute::day_start(first, zone);
    DateTime::from_timestamp_millis(start)
        .unwrap_or(now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn parse_metrics_args(
    argv: &[String],
    now: DateTime<Utc>,
    zone: Tz,
) -> Result<MetricsArgs, String> {
    const OPTIONS: &[(&str, Kind)] = &[
        ("hub", Kind::Str),
        ("key-file", Kind::Str),
        ("home", Kind::Str),
        ("project", Kind::Str),
        ("days", Kind::Str),
        ("json", Kind::Bool),
        ("retention", Kind::Str),
    ];
    let v = args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: false,
        },
    )?;
    let hub = match (
        v.str("hub").filter(|s| !s.is_empty()),
        v.str("key-file").filter(|s| !s.is_empty()),
    ) {
        (Some(hub), Some(key_file)) => Some((hub.to_owned(), key_file.to_owned())),
        (None, None) => None,
        (Some(_), None) => return Err("--hub needs --key-file".into()),
        (None, Some(_)) => return Err("--key-file needs --hub".into()),
    };
    let days = match v.str("days") {
        None => 30,
        Some(given) => given
            .parse::<u32>()
            .ok()
            .filter(|d| (1..=400).contains(d))
            .ok_or_else(|| format!("--days must be 1 to 400, got '{given}'"))?,
    };
    let retention = match v.str("retention") {
        None => None,
        Some(days) => Some(
            days.parse::<u32>()
                .ok()
                .filter(|d| (30..=400).contains(d))
                .ok_or_else(|| format!("--retention must be 30 to 400 days, got '{days}'"))?,
        ),
    };
    Ok(MetricsArgs {
        hub,
        home: v.string("home").filter(|s| !s.is_empty()),
        project: v.string("project").unwrap_or_default(),
        days,
        since: since_of(days, now, zone),
        json: v.flag("json"),
        retention,
    })
}

/// The views' words for a route, in the charts' order.
fn route_word(route: MergeRoute) -> &'static str {
    match route {
        MergeRoute::Train => "through fleetd",
        MergeRoute::FleetdByHand => "made by fleetd, merged by you",
        MergeRoute::Outside => "merged outside fleetd",
        MergeRoute::Direct => "pushed straight",
        MergeRoute::Unknown => "other",
    }
}

fn skip_words(why: SkipWhy, n: i64) -> String {
    let (one, many) = match why {
        SkipWhy::Bot => ("bot PR", "bot PRs"),
        SkipWhy::OtherBase => ("PR into another branch", "PRs into other branches"),
        SkipWhy::MergeBack => ("merge-back", "merge-backs"),
        SkipWhy::Unknown => ("other merge", "other merges"),
    };
    format!("{n} {}", if n == 1 { one } else { many })
}

fn host_word(host: GitHost) -> &'static str {
    match host {
        GitHost::GitHub => "GitHub",
        GitHost::GitLab => "GitLab",
        GitHost::Gitea => "Gitea",
        GitHost::Bitbucket => "Bitbucket",
        GitHost::AzureDevOps => "Azure DevOps",
        GitHost::Git => "git log",
        GitHost::Unknown => "its host",
    }
}

fn pct(v: f64) -> String {
    format!("{}%", v.round() as i64)
}

fn prs(n: i64) -> String {
    match n {
        1 => "1 PR".into(),
        n => format!("{n} PRs"),
    }
}

/// The person's minutes: "—" with why until the hub counts them (metrics PR 4 adds the touches), never a zero.
fn human_cells(h: &HumanTile) -> (String, String) {
    let total = h.total_ms.get();
    match h.per_pr_ms {
        Some(per) => (
            format!("≈ {}", dur(per.get())),
            format!(
                "≈ {} in all (at least {}) over {} · from what fleetd sees",
                dur(total),
                dur(h.low_ms.get()),
                prs(h.prs.get())
            ),
        ),
        None if total > 0 => (
            "—".into(),
            format!("no PRs made by fleetd · ≈ {} in all", dur(total)),
        ),
        None => ("—".into(), "not counted yet".into()),
    }
}

/// A landed change's name: repo#PR, or the pushed commit's short sha.
fn merge_name(m: &MetricsMerge) -> String {
    match (m.pr_number, &m.sha) {
        (Some(n), _) => format!("{}#{}", m.repo.as_str(), n.get()),
        (None, Some(sha)) => format!(
            "{}@{}",
            m.repo.as_str(),
            &sha.as_str()[..sha.as_str().len().min(8)]
        ),
        (None, None) => m.repo.as_str().to_owned(),
    }
}

/// What `fleetd metrics` prints. `scope` is the project's title, or empty for the fleet.
pub fn render(scope: &str, days: u32, out: &MetricsGetOutput, zone: Tz) -> String {
    let t = &out.tiles;
    let day = |iso: &str| local(iso, zone).chars().take(10).collect::<String>();
    let mut lines = vec![format!(
        "{}: last {} days, {} to {} ({})",
        if scope.is_empty() { "fleet" } else { scope },
        days,
        day(out.since.as_str()),
        day(out.until.as_str()),
        zone.name()
    )];

    let m = &t.merged;
    let mut merged_note = format!("{} in {days} days", m.n.get());
    if let Some(prev) = m.previous_per_day {
        merged_note.push_str(&format!(" · was {:.1}", prev.get()));
    }
    let o = &t.order_to_merged;
    let order = match (o.median_ms, o.p90_ms) {
        (Some(median), Some(p90)) => {
            let mut note = format!("median · p90 {} · {}", dur(p90.get()), prs(o.n.get()));
            if o.from_opened.get() > 0 {
                note.push_str(&format!(
                    " ({} timed from when the lead opened the order)",
                    o.from_opened.get()
                ));
            }
            (dur(median.get()), note)
        }
        _ => ("—".into(), "no merged PR belongs to an order".into()),
    };
    let order_note = match o.no_order.get() {
        0 => order.1,
        n => format!("{} · {n} merged with no order", order.1),
    };
    let (human, human_note) = human_cells(&t.human);
    let f = &t.through_fleetd;
    let (share, share_note) = match (f.pct, f.made_by_fleetd_pct) {
        (Some(p), Some(made)) => (pct(p.get()), format!("{} made by fleetd", pct(made.get()))),
        _ => ("—".into(), "nothing merged".into()),
    };
    let figures = [
        (
            "merged per day",
            format!("{:.1}", m.per_day.get()),
            merged_note,
        ),
        ("order to merged", order.0, order_note),
        ("your minutes per PR", human, human_note),
        ("through fleetd", share, share_note),
    ];
    let label_w = figures
        .iter()
        .map(|f| f.0.chars().count())
        .max()
        .unwrap_or(0);
    let value_w = figures
        .iter()
        .map(|f| f.1.chars().count())
        .max()
        .unwrap_or(0);
    lines.push(String::new());
    for (label, value, note) in figures {
        lines.push(format!("{label:<label_w$}  {value:>value_w$}  {note}"));
    }

    let by_route = [
        (MergeRoute::Train, m.by_route.train.get()),
        (MergeRoute::FleetdByHand, m.by_route.fleetd_by_hand.get()),
        (MergeRoute::Outside, m.by_route.outside.get()),
        (MergeRoute::Direct, m.by_route.direct.get()),
    ];
    let mut rows = vec![vec!["by route".to_owned(), "n".into(), "lines".into()]];
    for (route, n) in by_route {
        let lines = f
            .lines
            .iter()
            .find(|l| l.route == route)
            .map(|l| format!("+{} −{}", l.additions.get(), l.deletions.get()))
            .unwrap_or_default();
        rows.push(vec![
            format!("  {}", route_word(route)),
            n.to_string(),
            lines,
        ]);
    }
    lines.push(String::new());
    lines.extend(table(&rows));
    let mut skipped: BTreeMap<SkipWhy, i64> = BTreeMap::new();
    for d in out.days.iter() {
        for s in d.not_counted.iter() {
            *skipped.entry(s.why).or_default() += s.n.get();
        }
    }
    if !skipped.is_empty() {
        let words: Vec<String> = skipped.into_iter().map(|(w, n)| skip_words(w, n)).collect();
        lines.push(format!("  not counted: {}", words.join(", ")));
    }

    if let Some(repos) = out.repos.as_ref().filter(|r| !r.is_empty()) {
        let mut rows = vec![vec![
            "repo".to_owned(),
            "per day".into(),
            "n".into(),
            "order to merged".into(),
            "through fleetd".into(),
        ]];
        for r in repos.iter() {
            rows.push(vec![
                format!("  {}", r.repo.as_str()),
                format!("{:.1}", r.merged_per_day.get()),
                r.n.get().to_string(),
                r.order_to_merged_median_ms
                    .map_or_else(|| "—".into(), |ms| dur(ms.get())),
                r.through_fleetd_pct
                    .map_or_else(|| "—".into(), |p| pct(p.get())),
            ]);
        }
        lines.push(String::new());
        lines.extend(table(&rows));
    }

    lines.push(String::new());
    if out.merges.is_empty() {
        lines.push("No merges in this range.".into());
    } else {
        lines.push("latest merges".into());
        let rows: Vec<Vec<String>> = out
            .merges
            .iter()
            .take(LISTED)
            .map(|m| {
                vec![
                    format!("  {}", local(m.merged_at.as_str(), zone)),
                    merge_name(m),
                    route_word(m.route).into(),
                    m.order_to_merged_ms
                        .map_or_else(String::new, |ms| dur(ms.get())),
                    m.title
                        .as_ref()
                        .map_or_else(String::new, |t| one_line(t.as_str(), 50)),
                ]
            })
            .collect();
        // Left-aligned text after the date; only the order time is a number.
        let widths: Vec<usize> = (0..5)
            .map(|c| rows.iter().map(|r| r[c].chars().count()).max().unwrap_or(0))
            .collect();
        for r in &rows {
            let cell = |c: usize| format!("{:<w$}", r[c], w = widths[c]);
            let order = format!("{:>w$}", r[3], w = widths[3]);
            lines.push(
                format!("{}  {}  {}  {order}  {}", cell(0), cell(1), cell(2), r[4])
                    .trim_end()
                    .to_owned(),
            );
        }
        let total = out.merges_total.get() as usize;
        if total > LISTED {
            lines.push(format!("  and {} more (--json lists them)", total - LISTED));
        }
    }

    let c = &out.coverage;
    lines.push(String::new());
    if c.repos.is_empty() {
        lines.push("read from: no repos yet (merges are read from the merge train's repos)".into());
    } else {
        lines.push("read from".into());
        for r in c.repos.iter() {
            let mut line = format!("  {}: {}", r.repo.as_str(), host_word(r.host));
            if let Some(at) = &r.last_read {
                line.push_str(&format!(", read {}", local(at.as_str(), zone)));
            }
            if let Some(at) = &r.known_since {
                line.push_str(&format!(", merges known since {}", day(at.as_str())));
            }
            lines.push(line);
        }
    }
    for s in c.stale.iter() {
        lines.push(format!("  STALE {}: {}", s.repo.as_str(), s.reason));
    }
    lines.join("\n")
}

/// `fleetd metrics …`: exit 0, 1 when the hub refused the call, 2 on bad arguments, 3 when it refused the key, 4 when
/// it cannot be reached.
pub async fn metrics_command(argv: &[String]) -> u8 {
    let zone = crate::hub::attention::hub_zone();
    let args = match parse_metrics_args(argv, Utc::now(), zone) {
        Ok(args) => args,
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{METRICS_USAGE}");
            return 2;
        }
    };
    let mut hub = match Hub::connect(&args.hub, args.home.as_deref(), "metrics").await {
        Ok(hub) => hub,
        Err(code) => return code,
    };
    match run(&mut hub, &args, zone).await {
        Ok(()) => 0,
        Err(code) => code,
    }
}

async fn run(hub: &mut Hub, args: &MetricsArgs, zone: Tz) -> Result<(), u8> {
    if let Some(days) = args.retention {
        let set = hub
            .call("metrics_retention_set", json!({ "retentionDays": days }))
            .await?;
        println!("landed changes are kept {} days", set["retentionDays"]);
        return Ok(());
    }
    let mut input = json!({ "since": args.since, "tz": zone.name() });
    let mut title = String::new();
    if !args.project.is_empty() {
        let listed = hub.call("project_get", json!({})).await?;
        let projects = listed["projects"].as_array().cloned().unwrap_or_default();
        let project_ref = match resolve_project(&args.project, &projects) {
            Ok(project_ref) => project_ref,
            Err(error) => {
                eprintln!("fleetd metrics: {error}");
                return Err(2);
            }
        };
        title = projects
            .iter()
            .find(|p| {
                p["machineId"] == project_ref["machineId"]
                    && p["projectId"] == project_ref["projectId"]
            })
            .and_then(|p| p["title"].as_str())
            .unwrap_or(&args.project)
            .to_owned();
        input["projectRef"] = project_ref;
    }
    if args.json {
        println!("{}", hub.call("metrics_get", input).await?);
        return Ok(());
    }
    let got: MetricsGetOutput = hub.typed("metrics_get", input).await?;
    println!("{}", render(&title, args.days, &got, zone));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn arguments_and_the_days() {
        let parse = |a: &[&str]| parse_metrics_args(&argv(a), now(), Tz::UTC);
        let fleet = parse(&[]).unwrap();
        assert_eq!(
            (fleet.project.as_str(), fleet.days, fleet.json, fleet.hub),
            ("", 30, false, None)
        );
        assert_eq!(
            fleet.since, "2026-09-26T00:00:00.000Z",
            "30 days, today included"
        );
        let one = parse(&["--project", "storefront", "--days", "1", "--json"]).unwrap();
        assert_eq!(
            (one.project.as_str(), one.since.as_str(), one.json),
            ("storefront", "2026-10-25T00:00:00.000Z", true)
        );
        // Midnight in the zone: Berlin is on summer time until the 25th's 03:00.
        let berlin = parse_metrics_args(
            &argv(&["--days", "7"]),
            now(),
            "Europe/Berlin".parse().unwrap(),
        )
        .unwrap();
        assert_eq!(berlin.since, "2026-10-18T22:00:00.000Z");
        assert_eq!(parse(&["--retention", "30"]).unwrap().retention, Some(30));
        for bad in [
            &["--days", "0"][..],
            &["--days", "401"],
            &["--days", "7d"],
            &["--retention", "29"],
            &["--retention", "401"],
            &["storefront"],
            &["--hub", "http://h"],
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
    }

    fn output(extra: Value) -> MetricsGetOutput {
        let spark = json!([]);
        let mut v = json!({
            "since": "2026-10-19T00:00:00.000Z", "until": "2026-10-25T12:00:00.000Z",
            "tiles": {
                "merged": { "perDay": 0.9230769, "n": 6, "previousPerDay": 0.5,
                    "byRoute": { "train": 3, "fleetdByHand": 1, "outside": 1, "direct": 1 }, "spark": spark },
                "orderToMerged": { "medianMs": 11_400_000, "p90Ms": 68_400_000, "n": 4, "fromOpened": 1, "noOrder": 2,
                    "prOpenMedianMs": 3_600_000, "spark": spark },
                "human": { "totalMs": 0, "lowMs": 0, "prs": 4, "outsideTotalMs": 0, "outsidePrs": 2, "spark": spark },
                "throughFleetd": { "pct": 50.0, "madeByFleetdPct": 66.6667, "n": 6, "spark": spark,
                    "lines": [{ "route": "train", "additions": 120, "deletions": 30 }] },
            },
            "days": [
                { "day": "2026-10-24", "merged": { "train": 3, "fleetdByHand": 1, "outside": 1, "direct": 1 },
                  "notCounted": [{ "why": "bot", "n": 2 }], "human": [] },
            ],
            "merges": [
                { "repo": "github.com/acme/web", "prNumber": 212, "route": "train", "mergedAt": "2026-10-24T14:02:00.000Z",
                  "title": "Add the login page", "orderToMergedMs": 11_400_000, "touches": 0 },
                { "repo": "github.com/acme/web", "sha": "5c4cc175aa00000000000000000000000000beef", "route": "direct",
                  "mergedAt": "2026-10-24T09:30:00.000Z", "touches": 0 },
            ],
            "mergesTotal": 6,
            "coverage": {
                "repos": [{ "repo": "github.com/acme/web", "host": "github", "lastRead": "2026-10-25T11:58:00.000Z",
                            "knownSince": "2026-09-25T08:00:00.000Z" }],
                "stale": [], "invisible": [],
            },
        });
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_project_prints_its_four_numbers_routes_and_merges() {
        let text = render("storefront", 7, &output(json!({})), Tz::UTC);
        let expected = "\
storefront: last 7 days, 2026-10-19 to 2026-10-25 (UTC)

merged per day         0.9  6 in 7 days · was 0.5
order to merged      3h10m  median · p90 19h00m · 4 PRs (1 timed from when the lead opened the order) · 2 merged with no order
your minutes per PR      —  not counted yet
through fleetd         50%  67% made by fleetd

by route                         n     lines
  through fleetd                 3  +120 −30
  made by fleetd, merged by you  1
  merged outside fleetd          1
  pushed straight                1
  not counted: 2 bot PRs

latest merges
  2026-10-24 14:02  github.com/acme/web#212       through fleetd   3h10m  Add the login page
  2026-10-24 09:30  github.com/acme/web@5c4cc175  pushed straight

read from
  github.com/acme/web: GitHub, read 2026-10-25 11:58, merges known since 2026-09-25";
        assert_eq!(text, expected);
    }

    /// Until the hub counts the person's minutes they read "—", never "0m"; once it does, the estimate and its floor.
    #[test]
    fn your_minutes_are_never_a_zero_the_hub_did_not_count() {
        let text = render("storefront", 7, &output(json!({})), Tz::UTC);
        let line = text
            .lines()
            .find(|l| l.starts_with("your minutes"))
            .unwrap();
        assert!(line.contains("—  not counted yet"), "{line}");
        assert!(!line.contains("0s") && !line.contains("0m"), "{line}");

        let counted = |human: Value| {
            let mut out = output(json!({}));
            out.tiles.human = serde_json::from_value(human).unwrap();
            human_cells(&out.tiles.human)
        };
        let spark = json!([]);
        assert_eq!(
            counted(
                json!({ "perPrMs": 360_000, "totalMs": 1_440_000, "lowMs": 1_080_000, "prs": 4,
                            "outsideTotalMs": 0, "outsidePrs": 2, "spark": spark })
            ),
            (
                "≈ 6m".to_owned(),
                "≈ 24m in all (at least 18m) over 4 PRs · from what fleetd sees".to_owned()
            )
        );
        assert_eq!(
            counted(
                json!({ "totalMs": 600_000, "lowMs": 300_000, "prs": 0, "outsideTotalMs": 0, "outsidePrs": 0,
                            "spark": spark })
            ),
            (
                "—".to_owned(),
                "no PRs made by fleetd · ≈ 10m in all".to_owned()
            )
        );
    }

    #[test]
    fn the_fleet_lists_its_repos_and_an_empty_range_says_so() {
        let spark = json!([]);
        let fleet = output(json!({
            "tiles": {
                "merged": { "perDay": 0.0, "n": 0, "byRoute": { "train": 0, "fleetdByHand": 0, "outside": 0, "direct": 0 },
                    "spark": spark },
                "orderToMerged": { "n": 0, "fromOpened": 0, "noOrder": 0, "spark": spark },
                "human": { "totalMs": 0, "lowMs": 0, "prs": 0, "outsideTotalMs": 0, "outsidePrs": 0, "spark": spark },
                "throughFleetd": { "n": 0, "lines": [], "spark": spark },
            },
            "days": [], "merges": [], "mergesTotal": 0,
            "repos": [{ "repo": "gitlab.example.com/team/api", "projects": [], "mergedPerDay": 0.0, "n": 0,
                        "spark": spark }],
            "coverage": { "repos": [], "invisible": [],
                "stale": [{ "repo": "gitlab.example.com/team/api", "since": "2026-10-25T11:02:00.000Z",
                            "reason": "GitHub not read since 11:02: `gh` is signed out" }] },
        }));
        let text = render("", 7, &fleet, Tz::UTC);
        assert!(text.starts_with("fleet: last 7 days"), "{text}");
        for want in [
            "merged per day       0.0  0 in 7 days",
            "order to merged        —  no merged PR belongs to an order",
            "through fleetd         —  nothing merged",
            "  gitlab.example.com/team/api      0.0  0                —               —",
            "No merges in this range.",
            "read from: no repos yet",
            "  STALE gitlab.example.com/team/api: GitHub not read since 11:02: `gh` is signed out",
        ] {
            assert!(text.contains(want), "{want:?} not in\n{text}");
        }
        assert!(!text.contains("not counted:"), "{text}");
    }
}

#[cfg(test)]
mod against_a_hub {
    use std::sync::Arc;

    use crate::clock::SystemClock;
    use crate::hub::api::{self, HubConfig, Listen};
    use crate::hub::store::HubDb;
    use fleetd_contracts::auth::{Grant, KeyKind};
    use fleetd_contracts::ids::MachineId;
    use serde_json::json;

    /// Scripts read the exit code: the fleet and a project there is read 0, a project there isn't 2, and the
    /// retention needs an admin key, 1 when the hub refuses it.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_fleet_and_a_project_exit_0_an_unknown_project_2() {
        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
        };
        let hub = crate::hub::serve::build_on(
            HubDb::open_memory().unwrap(),
            config,
            Arc::new(SystemClock),
        )
        .unwrap();
        hub.store
            .projects_upsert_many(
                &MachineId::unchecked("devbox"),
                &[serde_json::from_value(json!({
                    "machineId": "devbox", "projectId": "storefront", "title": "storefront",
                    "workspaceRoot": "/work/storefront",
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 },
                    "lastActivityAt": "2026-10-18T10:00:00.000Z",
                }))
                .unwrap()],
            )
            .unwrap();
        let grants: Vec<Grant> =
            serde_json::from_value(json!([{ "role": "read", "machines": "*" }])).unwrap();
        let key = hub
            .auth
            .create_key("test", &grants, KeyKind::Agent)
            .unwrap()
            .key;
        let key_file = home.path().join("read.key");
        std::fs::write(&key_file, format!("{key}\n")).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let served = tokio::spawn(crate::hub::http::serve(
            listener,
            hub.clone(),
            Arc::new(api::registry()),
        ));
        let metrics = |extra: &[&str]| {
            let mut argv: Vec<String> = ["--hub", &url, "--key-file", key_file.to_str().unwrap()]
                .map(str::to_owned)
                .to_vec();
            argv.extend(extra.iter().map(|s| s.to_string()));
            async move { super::metrics_command(&argv).await }
        };
        assert_eq!(metrics(&[]).await, 0);
        assert_eq!(
            metrics(&["--project", "storefront", "--days", "7"]).await,
            0
        );
        assert_eq!(metrics(&["--project", "storefront", "--json"]).await, 0);
        assert_eq!(metrics(&["--project", "nope"]).await, 2, "no such project");
        assert_eq!(
            metrics(&["--retention", "90"]).await,
            1,
            "a read key can't set it"
        );
        served.abort();
    }
}
