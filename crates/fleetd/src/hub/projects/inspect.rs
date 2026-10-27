//! Pure: GitHub's answers about a repository into a `ProjectInspect`, the line on what the lead will need, the best
//! worker for a clone, and a failed clone's message into a problem with its fix.
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::prim::{Int, Text};
use fleetd_contracts::projects::{
    CiInfo, MergeRules, ProjectAddFailedData, ProjectAddedData, ProjectInspect, ProjectProblem,
    ProjectProblemCode,
};
use fleetd_contracts::sessions::RepoFacts;
use fleetd_contracts::train::GitHubRepo;
use serde_json::Value;

/// What GitHub said, one field per `gh api` read; `None` when that read failed (it becomes a note).
#[derive(Default)]
pub struct GitHubAnswers {
    /// `repos/{repo}`.
    pub repo: Option<Value>,
    /// `repos/{repo}/branches/{default}`.
    pub branch: Option<Value>,
    /// `repos/{repo}/rules/branches/{default}`.
    pub rules: Option<Value>,
    /// `repos/{repo}/rulesets`.
    pub rulesets: Option<Value>,
    /// `repos/{repo}/actions/workflows`.
    pub workflows: Option<Value>,
    /// Reads that failed, each as "what (why)": CI and merge rules are then unknown, not absent.
    pub unread: Vec<String>,
}

fn strs<'a>(v: Option<&'a Value>, key: &str) -> impl Iterator<Item = String> + 'a {
    let key = key.to_owned();
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(move |x| x.get(&key).and_then(Value::as_str).map(str::to_owned))
}

fn push_unique(list: &mut Vec<String>, item: String) {
    if !list.contains(&item) {
        list.push(item);
    }
}

