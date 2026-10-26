//! Logins from 1Password, filled without the agent seeing them (`fill_credential`). The node resolves an `op://`
//! reference with the 1Password SDK (`@1password/sdk`, pinned, run under Node.js by a small helper the node writes)
//! and a service account token: the project's secret variable `OP_SERVICE_ACCOUNT_TOKEN`, which a person enters
//! through `request_secret` and the node keeps out of every agent's environment. Each session keeps what it resolved
//! (not one-time codes, which change every 30 s) and backs off when 1Password rate-limits the token.
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use zeroize::Zeroizing;

/// The project secret variable holding the service account token.
pub const TOKEN_ENV: &str = "OP_SERVICE_ACCOUNT_TOKEN";
/// The SDK release the node installs.
pub const SDK_VERSION: &str = "0.5.0";
/// Tries after a rate limit, and the first wait (doubled each time).
const RATE_LIMIT_TRIES: u32 = 3;
const RATE_LIMIT_WAIT: Duration = Duration::from_secs(2);
/// One resolve's longest wait.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(30);

/// A resolved reference: its value, and the item's websites for the origin check.
#[derive(Clone)]
pub struct Credential {
    pub value: Zeroizing<String>,
    pub urls: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CredError {
    /// Plain words, never the value.
    pub message: String,
    pub rate_limited: bool,
}

pub type CredFuture = Pin<Box<dyn Future<Output = Result<Credential, CredError>> + Send>>;

/// Where values come from: 1Password, or a test's fake vault.
pub trait Vault: Send + Sync + 'static {
    fn resolve(&self, reference: &str) -> CredFuture;
}

/// Makes a vault from the token; the node's makes the SDK helper's.
pub type VaultFor = Arc<dyn Fn(Zeroizing<String>) -> Arc<dyn Vault> + Send + Sync>;

/// Whether a reference asks for a one-time code, which is never kept.
pub fn is_otp(reference: &str) -> bool {
    reference.ends_with("?attribute=otp") || reference.ends_with("?attribute=totp")
}

/// A session's resolved references, wiped when it goes.
#[derive(Default)]
pub struct Cache(Mutex<HashMap<String, Credential>>);

