//! What the PR views read from GitHub, through `gh` on the hub's machine, cached briefly so a burst of refetches
//! costs one call: a repo's open and recently closed PRs (one GraphQL query each, checks and review decision
//! included), one PR's detail (one query: description, checks, people's reviews), and its changed files (REST, per
//! page of 100, kept per head so a page is read once per push).
//!
//! Only the PR views call this, when a person opens one; nothing here runs on a timer. A failed read is remembered
//! for the same TTL, so a rate-limited or signed-out `gh` is asked again at most once a minute.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Deserialize;

use crate::clock::Clock;
use crate::hub::store::now_ms;
use crate::hub::train::github::GhRunner;

/// How long a repo's PR list is reused.
pub const LIST_TTL_MS: i64 = 60_000;
/// How long one PR's detail is reused.
pub const DETAIL_TTL_MS: i64 = 30_000;
/// How long a failed read is remembered before GitHub is asked again.
pub const ERROR_TTL_MS: i64 = 60_000;
/// Open PRs read per repo.
pub const OPEN_LIMIT: usize = 50;
/// Closed and merged PRs read per repo, most recent first.
pub const CLOSED_LIMIT: usize = 20;
/// A file's patch kept for paging; GitHub itself leaves out the patch of very large files.
const PATCH_MAX_BYTES: usize = 512 * 1024;

const MAX_LISTS: usize = 32;
const MAX_DETAILS: usize = 64;
const MAX_FILE_PAGES: usize = 16;

const LIST_FIELDS: &str = "number,title,state,isDraft,author,headRefName,headRefOid,createdAt,updatedAt,mergedAt,closedAt,reviewDecision,statusCheckRollup,url";
const DETAIL_FIELDS: &str = "number,title,state,isDraft,author,headRefName,headRefOid,createdAt,updatedAt,mergedAt,closedAt,reviewDecision,statusCheckRollup,url,body,baseRefName,additions,deletions,changedFiles,mergeCommit,reviews";

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Login {
    #[serde(default)]
    pub login: String,
}

