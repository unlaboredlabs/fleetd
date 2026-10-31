//! `fleetd work`: the work ledger from a terminal or a hook, for sessions without the hub's MCP. It reads what it
//! needs from the git checkout it runs in (the origin remote, the branch, `user.email`, and the paths changed since
//! the branch left the base plus those not committed), so a claim is one line of intent. It calls work_claim,
//! work_list and work_done over the hub's MCP endpoint, as `fleetd steer` does; any host's remote works.

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::mcp_client::McpClient;
use super::steer::{Failure, call, hub_url};

pub const WORK_USAGE: &str = r#"  work [list] --key-file <key> [--hub <url>]
             what is in flight on this checkout's repo and base: fleetd's agents, PRs on the merge
             train, and people's claims
  work claim "<intent>" [--issue <key>]... [--paths <a,b>] [--anyway]
        [--not-duplicate-of <ids> --why "<reason>"] --key-file <key> [--hub <url>]
             check the intent against the work in flight and claim it, with the repo, branch,
             user.email and changed paths read from this checkout. Exit 0 claimed (or yours: a
             fleetd agent on its own task's branch), 1 taken or a likely duplicate (it says by
             what). Again on the same branch: renews it. --anyway (a human key only) claims taken
             work regardless
  work done [C<n>] [--landing <sha>] --key-file <key> [--hub <url>]
             end your claim as landed (by default the one on this branch); --landing: the commit
             on the base. --key-file defaults to $FLEETD_KEY_FILE
  work drop [C<n>] --key-file <key> [--hub <url>]
             end your claim as dropped (by default the one on this branch): you stop, or leave it
             to someone else
"#;

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// As the hub caps a claim's observed paths.
const CHANGED_MAX: usize = fleetd_contracts::work::OBSERVED_PATHS_MAX;

#[derive(Debug, PartialEq)]
pub enum WorkCommand {
    List,
    Claim {
        title: String,
        issues: Vec<String>,
        paths: Vec<String>,
        anyway: bool,
        not_duplicate_of: Vec<String>,
        why: Option<String>,
    },
    End {
        claim_id: Option<String>,
        landed: bool,
        landing: Option<String>,
    },
}

#[derive(Debug, PartialEq)]
pub struct WorkArgs {
    pub command: WorkCommand,
    pub hub: Option<String>,
    pub home: Option<String>,
    pub key_file: String,
}

fn comma_list(text: Option<&str>) -> Vec<String> {
    text.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `env_key_file` is `$FLEETD_KEY_FILE`.
pub fn parse_work_args(argv: &[String], env_key_file: Option<String>) -> Result<WorkArgs, String> {
    const OPTIONS: &[(&str, Kind)] = &[
        ("hub", Kind::Str),
        ("key-file", Kind::Str),
        ("issue", Kind::Multi),
        ("paths", Kind::Str),
        ("anyway", Kind::Bool),
        ("not-duplicate-of", Kind::Str),
        ("why", Kind::Str),
        ("landing", Kind::Str),
    ];
    let v = args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: true,
        },
    )?;
    let p = &v.positionals;
    let claim_only = ["issue", "paths", "anyway", "not-duplicate-of", "why"];
    let refuse = |names: &[&str], what: &str| match names.iter().find(|n| v.has(n)) {
        Some(name) => Err(format!("--{name} is for {what}")),
        None => Ok(()),
    };
    let command = match p.first().map(String::as_str) {
        None | Some("list") => {
            if p.len() > 1 {
                return Err("expected fleetd work list".into());
            }
            refuse(&claim_only, "work claim")?;
            refuse(&["landing"], "work done")?;
            WorkCommand::List
        }
        Some("claim") => {
            refuse(&["landing"], "work done")?;
            let title = p[1..].join(" ").trim().to_owned();
            if title.is_empty() {
                return Err(r#"expected fleetd work claim "<intent>""#.into());
            }
            let not_duplicate_of = comma_list(v.str("not-duplicate-of"));
            let why = v.string("why").filter(|s| !s.trim().is_empty());
            if !not_duplicate_of.is_empty() && why.is_none() {
                return Err(
                    r#"--not-duplicate-of needs --why "<how it is different work>""#.into(),
                );
            }
            WorkCommand::Claim {
                title,
                issues: v.multi("issue"),
                paths: comma_list(v.str("paths")),
                anyway: v.flag("anyway"),
                not_duplicate_of,
                why,
            }
        }
        Some(verb @ ("done" | "drop")) => {
            refuse(&claim_only, "work claim")?;
            if verb == "drop" && v.has("landing") {
                return Err("--landing is for work done".into());
            }
            let claim_id = match &p[1..] {
                [] => None,
                [id] if is_claim_id(id) => Some(id.clone()),
                _ => return Err(format!("expected fleetd work {verb} [C<n>]")),
            };
            WorkCommand::End {
                claim_id,
                landed: verb == "done",
                landing: v.string("landing"),
            }
        }
        Some(other) => return Err(format!("unknown work command '{other}'")),
    };
    let key_file = v
        .string("key-file")
        .or(env_key_file)
        .filter(|s| !s.is_empty())
        .ok_or("--key-file (or FLEETD_KEY_FILE) is required: the key says whose claim it is. The one Claude Code \
                uses for the hub's MCP will do")?;
    Ok(WorkArgs {
        command,
        hub: v.string("hub").filter(|s| !s.is_empty()),
        home: None,
        key_file,
    })
}