impl Cache {
    /// The reference's credential: kept, or resolved now (retrying after a rate limit).
    pub async fn get(&self, vault: &dyn Vault, reference: &str) -> Result<Credential, CredError> {
        if let Some(kept) = self.lock().get(reference) {
            return Ok(kept.clone());
        }
        let mut wait = RATE_LIMIT_WAIT;
        let mut tries = 0;
        let credential = loop {
            match vault.resolve(reference).await {
                Ok(credential) => break credential,
                Err(e) if e.rate_limited && tries + 1 < RATE_LIMIT_TRIES => {
                    tries += 1;
                    tokio::time::sleep(wait).await;
                    wait *= 2;
                }
                Err(e) if e.rate_limited => {
                    return Err(CredError {
                        message: format!(
                            "1Password is rate-limiting this machine's service account ({}); try again in a few \
                             minutes",
                            e.message
                        ),
                        rate_limited: true,
                    });
                }
                Err(e) => return Err(e),
            }
        };
        if !is_otp(reference) {
            self.lock().insert(reference.to_owned(), credential.clone());
        }
        Ok(credential)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Credential>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The host of a URL, without a port: `https://shop.example.com:8443/x` → `shop.example.com`.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next()?,
        None => host.split(':').next()?,
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Whether the page at `page` is on one of the item's sites: the same host, or a subdomain of it.
pub fn origin_allowed(page: &str, urls: &[String]) -> bool {
    let Some(page) = host_of(page) else {
        return false;
    };
    urls.iter().filter_map(|u| host_of(u)).any(|site| {
        page == site
            || page
                .strip_suffix(site.as_str())
                .is_some_and(|rest| rest.ends_with('.'))
    })
}

/// The helper the node runs under Node.js: one JSON line in per reference, one out, over a client made once.
pub const HELPER: &str = r#"// fleetd's 1Password helper: resolves op:// references with the SDK and a service account token.
import { createClient } from "@1password/sdk";
import { createInterface } from "node:readline";

const client = await createClient({
  auth: process.env.OP_SERVICE_ACCOUNT_TOKEN,
  integrationName: "fleetd",
  integrationVersion: "1",
});
delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

// op://vault/item[/section]/field[?attribute=...]: the item's websites, for the origin check.
async function websites(reference) {
  const [vaultName, itemName] = reference.slice("op://".length).split("?")[0].split("/");
  const vaults = await client.vaults.list();
  const vault = vaults.find((v) => v.id === vaultName || v.title === vaultName);
  if (!vault) return [];
  const items = await client.items.list(vault.id);
  const overview = items.find((i) => i.id === itemName || i.title === itemName);
  if (!overview) return [];
  const item = await client.items.get(vault.id, overview.id);
  return (item.websites ?? []).map((w) => w.url).filter(Boolean);
}

for await (const line of createInterface({ input: process.stdin })) {
  let answer;
  try {
    const { ref } = JSON.parse(line);
    const value = await client.secrets.resolve(ref);
    answer = { value, urls: await websites(ref) };
  } catch (e) {
    const message = String(e?.message ?? e).slice(0, 300);
    answer = { error: message, rateLimited: /rate.?limit|too many requests|429/i.test(message) };
  }
  process.stdout.write(JSON.stringify(answer) + "\n");
}
"#;

pub fn install_dir(home: &Path) -> PathBuf {
    home.join("browser").join("onepassword")
}

/// The pinned SDK and the helper beside it; installed on the first fill.
pub fn install(home: &Path) -> Result<PathBuf, String> {
    let dir = install_dir(home);
    let helper = dir.join("resolve.mjs");
    let pinned = dir.join("node_modules/@1password/sdk/package.json");
    let have = std::fs::read_to_string(&pinned)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .is_some_and(|p| p["version"] == SDK_VERSION);
    if !have {
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
        let out = std::process::Command::new("npm")
            .args(["install", "--no-audit", "--no-fund", "--prefix"])
            .arg(&dir)
            .arg(format!("@1password/sdk@{SDK_VERSION}"))
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("cannot run npm (Node.js) to install the 1Password SDK: {e}"))?;
        if !out.status.success() {
            return Err("installing the 1Password SDK failed".into());
        }
    }
    std::fs::write(&helper, HELPER)
        .map_err(|e| format!("cannot write {}: {e}", helper.display()))?;
    Ok(helper)
}

/// The SDK helper, one process per session's vault, started on its first resolve.
pub struct OnePassword {
    home: PathBuf,
    token: Zeroizing<String>,
    process: tokio::sync::Mutex<Option<Helper>>,
}

struct Helper {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
}

impl OnePassword {
    pub fn new(home: &Path, token: Zeroizing<String>) -> Arc<Self> {
        Arc::new(Self {
            home: home.to_owned(),
            token,
            process: tokio::sync::Mutex::new(None),
        })
    }

    async fn start(&self) -> Result<Helper, CredError> {
        let fail = |message: String| CredError {
            message,
            rate_limited: false,
        };
        let home = self.home.clone();
        let helper = tokio::task::spawn_blocking(move || install(&home))
            .await
            .map_err(|e| fail(e.to_string()))?
            .map_err(fail)?;
        let mut child = tokio::process::Command::new("node")
            .arg(&helper)
            .current_dir(install_dir(&self.home))
            .env(TOKEN_ENV, self.token.as_str())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| fail(format!("cannot start Node.js for the 1Password SDK: {e}")))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        Ok(Helper {
            child,
            stdin,
            lines,
        })
    }

    async fn ask(&self, reference: &str) -> Result<Credential, CredError> {
        let fail = |message: &str| CredError {
            message: message.to_owned(),
            rate_limited: false,
        };
        let mut process = self.process.lock().await;
        if process.is_none() {
            *process = Some(self.start().await?);
        }
        let helper = process.as_mut().expect("started");
        let line = format!("{}\n", json!({ "ref": reference }));
        if helper.stdin.write_all(line.as_bytes()).await.is_err() {
            *process = None;
            return Err(fail("the 1Password helper stopped"));
        }
        let answer = tokio::time::timeout(RESOLVE_TIMEOUT, helper.lines.next_line()).await;
        let Ok(Ok(Some(answer))) = answer else {
            if let Some(mut gone) = process.take() {
                let _ = gone.child.start_kill();
            }
            return Err(fail("1Password did not answer in 30 s"));
        };
        let answer = Zeroizing::new(answer);
        let mut parsed: Value = serde_json::from_str(&answer)
            .map_err(|_| fail("the 1Password helper said nothing readable"))?;
        if let Some(error) = parsed["error"].as_str() {
            return Err(CredError {
                message: format!("1Password: {error}"),
                rate_limited: parsed["rateLimited"] == true,
            });
        }
        let value = match parsed.get_mut("value").map(Value::take) {
            Some(Value::String(value)) => Zeroizing::new(value),
            _ => return Err(fail("1Password returned no value")),
        };
        let urls = parsed["urls"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|u| u.as_str().map(str::to_owned))
            .collect();
        Ok(Credential { value, urls })
    }
}

