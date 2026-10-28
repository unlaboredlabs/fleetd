//! An order's agents on GitHub (D187). On a repository the hub's App reaches, an order's sessions get `GH_TOKEN`: its
//! starter's own token (people.rs), so the PRs its agents open are that person's, or, for work nobody started, the
//! App's own installation token. It travels as one of the order's variables (an `order:` sink, node/order_env.rs) at
//! each repo's checkout, so a task in each repo gets that repo's (its owner's installation), and one the App doesn't
//! reach gets none: sealed to the checkout machine's box key, masked in what the agents report, read again at each
//! turn, and dropped with the order's other variables when it closes, or withdrawn when its person disconnects or
//! leaves the hub. The hub delivers it at each task launch ([`deliver`]) and again
//! before it ends ([`run`]), from what it keeps in `github_order_tokens`: running agents keep getting fresh tokens
//! across a hub restart, with no new launch.
//!
//! A writer whose order's starter hasn't connected GitHub is refused at spawn ([`refusal`]), in plain words for the
//! lead to pass on: never anyone else's account. With no App, or on a repository it doesn't reach, nothing changes:
//! the agents use their machine's own `gh` login, as before.
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::github_app::{GITHUB_CONNECT_REFUSAL, GITHUB_TOKEN_ENV};
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::node_link::{CAP_ORDER_ENV, SecretDeliver};
use fleetd_contracts::people::PersonId;
use fleetd_contracts::repos::RepoId;
use fleetd_contracts::tasks::TaskKind;
use rusqlite::params;
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

/// An order's delivered token, as `github_order_tokens` keeps it: the checkout whose sessions hold it (the repo a task
/// works in), whose it is (none: the App's), when it ends, and how close to that it is delivered again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Kept {
    /// The order's project.
    pub r: ProjectRef,
    pub order: WorkstreamId,
    pub checkout: ProjectRef,
    pub repo_id: Option<RepoId>,
    pub person: Option<PersonId>,
    pub expires_ms: i64,
    pub margin_ms: i64,
}

pub(super) fn keep(hub: &Hub, kept: &Kept) -> Result<(), String> {
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO github_order_tokens (machine_id, project_id, workstream_id, checkout_machine_id,
                   checkout_project_id, repo_id, person_id, expires_ms, margin_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (workstream_id, checkout_machine_id, checkout_project_id) DO UPDATE SET
                   repo_id = excluded.repo_id, person_id = excluded.person_id, expires_ms = excluded.expires_ms,
                   margin_ms = excluded.margin_ms",
                params![
                    kept.r.machine_id.as_str(),
                    kept.r.project_id.as_str(),
                    kept.order.as_str(),
                    kept.checkout.machine_id.as_str(),
                    kept.checkout.project_id.as_str(),
                    kept.repo_id.as_ref().map(|r| r.as_str()),
                    kept.person.as_ref().map(|p| p.as_str()),
                    kept.expires_ms,
                    kept.margin_ms
                ],
            )?;
            Ok(())
        })
        .map_err(|e| e.to_string())
}

fn forget(hub: &Hub, checkout: &ProjectRef, order: &WorkstreamId) {
    let gone = hub.db.with(|c| {
        c.execute(
            "DELETE FROM github_order_tokens
             WHERE workstream_id = ? AND checkout_machine_id = ? AND checkout_project_id = ?",
            params![
                order.as_str(),
                checkout.machine_id.as_str(),
                checkout.project_id.as_str()
            ],
        )?;
        Ok(())
    });
    if let Err(e) = gone {
        tracing::warn!(
            order = order.as_str(),
            "github: the order's token not forgotten: {e}"
        );
    }
}

fn project_ref(machine: String, project: String) -> Option<ProjectRef> {
    serde_json::from_value(serde_json::json!({ "machineId": machine, "projectId": project })).ok()
}

/// Every order's delivered token.
pub fn kept(hub: &Hub) -> Vec<Kept> {
    type Row = (
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        i64,
        i64,
    );
    let rows = hub.db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT machine_id, project_id, workstream_id, checkout_machine_id, checkout_project_id, repo_id, person_id,
               expires_ms, margin_ms
             FROM github_order_tokens ORDER BY workstream_id, checkout_machine_id, checkout_project_id",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<Row>>>()?;
        Ok(rows)
    });
    rows.unwrap_or_default()
        .into_iter()
        .filter_map(|(m, p, w, cm, cp, repo, person, expires_ms, margin_ms)| {
            Some(Kept {
                r: project_ref(m, p)?,
                order: WorkstreamId::new(w).ok()?,
                checkout: project_ref(cm, cp)?,
                repo_id: repo.and_then(|r| RepoId::new(r).ok()),
                person: person.and_then(|p| PersonId::new(p).ok()),
                expires_ms,
                margin_ms,
            })
        })
        .collect()
}

/// The task's repository on GitHub (`owner/name`), and the checkout its sessions run in: its own repo's, else the
/// project's.
pub fn repo_at(
    hub: &Hub,
    r: &ProjectRef,
    repo_id: Option<&RepoId>,
) -> Option<(String, ProjectRef)> {
    let repos = hub.repos.repos_of(r).ok()?;
    let repo = match repo_id {
        Some(id) => repos.iter().find(|x| &x.repo_id == id),
        None => repos
            .iter()
            .find(|x| &x.checkout == r)
            .or_else(|| repos.first()),
    }?;
    let name = repo
        .repo_key
        .as_ref()?
        .as_str()
        .strip_prefix("github.com/")?
        .to_owned();
    Some((name, repo.checkout.clone()))
}

