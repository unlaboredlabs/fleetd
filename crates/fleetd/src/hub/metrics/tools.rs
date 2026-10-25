//! `metrics_get` and `metrics_retention_set`. A project's view covers its repos (the trains it owns, its Changes'
//! repos and the merges it owns), with every landed change on them, whoever's they are; the fleet's covers every
//! repo a caller can read on some machine, each counted once.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use chrono_tz::Tz;
use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::mcp::{
    ErrorCode, MetricsGetInput, MetricsGetOutput, MetricsRetentionSetInput,
    MetricsRetentionSetOutput,
};
use fleetd_contracts::metrics::{
    GitHost, MetricsComparePeriod, MetricsCoverage, RemoteRepo, RepoCoverage, RepoStale,
};
use fleetd_contracts::prim::{Count, Line, List};
use rusqlite::Connection;

use super::compute::{self, Period};
use super::human;
use super::no_host;
use super::store::{self, MergeRow, RepoRow, TouchRow};
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, allows_everywhere, require};
use crate::hub::status::fresh;
use crate::hub::store::{StoreError, iso_ms, now_ms, parse_ms};

/// Landed changes listed per read, newest first.
pub const MAX_MERGES: usize = 1000;
const MAX_REPOS: usize = 200;

/// What fleetd can't see of the person's time (design §3.4), for the info sheet.
const INVISIBLE: &[&str] = &[
    "Thinking and planning away from the keyboard, meetings and chat outside fleetd.",
    "Time in an editor or IDE, or a Claude Code session not registered with fleetd.",
    "Reading on the git host's website without leaving a review or comment.",
    "How long a review took: git hosts keep only when it was submitted.",
    "Work on machines with no fleetd node, or on a phone.",
    "Typing in your own Claude Code sessions: fleetd doesn't read their transcripts.",
    "Reading in the app, until the app reports when it is in use.",
];

pub fn register(tools: &mut Registry) {
    tools.add("metrics_get", metrics_get);
    tools.add("metrics_retention_set", metrics_retention_set);
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new(ErrorCode::Invalid, message)
}

fn ms_of(t: &Timestamp) -> Result<i64, ToolError> {
    parse_ms(t.as_str()).ok_or_else(|| invalid(format!("{} is not an ISO time", t.as_str())))
}

/// Projects by (machine, project), in order.
pub type Projects = BTreeMap<String, BTreeSet<(String, String)>>;

/// Every repo the metrics know, with the projects that have it: their checkouts' origins, the trains they own, their
/// Changes' repos and the merges they own.
pub fn repo_projects(c: &Connection) -> Result<Projects, StoreError> {
    let mut out = Projects::new();
    let mut stmt = c.prepare_cached(
        "SELECT repo, machine_id, project_id, 1 FROM trains
         UNION SELECT DISTINCT repo, machine_id, project_id, 1 FROM changes
         UNION SELECT DISTINCT repo, machine_id, project_id, 0 FROM metric_merges WHERE machine_id IS NOT NULL
         UNION SELECT repo, machine_id, project_id, 0 FROM metric_project_repos
         UNION SELECT repo, NULL, NULL, 0 FROM metric_repos",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, bool>(3)?,
        ))
    })?;
    for row in rows {
        let (repo, m, p, github) = row?;
        let repo = if github {
            store::github_remote(&repo)
        } else {
            repo
        };
        let refs = out.entry(repo).or_default();
        if let (Some(m), Some(p)) = (m, p) {
            refs.insert((m, p));
        }
    }
    Ok(out)
}

fn host(name: &str) -> Option<GitHost> {
    Some(match name {
        "github" => GitHost::GitHub,
        "gitlab" => GitHost::GitLab,
        "gitea" => GitHost::Gitea,
        "bitbucket" => GitHost::Bitbucket,
        "azure_devops" => GitHost::AzureDevOps,
        "git" => GitHost::Git,
        _ => return None,
    })
}

fn host_name(host: GitHost) -> &'static str {
    match host {
        GitHost::GitHub => "GitHub",
        GitHost::GitLab => "GitLab",
        GitHost::Gitea => "Gitea",
        GitHost::Bitbucket => "Bitbucket",
        GitHost::AzureDevOps => "Azure DevOps",
        GitHost::Git | GitHost::Unknown => "Its git log",
    }
}

fn line(text: &str) -> Option<Line<1, 200>> {
    Line::new(crate::node::util::head_utf16(text, 200)).ok()
}