/// A check run or a commit status, as `statusCheckRollup` lists them.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhCheck {
    #[serde(rename = "__typename", default)]
    pub typename: String,
    /// A check run's name.
    pub name: Option<String>,
    /// A commit status's context.
    pub context: Option<String>,
    /// A check run's QUEUED, IN_PROGRESS or COMPLETED.
    pub status: Option<String>,
    pub conclusion: Option<String>,
    /// A commit status's SUCCESS, PENDING, FAILURE, ERROR or EXPECTED.
    pub state: Option<String>,
    pub details_url: Option<String>,
    pub target_url: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhPull {
    pub number: i64,
    #[serde(default)]
    pub title: String,
    /// OPEN, CLOSED or MERGED.
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub is_draft: bool,
    pub author: Option<Login>,
    #[serde(default)]
    pub head_ref_name: String,
    #[serde(default)]
    pub head_ref_oid: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    pub merged_at: Option<String>,
    pub closed_at: Option<String>,
    /// APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or empty.
    pub review_decision: Option<String>,
    #[serde(default)]
    pub status_check_rollup: Vec<GhCheck>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Oid {
    #[serde(default)]
    pub oid: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhReview {
    pub author: Option<Login>,
    /// APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING.
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub body: String,
    pub submitted_at: Option<String>,
    pub commit: Option<Oid>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhDetail {
    #[serde(flatten)]
    pub pull: GhPull,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub base_ref_name: String,
    #[serde(default)]
    pub additions: i64,
    #[serde(default)]
    pub deletions: i64,
    #[serde(default)]
    pub changed_files: i64,
    pub merge_commit: Option<Oid>,
    #[serde(default)]
    pub reviews: Vec<GhReview>,
}

/// One changed file, as `pulls/{n}/files` answers it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct GhFile {
    pub filename: String,
    pub previous_filename: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub additions: i64,
    #[serde(default)]
    pub deletions: i64,
    pub patch: Option<String>,
}

/// A read's answer: the value (possibly an older one) and, when the last read failed, why.
#[derive(Clone, Debug)]
pub struct Read<T> {
    pub value: Option<Arc<T>>,
    pub error: Option<String>,
}

struct Entry<T> {
    value: Option<Arc<T>>,
    /// When `value` was read.
    ok_ms: i64,
    error: Option<(String, i64)>,
    used: u64,
}

impl<T> Entry<T> {
    fn fresh(&self, now: i64, ttl: i64) -> bool {
        match &self.error {
            Some((_, at)) => now - at < ERROR_TTL_MS,
            None => self.value.is_some() && now - self.ok_ms < ttl,
        }
    }

    fn read(&self) -> Read<T> {
        Read {
            value: self.value.clone(),
            error: self.error.as_ref().map(|(e, _)| e.clone()),
        }
    }
}

/// A small map that drops its least recently used entry past `max`.
struct Cache<K, T> {
    entries: HashMap<K, Entry<T>>,
    max: usize,
    tick: u64,
}

impl<K: std::hash::Hash + Eq + Clone, T> Cache<K, T> {
    fn new(max: usize) -> Self {
        Self {
            entries: HashMap::new(),
            max,
            tick: 0,
        }
    }

    fn get(&mut self, key: &K, now: i64, ttl: i64) -> Option<Read<T>> {
        self.tick += 1;
        let tick = self.tick;
        let entry = self.entries.get_mut(key)?;
        entry.used = tick;
        entry.fresh(now, ttl).then(|| entry.read())
    }

    fn put(&mut self, key: K, result: Result<T, String>, now: i64) -> Read<T> {
        self.tick += 1;
        if self.entries.len() >= self.max && !self.entries.contains_key(&key) {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone());
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
        let entry = self.entries.entry(key).or_insert(Entry {
            value: None,
            ok_ms: 0,
            error: None,
            used: 0,
        });
        entry.used = self.tick;
        match result {
            Ok(value) => {
                entry.value = Some(Arc::new(value));
                entry.ok_ms = now;
                entry.error = None;
            }
            // An older value stays: the views show it with the reason the refresh failed.
            Err(error) => entry.error = Some((error, now)),
        }
        entry.read()
    }
}

/// Why a `gh` read failed, in words a person can act on. The machine is "the machine fleetd runs on".
pub fn explain(exit_code: i32, stderr: &str) -> String {
    let s = stderr.to_lowercase();
    if exit_code == 4 || s.contains("gh auth login") || s.contains("not logged in") {
        "GitHub isn't signed in on the machine fleetd runs on: run `gh auth login` there.".into()
    } else if s.contains("rate limit") {
        "GitHub's rate limit is reached; fleetd asks again in a minute.".into()
    } else if s.contains("could not resolve") || s.contains("not found") {
        "GitHub doesn't know this repository or PR, or the signed-in account can't see it.".into()
    } else {
        let last = stderr.trim().lines().next_back().unwrap_or("").trim();
        let last = last.strip_prefix("gh: ").unwrap_or(last);
        format!(
            "GitHub couldn't be read: {}",
            crate::hub::api::clip(if last.is_empty() { "no answer" } else { last }, 200)
        )
    }
}

/// Repo (lowercase), PR number, head sha and 0-based page.
type FilePage = (String, i64, String, usize);

pub struct PrsGitHub {
    gh: Arc<dyn GhRunner>,
    clock: Arc<dyn Clock>,
    lists: Mutex<Cache<(String, &'static str), Vec<GhPull>>>,
    details: Mutex<Cache<(String, i64), GhDetail>>,
    files: Mutex<Cache<FilePage, Vec<GhFile>>>,
    /// One read from GitHub at a time: a burst of refetches waits for the first and takes its answer from the cache.
    fetch: tokio::sync::Mutex<()>,
}

impl PrsGitHub {
    pub fn new(gh: Arc<dyn GhRunner>, clock: Arc<dyn Clock>) -> Self {
        Self {
            gh,
            clock,
            lists: Mutex::new(Cache::new(MAX_LISTS)),
            details: Mutex::new(Cache::new(MAX_DETAILS)),
            files: Mutex::new(Cache::new(MAX_FILE_PAGES)),
            fetch: tokio::sync::Mutex::new(()),
        }
    }

    fn now(&self) -> i64 {
        now_ms(self.clock.as_ref())
    }

    async fn run_json<T: serde::de::DeserializeOwned>(
        &self,
        args: Vec<String>,
    ) -> Result<T, String> {
        let out = self.gh.run(args).await.map_err(|spawn| {
            if spawn == "ENOENT" {
                "The GitHub CLI (gh) isn't installed on the machine fleetd runs on.".to_owned()
            } else {
                format!("GitHub couldn't be read: {spawn}")
            }
        })?;
        if out.exit_code != 0 {
            return Err(explain(out.exit_code, &out.stderr));
        }
        serde_json::from_str(&out.stdout)
            .map_err(|_| "GitHub answered in a shape fleetd doesn't read.".to_owned())
    }

    /// The repo's open PRs (`closed` false) or its most recently closed and merged ones.
    pub async fn list(&self, repo: &str, closed: bool) -> Read<Vec<GhPull>> {
        let state = if closed { "closed" } else { "open" };
        let key = (repo.to_lowercase(), state);
        if let Some(hit) = self
            .lists
            .lock()
            .unwrap()
            .get(&key, self.now(), LIST_TTL_MS)
        {
            return hit;
        }
        let _one = self.fetch.lock().await;
        if let Some(hit) = self
            .lists
            .lock()
            .unwrap()
            .get(&key, self.now(), LIST_TTL_MS)
        {
            return hit;
        }
        let limit = if closed { CLOSED_LIMIT } else { OPEN_LIMIT };
        let args = [
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            state,
            "--limit",
            &limit.to_string(),
            "--json",
            LIST_FIELDS,
        ]
        .map(String::from)
        .to_vec();
        let result = self.run_json(args).await;
        self.lists.lock().unwrap().put(key, result, self.now())
    }

    /// One PR's detail.
    pub async fn detail(&self, repo: &str, number: i64) -> Read<GhDetail> {
        let key = (repo.to_lowercase(), number);
        if let Some(hit) = self
            .details
            .lock()
            .unwrap()
            .get(&key, self.now(), DETAIL_TTL_MS)
        {
            return hit;
        }
        let _one = self.fetch.lock().await;
        if let Some(hit) = self
            .details
            .lock()
            .unwrap()
            .get(&key, self.now(), DETAIL_TTL_MS)
        {
            return hit;
        }
        let args = [
            "pr",
            "view",
            &number.to_string(),
            "--repo",
            repo,
            "--json",
            DETAIL_FIELDS,
        ]
        .map(String::from)
        .to_vec();
        let result = self.run_json(args).await;
        self.details.lock().unwrap().put(key, result, self.now())
    }

    /// Page `page` (0-based, 100 files each) of the PR's files at `head`. A head's files never change, so a page is
    /// kept until it falls out of the cache.
    pub async fn files(
        &self,
        repo: &str,
        number: i64,
        head: &str,
        page: usize,
    ) -> Read<Vec<GhFile>> {
        let key = (repo.to_lowercase(), number, head.to_owned(), page);
        if let Some(hit) = self.files.lock().unwrap().get(&key, self.now(), i64::MAX) {
            return hit;
        }
        let _one = self.fetch.lock().await;
        if let Some(hit) = self.files.lock().unwrap().get(&key, self.now(), i64::MAX) {
            return hit;
        }
        let path = format!(
            "repos/{repo}/pulls/{number}/files?per_page=100&page={}",
            page + 1
        );
        let result = self
            .run_json::<Vec<GhFile>>(vec!["api".into(), path])
            .await
            .map(|mut files| {
                for f in &mut files {
                    if f.patch.as_ref().is_some_and(|p| p.len() > PATCH_MAX_BYTES) {
                        f.patch = None;
                    }
                }
                files
            });
        self.files.lock().unwrap().put(key, result, self.now())
    }
}