/// The SDK helper as a session's vault.
pub struct OnePasswordVault(pub Arc<OnePassword>);

impl Vault for OnePasswordVault {
    fn resolve(&self, reference: &str) -> CredFuture {
        let (helper, reference) = (self.0.clone(), reference.to_owned());
        Box::pin(async move { helper.ask(&reference).await })
    }
}

/// The node's vaults: the SDK helper with the session's token.
pub fn vault_for(home: &Path) -> VaultFor {
    let home = home.to_owned();
    Arc::new(move |token| {
        Arc::new(OnePasswordVault(OnePassword::new(&home, token))) as Arc<dyn Vault>
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_is_on_the_items_site_by_its_host_or_a_subdomain() {
        let urls = vec!["https://shop.example.com/login".to_owned()];
        assert!(origin_allowed("https://shop.example.com/account", &urls));
        assert!(origin_allowed("https://eu.shop.example.com:8443/", &urls));
        assert!(
            !origin_allowed("https://example.com/", &urls),
            "a parent domain isn't the site"
        );
        assert!(!origin_allowed(
            "https://shop.example.com.evil.test/",
            &urls
        ));
        assert!(!origin_allowed("https://evilshop.example.com/", &urls));
        assert!(!origin_allowed("about:blank", &urls));
        assert!(
            !origin_allowed("https://shop.example.com/", &[]),
            "an item without a website fills nowhere"
        );
        assert_eq!(
            host_of("http://user@127.0.0.1:9/x").as_deref(),
            Some("127.0.0.1")
        );
    }

    struct Flaky {
        calls: Mutex<u32>,
        limited: u32,
    }

    impl Vault for Arc<Flaky> {
        fn resolve(&self, reference: &str) -> CredFuture {
            let (this, reference) = (self.clone(), reference.to_owned());
            Box::pin(async move {
                let mut calls = this.calls.lock().unwrap();
                *calls += 1;
                if *calls <= this.limited {
                    return Err(CredError {
                        message: "429 Too Many Requests".into(),
                        rate_limited: true,
                    });
                }
                Ok(Credential {
                    value: Zeroizing::new(format!("v-{reference}-{calls}")),
                    urls: Vec::new(),
                })
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_keeps_what_it_resolved_but_one_time_codes_and_backs_off_a_rate_limit() {
        let vault = Arc::new(Flaky {
            calls: Mutex::new(0),
            limited: 2,
        });
        let cache = Cache::default();
        let first = cache.get(&vault, "op://Team/Shop/password").await.unwrap();
        assert_eq!(
            *vault.calls.lock().unwrap(),
            3,
            "two rate limits, then the value"
        );
        let again = cache.get(&vault, "op://Team/Shop/password").await.unwrap();
        assert_eq!(first.value.as_str(), again.value.as_str());
        assert_eq!(*vault.calls.lock().unwrap(), 3, "kept");
        let otp = "op://Team/Shop/one-time password?attribute=otp";
        cache.get(&vault, otp).await.unwrap();
        cache.get(&vault, otp).await.unwrap();
        assert_eq!(
            *vault.calls.lock().unwrap(),
            5,
            "a one-time code is read every time"
        );

        let stuck = Arc::new(Flaky {
            calls: Mutex::new(0),
            limited: 10,
        });
        let refused = Cache::default()
            .get(&stuck, "op://Team/Shop/password")
            .await
            .err()
            .unwrap();
        assert!(refused.rate_limited && refused.message.contains("try again in a few minutes"));
        assert_eq!(*stuck.calls.lock().unwrap(), RATE_LIMIT_TRIES);
    }
}
