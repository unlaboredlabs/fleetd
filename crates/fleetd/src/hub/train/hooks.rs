//! Opt-in GitHub webhooks, never on by default: `github_webhook_set` makes a secret and a repo hook on every train
//! repo pointing at a public URL the user brings (fleetd never opens one). A delivery is only a latency hint that
//! kicks the repo's train; the train's reconciliation reads stay the source of truth, so a forged or lost delivery
//! changes nothing.
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{ErrorCode, GithubHook, GithubWebhookSetInput, GithubWebhookSetOutput};
use fleetd_contracts::prim::Positive;
use fleetd_contracts::train::GitHubRepo;

use crate::hub::api::{Caller, Hub, ToolError, allows_everywhere};
use crate::hub::store::StoreError;
use crate::hub::train::secret_box::SecretBox;

/// The sealed secret, beside the key that opens it (`webhook.key`).
fn secret_file(hub: &Hub) -> PathBuf {
    hub.config.home.join("github-webhook.secret")
}

/// The secret deliveries are signed with; absent while webhooks are off.
pub fn secret(hub: &Hub) -> Option<String> {
    let sealed = std::fs::read_to_string(secret_file(hub)).ok()?;
    SecretBox::for_home(&hub.config.home)
        .ok()?
        .open(sealed.trim())
        .ok()
}

/// At hub start: webhooks are on when hooks are recorded and their secret opens.
pub fn restore(hub: &Arc<Hub>) {
    let hooked = hub
        .db
        .with(|c| {
            Ok(c.query_row("SELECT count(*) FROM github_hooks", [], |r| {
                r.get::<_, i64>(0)
            })?)
        })
        .unwrap_or(0);
    hub.train.set_webhooks(hooked > 0 && secret(hub).is_some());
}

/// `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body>`, compared in constant time.
pub fn verify(secret: &str, signature: &str, body: &[u8]) -> bool {
    let Some(hex) = signature.strip_prefix("sha256=") else {
        return false;
    };
    let Some(given) = decode_hex(hex) else {
        return false;
    };
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac takes any key length");
    mac.update(body);
    mac.verify_slice(&given).is_ok()
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

fn new_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn stored(hub: &Hub) -> Result<Vec<(String, i64)>, StoreError> {
    hub.db.with(|c| {
        let mut stmt = c.prepare("SELECT repo, hook_id FROM github_hooks ORDER BY repo")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

fn failed(message: String) -> ToolError {
    ToolError::new(ErrorCode::Failed, message)
        .with_fix("check `gh auth status` on the hub machine; the token needs admin:repo_hook")
}

pub async fn github_webhook_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: GithubWebhookSetInput,
) -> Result<GithubWebhookSetOutput, ToolError> {
    if !allows_everywhere(&caller, Role::Admin) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Webhooks change every train repo's settings on GitHub; this key is not admin on every machine.",
        )
        .with_fix("Use a key from fleetd hub key create --role admin --machines '*'."));
    }
    let github = hub.train.github().clone();
    // Hooks made before go first, whether turning off or pointing somewhere new.
    for (repo, id) in stored(&hub)? {
        github
            .delete_hook(&repo, id)
            .await
            .map_err(|e| failed(e.message))?;
        hub.db.with(|c| {
            c.execute("DELETE FROM github_hooks WHERE repo = ?1", [&repo])?;
            Ok(())
        })?;
    }
    let Some(url) = input.url else {
        let _ = std::fs::remove_file(secret_file(&hub));
        hub.train.set_webhooks(false);
        return Ok(GithubWebhookSetOutput {
            repos: Default::default(),
            next: Some("Webhooks are off; the train reconciles with GitHub every pass.".into()),
            truncated: None,
        });
    };
    let secret = new_secret();
    let sealed = SecretBox::for_home(&hub.config.home)
        .map_err(|e| failed(format!("the webhook secret could not be sealed: {e}")))?
        .seal(&secret);
    let path = secret_file(&hub);
    let _ = std::fs::remove_file(&path);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, sealed.as_bytes()))
        .map_err(|e| failed(format!("the webhook secret could not be saved: {e}")))?;
    let mut hooks = Vec::new();
    for (repo, _) in hub.train.repos() {
        let id = github
            .create_hook(&repo, url.as_str(), &secret)
            .await
            .map_err(|e| failed(format!("{repo}: {}", e.message)))?;
        hub.db.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO github_hooks (repo, hook_id, url) VALUES (?1, ?2, ?3)",
                rusqlite::params![repo, id, url.as_str()],
            )?;
            Ok(())
        })?;
        hooks.push(GithubHook {
            repo: GitHubRepo::unchecked(repo),
            hook_id: Positive::unchecked(id),
        });
    }
    hub.train.set_webhooks(true);
    Ok(GithubWebhookSetOutput {
        repos: hooks.try_into().unwrap_or_default(),
        next: Some(
            "GitHub now posts check_suite, pull_request and push to that URL; it must reach this hub's /github. Repos added to the train later need the command run again."
                .into(),
        ),
        truncated: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_body_signed_with_the_secret_verifies() {
        let body = br#"{"repository":{"full_name":"acme/storefront"}}"#;
        let mut mac = Hmac::<Sha256>::new_from_slice(b"s3cret").unwrap();
        mac.update(body);
        let hex: String = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert!(verify("s3cret", &format!("sha256={hex}"), body));
        assert!(!verify("other", &format!("sha256={hex}"), body));
        assert!(!verify("s3cret", &format!("sha256={hex}"), b"{}"));
        assert!(
            !verify("s3cret", &hex, body),
            "the sha256= prefix is required"
        );
        assert!(!verify("s3cret", "sha256=zz", body));
    }
}