/// What each repo's figures were read from, and the repos whose reads are failing.
fn coverage(
    hub: &Hub,
    repos: &[String],
    stored: &[RepoRow],
    known_since: Option<i64>,
    now: i64,
    tz: Tz,
) -> MetricsCoverage {
    let mut covered = Vec::new();
    let mut stale = Vec::new();
    for repo in repos.iter().take(MAX_REPOS) {
        let Ok(remote) = RemoteRepo::new(repo) else {
            continue;
        };
        let row = stored.iter().find(|r| &r.repo == repo);
        // A train's repo is read by the train's GitHub calls.
        let seen =
            store::train_repo(repo).and_then(|r| hub.status.fresh.view(&fresh::github(r), now));
        let Some(stored) = row.map_or(seen.is_some().then_some(GitHost::GitHub), |r| host(&r.host))
        else {
            continue;
        };
        // A host the sweep has no source for is read from git alone, and says what that can't know.
        let from_git = row.is_some_and(|r| !super::source::has_api(&r.host));
        let host = if from_git { GitHost::Git } else { stored };
        let last_read = seen
            .as_ref()
            .and_then(|v| v.as_of_ms)
            .max(row.and_then(|r| r.last_ok_ms));
        // The train's reads going stale, else the sweep's last read failing.
        let failing = seen
            .as_ref()
            .and_then(|v| v.stale.as_ref())
            .map(|s| (Some(s.since_ms), s.reason.as_str()))
            .or_else(|| {
                row.and_then(|r| r.last_error.as_deref())
                    .map(|why| (last_read, why))
            });
        if let Some((since_ms, why)) = failing {
            let name = host_name(host);
            let reason = match since_ms {
                Some(ms) => format!(
                    "{name} not read since {}: {why}",
                    crate::hub::status::rows::clock(ms, now, tz)
                ),
                None => format!("{name} not read yet: {why}"),
            };
            stale.push(RepoStale {
                repo: remote.clone(),
                since: Timestamp(iso_ms(since_ms.unwrap_or(now))),
                reason: line(&reason)
                    .unwrap_or_else(|| Line::unchecked("Not read from its git host")),
            });
        }
        covered.push(RepoCoverage {
            repo: remote,
            host,
            default_branch: row
                .and_then(|r| r.default_branch.as_deref())
                .and_then(|b| Line::new(b).ok()),
            last_read: last_read.map(|ms| Timestamp(iso_ms(ms))),
            known_since: row
                .and_then(|r| r.backfilled_ms)
                .or(known_since)
                .map(|ms| Timestamp(iso_ms(ms))),
            partly_read: row.is_some_and(|r| r.partly_read).then_some(true),
            unknown: from_git.then(|| {
                List::unchecked(no_host::UNKNOWN.iter().filter_map(|l| line(l)).collect())
            }),
        });
    }
    MetricsCoverage {
        repos: List::unchecked(covered),
        stale: List::unchecked(stale),
        invisible: List::unchecked(INVISIBLE.iter().filter_map(|l| line(l)).collect()),
    }
}

