//! A pull request's current head commit, from GitHub through the `gh` CLI on the hub machine.
use crate::hub::checks::GhRunner;
use crate::hub::checks::ports::BoxFuture;
use regex::Regex;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PrHeadError {
    pub pr: String,
    pub message: String,
}

pub trait PrHeads: Send + Sync + 'static {
    fn head_sha<'a>(&'a self, pr_url: &'a str) -> BoxFuture<'a, Result<String, PrHeadError>>;
}

static PULLS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^https?://github\.com/([^/\s]+)/([^/\s]+)/pulls?/(\d+)/?(?:[?#].*)?$")
        .expect("pulls regex")
});
static SHA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$").expect("sha regex"));

/// `repos/<owner>/<repo>/pulls/<n>` for a github.com PR URL.
pub fn pulls_path(pr_url: &str) -> Option<String> {
    let m = PULLS.captures(pr_url.trim())?;
    Some(format!("repos/{}/{}/pulls/{}", &m[1], &m[2], &m[3]))
}

/// `gh api <path> --jq .head.sha`, 15 s at most.
pub struct GhPrHeads {
    pub runner: Arc<dyn GhRunner>,
}

impl PrHeads for GhPrHeads {
    fn head_sha<'a>(&'a self, pr: &'a str) -> BoxFuture<'a, Result<String, PrHeadError>> {
        Box::pin(async move {
            let fail = |message: String| PrHeadError {
                pr: pr.to_owned(),
                message: crate::hub::checks::utf16_prefix(&message, 500).to_owned(),
            };
            let Some(path) = pulls_path(pr) else {
                return Err(PrHeadError {
                    pr: pr.to_owned(),
                    message: "not a github.com pull request URL".into(),
                });
            };
            let args = vec![
                "api".into(),
                path.clone(),
                "--jq".into(),
                ".head.sha".into(),
            ];
            let out =
                match tokio::time::timeout(Duration::from_secs(15), self.runner.run(args)).await {
                    Err(_) => return Err(fail(format!("gh api {path}: timed out"))),
                    Ok(Err(e)) => return Err(fail(format!("gh api {path}: {}", e.0))),
                    Ok(Ok(out)) => out,
                };
            let sha = out.stdout.trim().to_lowercase();
            if out.exit_code != 0 || !SHA.is_match(&sha) {
                let stderr = out.stderr.trim();
                let reason = if !stderr.is_empty() {
                    stderr.to_owned()
                } else if out.exit_code != 0 {
                    format!("Command failed: gh api {path} --jq .head.sha")
                } else {
                    format!(
                        "unexpected output: {}",
                        crate::hub::checks::utf16_prefix(&sha, 80)
                    )
                };
                return Err(fail(format!("gh api {path}: {reason}")));
            }
            Ok(sha)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::pulls_path;

    #[test]
    fn rest_path_of_a_github_pr_only() {
        assert_eq!(
            pulls_path("https://github.com/wynn-dev/lab/pull/7").as_deref(),
            Some("repos/wynn-dev/lab/pulls/7")
        );
        assert_eq!(
            pulls_path("https://github.com/wynn-dev/lab/pull/7/files"),
            None
        );
        assert_eq!(
            pulls_path("https://gitlab.com/o/r/-/merge_requests/3"),
            None
        );
    }
}