fn is_claim_id(id: &str) -> bool {
    fleetd_contracts::work::ClaimId::new(id).is_ok()
}

// ---- what the checkout says ----

/// What `fleetd work` reads from the checkout it runs in.
#[derive(Debug, Default, PartialEq)]
pub struct GitFacts {
    /// `remote.origin.url`, as configured.
    pub remote: String,
    /// `origin/HEAD`'s branch; absent when the clone doesn't record it (the hub then picks).
    pub base: Option<String>,
    /// The checked-out branch; absent when detached.
    pub branch: Option<String>,
    pub email: Option<String>,
    pub head: Option<String>,
    /// Changed since the branch left `origin/<base>` (or since HEAD without one), staged or not, and untracked.
    pub changed: Vec<String>,
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn lines(text: Option<String>) -> Vec<String> {
    text.unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The checkout's facts; an error when `dir` is not a git checkout with an origin remote.
pub fn git_facts(dir: &Path) -> Result<GitFacts, String> {
    if git(dir, &["rev-parse", "--git-dir"]).is_none() {
        return Err(format!("{} is not in a git checkout", dir.display()));
    }
    let remote = git(dir, &["config", "--get", "remote.origin.url"])
        .filter(|r| !r.is_empty())
        .ok_or("this checkout has no origin remote: fleetd knows a repo by its origin")?;
    let base = git(
        dir,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .and_then(|b| b.strip_prefix("origin/").map(str::to_owned));
    let branch =
        git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).filter(|b| !b.is_empty());
    let email = git(dir, &["config", "--get", "user.email"]).filter(|e| !e.is_empty());
    let head = git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"]);
    let since = base
        .as_ref()
        .and_then(|b| git(dir, &["merge-base", "HEAD", &format!("origin/{b}")]))
        .or_else(|| head.clone());
    let mut changed = BTreeSet::new();
    if let Some(since) = &since {
        changed.extend(lines(git(dir, &["diff", "--name-only", since])));
    }
    changed.extend(lines(git(
        dir,
        &["ls-files", "--others", "--exclude-standard"],
    )));
    Ok(GitFacts {
        remote,
        base,
        branch,
        email,
        head,
        changed: changed.into_iter().take(CHANGED_MAX).collect(),
    })
}

/// work_claim's input from the checkout and the command. A branch that is the base is no work branch.
pub fn claim_input(facts: &GitFacts, command: &WorkCommand) -> Value {
    let WorkCommand::Claim {
        title,
        issues,
        paths,
        anyway,
        not_duplicate_of,
        why,
    } = command
    else {
        return Value::Null;
    };
    let mut input = json!({ "repo": facts.remote, "title": title, "changed": facts.changed });
    let set = |input: &mut Value, key: &str, value: Value| {
        input[key] = value;
    };
    if let Some(base) = &facts.base {
        set(&mut input, "base", json!(base));
    }
    if let Some(branch) = facts
        .branch
        .as_ref()
        .filter(|b| Some(*b) != facts.base.as_ref())
    {
        set(&mut input, "branch", json!(branch));
    }
    if let Some(email) = &facts.email {
        set(&mut input, "authorEmail", json!(email));
    }
    if let Some(head) = &facts.head {
        set(&mut input, "headSha", json!(head));
    }
    if !issues.is_empty() {
        let keys: Vec<Value> = issues.iter().map(|i| json!({ "issue": i })).collect();
        set(&mut input, "keys", json!(keys));
    }
    if !paths.is_empty() {
        set(&mut input, "paths", json!(paths));
    }
    if *anyway {
        set(&mut input, "anyway", json!(true));
    }
    if !not_duplicate_of.is_empty() {
        set(&mut input, "notDuplicateOf", json!(not_duplicate_of));
        set(&mut input, "notDuplicateWhy", json!(why));
    }
    input
}

fn scope_input(facts: &GitFacts) -> Value {
    let mut input = json!({ "repo": facts.remote });
    if let Some(base) = &facts.base {
        input["base"] = json!(base);
    }
    input
}

// ---- what it prints ----

fn st<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `C7  claim active  dark mode toggle  · laptop · app/theme.ts +2`.
pub fn item_line(item: &Value) -> String {
    let mut line = format!(
        "{}  {} {}  {}",
        st(item, "id"),
        st(item, "kind"),
        st(item, "state"),
        st(item, "title")
    );
    if let Some(owner) = item.get("owner") {
        let name = owner
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or(st(owner, "keyId"));
        line.push_str(&format!("  · {name}"));
    } else if let Some(r) = item.get("projectRef") {
        line.push_str(&format!(
            "  · {}/{}",
            st(r, "machineId"),
            st(r, "projectId")
        ));
    }
    let paths: Vec<&str> = item
        .get("paths")
        .and_then(Value::as_array)
        .map(|p| p.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    match paths.as_slice() {
        [] => {}
        [one] => line.push_str(&format!(" · {one}")),
        [first, rest @ ..] => line.push_str(&format!(" · {first} +{}", rest.len())),
    }
    line
}

/// The claim's answer: the hub's message, each match with why, and what to do next.
pub fn claim_lines(answer: &Value) -> Vec<String> {
    let mut out = vec![st(answer, "message").to_owned()];
    let warning = st(answer, "warning");
    if !warning.is_empty() {
        out.push(format!("warning: {warning}"));
    }
    for m in answer
        .get("matches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        out.push(format!(
            "  {:<6} {}  ({})",
            st(m, "strength"),
            item_line(&m["item"]),
            st(m, "why")
        ));
    }
    let next = st(answer, "next");
    if !next.is_empty() {
        out.push(format!("next: {next}"));
    }
    out
}

/// 0 claimed, renewed or yours, 1 taken or a likely duplicate.
pub fn exit_for_status(status: &str) -> u8 {
    match status {
        "claimed" | "renewed" | "yours" => 0,
        _ => 1,
    }
}

/// The active claim on `branch` among work_list's items: what `work done` ends when given no id.
pub fn claim_on_branch(items: &[Value], branch: &str) -> Option<String> {
    let on: Vec<&Value> = items
        .iter()
        .filter(|i| st(i, "kind") == "claim" && st(i, "state") == "active")
        .filter(|i| {
            i.get("keys")
                .and_then(Value::as_array)
                .is_some_and(|keys| keys.iter().any(|k| st(k, "branch") == branch))
        })
        .collect();
    match on.as_slice() {
        [one] => Some(st(one, "id").to_owned()),
        _ => None,
    }
}

// ---- running it ----

async fn run(args: WorkArgs, dir: &Path) -> Result<u8, Failure> {
    let facts = git_facts(dir).map_err(Failure::Refused)?;
    let key = std::fs::read_to_string(&args.key_file)
        .map(|k| k.trim().to_owned())
        .map_err(|error| Failure::Refused(format!("cannot read --key-file: {error}")))?;
    let url = hub_url(args.hub, args.home.as_deref()).map_err(Failure::Unreachable)?;
    let mut client = McpClient::connect(&url, &key, "fleetd-work", Duration::from_secs(15)).await?;
    match &args.command {
        WorkCommand::List => {
            let list = call(&mut client, "work_list", scope_input(&facts), CALL_TIMEOUT).await?;
            let scope = &list["scope"];
            let items = list["items"].as_array().cloned().unwrap_or_default();
            println!(
                "{} in flight on {} {}",
                items.len(),
                st(scope, "repoKey"),
                st(scope, "base")
            );
            for item in &items {
                println!("  {}", item_line(item));
            }
            let warning = st(&list, "warning");
            if !warning.is_empty() {
                println!("warning: {warning}");
            }
            Ok(0)
        }
        WorkCommand::Claim { .. } => {
            let input = claim_input(&facts, &args.command);
            let answer = call(&mut client, "work_claim", input, CALL_TIMEOUT).await?;
            for line in claim_lines(&answer) {
                println!("{line}");
            }
            Ok(exit_for_status(st(&answer, "status")))
        }
        WorkCommand::End {
            claim_id,
            landed,
            landing,
        } => {
            let claim_id = match claim_id {
                Some(id) => id.clone(),
                None => {
                    let branch = facts.branch.clone().ok_or_else(|| {
                        Failure::Refused(
                            "no branch is checked out: pass the claim's id (C<n>)".into(),
                        )
                    })?;
                    let list =
                        call(&mut client, "work_list", scope_input(&facts), CALL_TIMEOUT).await?;
                    let items = list["items"].as_array().cloned().unwrap_or_default();
                    claim_on_branch(&items, &branch).ok_or_else(|| {
                        Failure::Refused(format!(
                            "no one active claim on {branch}: pass its id (fleetd work lists them)"
                        ))
                    })?
                }
            };
            let mut input = json!({
                "claimId": claim_id,
                "outcome": if *landed { "landed" } else { "dropped" },
            });
            // Only as given: a squash or rebase merge lands as another commit than the branch's tip.
            if let Some(landing) = landing {
                input["landing"] = json!(landing);
            }
            let done = call(&mut client, "work_done", input, CALL_TIMEOUT).await?;
            let claim = &done["claim"];
            println!(
                "{} {}: {}",
                st(claim, "claimId"),
                st(claim, "state"),
                st(claim, "title")
            );
            Ok(0)
        }
    }
}

/// `fleetd work …`, in the current directory.
pub async fn work_command(argv: &[String]) -> u8 {
    match parse_work_args(argv, std::env::var("FLEETD_KEY_FILE").ok()) {
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{WORK_USAGE}");
            2
        }
        Ok(args) => {
            let dir = std::env::current_dir().unwrap_or_else(|_| ".".into());
            run(args, &dir)
                .await
                .unwrap_or_else(|f| f.report_as("work"))
        }
    }
}

