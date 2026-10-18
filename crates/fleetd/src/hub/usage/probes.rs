//! The probe counter: how many direct usage or reset-credit calls a T3 made, counted from its trace file. fleetd
//! configures T3 so it never makes one (no stored OAuth credentials, no cliproxy usage source), so this must read 0.
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

/// A line that shows a call out: the URLs of the `oauth/usage` probe and of Claude's and Codex's reset-credit calls,
/// or a span of T3's CLIProxyAPI usage source, which only runs when it calls the proxy. A span like
/// `readClaudeResetCredits` alone does not count: it returns early without a stored token.
static PROBE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"api/oauth/usage|reset_rate_limits|rate-limit-reset-credits|"name":"CliproxyApi\."#,
    )
    .unwrap()
});
static TRACE_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^server\.trace\.ndjson(?:\.\d+)?$").unwrap());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeCounter {
    pub observable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ProbeCounter {
    pub fn not_observable(reason: impl Into<String>) -> Self {
        Self {
            observable: false,
            count: None,
            source: None,
            reason: Some(reason.into()),
        }
    }
}

type CacheKey = (u64, Option<SystemTime>);
static CACHE: LazyLock<Mutex<HashMap<PathBuf, (CacheKey, u64)>>> = LazyLock::new(Default::default);

fn count_file(file: &Path) -> std::io::Result<u64> {
    let meta = std::fs::metadata(file)?;
    let key = (meta.len(), meta.modified().ok());
    if let Some((k, n)) = CACHE.lock().unwrap().get(file)
        && *k == key
    {
        return Ok(*n);
    }
    let mut count = 0;
    for line in BufReader::new(std::fs::File::open(file)?).split(b'\n') {
        if PROBE_LINE.is_match(&String::from_utf8_lossy(&line?)) {
            count += 1;
        }
    }
    CACHE
        .lock()
        .unwrap()
        .insert(file.to_path_buf(), (key, count));
    Ok(count)
}

/// `path.resolve`: absolute and normalised, without following symlinks.
fn resolve(p: &Path) -> PathBuf {
    let base = if p.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_default()
    };
    let mut out = PathBuf::new();
    for c in base.join(p).components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn realish(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| resolve(p))
}

/// Counts probe lines across `server.trace.ndjson` and its rotations in `logs_dir`. Refuses anything under the live
/// T3 home (`~/.t3`), which fleetd never reads.
pub fn count_probes(logs_dir: &str, user_home: &Path) -> ProbeCounter {
    let t3_home = user_home.join(".t3");
    let live = || {
        ProbeCounter::not_observable(
            "T3's logs are in the live T3 home (~/.t3), which fleetd never reads",
        )
    };
    let dir = Path::new(logs_dir);
    if !dir.is_absolute() {
        return ProbeCounter::not_observable(format!(
            "T3 reported a relative logs directory, {logs_dir}"
        ));
    }
    // The plain path first, so nothing under ~/.t3 is touched; then through symlinks.
    if resolve(dir).starts_with(resolve(&t3_home)) {
        return live();
    }
    let real = realish(dir);
    if real.starts_with(realish(&t3_home)) {
        return live();
    }
    let mut traces: Vec<String> = match std::fs::read_dir(&real) {
        Ok(entries) => entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| TRACE_FILE.is_match(n))
            .collect(),
        Err(_) => Vec::new(),
    };
    traces.sort();
    if traces.is_empty() {
        return ProbeCounter::not_observable(format!("no T3 trace file in {logs_dir}"));
    }
    let mut count = 0;
    for name in traces {
        match count_file(&real.join(&name)) {
            Ok(n) => count += n,
            Err(_) => {
                return ProbeCounter::not_observable(format!(
                    "T3's trace file {name} in {logs_dir} is not readable"
                ));
            }
        }
    }
    ProbeCounter {
        observable: true,
        count: Some(count),
        source: Some(logs_dir.to_string()),
        reason: None,
    }
}

/// The hub user's home directory, where the live T3 home lives.
pub fn user_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}
