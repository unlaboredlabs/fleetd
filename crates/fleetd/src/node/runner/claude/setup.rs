//! Which claude setup fleetd's sessions use, in words a person recognises: the version, the login, the proxy it goes
//! through and the config dir. Sessions run with the user's own setup (`~/.claude`, or their `CLAUDE_CONFIG_DIR`),
//! so a login, a local proxy in `settings.json` or an `apiKeyHelper` that works in their shell works for fleetd too.
//!
//! Everything here comes from the zero-cost probe ([`conformance::probe`]) and from reading files. Nothing calls the
//! proxy or the Anthropic API.
use std::fmt;
use std::path::{Path, PathBuf};

use fleetd_contracts::sessions::{LoginStatus, RunnerInfo};
use serde_json::Value;

use super::conformance;

/// The base URL claude talks to when nothing overrides it; not a proxy.
const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeSetup {
    /// `2.1.302`: the first word of `claude --version`. None when claude is missing or did not answer.
    pub version: Option<String>,
    /// "Max", "Pro", "API key", "gateway token", "Bedrock", …; None when logged out or unknown.
    pub login_kind: Option<String>,
    /// The `ANTHROPIC_BASE_URL` claude would use, when it is not Anthropic's own.
    pub proxy: Option<String>,
    /// Where [`Self::proxy`] is set: a file (`~/.claude/settings.json`, `~/.fleetd/claude.env`) or "environment".
    pub proxy_source: Option<String>,
    /// The config dir sessions use: the user's `CLAUDE_CONFIG_DIR`, or `~/.claude`.
    pub config_dir: PathBuf,
    /// Why sessions cannot run here, with the fix.
    pub problem: Option<String>,
}

/// Probes `binary` with `env` (the environment a session would get) and describes the result.
pub async fn describe(binary: &Path, env: &[(String, String)]) -> ClaudeSetup {
    ClaudeSetup::from_info(&conformance::probe(binary, env).await)
}

impl ClaudeSetup {
    /// From a probe's [`RunnerInfo`], e.g. one a node sent the hub. Only what the probe reported: the hub never reads
    /// its own files to describe another machine.
    pub fn from_info(info: &RunnerInfo) -> Self {
        Self {
            version: info
                .version
                .as_deref()
                .and_then(|v| v.split_whitespace().next())
                .map(str::to_owned),
            login_kind: (info.login == LoginStatus::LoggedIn).then(|| {
                info.login_label
                    .clone()
                    .or_else(|| info.login_kind.clone())
                    .unwrap_or_else(|| "unknown kind".to_owned())
            }),
            proxy: info.proxy.clone(),
            proxy_source: info.proxy_source.clone(),
            // A node from before these fields reports none; it ran its sessions in fleetd's old profile.
            config_dir: PathBuf::from(info.config_dir.as_deref().unwrap_or("~/.fleetd/claude")),
            problem: info.problem.clone(),
        }
    }
}

impl fmt::Display for ClaudeSetup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Some(version) = &self.version else {
            return f.write_str("claude is not usable");
        };
        write!(f, "claude {version}, ")?;
        match &self.login_kind {
            Some(kind) => write!(f, "logged in ({kind})")?,
            None if self.problem.is_some() => f.write_str("not logged in")?,
            None => f.write_str("login unknown")?,
        }
        if let Some(proxy) = &self.proxy {
            write!(f, ", via proxy {proxy}")?;
            if let Some(source) = &self.proxy_source {
                write!(f, " from {source}")?;
            }
        }
        if !is_default_dir(&self.config_dir) {
            write!(f, ", config {}", tilde(&self.config_dir))?;
        }
        Ok(())
    }
}

fn env_get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter()
        .rev()
        .find(|(k, v)| k == key && !v.is_empty())
        .map(|(_, v)| v.as_str())
}

fn home(env: &[(String, String)]) -> PathBuf {
    env_get(env, "HOME").map_or_else(crate::node::util::home_dir, PathBuf::from)
}

/// The config dir a claude started with `env` reads and writes: `CLAUDE_CONFIG_DIR`, else `$HOME/.claude`.
pub fn config_dir(env: &[(String, String)]) -> PathBuf {
    env_get(env, "CLAUDE_CONFIG_DIR").map_or_else(|| home(env).join(".claude"), PathBuf::from)
}