#[cfg(test)]
pub(crate) async fn run_in(args: WorkArgs, dir: &Path) -> Result<u8, String> {
    run(args, dir).await.map_err(|f| match f {
        Failure::Refused(m) | Failure::Unreachable(m) => m,
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use fleetd_contracts::auth::{Grant, KeyKind};

    use super::*;
    use crate::clock::SystemClock;
    use crate::hub::api::{self, Hub, HubConfig, Listen};
    use crate::hub::store::HubDb;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    fn write(dir: &Path, path: &str, text: &str) {
        let path = dir.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A bare origin with `main` (README.md, app/theme.ts), and a clone of it named `name` with its own user.email.
    fn origin(tmp: &Path) -> PathBuf {
        let origin = tmp.join("origin.git");
        sh(
            tmp,
            &[
                "init",
                "--bare",
                "-q",
                "-b",
                "main",
                origin.to_str().unwrap(),
            ],
        );
        let seed = tmp.join("seed");
        sh(tmp, &["init", "-q", "-b", "main", seed.to_str().unwrap()]);
        write(&seed, "README.md", "shop\n");
        write(&seed, "app/theme.ts", "export const theme = 'light';\n");
        sh(&seed, &["add", "-A"]);
        sh(&seed, &["commit", "-q", "-m", "first"]);
        sh(
            &seed,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        sh(&seed, &["push", "-q", "origin", "main"]);
        origin
    }

    fn clone(tmp: &Path, origin: &Path, name: &str) -> PathBuf {
        let dir = tmp.join(name);
        sh(
            tmp,
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                dir.to_str().unwrap(),
            ],
        );
        sh(
            &dir,
            &["config", "user.email", &format!("{name}@example.com")],
        );
        dir
    }

    /// On `ada/dark-mode`: theme.ts changed and committed, README.md changed and not, app/toggle.ts new.
    fn dark_mode(dir: &Path) {
        sh(dir, &["checkout", "-q", "-b", "ada/dark-mode"]);
        write(dir, "app/theme.ts", "export const theme = 'dark';\n");
        sh(dir, &["commit", "-q", "-am", "dark"]);
        write(dir, "README.md", "shop, now dark\n");
        write(dir, "app/toggle.ts", "export {};\n");
    }

    #[test]
    fn the_checkout_gives_its_remote_base_branch_email_and_every_changed_path() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = origin(tmp.path());
        let laptop = clone(tmp.path(), &origin, "laptop");
        dark_mode(&laptop);
        let facts = git_facts(&laptop).unwrap();
        assert_eq!(facts.remote, origin.to_str().unwrap());
        assert_eq!(facts.base.as_deref(), Some("main"));
        assert_eq!(facts.branch.as_deref(), Some("ada/dark-mode"));
        assert_eq!(facts.email.as_deref(), Some("laptop@example.com"));
        assert_eq!(
            facts.head.as_deref(),
            Some(sh(&laptop, &["rev-parse", "HEAD"]).as_str())
        );
        assert_eq!(
            facts.changed,
            ["README.md", "app/theme.ts", "app/toggle.ts"]
        );

        // On the base, with nothing changed: no work branch, no paths.
        let fresh = clone(tmp.path(), &origin, "fresh");
        let facts = git_facts(&fresh).unwrap();
        assert!(facts.changed.is_empty());
        let input = claim_input(
            &facts,
            &WorkCommand::Claim {
                title: "x".into(),
                issues: vec![],
                paths: vec![],
                anyway: false,
                not_duplicate_of: vec![],
                why: None,
            },
        );
        assert_eq!(input["base"], "main");
        assert!(input.get("branch").is_none(), "the base is no work branch");

        // A clone that doesn't record origin/HEAD leaves the base to the hub.
        sh(&fresh, &["remote", "set-head", "origin", "-d"]);
        assert_eq!(git_facts(&fresh).unwrap().base, None);

        let plain = tmp.path().join("plain");
        sh(tmp.path(), &["init", "-q", plain.to_str().unwrap()]);
        assert!(git_facts(&plain).unwrap_err().contains("no origin remote"));
        // Not a temp dir: one may sit inside a checkout.
        assert!(
            git_facts(Path::new("/"))
                .unwrap_err()
                .contains("not in a git checkout")
        );
    }

    #[test]
    fn claim_takes_the_intent_and_its_flags_and_needs_a_key() {
        let args = parse_work_args(
            &argv(&[
                "claim",
                "dark",
                "mode",
                "toggle",
                "--issue",
                "#12",
                "--issue",
                "SHOP-3",
                "--paths",
                "app/theme.ts, app/settings/**",
                "--not-duplicate-of",
                "C7,T12",
                "--why",
                "mobile only",
            ]),
            Some("/k".into()),
        )
        .unwrap();
        assert_eq!(args.key_file, "/k", "FLEETD_KEY_FILE");
        assert_eq!(
            args.command,
            WorkCommand::Claim {
                title: "dark mode toggle".into(),
                issues: vec!["#12".into(), "SHOP-3".into()],
                paths: vec!["app/theme.ts".into(), "app/settings/**".into()],
                anyway: false,
                not_duplicate_of: vec!["C7".into(), "T12".into()],
                why: Some("mobile only".into()),
            }
        );
        let input = claim_input(
            &GitFacts {
                remote: "ssh://git@git.example.org/acme/shop.git".into(),
                branch: Some("ada/x".into()),
                ..GitFacts::default()
            },
            &args.command,
        );
        assert_eq!(
            input["keys"],
            json!([{ "issue": "#12" }, { "issue": "SHOP-3" }])
        );
        assert_eq!(input["notDuplicateOf"], json!(["C7", "T12"]));
        assert_eq!(input["notDuplicateWhy"], "mobile only");
        assert_eq!(input["branch"], "ada/x");

        let err = |a: &[&str]| parse_work_args(&argv(a), Some("/k".into())).unwrap_err();
        assert!(
            parse_work_args(&argv(&["claim", "x"]), None)
                .unwrap_err()
                .contains("--key-file")
        );
        assert!(err(&["claim"]).contains("<intent>"));
        assert!(err(&["claim", "x", "--not-duplicate-of", "C1"]).contains("--why"));
        assert!(err(&["list", "--anyway"]).contains("work claim"));
        assert!(err(&["drop", "--landing", "abc"]).contains("work done"));
        assert!(err(&["done", "T4"]).contains("C<n>"));
        assert_eq!(
            parse_work_args(&argv(&["--key-file", "f"]), None)
                .unwrap()
                .command,
            WorkCommand::List
        );
        assert_eq!(
            parse_work_args(&argv(&["drop", "C3", "--key-file", "f"]), None)
                .unwrap()
                .command,
            WorkCommand::End {
                claim_id: Some("C3".into()),
                landed: false,
                landing: None
            }
        );
    }

    async fn hub_on_a_port() -> (Arc<Hub>, String, tempfile::TempDir) {
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
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(crate::hub::http::serve(
            listener,
            hub.clone(),
            Arc::new(api::registry()),
        ));
        (hub, url, home)
    }

    fn key_file(hub: &Hub, dir: &Path, name: &str) -> String {
        let grants: Vec<Grant> =
            serde_json::from_value(json!([{ "role": "operate", "machines": "*" }])).unwrap();
        let key = hub
            .auth
            .create_key(name, &grants, KeyKind::Agent)
            .unwrap()
            .key;
        let path = dir.join(format!("{name}.key"));
        std::fs::write(&path, format!("{key}\n")).unwrap();
        path.to_str().unwrap().to_owned()
    }

    fn args(command: &[&str], hub: &str, key_file: &str) -> WorkArgs {
        let mut v = argv(command);
        v.extend(argv(&["--hub", hub, "--key-file", key_file]));
        parse_work_args(&v, None).unwrap()
    }

    #[tokio::test]
    async fn two_checkouts_of_one_bare_origin_claim_the_same_branch_and_the_second_is_told() {
        let tmp = tempfile::tempdir().unwrap();
        let (hub, url, _home) = hub_on_a_port().await;
        let origin = origin(tmp.path());
        let laptop = clone(tmp.path(), &origin, "laptop");
        let desktop = clone(tmp.path(), &origin, "desktop");
        let laptop_key = key_file(&hub, tmp.path(), "laptop");
        let desktop_key = key_file(&hub, tmp.path(), "desktop");
        dark_mode(&laptop);
        sh(&laptop, &["push", "-q", "origin", "ada/dark-mode"]);

        let code = run_in(
            args(&["claim", "dark mode toggle"], &url, &laptop_key),
            &laptop,
        )
        .await;
        assert_eq!(code, Ok(0));
        let c1 = hub
            .work
            .get(&fleetd_contracts::work::ClaimId::unchecked("C1"))
            .unwrap()
            .unwrap();
        assert_eq!(
            c1.repo_key.as_str(),
            origin
                .to_str()
                .unwrap()
                .trim_end_matches(".git")
                .to_lowercase()
        );
        assert_eq!(c1.base.as_str(), "main");
        assert_eq!(
            c1.branch.as_ref().map(|b| b.as_str()),
            Some("ada/dark-mode")
        );
        assert_eq!(
            c1.author_email.as_ref().map(|e| e.as_str()),
            Some("laptop@example.com")
        );
        let observed: Vec<&str> = c1
            .observed
            .as_ref()
            .unwrap()
            .paths
            .iter()
            .map(|p| p.as_str())
            .collect();
        assert_eq!(observed, ["README.md", "app/theme.ts", "app/toggle.ts"]);

        // The desktop picks up the same branch: taken, exit 1, nothing claimed.
        sh(&desktop, &["fetch", "-q", "origin"]);
        sh(&desktop, &["checkout", "-q", "ada/dark-mode"]);
        let code = run_in(
            args(&["claim", "theme switch"], &url, &desktop_key),
            &desktop,
        )
        .await;
        assert_eq!(code, Ok(1));
        assert!(
            hub.work
                .get(&fleetd_contracts::work::ClaimId::unchecked("C2"))
                .unwrap()
                .is_none()
        );

        assert_eq!(
            run_in(args(&["list"], &url, &desktop_key), &desktop).await,
            Ok(0)
        );
        // The desktop can't end the laptop's claim; the laptop ends the one on its branch.
        assert!(
            run_in(args(&["drop", "C1"], &url, &desktop_key), &desktop)
                .await
                .unwrap_err()
                .contains("another key")
        );
        assert_eq!(
            run_in(args(&["done"], &url, &laptop_key), &laptop).await,
            Ok(0)
        );
        let c1 = hub
            .work
            .get(&fleetd_contracts::work::ClaimId::unchecked("C1"))
            .unwrap()
            .unwrap();
        assert_eq!(c1.state, fleetd_contracts::work::ClaimState::Landed);
        assert_eq!(
            c1.end.unwrap().landing,
            None,
            "the branch's tip is not what lands after a squash or a rebase"
        );
    }
}
