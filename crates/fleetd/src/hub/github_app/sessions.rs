//! An order's agents on GitHub (D187). On a repository the hub's App reaches, an order's sessions get `GH_TOKEN`: its
//! starter's own token (people.rs), so the PRs its agents open are that person's, or, for work nobody started, the
//! App's own installation token. It travels as one of the order's variables (an `order:` sink, node/order_env.rs):
//! sealed to the project machine's box key, masked in what the agents report, read again at each turn, and dropped
//! with the order's other variables when it closes. The hub delivers it at each task launch ([`deliver`]) and again
//! before it ends ([`run`]).
//!
//! A writer whose order's starter hasn't connected GitHub is refused at spawn ([`refusal`]), in plain words for the
//! lead to pass on: never anyone else's account. With no App, or on a repository it doesn't reach, nothing changes:
//! the agents use their machine's own `gh` login, as before.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::github_app::{GITHUB_CONNECT_REFUSAL, GITHUB_TOKEN_ENV};
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::node_link::{CAP_ORDER_ENV, SecretDeliver};
use fleetd_contracts::people::PersonId;
use fleetd_contracts::repos::RepoId;
use fleetd_contracts::tasks::TaskKind;
use zeroize::Zeroizing;

use super::people::SESSION_MARGIN_MS;
use crate::hub::api::Hub;
use crate::hub::claude_accounts::{Whose, whose_for_task};
use crate::hub::projects::order_env::OrderEnvRow;
use crate::hub::store::{iso_ms, now_ms};

/// An App token handed to sessions has at least this long left; it is delivered again once it has less.
const APP_MARGIN_MS: i64 = 30 * 60_000;

/// What the hub keeps under an order's variables for its token, in place of a request id.
const REQUEST_ID: &str = "github";

/// Whose GitHub an order's agents use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GithubAs {
    /// The person who started it.
    Person(PersonId),
    /// Nobody started it: the App's own.
    App,
}

/// Each order's delivered token: the repo it was for, when it ends, and how close to that it is delivered again. Kept
/// in memory: after a restart, the next task launch delivers again.
#[derive(Default)]
pub struct Delivered(Mutex<HashMap<(ProjectRef, WorkstreamId), Kept>>);

#[derive(Clone)]
struct Kept {
    repo_id: Option<RepoId>,
    expires_ms: i64,
    margin_ms: i64,
}

/// The task's repository on GitHub (`owner/name`): its own repo's, else the project's.
pub fn repo_of(hub: &Hub, r: &ProjectRef, repo_id: Option<&RepoId>) -> Option<String> {
    let repos = hub.repos.repos_of(r).ok()?;
    let repo = match repo_id {
        Some(id) => repos.iter().find(|x| &x.repo_id == id),
        None => repos
            .iter()
            .find(|x| &x.checkout == r)
            .or_else(|| repos.first()),
    }?;
    Some(
        repo.repo_key
            .as_ref()?
            .as_str()
            .strip_prefix("github.com/")?
            .to_owned(),
    )
}

/// Whose GitHub the order's agents use on `repo`; none when the App doesn't reach it.
pub fn github_as(
    hub: &Hub,
    r: &ProjectRef,
    order: Option<&WorkstreamId>,
    repo: &str,
) -> Option<GithubAs> {
    if !hub.github_app.reaches(repo) {
        return None;
    }
    let setup = hub.db.claude_accounts().setup().ok()?;
    Some(match whose_for_task(&hub.db, &setup, r, order).ok()? {
        Whose::Person(p) => GithubAs::Person(p),
        Whose::Hub => GithubAs::App,
    })
}

/// Why a task of `kind` can't be spawned for the order: a writer, on a repository the App reaches, for a person who
/// hasn't connected GitHub (or whose connection lapsed). The message, and its fix.
pub fn refusal(
    hub: &Hub,
    r: &ProjectRef,
    order: &WorkstreamId,
    kind: TaskKind,
    repo_id: Option<&RepoId>,
) -> Option<(String, String)> {
    if kind != TaskKind::Write {
        return None;
    }
    let repo = repo_of(hub, r, repo_id)?;
    let Some(GithubAs::Person(person)) = github_as(hub, r, Some(order), &repo) else {
        return None;
    };
    let name = crate::hub::people::People::new(hub.db.clone(), hub.clock.clone())
        .get(&person)
        .ok()
        .flatten()
        .map_or_else(
            || "The person who started it".to_owned(),
            |p| p.name.to_string(),
        );
    match hub.github_app.account(&person) {
        Ok(Some(a)) if a.lapsed != Some(true) => None,
        Ok(Some(a)) => Some((
            format!(
                "GitHub no longer takes {name}'s connection ({}): connect GitHub again to open this order's PRs.",
                a.login
            ),
            format!(
                "Ask {name} to press Connect again in Settings › GitHub in their fleetd app; then spawn the writer again."
            ),
        )),
        _ => Some((
            format!(
                "{GITHUB_CONNECT_REFUSAL} {name} started it and hasn't connected their GitHub, and its PRs open as them."
            ),
            format!(
                "Ask {name} to connect GitHub in Settings › GitHub in their fleetd app (one sign-in); then spawn the writer again."
            ),
        )),
    }
}

