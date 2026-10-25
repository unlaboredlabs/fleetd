//! Which PR a write task's result links (D67). The host's PR for the task's branch is the answer; a URL in the
//! report counts only when the host can't be read, and only one on the project's own remote. A URL is never taken
//! for being the last one in the text: a report quotes test fixtures, other repos and other PRs.
use fleetd_contracts::projects::short_remote;

use super::ports::{BranchPrError, PortError};
use super::render::pr_urls;

/// `host` is the host's answer for the branch; `remote` the project's `origin`, shortened ("github.com/acme/shop");
/// `texts` the report, read in order.
pub fn task_pr_url<'a>(
    host: Result<Option<String>, PortError>,
    remote: Option<&str>,
    texts: impl IntoIterator<Item = &'a str>,
) -> Option<String> {
    match host {
        Ok(found) => found,
        Err(_) => {
            let remote = remote?;
            pr_urls(texts)
                .into_iter()
                .rfind(|url| on_remote(url, remote))
        }
    }
}

/// A host's non-2xx answer to a branch's PR lookup (`status` 0 when gh named none): a 5xx, a rate limit or no
/// status at all is worth asking again; any other 4xx (a 401, a 404) isn't.
pub fn host_error(status: u16, message: &str) -> BranchPrError {
    let rate_limited =
        status == 429 || (status == 403 && message.to_lowercase().contains("rate limit"));
    if (400..500).contains(&status) && !rate_limited {
        BranchPrError::Refused(format!("GitHub answered {status}: {message}"))
    } else {
        BranchPrError::Unread(format!("GitHub answered {status}: {message}"))
    }
}

/// Whether `url` is on `remote`: the same host and the same repo path, whatever the host's URL shape. A port on
/// either side (an ssh remote's) is ignored.
pub fn on_remote(url: &str, remote: &str) -> bool {
    let (Some(url), Some(remote)) = (host_and_path(url), host_and_path(remote)) else {
        return false;
    };
    url.0 == remote.0
        && url
            .1
            .strip_prefix(remote.1.as_str())
            .is_some_and(|rest| rest.starts_with('/'))
}

fn host_and_path(text: &str) -> Option<(String, String)> {
    let short = short_remote(text).to_lowercase();
    let (host, path) = short.split_once('/')?;
    let host = host.split(':').next().unwrap_or(host);
    let host = host.strip_prefix("www.").unwrap_or(host);
    let path = path.trim_matches('/');
    (!host.is_empty() && !path.is_empty()).then(|| (host.to_owned(), path.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REMOTE: &str = "github.com/unlaboredlabs/fleetd";
    const REAL: &str = "https://github.com/unlaboredlabs/fleetd/pull/226";

    fn unreadable() -> Result<Option<String>, PortError> {
        Err(PortError::Failed("gh: not logged in".into()))
    }

    /// T43's report: its own PR, then a fixture URL from a test it wrote. The host's answer wins; unread, the
    /// fixture is not the project's remote, so the real PR stays.
    #[test]
    fn a_fixture_url_after_the_real_pr_keeps_the_real_pr() {
        let report = format!(
            "Opened {REAL}.\nThe test feeds https://gitlab.example.com/group/shop/-/merge_requests/9 to the parser."
        );
        assert_eq!(
            task_pr_url(Ok(Some(REAL.into())), Some(REMOTE), [report.as_str()]).as_deref(),
            Some(REAL)
        );
        assert_eq!(
            task_pr_url(unreadable(), Some(REMOTE), [report.as_str()]).as_deref(),
            Some(REAL)
        );
    }

    #[test]
    fn a_report_with_only_a_foreign_url_records_none() {
        let report = "Done; see https://gitlab.example.com/acme/shop/-/merge_requests/42 and \
                      https://github.com/unlaboredlabs/fleetd-lab/pull/3 and https://github.com/other/fleetd/pull/7";
        assert_eq!(task_pr_url(unreadable(), Some(REMOTE), [report]), None);
        assert_eq!(
            task_pr_url(unreadable(), None, [REAL]),
            None,
            "no remote known"
        );
    }

    #[test]
    fn a_branch_with_a_pr_on_the_host_gets_it_even_unnamed() {
        assert_eq!(
            task_pr_url(Ok(Some(REAL.into())), Some(REMOTE), ["All done."]).as_deref(),
            Some(REAL)
        );
    }

    /// The host read fine and the branch has no PR: a URL in the report, even the project's own, is not it.
    #[test]
    fn a_readable_host_without_a_pr_records_none() {
        assert_eq!(task_pr_url(Ok(None), Some(REMOTE), [REAL]), None);
    }

    /// gh not logged in or a 404 ends the lookup; a 5xx, a rate limit or a network failure is asked again.
    #[test]
    fn a_refusal_ends_the_lookup_and_an_outage_is_asked_again() {
        let refused = |e| matches!(e, BranchPrError::Refused(_));
        assert!(refused(host_error(404, "Not Found")));
        assert!(refused(host_error(401, "Bad credentials")));
        assert!(refused(host_error(
            403,
            "Resource not accessible by integration"
        )));
        assert!(!refused(host_error(
            403,
            "API rate limit exceeded for user"
        )));
        assert!(!refused(host_error(429, "secondary rate limit")));
        assert!(!refused(host_error(502, "Bad Gateway")));
        assert!(!refused(host_error(
            0,
            "error connecting to api.github.com"
        )));
    }

    /// Any host: the remote's host and repo path decide, not GitHub's URL shape.
    #[test]
    fn the_fallback_matches_any_hosts_remote() {
        let gitlab = "gitlab.acme.dev/group/sub/shop";
        let mr = "https://gitlab.acme.dev/group/sub/shop/-/merge_requests/12";
        let report =
            format!("{mr}\nhttps://gitlab.acme.dev/group/sub/shop-fixtures/-/merge_requests/1");
        assert_eq!(
            task_pr_url(unreadable(), Some(gitlab), [report.as_str()]).as_deref(),
            Some(mr)
        );
        assert!(on_remote(
            "https://bitbucket.org/acme/shop/pull-requests/4",
            &short_remote("git@bitbucket.org:acme/shop.git")
        ));
        assert!(on_remote(
            "https://git.acme.dev/acme/shop/pulls/4",
            &short_remote("ssh://git@git.acme.dev:2222/acme/shop.git")
        ));
        assert!(on_remote(
            "https://GitHub.com/UnlaboredLabs/fleetd/pull/1",
            REMOTE
        ));
    }
}