/// `local` is the checkout's own facts, when there is one: its workflow files stand in when GitHub can't be read.
pub fn build(
    repo: Option<&GitHubRepo>,
    gh: &GitHubAnswers,
    local: Option<&RepoFacts>,
    mut notes: Vec<String>,
    gh_ok: bool,
) -> ProjectInspect {
    let default_branch = gh
        .repo
        .as_ref()
        .and_then(|r| r.get("default_branch"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| local.and_then(|l| l.default_branch.clone()));
    let mut ci = CiInfo::default();
    let mut merge = MergeRules {
        squash_allowed: gh
            .repo
            .as_ref()
            .and_then(|r| r.get("allow_squash_merge"))
            .and_then(Value::as_bool),
        ..MergeRules::default()
    };
    match gh.workflows.as_ref().and_then(|w| w.get("workflows")) {
        Some(Value::Array(rows)) => {
            for w in rows {
                // GitHub's own dynamic workflows (Copilot, Dependabot) are not the repo's CI.
                let dynamic = w
                    .get("path")
                    .and_then(Value::as_str)
                    .is_some_and(|p| p.starts_with("dynamic/"));
                if !dynamic
                    && w.get("state").and_then(Value::as_str) == Some("active")
                    && let Some(name) = w.get("name").and_then(Value::as_str)
                {
                    push_unique(&mut ci.workflows, name.to_owned());
                }
            }
        }
        _ => {
            if let Some(l) = local {
                ci.workflows = l.workflow_files.clone();
            }
        }
    }
    if let Some(b) = &gh.branch {
        merge.protected |= b.get("protected").and_then(Value::as_bool) == Some(true);
        let checks = b.pointer("/protection/required_status_checks");
        for c in checks
            .and_then(|c| c.get("contexts"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|c| c.as_str().map(str::to_owned))
        {
            push_unique(&mut ci.required_checks, c);
        }
    }
    let names: Vec<(i64, String)> = gh
        .rulesets
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| Some((r.get("id")?.as_i64()?, r.get("name")?.as_str()?.to_owned())))
        .collect();
    for rule in gh
        .rules
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        merge.protected = true;
        if let Some(id) = rule.get("ruleset_id").and_then(Value::as_i64) {
            let name = names
                .iter()
                .find(|(i, _)| *i == id)
                .map_or_else(|| format!("ruleset {id}"), |(_, n)| n.clone());
            push_unique(&mut merge.rulesets, name);
        }
        let params = rule.get("parameters");
        match rule.get("type").and_then(Value::as_str) {
            Some("required_status_checks") => {
                for c in strs(
                    params.and_then(|p| p.get("required_status_checks")),
                    "context",
                ) {
                    push_unique(&mut ci.required_checks, c);
                }
                if params
                    .and_then(|p| p.get("strict_required_status_checks_policy"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    merge.strict = Some(true);
                }
            }
            Some("pull_request") => {
                let n = params
                    .and_then(|p| p.get("required_approving_review_count"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let prev = merge.required_reviews.as_ref().map_or(0, |r| r.get());
                merge.required_reviews = Some(Int::unchecked(n.max(prev).clamp(0, 10)));
            }
            _ => {}
        }
    }
    if repo.is_some() && gh_ok {
        for what in &gh.unread {
            notes.push(format!("could not read {what}"));
        }
        if gh.repo.is_some() && merge.squash_allowed.is_none() {
            notes.push("merge settings need push access to read".into());
        }
    }
    let mut inspect = ProjectInspect {
        repo: repo.cloned(),
        default_branch,
        ci,
        merge,
        lead_needs: Text::unchecked("ready"),
        notes,
    };
    let line = lead_needs(&inspect, gh_ok, &gh.unread);
    inspect.lead_needs = Text::unchecked(crate::hub::executor::shell_mapper::js_take(&line, 300));
    inspect
}

/// One line for a person: the most important thing the lead and the merge train will need here.
/// What a plain folder's lead can do, as its inspect says it.
pub const FOLDER_NEEDS: &str = "a plain folder with no git: its lead chats, remembers and uses screens here; agents \
                                that change code need a git repo";

/// The inspect of a plain folder: no git, so no repo, branch, CI or merge rules.
pub fn folder() -> ProjectInspect {
    ProjectInspect {
        repo: None,
        default_branch: None,
        ci: CiInfo::default(),
        merge: MergeRules::default(),
        lead_needs: Text::unchecked(FOLDER_NEEDS),
        notes: vec![],
    }
}

pub fn lead_needs(i: &ProjectInspect, gh_ok: bool, unread: &[String]) -> String {
    let branch = i.default_branch.as_deref().unwrap_or("the default branch");
    let Some(repo) = &i.repo else {
        return "no GitHub remote: the lead can work here, but the merge train needs a GitHub repo to open and merge PRs".into();
    };
    if !gh_ok {
        return "gh is not logged in on the hub: run `gh auth login` there so the merge train can open and merge PRs".into();
    }
    if !unread.is_empty() {
        return format!(
            "CI and merge rules unknown: gh on the hub could not read {} on {repo}",
            unread.join(", ")
        );
    }
    if i.merge.squash_allowed == Some(false) {
        return format!(
            "squash merges are off on {repo}: turn them on in its settings, the merge train squash-merges"
        );
    }
    let reviews = i.merge.required_reviews.as_ref().map_or(0, |r| r.get());
    if reviews > 0 {
        let s = if reviews == 1 { "" } else { "s" };
        return format!(
            "{branch} needs {reviews} approving review{s}: the train's merges wait for a person to approve"
        );
    }
    if i.ci.workflows.is_empty() && i.ci.required_checks.is_empty() {
        return "no CI found: the merge train holds its PRs until the repo has CI".into();
    }
    if i.ci.required_checks.is_empty() {
        let n = i.ci.workflows.len();
        let s = if n == 1 { "" } else { "s" };
        return format!(
            "CI runs ({n} workflow{s}) but {branch} requires no check: the train still waits for CI on each head"
        );
    }
    let checks = &i.ci.required_checks;
    let named = if checks.len() > 3 {
        format!("{} checks ({}, …)", checks.len(), checks[..2].join(", "))
    } else {
        checks.join(", ")
    };
    format!("ready: {branch} requires {named}; the train waits for them before each squash merge")
}

/// The inspect cut to fit an event's 2 KB of data: the longest list loses half its entries until it fits.
pub fn compact(mut i: ProjectInspect, budget: usize) -> ProjectInspect {
    let size = |i: &ProjectInspect| serde_json::to_string(i).map_or(0, |t| t.len());
    while size(&i) > budget {
        let lists = [
            &mut i.ci.workflows,
            &mut i.ci.required_checks,
            &mut i.merge.rulesets,
            &mut i.notes,
        ];
        let Some(longest) = lists
            .into_iter()
            .max_by_key(|l| l.len())
            .filter(|l| !l.is_empty())
        else {
            break;
        };
        let keep = longest.len() / 2;
        longest.truncate(keep);
    }
    i
}

/// A machine a clone could go to.
pub struct Worker {
    pub machine_id: MachineId,
    pub connected: bool,
    /// Its node understands the repo calls (it is new enough).
    pub capable: bool,
    /// The runner is usable (not degraded).
    pub ready: bool,
    pub running: usize,
    /// load1 / cpus.
    pub load: Option<f64>,
}

/// Connected first, then a usable runner, then the fewest running threads, then the lowest load, then the id.
pub fn best_worker(workers: &[Worker]) -> Option<MachineId> {
    workers
        .iter()
        .filter(|w| w.connected && w.capable)
        .min_by(|a, b| {
            (!a.ready, a.running)
                .cmp(&(!b.ready, b.running))
                .then(
                    a.load
                        .unwrap_or(f64::MAX)
                        .total_cmp(&b.load.unwrap_or(f64::MAX)),
                )
                .then(a.machine_id.as_str().cmp(b.machine_id.as_str()))
        })
        .map(|w| w.machine_id.clone())
}

/// Under the event log's 2 KB of data (it replaces anything larger, addId included, with `{"truncated":true}`).
const EVENT_DATA_MAX: usize = 1900;

fn size<T: serde::Serialize>(v: &T) -> usize {
    serde_json::to_string(v).map_or(usize::MAX, |t| t.len())
}

/// At most `max` bytes, cut at a character boundary, with "…" when cut.
pub fn cut(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max.saturating_sub(3);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// A path's end matters most: "…" and its last `max` bytes.
pub fn cut_path(path: &str, max: usize) -> String {
    if path.len() <= max {
        return path.to_owned();
    }
    let mut start = path.len() - max.saturating_sub(3);
    while !path.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &path[start..])
}

/// `project.added` data that fits the event log, so its addId always arrives.
pub fn fit_added(mut d: ProjectAddedData) -> ProjectAddedData {
    d.title = cut(&d.title, 300);
    d.path = cut_path(&d.path, 500);
    let mut budget = 1500;
    loop {
        d.inspect = compact(d.inspect, budget);
        if size(&d) <= EVENT_DATA_MAX || budget <= 200 {
            return d;
        }
        budget -= 200;
    }
}

/// `project.add_failed` data that fits the event log.
pub fn fit_failed(mut d: ProjectAddFailedData) -> ProjectAddFailedData {
    d.path = cut_path(&d.path, 500);
    d.problem.message = cut(&d.problem.message, 700);
    d.problem.fix = d.problem.fix.map(|f| cut(&f, 400));
    d
}

/// Whether a machine's node can take the repo calls: linked, and new enough to list them in its hello.
pub fn repo_gate(m: &MachineId, connected: bool, capable: bool) -> Result<(), ProjectProblem> {
    if !connected {
        return Err(ProjectProblem {
            code: ProjectProblemCode::MachineOffline,
            message: format!("{m} is offline"),
            fix: Some(format!(
                "Start the node on {m} (fleetd node run) or check its network, then retry"
            )),
        });
    }
    if !capable {
        return Err(ProjectProblem {
            code: ProjectProblemCode::NodeTooOld,
            message: format!("{m}'s node is too old to find, inspect or clone repos"),
            fix: Some(format!("Run fleetd update on {m}, then retry")),
        });
    }
    Ok(())
}

/// A clone's failure, from git's own last line.
pub fn clone_problem(
    message: &str,
    repo: &GitHubRepo,
    machine: &MachineId,
    dest: &str,
) -> ProjectProblem {
    let m = message.to_lowercase();
    let (code, fix) = if (m.contains("repository") && m.contains("not found"))
        || m.contains("could not read username")
        || m.contains("authentication failed")
        || m.contains("terminal prompts disabled")
        || m.contains("permission denied")
    {
        (
            ProjectProblemCode::GhNoAccess,
            format!(
                "On {machine}, run `gh auth login` with an account that can read {repo}, then add it again"
            ),
        )
    } else if m.contains("already exists") {
        (
            ProjectProblemCode::DestExists,
            format!(
                "Add the existing checkout at {dest} on {machine} instead, or clone into another folder"
            ),
        )
    } else if m.contains("no space left") {
        (
            ProjectProblemCode::CloneFailed,
            format!("Free disk space on {machine}, then add it again"),
        )
    } else if m.contains("no answer within") || m.contains("link dropped") {
        (
            ProjectProblemCode::CloneFailed,
            format!(
                "The link to {machine} dropped mid-clone; add it again (a finished checkout is offered for reuse)"
            ),
        )
    } else {
        (
            ProjectProblemCode::CloneFailed,
            format!("Run `git clone https://github.com/{repo} {dest}` on {machine} to see why"),
        )
    };
    ProjectProblem {
        code,
        message: format!("cloning {repo} on {machine} failed: {message}"),
        fix: Some(fix),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn repo() -> GitHubRepo {
        GitHubRepo::new("acme/storefront").unwrap()
    }

    #[test]
    fn reads_ci_and_merge_rules_from_github() {
        let gh = GitHubAnswers {
            repo: Some(json!({ "default_branch": "main", "allow_squash_merge": true })),
            branch: Some(
                json!({ "protected": true, "protection": { "required_status_checks": { "contexts": ["build"] } } }),
            ),
            rules: Some(json!([
                { "type": "required_status_checks", "ruleset_id": 7, "parameters": {
                    "strict_required_status_checks_policy": true,
                    "required_status_checks": [{ "context": "test" }, { "context": "build" }] } },
                { "type": "pull_request", "ruleset_id": 7, "parameters": { "required_approving_review_count": 0 } },
            ])),
            rulesets: Some(json!([{ "id": 7, "name": "main gate" }])),
            workflows: Some(json!({ "workflows": [
                { "name": "CI", "state": "active", "path": ".github/workflows/ci.yml" },
                { "name": "Old", "state": "disabled_manually" },
                { "name": "Copilot", "state": "active", "path": "dynamic/copilot-swe-agent/copilot" } ] })),
            unread: vec![],
        };
        let i = build(Some(&repo()), &gh, None, vec![], true);
        assert_eq!(i.default_branch.as_deref(), Some("main"));
        assert_eq!(i.ci.workflows, vec!["CI"]);
        assert_eq!(i.ci.required_checks, vec!["build", "test"]);
        assert!(i.merge.protected);
        assert_eq!(i.merge.rulesets, vec!["main gate"]);
        assert_eq!(i.merge.strict, Some(true));
        assert_eq!(i.merge.squash_allowed, Some(true));
        assert!(i.notes.is_empty(), "{:?}", i.notes);
        assert_eq!(
            i.lead_needs.as_str(),
            "ready: main requires build, test; the train waits for them before each squash merge"
        );
    }

    #[test]
    fn failed_reads_are_unknown_not_absent() {
        let gh = GitHubAnswers {
            repo: Some(json!({ "default_branch": "main", "allow_squash_merge": true })),
            branch: Some(json!({ "protected": false })),
            rules: Some(json!([])),
            unread: vec!["workflows (HTTP 403: API rate limit exceeded)".into()],
            ..GitHubAnswers::default()
        };
        let i = build(Some(&repo()), &gh, None, vec![], true);
        assert_eq!(
            i.lead_needs.as_str(),
            "CI and merge rules unknown: gh on the hub could not read workflows (HTTP 403: API rate limit exceeded) on acme/storefront"
        );
        assert!(i.notes.iter().any(|n| n.contains("rate limit")));
        let whole = GitHubAnswers {
            unread: vec!["acme/storefront (HTTP 502: Bad Gateway)".into()],
            ..GitHubAnswers::default()
        };
        assert!(
            build(Some(&repo()), &whole, None, vec![], true)
                .lead_needs
                .starts_with("CI and merge rules unknown")
        );
    }

    #[test]
    fn many_checks_are_counted_and_an_event_fits() {
        let checks: Vec<Value> = (0..40)
            .map(|n| json!({ "context": format!("test matrix job number {n}") }))
            .collect();
        let gh = GitHubAnswers {
            repo: Some(json!({ "default_branch": "master", "allow_squash_merge": true })),
            rules: Some(
                json!([{ "type": "required_status_checks", "parameters": { "required_status_checks": checks } }]),
            ),
            ..GitHubAnswers::default()
        };
        let i = build(Some(&repo()), &gh, None, vec![], true);
        assert_eq!(
            i.lead_needs.as_str(),
            "ready: master requires 40 checks (test matrix job number 0, test matrix job number 1, …); the train waits for them before each squash merge"
        );
        let small = compact(i, 1500);
        assert!(serde_json::to_string(&small).unwrap().len() <= 1500);
        assert!(!small.ci.required_checks.is_empty());
        assert_eq!(
            small.lead_needs,
            build(Some(&repo()), &gh, None, vec![], true).lead_needs
        );
    }

    #[test]
    fn says_what_the_lead_will_need() {
        let bare = |gh: GitHubAnswers| build(Some(&repo()), &gh, None, vec![], true);
        let none = GitHubAnswers {
            repo: Some(json!({ "default_branch": "main", "allow_squash_merge": true })),
            branch: Some(json!({ "protected": false })),
            rules: Some(json!([])),
            rulesets: Some(json!([])),
            workflows: Some(json!({ "workflows": [] })),
            unread: vec![],
        };
        assert_eq!(
            bare(none).lead_needs.as_str(),
            "no CI found: the merge train holds its PRs until the repo has CI"
        );

        let no_squash = GitHubAnswers {
            repo: Some(json!({ "default_branch": "main", "allow_squash_merge": false })),
            ..GitHubAnswers::default()
        };
        assert!(
            bare(no_squash)
                .lead_needs
                .starts_with("squash merges are off on acme/storefront")
        );

        let reviews = GitHubAnswers {
            repo: Some(json!({ "default_branch": "trunk" })),
            rules: Some(
                json!([{ "type": "pull_request", "parameters": { "required_approving_review_count": 2 } }]),
            ),
            ..GitHubAnswers::default()
        };
        let i = bare(reviews);
        assert!(
            i.lead_needs.starts_with("trunk needs 2 approving reviews"),
            "{}",
            i.lead_needs
        );
        assert!(i.notes.iter().any(|n| n.contains("merge settings")));

        let local = RepoFacts {
            exists: true,
            is_git: true,
            default_branch: Some("main".into()),
            workflow_files: vec!["ci.yml".into()],
            ..RepoFacts::default()
        };
        let i = build(None, &GitHubAnswers::default(), Some(&local), vec![], true);
        assert!(i.lead_needs.starts_with("no GitHub remote"));
        assert_eq!(i.ci.workflows, vec!["ci.yml"]);

        let i = build(
            Some(&repo()),
            &GitHubAnswers::default(),
            None,
            vec![],
            false,
        );
        assert!(i.lead_needs.starts_with("gh is not logged in on the hub"));
    }

    #[test]
    fn picks_the_least_busy_connected_worker() {
        let w = |id: &str, connected, ready, running, load| Worker {
            machine_id: MachineId::new(id).unwrap(),
            connected,
            capable: true,
            ready,
            running,
            load,
        };
        let best = |ws: &[Worker]| best_worker(ws).map(|m| m.to_string());
        assert_eq!(best(&[]), None);
        assert_eq!(best(&[w("devbox", false, true, 0, None)]), None);
        assert_eq!(
            best(&[
                w("devbox", true, true, 3, Some(0.1)),
                w("buildbox", true, true, 1, Some(0.9))
            ]),
            Some("buildbox".into())
        );
        assert_eq!(
            best(&[
                w("devbox", true, false, 0, None),
                w("buildbox", true, true, 4, None)
            ]),
            Some("buildbox".into())
        );
        assert_eq!(
            best(&[
                w("devbox", true, true, 1, Some(0.5)),
                w("buildbox", true, true, 1, Some(0.2))
            ]),
            Some("buildbox".into())
        );
    }

    #[test]
    fn project_events_always_fit_the_log_with_their_add_id() {
        let long = format!("/home/me/{}/storefront", "é".repeat(490));
        let checks: Vec<Value> = (0..60)
            .map(|n| json!({ "context": format!("a long required check name {n}") }))
            .collect();
        let gh = GitHubAnswers {
            repo: Some(json!({ "default_branch": "main" })),
            rules: Some(
                json!([{ "type": "required_status_checks", "parameters": { "required_status_checks": checks } }]),
            ),
            ..GitHubAnswers::default()
        };
        let added = fit_added(ProjectAddedData {
            add_id: Some(Text::unchecked("08028d03-66c3-4f57-c1f1-967e18cd24f4")),
            title: "t".repeat(200),
            path: long.clone(),
            created: true,
            inspect: build(Some(&repo()), &gh, None, vec!["n".repeat(400); 5], true),
        });
        let text = serde_json::to_string(&added).unwrap();
        assert!(text.len() <= 2048, "{}", text.len());
        assert!(text.contains("08028d03-66c3-4f57-c1f1-967e18cd24f4"));
        assert!(added.path.ends_with("/storefront"));

        let failed = fit_failed(ProjectAddFailedData {
            add_id: Text::unchecked("a1"),
            repo: Some(repo()),
            path: long.clone(),
            problem: clone_problem(
                &"x".repeat(2000),
                &repo(),
                &MachineId::new("devbox").unwrap(),
                &long,
            ),
        });
        let text = serde_json::to_string(&failed).unwrap();
        assert!(text.len() <= 2048, "{}", text.len());
        assert!(text.contains("\"addId\":\"a1\"") && text.contains("clone_failed"));
    }

    #[test]
    fn an_old_node_is_never_sent_repo_calls() {
        let m = MachineId::new("buildbox").unwrap();
        assert_eq!(
            repo_gate(&m, true, false).unwrap_err().code,
            ProjectProblemCode::NodeTooOld
        );
        assert_eq!(
            repo_gate(&m, false, false).unwrap_err().code,
            ProjectProblemCode::MachineOffline
        );
        assert!(repo_gate(&m, true, true).is_ok());
        let old = Worker {
            machine_id: m,
            connected: true,
            capable: false,
            ready: true,
            running: 0,
            load: None,
        };
        let new = Worker {
            machine_id: MachineId::new("devbox").unwrap(),
            connected: true,
            capable: true,
            ready: true,
            running: 9,
            load: None,
        };
        assert_eq!(
            best_worker(&[old, new]).map(|w| w.to_string()),
            Some("devbox".into())
        );
        // A hello from before this release carries no capabilities.
        let hello: fleetd_contracts::node_link::NodeHello = serde_json::from_value(serde_json::json!({
            "machineId": "buildbox", "name": "buildbox", "tags": [], "nodeVersion": "0.1.0", "protocol": 1,
            "pubKey": "k", "sig": "s"
        }))
        .unwrap();
        assert!(hello.capabilities.is_empty());
    }

    #[test]
    fn a_failed_clone_says_how_to_fix_it() {
        let m = MachineId::new("devbox").unwrap();
        let p = clone_problem(
            "repository 'https://github.com/acme/storefront/' not found",
            &repo(),
            &m,
            "/x",
        );
        assert_eq!(p.code, ProjectProblemCode::GhNoAccess);
        assert!(p.fix.unwrap().contains("gh auth login"));
        let p = clone_problem(
            "could not read Username for 'https://github.com': terminal prompts disabled",
            &repo(),
            &m,
            "/x",
        );
        assert_eq!(p.code, ProjectProblemCode::GhNoAccess);
        let p = clone_problem(
            "/home/me/src/storefront already exists",
            &repo(),
            &m,
            "/home/me/src/storefront",
        );
        assert_eq!(p.code, ProjectProblemCode::DestExists);
        let p = clone_problem("early EOF", &repo(), &m, "/x");
        assert_eq!(p.code, ProjectProblemCode::CloneFailed);
        assert!(p.fix.unwrap().contains("git clone"));
    }
}