/// Hands the order's sessions their GitHub token, when the App reaches the task's repo: sealed to the project
/// machine's box key, as one of the order's variables. `Err` says why it couldn't, for a launch to refuse rather than
/// run as the machine's login.
pub async fn deliver(
    hub: &Hub,
    r: &ProjectRef,
    order: &WorkstreamId,
    repo_id: Option<&RepoId>,
) -> Result<(), String> {
    let Some(repo) = repo_of(hub, r, repo_id) else {
        return Ok(());
    };
    let Some(github) = github_as(hub, r, Some(order), &repo) else {
        return Ok(());
    };
    let margin_ms = match github {
        GithubAs::Person(_) => SESSION_MARGIN_MS,
        GithubAs::App => APP_MARGIN_MS,
    };
    let (token, expires_ms) = match &github {
        GithubAs::Person(person) => match hub.github_app.user_token(person).await? {
            Some(t) => t,
            // Not connected: a writer was refused at spawn; a reader or reviewer goes without.
            None => return Ok(()),
        },
        GithubAs::App => hub
            .github_app
            .installation_token(&repo, APP_MARGIN_MS)
            .await
            .ok_or_else(|| format!("GitHub gave the hub's App no token for {repo}"))?,
    };
    put(hub, r, order, &token).await?;
    hub.github_app
        .delivered
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            (r.clone(), order.clone()),
            Kept {
                repo_id: repo_id.cloned(),
                expires_ms,
                margin_ms,
            },
        );
    Ok(())
}

/// Seals `token` to the project machine's box key and has its node keep it as the order's `GH_TOKEN`.
async fn put(
    hub: &Hub,
    r: &ProjectRef,
    order: &WorkstreamId,
    token: &Zeroizing<String>,
) -> Result<(), String> {
    let m = &r.machine_id;
    if !hub.link.node_can(m, CAP_ORDER_ENV) {
        return Err(format!(
            "{m}'s node is too old to hand agents a GitHub token: update fleetd there"
        ));
    }
    let key = hub
        .store
        .machine_get(m)
        .map_err(|e| e.to_string())?
        .and_then(|machine| machine.box_pub_key)
        .ok_or_else(|| format!("{m}'s node takes no secrets: it publishes no box key"))?;
    let public: [u8; 32] = B64
        .decode(key.as_str())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| format!("{m}'s box key isn't one"))?;
    let sealed = crypto_box::PublicKey::from(public)
        .seal(&mut crypto_box::aead::OsRng, token.as_bytes())
        .map_err(|_| "sealing failed".to_owned())?;
    let frame: SecretDeliver = serde_json::from_value(serde_json::json!({
        "id": "github",
        "sink": format!("order:{m}:{order}"),
        "sealed": B64.encode(sealed),
        "secretKey": "github.token",
        "envName": GITHUB_TOKEN_ENV,
        "projectId": r.project_id,
    }))
    .map_err(|e| e.to_string())?;
    let result = hub
        .node_commands
        .deliver_secret(m, frame)
        .await
        .map_err(|e| format!("{m}'s node didn't take the GitHub token: {e}"))?;
    let fingerprint = match (result.fingerprint, result.error) {
        (Some(f), _) => f,
        (None, e) => {
            return Err(format!(
                "{m}'s node didn't keep the GitHub token: {}",
                e.map(|e| e.to_string()).unwrap_or_default()
            ));
        }
    };
    // Recorded as the order's other variables are, so it goes when the order closes.
    let row = OrderEnvRow {
        name: GITHUB_TOKEN_ENV.to_owned(),
        fingerprint: fingerprint.to_string(),
        bytes: token.len() as i64,
        request_id: REQUEST_ID.to_owned(),
        updated_at: Timestamp(iso_ms(now_ms(hub.clock.as_ref()))).to_string(),
    };
    hub.db
        .order_env()
        .save(r, order.as_str(), &row)
        .map_err(|e| e.to_string())
}

/// Delivers again each open order's token that ends within its margin; forgets closed orders'.
pub async fn renew(hub: &Hub) {
    let now = now_ms(hub.clock.as_ref());
    let due: Vec<_> = hub
        .github_app
        .delivered
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|((r, order), kept)| (r.clone(), order.clone(), kept.clone()))
        .collect();
    for (r, order, kept) in due {
        let open = hub
            .leads
            .records
            .workstream_get(&order)
            .ok()
            .flatten()
            .is_some_and(|w| !crate::hub::leads::records::is_closed(w.state));
        if !open {
            hub.github_app
                .delivered
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&(r, order));
            continue;
        }
        if kept.expires_ms - now >= kept.margin_ms {
            continue;
        }
        if let Err(e) = deliver(hub, &r, &order, kept.repo_id.as_ref()).await {
            tracing::warn!(
                order = order.as_str(),
                "github: the order's token not renewed: {e}"
            );
        }
    }
}

/// Renews the orders' tokens on every sweep.
pub fn run(hub: &Arc<Hub>) {
    let check = hub.clone();
    hub.sweep.register(crate::hub::sweep::SweepCheck {
        name: "github-tokens".into(),
        run: Arc::new(move || {
            let hub = check.clone();
            Box::pin(async move {
                renew(&hub).await;
                Ok(())
            })
        }),
    });
}