/// `<home>/.claude`, whatever the home: a hub describes machines whose home is not its own.
fn is_default_dir(dir: &Path) -> bool {
    dir.file_name().is_some_and(|n| n == ".claude")
}

/// `~/…` for paths under the home directory, for messages.
pub fn tilde(path: &Path) -> String {
    match path.strip_prefix(crate::node::util::home_dir()) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_owned(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

/// The user settings file claude reads with `--setting-sources user`.
fn user_settings(env: &[(String, String)]) -> PathBuf {
    config_dir(env).join("settings.json")
}

/// `settings.json`'s `env` object.
fn settings_env(file: &Path) -> Option<serde_json::Map<String, Value>> {
    let text = std::fs::read_to_string(file).ok()?;
    match serde_json::from_str::<Value>(&text).ok()?.get("env")? {
        Value::Object(env) => Some(env.clone()),
        _ => None,
    }
}

/// The proxy claude would use with `env`, and where it is set. claude applies its user settings' `env` over the
/// process environment, so `settings.json` wins.
pub fn proxy_of(env: &[(String, String)]) -> Option<(String, String)> {
    let file = user_settings(env);
    let from_settings = settings_env(&file).and_then(|e| {
        e.get("ANTHROPIC_BASE_URL")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
    });
    let (url, source) = match from_settings {
        Some(url) => (url, tilde(&file)),
        None => {
            let url = env_get(env, "ANTHROPIC_BASE_URL")?.to_owned();
            let source = env_get(env, FLEETD_ENV_SOURCE)
                .map_or_else(|| "environment".to_owned(), str::to_owned);
            (url, source)
        }
    };
    let url = url.trim().trim_end_matches('/').to_owned();
    (url != DEFAULT_BASE_URL).then_some((url, source))
}

/// The account variables (`ACCOUNT_CLEARS`) the user settings' `env` sets with `env`, by name, in that list's
/// order: read only, and the values are never kept.
pub fn account_overrides(env: &[(String, String)]) -> Vec<String> {
    let Some(set) = settings_env(&user_settings(env)) else {
        return Vec::new();
    };
    fleetd_contracts::claude_accounts::ACCOUNT_CLEARS
        .iter()
        .filter(|name| {
            set.get(**name)
                .is_some_and(|v| !v.is_null() && v.as_str().is_none_or(|s| !s.trim().is_empty()))
        })
        .map(|name| (*name).to_owned())
        .collect()
}

/// Not passed to claude: the node marks the env file a variable came from, so a proxy can name its source.
pub const FLEETD_ENV_SOURCE: &str = "FLEETD_ENV_SOURCE";

/// A person's name for the credential: the plan for a subscription, else how the key or token is supplied.
pub fn login_label(account: &conformance::Account) -> Option<String> {
    let set = |v: &Option<String>| {
        v.as_deref()
            .filter(|s| !s.is_empty() && *s != "none")
            .map(str::to_owned)
    };
    if let Some(provider) = set(&account.api_provider).filter(|p| p != "firstParty") {
        return Some(match provider.as_str() {
            "bedrock" => "Bedrock".to_owned(),
            "vertex" => "Vertex".to_owned(),
            "foundry" => "Foundry".to_owned(),
            _ => provider,
        });
    }
    if let Some(plan) = set(&account.subscription_type) {
        let mut chars = plan.chars();
        return Some(
            chars
                .next()
                .map_or_else(String::new, |c| c.to_uppercase().chain(chars).collect()),
        );
    }
    if let Some(source) = set(&account.token_source) {
        return Some(match source.as_str() {
            "claude.ai" | "CLAUDE_CODE_OAUTH_TOKEN" => "subscription".to_owned(),
            _ => "gateway token".to_owned(),
        });
    }
    set(&account.api_key_source).map(|source| match source.as_str() {
        "apiKeyHelper" => "API key from apiKeyHelper".to_owned(),
        _ => "API key".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn the_config_dir_is_the_users_own_unless_they_chose_another() {
        assert_eq!(
            config_dir(&env(&[("HOME", "/home/ada")])),
            PathBuf::from("/home/ada/.claude")
        );
        assert_eq!(
            config_dir(&env(&[
                ("HOME", "/home/ada"),
                ("CLAUDE_CONFIG_DIR", "/home/ada/work-claude")
            ])),
            PathBuf::from("/home/ada/work-claude")
        );
    }

    #[test]
    fn paths_under_the_home_dir_read_from_a_tilde() {
        let home = crate::node::util::home_dir();
        assert_eq!(tilde(&home), "~");
        assert_eq!(
            tilde(&home.join(".claude/settings.json")),
            "~/.claude/settings.json"
        );
        let outside = Path::new("/nonexistent-home-sibling/settings.json");
        assert_eq!(tilde(outside), "/nonexistent-home-sibling/settings.json");
    }

    /// Only the account variables a temp home's settings set, by name; the process environment and other settings
    /// never count, and the real ~/.claude is never read.
    #[test]
    fn account_overrides_name_the_credentials_user_settings_set() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_str().unwrap();
        let base = env(&[
            ("HOME", home),
            ("ANTHROPIC_API_KEY", "from-the-environment"),
        ]);
        assert!(account_overrides(&base).is_empty(), "no settings file");
        std::fs::create_dir_all(dir.path().join(".claude")).unwrap();
        std::fs::write(
            dir.path().join(".claude/settings.json"),
            r#"{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8317","DISABLE_AUTOUPDATER":"1","ANTHROPIC_AUTH_TOKEN":"devbox-token","CLAUDE_CODE_OAUTH_TOKEN":""}}"#,
        )
        .unwrap();
        assert_eq!(
            account_overrides(&base),
            vec![
                "ANTHROPIC_BASE_URL".to_owned(),
                "ANTHROPIC_AUTH_TOKEN".to_owned()
            ]
        );
    }

    #[test]
    fn a_proxy_in_user_settings_wins_over_the_environment_and_names_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_str().unwrap();
        std::fs::create_dir_all(dir.path().join(".claude")).unwrap();
        let base = env(&[
            ("HOME", home),
            ("ANTHROPIC_BASE_URL", "http://gw.example"),
            (FLEETD_ENV_SOURCE, "~/.fleetd/claude.env"),
        ]);
        assert_eq!(
            proxy_of(&base),
            Some(("http://gw.example".into(), "~/.fleetd/claude.env".into()))
        );
        let settings = dir.path().join(".claude/settings.json");
        std::fs::write(
            &settings,
            r#"{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8317/","ANTHROPIC_AUTH_TOKEN":"x"}}"#,
        )
        .unwrap();
        // Named as messages show paths: `~/…` when the temp dir sits under the node's own home.
        assert_eq!(
            proxy_of(&base),
            Some(("http://127.0.0.1:8317".into(), tilde(&settings)))
        );
        std::fs::write(
            &settings,
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}"#,
        )
        .unwrap();
        assert_eq!(proxy_of(&base), None, "Anthropic's own URL is no proxy");
    }

    #[test]
    fn credentials_get_a_persons_name() {
        let label = |json: Value| login_label(&serde_json::from_value(json).unwrap());
        use serde_json::json;
        assert_eq!(
            label(json!({"tokenSource": "claude.ai", "subscriptionType": "max"})).as_deref(),
            Some("Max")
        );
        assert_eq!(
            label(json!({"tokenSource": "ANTHROPIC_AUTH_TOKEN", "apiProvider": "firstParty"}))
                .as_deref(),
            Some("gateway token")
        );
        assert_eq!(
            label(json!({"apiKeySource": "apiKeyHelper"})).as_deref(),
            Some("API key from apiKeyHelper")
        );
        assert_eq!(
            label(json!({"apiKeySource": "ANTHROPIC_API_KEY"})).as_deref(),
            Some("API key")
        );
        assert_eq!(
            label(json!({"apiProvider": "bedrock"})).as_deref(),
            Some("Bedrock")
        );
        assert_eq!(
            label(json!({"tokenSource": "none", "apiProvider": "firstParty"})),
            None
        );
    }
}
