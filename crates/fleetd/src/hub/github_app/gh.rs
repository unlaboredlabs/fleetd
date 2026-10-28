//! The hub's `gh`, as the App where it can: each run about a repository the App is installed on gets that
//! installation's token in `GH_TOKEN`; any other run, or one while GitHub can't mint a token, uses the hub machine's
//! own `gh` login, as before the App. A run GitHub refuses to the App itself ("Resource not accessible by
//! integration": a permission it lacks, a branch rule that leaves it out) runs once more on the machine's login; any
//! other failure is the run's own.
use std::sync::Arc;

use super::GithubApps;
use crate::hub::train::github::{GhOut, GhRunner, run_gh};
use crate::hub::train::host::BoxFut;

pub struct AppGh {
    apps: Arc<GithubApps>,
    program: String,
}

impl AppGh {
    pub fn new(apps: Arc<GithubApps>) -> Self {
        Self::with_program(apps, "gh")
    }

    /// Runs `program` instead of `gh`: a stand-in in tests.
    pub fn with_program(apps: Arc<GithubApps>, program: impl Into<String>) -> Self {
        Self {
            apps,
            program: program.into(),
        }
    }
}

impl GhRunner for AppGh {
    fn run(&self, args: Vec<String>) -> BoxFut<'_, Result<GhOut, String>> {
        Box::pin(async move {
            let token = match repo_of(&args) {
                Some(repo) => self.apps.token_for(&repo).await,
                None => None,
            };
            let Some(token) = token else {
                return run_gh(&self.program, args, None).await;
            };
            let out = run_gh(&self.program, args.clone(), Some(token.as_str())).await?;
            if out.exit_code != 0 && (refused_app(&out.stderr) || refused_app(&out.stdout)) {
                tracing::warn!(
                    "github app: GitHub refused the App on gh {}; running it on the machine's login",
                    args.first().map(String::as_str).unwrap_or_default()
                );
                return run_gh(&self.program, args, None).await;
            }
            Ok(out)
        })
    }
}

/// GitHub's words when an App's token may not do what was asked.
fn refused_app(text: &str) -> bool {
    text.contains("Resource not accessible by integration")
}

/// The repository (`owner/name`) a `gh` run is about, as the hub's calls name it: `--repo`/`-R`, a `repos/<owner>/
/// <name>` API path, or GraphQL's `owner=` and `name=` fields. None for anything else (`gh api user`).
pub fn repo_of(args: &[String]) -> Option<String> {
    let mut owner = None;
    let mut name = None;
    let mut it = args.iter().peekable();
    while let Some(arg) = it.next() {
        if arg == "--repo" || arg == "-R" {
            return it.next().filter(|r| is_repo(r)).cloned();
        }
        if let Some(r) = arg.strip_prefix("--repo=") {
            return is_repo(r).then(|| r.to_owned());
        }
        if arg == "-f" || arg == "-F" {
            if let Some(field) = it.peek() {
                if let Some(o) = field.strip_prefix("owner=") {
                    owner = Some(o.to_owned());
                } else if let Some(n) = field.strip_prefix("name=") {
                    name = Some(n.to_owned());
                }
            }
            it.next();
            continue;
        }
        let path = arg.strip_prefix('/').unwrap_or(arg);
        if let Some(rest) = path.strip_prefix("repos/") {
            let mut parts = rest.split(['/', '?']);
            if let (Some(o), Some(n)) = (parts.next(), parts.next()) {
                let repo = format!("{o}/{n}");
                if is_repo(&repo) {
                    return Some(repo);
                }
            }
        }
    }
    let repo = format!("{}/{}", owner?, name?);
    is_repo(&repo).then_some(repo)
}

fn is_repo(r: &str) -> bool {
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    r.split_once('/').is_some_and(|(o, n)| ok(o) && ok(n))
}