async fn metrics_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: MetricsGetInput,
) -> Result<MetricsGetOutput, ToolError> {
    if let Some(p) = &input.project_ref {
        require(&caller, Role::Read, Some(&p.machine_id))?;
    }
    let now = now_ms(hub.clock.as_ref());
    let tz = Tz::from_str_insensitive(input.tz.as_str()).unwrap_or(Tz::UTC);
    let until = input
        .until
        .as_ref()
        .map(ms_of)
        .transpose()?
        .unwrap_or(now)
        .min(now);
    let since = ms_of(&input.since)?;
    if since >= until {
        return Err(invalid("since must be before until, and before now.")
            .with_fix("Pass a since in the past, e.g. 30 days ago."));
    }
    let since = compute::clamp_since(since, until, tz);
    let prev_since = compute::clamp_since(since - (until - since), since, tz);
    // The person's identities: those recorded (the host's signed-in login) and the commit identity setup wrote.
    let setup = crate::hub::doctor::config::read_hub_config(&hub.config.home).0;
    let (projects, rows, touches, stored, known_since) = hub.db.with(|c| {
        let ids = human::Identities::new(
            store::identities(c)?
                .into_iter()
                .chain(setup.git_identity.as_ref().map(|g| g.email.clone())),
        );
        let mut projects = repo_projects(c)?;
        projects.retain(|_, refs| match &input.project_ref {
            Some(p) => refs.contains(&(p.machine_id.to_string(), p.project_id.to_string())),
            None => {
                allows_everywhere(&caller, Role::Read)
                    || refs
                        .iter()
                        .any(|(m, _)| allows(&caller, Role::Read, Some(&MachineId::unchecked(m))))
            }
        });
        let repos: Vec<String> = projects.keys().cloned().collect();
        let rows = store::merges(c, prev_since, until, Some(&repos))?;
        // A touch recorded up to a review's credit after `until` may have started before it.
        let touches = store::touches(c, prev_since, until + human::REVIEW_MAX_MS)?;
        let touches: Vec<TouchRow> = touches
            .into_iter()
            .filter(|t| {
                let repo = t.repo.as_ref().is_some_and(|r| projects.contains_key(r));
                let project = t.machine_id.as_deref().zip(t.project_id.as_deref());
                repo || match (&input.project_ref, project) {
                    (Some(p), Some((m, pid))) => {
                        p.machine_id.as_str() == m && p.project_id.as_str() == pid
                    }
                    (Some(_), None) => false,
                    (None, Some((m, _))) => {
                        allows(&caller, Role::Read, Some(&MachineId::unchecked(m)))
                    }
                    (None, None) => allows_everywhere(&caller, Role::Read),
                }
            })
            .filter(|t| human::attributed(t, &ids))
            .collect();
        let known = crate::hub::time::store::cursor(c, store::KNOWN_SINCE)?;
        Ok((projects, rows, touches, store::repos(c)?, known))
    })?;
    let repos: Vec<String> = projects.keys().cloned().collect();
    // A read asks the sweep for these repos' latest; it answers with what is stored now.
    hub.metrics.sweep.want(&repos);
    let (cur_rows, prev_rows): (Vec<MergeRow>, Vec<MergeRow>) =
        rows.into_iter().partition(|r| r.merged_ms >= since);
    let days = compute::days(since, until, tz);
    let prev_days = compute::days(prev_since, since, tz);
    let cur = Period {
        rows: &cur_rows,
        touches: &touches,
        days: &days,
    };
    let prev = Period {
        rows: &prev_rows,
        touches: &touches,
        days: &prev_days,
    };
    // The previous period counts only when every repo's merges were known that far back.
    let known_from = repos
        .iter()
        .map(|r| {
            stored
                .iter()
                .find(|s| &s.repo == r)
                .and_then(|s| s.backfilled_ms)
                .or(known_since)
        })
        .try_fold(i64::MIN, |acc, k| k.map(|k| acc.max(k)));
    let prev_known = known_from.is_some_and(|k| k <= prev_since);
    let on_prs = compute::pr_touches(&touches);
    let items: Vec<_> = cur_rows
        .iter()
        .filter_map(|r| compute::merge_item(r, &on_prs))
        .collect();
    let merges_total = items.len();
    Ok(MetricsGetOutput {
        since: Timestamp(iso_ms(since)),
        until: Timestamp(iso_ms(until)),
        tiles: compute::tiles(&cur, prev_known.then_some(&prev)),
        days: List::unchecked(compute::day_list(&cur)),
        merges: List::unchecked(items.into_iter().take(MAX_MERGES).collect()),
        merges_total: Count::unchecked(merges_total as i64),
        repos: input.project_ref.is_none().then(|| {
            List::unchecked(
                compute::repo_rows(&cur, &projects)
                    .into_iter()
                    .take(MAX_REPOS)
                    .collect(),
            )
        }),
        coverage: coverage(&hub, &repos, &stored, known_since, now, tz),
        compare: input.compare.then(|| MetricsComparePeriod {
            since: Timestamp(iso_ms(prev_since)),
            until: Timestamp(iso_ms(since)),
            days: List::unchecked(compute::day_list(&prev)),
        }),
        next: Some(
            "Your minutes count what fleetd sees (chat, approvals, steers, decisions, orders, and reviews and \
             comments on the git host made by your own login); coverage.invisible lists what it can't. A repo read \
             from git alone lists in coverage.repos[].unknown what git can't say, such as who merged. Each repo is \
             read again within a minute of this read."
                .into(),
        ),
        truncated: (merges_total > MAX_MERGES).then_some(true),
    })
}

async fn metrics_retention_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: MetricsRetentionSetInput,
) -> Result<MetricsRetentionSetOutput, ToolError> {
    // Retention prunes every repo's merges, so Admin on one machine is not enough.
    if !allows_everywhere(&caller, Role::Admin) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Metrics retention is fleet-wide: it needs Admin on every machine.",
        )
        .with_fix("Use an Admin key for all machines (`--machines '*'`)."));
    }
    let days = input.retention_days.get();
    hub.db.transaction(|c| store::set_retention_days(c, days))?;
    Ok(MetricsRetentionSetOutput {
        retention_days: input.retention_days,
        next: Some("Landed changes older than this go at the next hourly prune.".into()),
        truncated: None,
    })
}