/// The task's repository on GitHub (`owner/name`).
pub fn repo_of(hub: &Hub, r: &ProjectRef, repo_id: Option<&RepoId>) -> Option<String> {
    repo_at(hub, r, repo_id).map(|(name, _)| name)
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

/// Hands the sessions of the order's task in that repo their GitHub token, when the App reaches it: sealed to the
/// checkout machine's box key, as one of the order's variables there. So each repo an order works in gets its own: the
/// installation's for its owner, or the starter's. Where the App doesn't reach, or the starter has no token, a token
/// handed there before is withdrawn, so `gh` uses the machine's own login. `Err` says why it couldn't, for a launch to
/// refuse rather than run as the machine's login: a `writer` whose starter hasn't connected is refused here too, as at
/// its spawn (a task queued before the App was installed, or relaunched after a disconnect).
pub async fn deliver(
    hub: &Hub,
    r: &ProjectRef,
    order: &WorkstreamId,
    repo_id: Option<&RepoId>,
    writer: bool,
) -> Result<(), String> {
    let Some((repo, checkout)) = repo_at(hub, r, repo_id) else {
        return Ok(());
    };
    let Some(github) = github_as(hub, r, Some(order), &repo) else {
        withdraw_at(hub, &checkout, order).await;
        return Ok(());
    };
    let (person, margin_ms) = match &github {
        GithubAs::Person(p) => (Some(p.clone()), SESSION_MARGIN_MS),
        GithubAs::App => (None, APP_MARGIN_MS),
    };
    let (token, expires_ms) = match &github {
        GithubAs::Person(person) => match hub.github_app.user_token(person).await? {
            Some(t) => t,
            None if writer => {
                return Err(format!(
                    "{GITHUB_CONNECT_REFUSAL} Its starter connects GitHub in Settings › GitHub"
                ));
            }
            // Not connected: a reader or reviewer opens no PR, and goes without.
            None => {
                withdraw_at(hub, &checkout, order).await;
                return Ok(());
            }
        },
        GithubAs::App => hub
            .github_app
            .installation_token(&repo, APP_MARGIN_MS)
            .await
            .ok_or_else(|| format!("GitHub gave the hub's App no token for {repo}"))?,
    };
    put(hub, &checkout, order, &token).await?;
    keep(
        hub,
        &Kept {
            r: r.clone(),
            order: order.clone(),
            checkout,
            repo_id: repo_id.cloned(),
            person,
            expires_ms,
            margin_ms,
        },
    )
}

/// Has the checkout's node forget the order's `GH_TOKEN`, if it holds one, and forgets it here once it has. A node
/// offline keeps the record, so the sweep tries again.
async fn withdraw_at(hub: &Hub, checkout: &ProjectRef, order: &WorkstreamId) {
    let held = hub
        .db
        .order_env()
        .list(checkout, order.as_str())
        .ok()
        .and_then(|rows| rows.into_iter().find(|v| v.name == GITHUB_TOKEN_ENV));
    let Some(held) = held else {
        forget(hub, checkout, order);
        return;
    };
    let name = fleetd_contracts::project_settings::EnvVarName::unchecked(GITHUB_TOKEN_ENV);
    let fingerprint =
        fleetd_contracts::secrets::SecretFingerprint::unchecked(held.fingerprint.clone());
    match hub
        .executors
        .order_env_drop(
            &checkout.machine_id,
            &checkout.project_id,
            order,
            Some((name, fingerprint)),
        )
        .await
    {
        Ok(()) => {
            if let Err(e) =
                hub.db
                    .order_env()
                    .forget_one(checkout, order.as_str(), GITHUB_TOKEN_ENV)
            {
                tracing::warn!(
                    order = order.as_str(),
                    "github: the withdrawn token's row stays: {e}"
                );
            }
            forget(hub, checkout, order);
        }
        Err(e) => tracing::warn!(
            order = order.as_str(),
            machine = %checkout.machine_id,
            "github: the order's token not withdrawn yet: {e}"
        ),
    }
}

/// Withdraws every token of `person` from their open orders' agents: they disconnected, or left the hub.
pub async fn withdraw_person(hub: &Hub, person: &PersonId) {
    for k in kept(hub)
        .into_iter()
        .filter(|k| k.person.as_ref() == Some(person))
    {
        withdraw_at(hub, &k.checkout, &k.order).await;
    }
}

/// A person leaves the hub: their GitHub token is revoked at GitHub and forgotten, and withdrawn from their orders.
pub async fn forget_person(hub: &Hub, person: &PersonId) {
    if let Err(e) = hub.github_app.disconnect(person).await {
        tracing::warn!("github: a removed person's token not revoked: {e}");
    }
    withdraw_person(hub, person).await;
}

/// Seals `token` to the checkout machine's box key and has its node keep it as the order's `GH_TOKEN` there.
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

/// Delivers again each open order's token that ends within its margin, withdraws a person's who is no longer connected,
/// and forgets closed orders'.
pub async fn renew(hub: &Hub) {
    let now = now_ms(hub.clock.as_ref());
    for kept in kept(hub) {
        let open = hub
            .leads
            .records
            .workstream_get(&kept.order)
            .ok()
            .flatten()
            .is_some_and(|w| !crate::hub::leads::records::is_closed(w.state));
        if !open {
            forget(hub, &kept.checkout, &kept.order);
            continue;
        }
        let gone = kept.person.as_ref().is_some_and(
            |p| !matches!(hub.github_app.account(p), Ok(Some(a)) if a.lapsed != Some(true)),
        );
        if gone {
            withdraw_at(hub, &kept.checkout, &kept.order).await;
            continue;
        }
        if kept.expires_ms - now >= kept.margin_ms {
            continue;
        }
        if let Err(e) = deliver(hub, &kept.r, &kept.order, kept.repo_id.as_ref(), false).await {
            tracing::warn!(
                order = kept.order.as_str(),
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
