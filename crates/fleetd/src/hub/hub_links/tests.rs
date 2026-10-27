//! Two hubs in one process: "home", with the Navi, and "acme", served on a loopback port, whose projects a link
//! reaches.
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use fleetd_contracts::auth::{Grant, GrantMachines, KeyKind, Role, Star};
use fleetd_contracts::chat::ChatAuthor;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::ErrorCode;
use serde_json::{Value, json};

use super::client::{Followed, follow_once, refresh};
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::{CallerAgent, lead_by};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-25T10:00:00.000Z";

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(id),
    }
}

fn hub(
    projects: &[(&str, &str)],
    navi: Option<&str>,
) -> (Arc<Hub>, tempfile::TempDir, Arc<ManualClock>) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let clock = ManualClock::at(1_792_000_000_000);
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    for (id, title) in projects {
        hub.store
            .projects_upsert_many(
                &MachineId::unchecked("devbox"),
                &[serde_json::from_value(json!({
                    "machineId": "devbox", "projectId": id, "title": title, "workspaceRoot": format!("/work/{id}"),
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                }))
                .unwrap()],
            )
            .unwrap();
    }
    if let Some(navi) = navi {
        hub.db
            .with(|c| {
                // Navi core's table (its migration makes it on a hub that has it).
                c.execute_batch(&format!(
                    "CREATE TABLE IF NOT EXISTS assistants (
                       machine_id TEXT NOT NULL, project_id TEXT NOT NULL, created_ms INTEGER NOT NULL,
                       created_by_key TEXT NOT NULL, created_by_name TEXT NOT NULL, archived_ms INTEGER,
                       PRIMARY KEY (machine_id, project_id)
                     );
                     INSERT INTO assistants (machine_id, project_id, created_ms, created_by_key, created_by_name)
                     VALUES ('devbox', '{navi}', 1792000000000, 'k1', 'desk');"
                ))?;
                Ok(())
            })
            .unwrap();
    }
    (hub, home, clock)
}

/// A person's device on `hub`, with `role` on every machine.
/// A device `device` of the person `who` on `hub` (made on first use: an admin for `Role::Admin`, else a member), with
/// `role` on every machine.
fn person(hub: &Hub, who: &str, device: &str, role: Role) -> Caller {
    let people = crate::hub::people::People::new(hub.db.clone(), hub.clock.clone());
    let found = people
        .list(false)
        .unwrap()
        .into_iter()
        .find(|p| p.name.as_str() == who);
    let someone = match found {
        Some(p) => p,
        None => {
            let hub_role = if role == Role::Admin {
                fleetd_contracts::people::HubRole::Admin
            } else {
                fleetd_contracts::people::HubRole::Member
            };
            people
                .create(
                    &fleetd_contracts::people::PersonName::unchecked(who),
                    hub_role,
                )
                .unwrap()
        }
    };
    hub.auth
        .create_key_for(
            device,
            &[Grant {
                role,
                machines: GrantMachines::All(Star::Value),
            }],
            KeyKind::Human,
            Some(&someone.person_id),
        )
        .unwrap()
        .info
}

async fn tool(
    hub: &Arc<Hub>,
    caller: &Caller,
    name: &str,
    input: Value,
) -> Result<Value, (ErrorCode, String)> {
    match registry().call(hub, caller, name, input).await {
        Ok(out) => Ok(out),
        Err(CallError::Tool(e)) => Err((
            e.code,
            format!("{} {}", e.message, e.fix.unwrap_or_default()),
        )),
        Err(other) => panic!("{name}: {other:?}"),
    }
}

/// A lead-side call as `r`'s lead makes it.
async fn lead(hub: &Hub, r: &ProjectRef, call: Value) -> Result<Value, (ErrorCode, String)> {
    let op = call["op"].as_str().unwrap().to_owned();
    let call: LeadCall = serde_json::from_value(call).unwrap();
    let caller = LeadCaller {
        project_ref: r.clone(),
        by: lead_by(r),
        agent: CallerAgent::Lead,
    };
    let out = hub
        .lead_calls
        .handler(&op)
        .unwrap()
        .handle(caller, call)
        .await;
    match out {
        Ok(LeadCallResult::ProjectMessage(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(LeadCallResult::FactoryStatus(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(LeadCallResult::BriefCreate(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(LeadCallResult::Close(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(other) => panic!("unexpected result {other:?}"),
        Err(e) => Err((
            e.code,
            format!("{} {}", e.message, e.fix.unwrap_or_default()),
        )),
    }
}

fn brief() -> Value {
    json!({ "goal": "Gift cards at checkout", "why": "Asked by the person", "pointers": [], "constraints": [],
            "doneWhen": ["A gift card pays at checkout"] })
}

/// Serves `hub` on a loopback port: its URL.
async fn serve(hub: &Arc<Hub>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = crate::hub::http::router(hub.clone(), Arc::new(registry()));
    tokio::spawn(async move { axum::serve(listener, router).await });
    url
}

/// A loopback URL nothing listens on.
async fn closed_url() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    url
}

/// Seals `key` to `hub`'s box key, as the app does.
async fn sealed(hub: &Arc<Hub>, caller: &Caller, key: &str) -> String {
    let got = tool(hub, caller, "hub_links_get", json!({})).await.unwrap();
    let public: [u8; 32] = STANDARD
        .decode(got["boxPubKey"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let boxed = crypto_box::PublicKey::from(public)
        .seal(&mut crypto_box::aead::OsRng, key.as_bytes())
        .unwrap();
    STANDARD.encode(boxed)
}

struct Linked {
    home: Arc<Hub>,
    acme: Arc<Hub>,
    you_home: Caller,
    you_acme: Caller,
    link_there: String,
    link_here: String,
    url: String,
    key: String,
    acme_clock: Arc<ManualClock>,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

/// Home's Navi linked to acme as "acme"; acme calls home "home". `projects` limits the link.
async fn linked(projects: Option<Value>) -> Linked {
    let (home, home_dir, _) = hub(&[("navi", "Home"), ("site", "Site")], Some("navi"));
    let (acme, acme_dir, acme_clock) = hub(
        &[("storefront", "Storefront"), ("checkout", "Checkout")],
        None,
    );
    let url = serve(&acme).await;
    let you_acme = person(&acme, "Alex", "laptop", Role::Operate);
    let you_home = person(&home, "Alex", "laptop", Role::Operate);
    // The Navi is Alex's.
    home.db
        .with(|c| {
            c.execute(
                "UPDATE assistants SET created_by_key = ?",
                [you_home.key_id.as_str()],
            )?;
            Ok(())
        })
        .unwrap();
    let mut mint = json!({ "label": "home" });
    if let Some(p) = projects {
        mint["projects"] = p;
    }
    let minted = tool(&acme, &you_acme, "hub_link_mint", mint).await.unwrap();
    let key = minted["key"].as_str().unwrap().to_owned();
    assert!(key.starts_with("flk_"));
    let sealed = sealed(&home, &you_home, &key).await;
    let added = tool(
        &home,
        &you_home,
        "hub_link_add",
        json!({ "navi": project("navi"), "label": "acme", "url": &url, "sealed": sealed }),
    )
    .await
    .unwrap();
    assert_eq!(added["link"]["state"], "ok");
    // Neither hub keeps the key in the clear, nor returns it again.
    let kept = serde_json::to_string(
        &tool(
            &home,
            &you_home,
            "hub_links_get",
            json!({ "navi": project("navi") }),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert!(!kept.contains(&key));
    Linked {
        link_there: minted["link"]["linkId"].as_str().unwrap().to_owned(),
        link_here: added["link"]["linkId"].as_str().unwrap().to_owned(),
        url,
        key,
        acme_clock,
        home,
        acme,
        you_home,
        you_acme,
        _dirs: (home_dir, acme_dir),
    }
}

fn agent_posts(hub: &Hub, r: &ProjectRef) -> Vec<(String, String)> {
    let (messages, _, _) = hub.chat.page(r, None, None, 50).unwrap();
    messages
        .iter()
        .filter(|m| m.author == ChatAuthor::Agent)
        .map(|m| {
            (
                m.by.clone().map(|b| b.to_string()).unwrap_or_default(),
                m.text.to_string(),
            )
        })
        .collect()
}

async fn read(hub: &Hub, link: &str) -> Vec<String> {
    match follow_once(hub, link, 0).await.unwrap() {
        Followed::Read(sent) => sent.into_iter().map(|(_, l)| l).collect(),
        Followed::Stop => panic!("the follower stopped"),
    }
}

#[tokio::test]
async fn an_ask_from_a_navi_opens_an_order_on_the_other_hub_as_the_person_and_its_news_comes_back()
{
    let l = linked(None).await;
    let navi = project("navi");
    let shop = project("storefront");
    // A local ask first, so the handles here and there differ.
    lead(
        &l.home,
        &navi,
        json!({ "op": "project_message", "project": "site", "text": "Fix the footer." }),
    )
    .await
    .unwrap();
    let out = lead(
        &l.home,
        &navi,
        json!({ "op": "project_message", "hub": "acme", "project": "Storefront", "text": "Gift cards, please." }),
    )
    .await
    .unwrap();
    assert_eq!(out["handle"], "N2", "a handle here");
    assert_eq!(out["hub"], "acme");
    assert_eq!(out["title"], "Storefront");

    // Acme records it as the person, via home's Navi, and sees nothing of the Navi itself.
    let posts = agent_posts(&l.acme, &shop);
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].0, "Alex via home Navi");
    assert!(posts[0].1.starts_with("Gift cards, please."));
    assert!(posts[0].1.contains("pass asked: \"N1\""), "{}", posts[0].1);
    assert!(
        !posts[0].1.contains("Home"),
        "the Navi's own name stays home"
    );
    // Acme's own bridge wakes nobody for it.
    let (_, _, woken) = crate::hub::navi::bridge::step(&l.acme, 0).unwrap();
    assert_eq!(woken, []);

    // Its lead opens an order for acme's N1; home hears it as its own N2.
    let opened = lead(
        &l.acme,
        &shop,
        json!({ "op": "brief_create", "text": "Gift cards", "brief": brief(), "asked": "N1" }),
    )
    .await
    .unwrap();
    let w = opened["workstreamId"].as_str().unwrap().to_owned();
    assert_eq!(
        read(&l.home, &l.link_here).await,
        [format!(
            "- N2 to Storefront on acme: its lead opened order {w} \"Gift cards\""
        )]
    );
    assert!(
        l.home.leads.wakes.pending(&navi),
        "the Navi's lead is woken"
    );

    // Status reads through the link, in home's handles.
    let status = lead(
        &l.home,
        &navi,
        json!({ "op": "factory_status", "hub": "acme", "project": "storefront" }),
    )
    .await
    .unwrap();
    let store = &status["projects"][0];
    assert_eq!(store["title"], "Storefront");
    assert_eq!(store["openOrders"][0]["workstreamId"], w.as_str());
    assert_eq!(store["openOrders"][0]["asked"], "N2");
    assert_eq!(store["asks"][0]["handle"], "N2");
    assert_eq!(store["asks"][0]["orders"], json!([w]));
    // Home's own read names the linked hub and doesn't mix acme's asks into its projects.
    let own = lead(&l.home, &navi, json!({ "op": "factory_status" }))
        .await
        .unwrap();
    assert_eq!(own["hubs"], json!([{ "label": "acme", "state": "ok" }]));
    let site = &own["projects"][0];
    assert_eq!(site["title"], "Site");
    assert_eq!(site["asks"].as_array().unwrap().len(), 1);

    // A retry is the first ask, here and there.
    let again = lead(
        &l.home,
        &navi,
        json!({ "op": "project_message", "hub": "acme", "project": "Storefront", "text": "Gift cards, please." }),
    )
    .await
    .unwrap();
    assert_eq!(again["handle"], "N2");
    assert_eq!(agent_posts(&l.acme, &shop).len(), 1);

    // It lands.
    lead(
        &l.acme,
        &shop,
        json!({ "op": "close", "workstreamId": w, "why": "Gift cards pay at checkout" }),
    )
    .await
    .unwrap();
    assert_eq!(
        read(&l.home, &l.link_here).await,
        [format!(
            "- N2 to Storefront on acme: order {w} \"Gift cards\" is done: Gift cards pay at checkout"
        )]
    );
    assert_eq!(
        read(&l.home, &l.link_here).await,
        Vec::<String>::new(),
        "nothing twice"
    );
}

#[tokio::test]
async fn the_feed_waits_for_news_and_answers_as_it_comes() {
    let l = linked(None).await;
    let navi = project("navi");
    let shop = project("storefront");
    lead(
        &l.home,
        &navi,
        json!({ "op": "project_message", "hub": "acme", "project": "storefront", "text": "Gift cards." }),
    )
    .await
    .unwrap();
    let home = l.home.clone();
    let link = l.link_here.clone();
    let waiting = tokio::spawn(async move { follow_once(&home, &link, 10).await.unwrap() });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(!waiting.is_finished(), "nothing yet: it waits");
    lead(
        &l.acme,
        &shop,
        json!({ "op": "brief_create", "text": "Gift cards", "brief": brief(), "asked": "N1" }),
    )
    .await
    .unwrap();
    let got = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
        .await
        .expect("answered as the news came")
        .unwrap();
    let Followed::Read(sent) = got else {
        panic!("stopped")
    };
    assert_eq!(sent.len(), 1);
    assert!(
        sent[0]
            .1
            .starts_with("- N1 to Storefront on acme: its lead opened order"),
        "{sent:?}"
    );
}

#[tokio::test]
async fn a_project_outside_the_links_limits_is_refused() {
    let l = linked(Some(json!([project("storefront")]))).await;
    let navi = project("navi");
    let (code, why) = lead(
        &l.home,
        &navi,
        json!({ "op": "project_message", "hub": "acme", "project": "Checkout", "text": "Hi." }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden, "{why}");
    assert!(
        why.contains("acme: Checkout is not one of this link's projects"),
        "{why}"
    );
    assert_eq!(agent_posts(&l.acme, &project("checkout")), []);
    let status = lead(
        &l.home,
        &navi,
        json!({ "op": "factory_status", "hub": "acme" }),
    )
    .await
    .unwrap();
    let titles: Vec<&str> = status["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, ["Storefront"]);

    // A link reaches only what it may: one from before people acts at its device, and a read-only device's opens no
    // order. (A person's link acts at their role, and every role operates.)
    let reader = l
        .acme
        .auth
        .create_key(
            "tablet",
            &[
                Grant {
                    role: Role::Read,
                    machines: GrantMachines::All(Star::Value),
                },
                Grant {
                    role: Role::Operate,
                    machines: GrantMachines::Only(vec![MachineId::unchecked("elsewhere")]),
                },
            ],
            KeyKind::Human,
        )
        .unwrap()
        .info;
    let minted = tool(
        &l.acme,
        &reader,
        "hub_link_mint",
        json!({ "label": "home" }),
    )
    .await
    .unwrap();
    let (link, key) = (
        minted["link"]["linkId"].as_str().unwrap().to_owned(),
        reader.key_id.to_string(),
    );
    l.acme
        .db
        .with(|c| {
            c.execute(
                "UPDATE hub_links_issued SET person = NULL WHERE link_id = ?",
                [&link],
            )?;
            c.execute(
                "UPDATE agent_keys SET person_id = NULL WHERE key_id = ?",
                [&key],
            )?;
            Ok(())
        })
        .unwrap();
    let sealed = sealed(&l.home, &l.you_home, minted["key"].as_str().unwrap()).await;
    let url = crate::hub::hub_links::kept_get(&l.home.db, &l.link_here)
        .unwrap()
        .unwrap()
        .url;
    tool(
        &l.home,
        &l.you_home,
        "hub_link_add",
        json!({ "navi": navi, "label": "acme-read", "url": url, "sealed": sealed }),
    )
    .await
    .unwrap();
    let (code, why) = lead(
        &l.home,
        &navi,
        json!({ "op": "project_message", "hub": "acme-read", "project": "Storefront", "text": "Hi." }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden, "{why}");
    assert!(why.contains("only read it"), "{why}");
    // And a person can't limit a link to a project they can't operate.
    let (code, _) = tool(
        &l.acme,
        &reader,
        "hub_link_mint",
        json!({ "label": "home", "projects": [project("storefront")] }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
}

#[tokio::test]
async fn revoking_on_the_other_hub_stops_the_link_at_once() {
    let l = linked(None).await;
    let navi = project("navi");
    let ask =
        json!({ "op": "project_message", "hub": "acme", "project": "storefront", "text": "Hi." });
    // The person sees their link there; another person's device sees nothing; revoking it there stops it.
    let mine = tool(&l.acme, &l.you_acme, "hub_links_get", json!({}))
        .await
        .unwrap();
    assert_eq!(mine["issued"][0]["label"], "home");
    assert_eq!(mine["issued"][0]["device"], "laptop");
    let other = person(&l.acme, "Sam", "phone", Role::Operate);
    let theirs = tool(&l.acme, &other, "hub_links_get", json!({}))
        .await
        .unwrap();
    assert_eq!(theirs["issued"], json!([]));
    let (code, _) = tool(
        &l.acme,
        &other,
        "hub_link_revoke",
        json!({ "linkId": l.link_there }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::NotFound);
    let admin = person(&l.acme, "Robin", "desk", Role::Admin);
    let all = tool(&l.acme, &admin, "hub_links_get", json!({}))
        .await
        .unwrap();
    assert_eq!(
        all["issued"].as_array().unwrap().len(),
        1,
        "an admin sees every link"
    );

    let revoked = tool(
        &l.acme,
        &l.you_acme,
        "hub_link_revoke",
        json!({ "linkId": l.link_there }),
    )
    .await
    .unwrap();
    assert!(revoked["link"]["revokedAt"].is_string());
    let (code, why) = lead(&l.home, &navi, ask.clone()).await.unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    assert!(why.contains("The link to acme no longer works"), "{why}");
    assert!(why.contains("revoked"), "{why}");
    assert_eq!(agent_posts(&l.acme, &project("storefront")), []);
    // The follower tells the Navi once and stops; the app reads it as revoked.
    let got = tool(
        &l.home,
        &l.you_home,
        "hub_links_get",
        json!({ "navi": navi }),
    )
    .await
    .unwrap();
    assert_eq!(got["links"][0]["state"], "revoked");
    assert_eq!(
        follow_once(&l.home, &l.link_here, 0).await.unwrap(),
        Followed::Stop
    );
}

#[tokio::test]
async fn a_link_acts_as_its_person_whatever_their_device_and_stops_when_they_leave() {
    let l = linked(None).await;
    let navi = project("navi");
    let shop = project("storefront");
    let ask = |text: &str| json!({ "op": "project_message", "hub": "acme", "project": "storefront", "text": text });
    // The device it was made on is revoked: the link still acts as Alex, at Alex's role.
    l.acme.auth.revoke(l.you_acme.key_id.as_str()).unwrap();
    lead(&l.home, &navi, ask("Gift cards.")).await.unwrap();
    assert_eq!(agent_posts(&l.acme, &shop)[0].0, "Alex via home Navi");
    // A new name shows on the next ask.
    let people = crate::hub::people::People::new(l.acme.db.clone(), l.acme.clock.clone());
    let alex = l.you_acme.person.clone().unwrap();
    people
        .set(
            &alex.person_id,
            Some(&fleetd_contracts::people::PersonName::unchecked("Alex K")),
            None,
        )
        .unwrap();
    lead(&l.home, &navi, ask("Dark mode.")).await.unwrap();
    assert_eq!(agent_posts(&l.acme, &shop)[1].0, "Alex K via home Navi");
    // Alex leaves acme: the link stops at once, and home marks it revoked.
    people.remove(&alex.person_id).unwrap().unwrap();
    let (code, why) = lead(&l.home, &navi, ask("Receipts.")).await.unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    assert!(why.contains("person who made link"), "{why}");
    assert_eq!(agent_posts(&l.acme, &shop).len(), 2);
    let state = super::kept_get(&l.home.db, &l.link_here)
        .unwrap()
        .unwrap()
        .state;
    assert_eq!(state, fleetd_contracts::hub_links::HubLinkState::Revoked);
}

#[tokio::test]
async fn a_link_never_holds_more_than_the_device_that_made_it() {
    let l = linked(None).await;
    let navi = project("navi");
    let ask =
        json!({ "op": "project_message", "hub": "acme", "project": "storefront", "text": "Hi." });
    // Alex is still on acme, but this device of theirs only reads: it mints nothing, with projects or without.
    let tablet = person(&l.acme, "Alex", "tablet", Role::Read);
    for mint in [
        json!({ "label": "home" }),
        json!({ "label": "home", "projects": [project("storefront")] }),
    ] {
        let (code, why) = tool(&l.acme, &tablet, "hub_link_mint", mint)
            .await
            .unwrap_err();
        assert_eq!(code, ErrorCode::Forbidden);
        assert!(why.contains("lacks the operate role"), "{why}");
    }
    // A link holding a read-only device's grants (made before minting checked) reads but never asks, though Alex
    // operates: it acts at the lesser of the two.
    l.acme
        .db
        .with(|c| {
            c.execute(
                "UPDATE hub_links_issued SET grants = ?",
                [serde_json::to_string(&[Grant {
                    role: Role::Read,
                    machines: GrantMachines::All(Star::Value),
                }])
                .unwrap()],
            )?;
            Ok(())
        })
        .unwrap();
    let (code, why) = lead(&l.home, &navi, ask.clone()).await.unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden, "{why}");
    assert!(agent_posts(&l.acme, &project("storefront")).is_empty());
    let status = lead(
        &l.home,
        &navi,
        json!({ "op": "factory_status", "hub": "acme" }),
    )
    .await
    .unwrap();
    assert!(status.to_string().contains("Storefront"), "{status}");
    // Its device revoked, the link still acts as Alex, and still only reads.
    l.acme.auth.revoke(l.you_acme.key_id.as_str()).unwrap();
    let (code, _) = lead(&l.home, &navi, ask).await.unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    // An admin's link is never more than operate.
    let got = super::verify(&l.acme, &l.key).unwrap();
    assert!(got.grants.iter().all(|g| g.role == Role::Read));
    assert!(
        super::link_grants(
            &[Grant {
                role: Role::Admin,
                machines: GrantMachines::All(Star::Value),
            }],
            Role::Admin
        )
        .iter()
        .all(|g| g.role == Role::Operate)
    );
}

#[tokio::test]
async fn only_the_navis_owner_or_an_admin_changes_its_links() {
    let l = linked(None).await;
    let blake = person(&l.home, "Blake", "desk", Role::Operate);
    let sealed = sealed(&l.home, &blake, &l.key).await;
    let add = json!({ "navi": project("navi"), "label": "acme2", "url": &l.url, "sealed": sealed });
    let (code, why) = tool(&l.home, &blake, "hub_link_add", add.clone())
        .await
        .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    assert!(why.contains("Navi's owner"), "{why}");
    let (code, _) = tool(
        &l.home,
        &blake,
        "hub_link_remove",
        json!({ "linkId": l.link_here }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    // Another device of Alex's may, and so may an admin.
    let phone = person(&l.home, "Alex", "phone", Role::Operate);
    tool(&l.home, &phone, "hub_link_add", add).await.unwrap();
    let admin = person(&l.home, "Sam", "desk", Role::Admin);
    tool(
        &l.home,
        &admin,
        "hub_link_remove",
        json!({ "linkId": l.link_here }),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_removed_link_or_an_archived_navi_wakes_no_one() {
    let l = linked(None).await;
    let navi = project("navi");
    lead(
        &l.home,
        &navi,
        json!({ "op": "project_message", "hub": "acme", "project": "storefront", "text": "Gift cards." }),
    )
    .await
    .unwrap();
    // Removed here while a read waits there: the news it brings back goes nowhere.
    let home = l.home.clone();
    let link = l.link_here.clone();
    let waiting = tokio::spawn(async move { follow_once(&home, &link, 10).await.unwrap() });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    super::forget(&l.home.db, &l.link_here).unwrap();
    lead(
        &l.acme,
        &project("storefront"),
        json!({ "op": "brief_create", "text": "Gift cards", "brief": brief(), "asked": "N1" }),
    )
    .await
    .unwrap();
    let got = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
        .await
        .expect("answered as the news came")
        .unwrap();
    assert_eq!(got, Followed::Stop);
    // An archived Navi's links are no longer followed.
    let l = linked(None).await;
    l.home
        .db
        .with(|c| {
            c.execute_batch("UPDATE assistants SET archived_ms = 1792000000000")?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        follow_once(&l.home, &l.link_here, 0).await.unwrap(),
        Followed::Stop
    );
}

#[tokio::test]
async fn a_link_from_before_people_acts_at_its_device_and_dies_with_it() {
    let l = linked(None).await;
    let navi = project("navi");
    let ask =
        json!({ "op": "project_message", "hub": "acme", "project": "storefront", "text": "Hi." });
    l.acme
        .db
        .with(|c| {
            c.execute_batch(
                "UPDATE hub_links_issued SET person = NULL; UPDATE agent_keys SET person_id = NULL;",
            )?;
            Ok(())
        })
        .unwrap();
    lead(&l.home, &navi, ask.clone()).await.unwrap();
    assert_eq!(
        agent_posts(&l.acme, &project("storefront"))[0].0,
        "laptop via home Navi"
    );
    l.acme.auth.revoke(l.you_acme.key_id.as_str()).unwrap();
    let (code, why) = lead(&l.home, &navi, ask).await.unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    assert!(why.contains("device that made link"), "{why}");
}

#[tokio::test]
async fn removing_the_link_on_the_navis_hub_deletes_the_key_and_revokes_it_there() {
    let l = linked(None).await;
    let navi = project("navi");
    let removed = tool(
        &l.home,
        &l.you_home,
        "hub_link_remove",
        json!({ "linkId": l.link_here }),
    )
    .await
    .unwrap();
    assert_eq!(removed["revokedThere"], true);
    let (code, why) = lead(
        &l.home,
        &navi,
        json!({ "op": "project_message", "hub": "acme", "project": "storefront", "text": "Hi." }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::NotFound);
    assert!(why.contains("no linked hub called acme"), "{why}");
    let rows: i64 = l
        .home
        .db
        .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM hub_links", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 0, "the sealed key is gone");
    let there = tool(&l.acme, &l.you_acme, "hub_links_get", json!({}))
        .await
        .unwrap();
    assert!(there["issued"][0]["revokedAt"].is_string());
    assert_eq!(
        follow_once(&l.home, &l.link_here, 0).await.unwrap(),
        Followed::Stop
    );
}

#[tokio::test]
async fn an_unreachable_hub_says_so_plainly() {
    let l = linked(None).await;
    let navi = project("navi");
    let closed = closed_url().await;
    l.home
        .db
        .with(|c| {
            c.execute("UPDATE hub_links SET url = ?", [&closed])?;
            Ok(())
        })
        .unwrap();
    let (code, why) = lead(
        &l.home,
        &navi,
        json!({ "op": "project_message", "hub": "acme", "project": "storefront", "text": "Hi." }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Failed);
    assert!(
        why.contains(&format!("Can't reach acme at {closed}")),
        "{why}"
    );
    assert!(why.contains("over a tailnet or HTTPS"), "{why}");
    let got = tool(
        &l.home,
        &l.you_home,
        "hub_links_get",
        json!({ "navi": navi }),
    )
    .await
    .unwrap();
    assert_eq!(got["links"][0]["state"], "unreachable");
    assert!(
        got["links"][0]["error"]
            .as_str()
            .unwrap()
            .contains("Can't reach acme")
    );
    let own = lead(&l.home, &navi, json!({ "op": "factory_status" }))
        .await
        .unwrap();
    assert_eq!(own["hubs"][0]["state"], "unreachable");
    // The follower retries rather than stopping.
    assert!(follow_once(&l.home, &l.link_here, 0).await.is_err());

    // Adding a link to a hub that doesn't answer is refused the same way, and keeps nothing.
    let sealed = sealed(&l.home, &l.you_home, "flk_whatever").await;
    let (code, why) = tool(
        &l.home,
        &l.you_home,
        "hub_link_add",
        json!({ "navi": navi, "label": "nowhere", "url": closed, "sealed": sealed }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Failed);
    assert!(why.contains("Can't reach nowhere"), "{why}");
    // Plain HTTP off a tailnet is refused before anything is sent.
    let (code, why) = tool(
        &l.home,
        &l.you_home,
        "hub_link_add",
        json!({ "navi": navi, "label": "lan", "url": "http://192.168.1.20:4790", "sealed": sealed }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Invalid);
    assert!(why.contains("in the clear"), "{why}");
}

#[test]
fn link_urls_are_https_or_a_private_path() {
    for ok in [
        "https://hub.example.com",
        "http://127.0.0.1:4790",
        "http://localhost:4790",
        "http://100.104.1.2:4790",
        "http://devbox.tail1234.ts.net:4790",
        "http://[fd7a:115c:a1e0::1]:4790",
    ] {
        assert!(super::check_url(ok).is_ok(), "{ok}");
    }
    for bad in [
        "http://hub.example.com",
        "http://10.0.0.2:4790",
        "http://100.200.1.2",
        "ftp://hub.example.com",
        "hub",
    ] {
        assert!(super::check_url(bad).is_err(), "{bad}");
    }
}

#[tokio::test]
async fn only_a_person_links_hubs_and_only_for_a_navi() {
    let l = linked(None).await;
    let agent = l
        .acme
        .auth
        .create_key(
            "scout",
            &[Grant {
                role: Role::Admin,
                machines: GrantMachines::All(Star::Value),
            }],
            KeyKind::Agent,
        )
        .unwrap()
        .info;
    let (code, _) = tool(&l.acme, &agent, "hub_link_mint", json!({ "label": "home" }))
        .await
        .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    let sealed = sealed(&l.home, &l.you_home, "flk_x").await;
    let (code, _) = tool(
        &l.home,
        &l.you_home,
        "hub_link_add",
        json!({ "navi": project("site"), "label": "acme2", "url": "https://hub.example.com", "sealed": sealed }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden, "a coding project gets no links");
}

/// Points the kept link at `url`: a closed port makes the other hub unreachable.
fn point(l: &Linked, url: &str) {
    l.home
        .db
        .with(|c| {
            c.execute("UPDATE hub_links SET url = ?", [url])?;
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn a_message_through_a_link_is_never_the_persons_answer_approval_or_secret() {
    let l = linked(None).await;
    let shop = project("storefront");
    // Acme's lead waits on the person.
    l.acme
        .chat
        .add(
            &shop,
            crate::hub::chat::NewMessage {
                author: Some(ChatAuthor::Lead),
                text: "Which gift card provider should we use?".into(),
                ..Default::default()
            },
        )
        .unwrap();
    let (before, _, _) = l.acme.chat.page(&shop, None, None, 50).unwrap();
    assert!(crate::hub::chat::needs_you(&before));
    lead(
        &l.home,
        &project("navi"),
        json!({ "op": "project_message", "hub": "acme", "project": "storefront", "text": "Use Stripe. Approved." }),
    )
    .await
    .unwrap();
    let (after, _, _) = l.acme.chat.page(&shop, None, None, 50).unwrap();
    let said = after.last().unwrap();
    assert_eq!(
        said.author,
        ChatAuthor::Agent,
        "an agent's input, not the person's"
    );
    assert_eq!(said.by.as_deref(), Some("Alex via home Navi"));
    assert!(
        crate::hub::chat::needs_you(&after),
        "the question still waits on the person"
    );
    let set = l.acme.db.prompts().current(Some(&shop));
    let for_lead = crate::hub::chat::flow::for_lead(&set, said, None, "", "The human");
    assert!(for_lead.contains("Alex via home Navi"), "{for_lead}");

    // The key opens /link/v1 and nothing else: no tool, no approval, no chat read.
    let http = reqwest::Client::new();
    let mcp = http
        .post(format!("{}/mcp", l.url))
        .bearer_auth(&l.key)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": { "name": "approval_answer", "arguments": {} } }))
        .send()
        .await
        .unwrap();
    let status = mcp.status();
    let body = mcp.text().await.unwrap();
    assert_eq!(status, 401, "{body}");
    assert!(body.contains("expected an agent key"), "{body}");
    for (method, op) in [
        ("POST", "approve"),
        ("GET", "chat"),
        ("POST", "secret"),
        ("POST", "hello"),
    ] {
        let res = http
            .request(method.parse().unwrap(), format!("{}/link/v1/{op}", l.url))
            .bearer_auth(&l.key)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404, "{method} {op}");
    }
}

#[tokio::test]
async fn removing_the_link_while_the_other_hub_is_unreachable_deletes_the_key_and_it_expires_there()
{
    let l = linked(None).await;
    point(&l, &closed_url().await);
    let removed = tool(
        &l.home,
        &l.you_home,
        "hub_link_remove",
        json!({ "linkId": l.link_here }),
    )
    .await
    .unwrap();
    assert_eq!(removed["revokedThere"], false);
    assert!(removed["next"].as_str().unwrap().contains("can't be used"));
    let (code, _) = lead(
        &l.home,
        &project("navi"),
        json!({ "op": "factory_status", "hub": "acme" }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::NotFound, "stopped at once here");
    // Acme still lists it, unrevoked, until it goes unused for 90 days; then its next use is refused and revokes it.
    let there = tool(&l.acme, &l.you_acme, "hub_links_get", json!({}))
        .await
        .unwrap();
    assert!(there["issued"][0]["revokedAt"].is_null());
    l.acme_clock.advance(std::time::Duration::from_millis(
        super::IDLE_EXPIRY_MS as u64,
    ));
    let refused = super::client::call::<Value>(
        &l.url,
        &l.key,
        None,
        "hello",
        std::time::Duration::from_secs(5),
    )
    .await
    .unwrap_err();
    let super::client::Failure::Dead(e) = refused else {
        panic!("{refused:?}")
    };
    assert!(e.message.contains("unused for 90 days"), "{}", e.message);
    let there = tool(&l.acme, &l.you_acme, "hub_links_get", json!({}))
        .await
        .unwrap();
    assert!(there["issued"][0]["revokedAt"].is_string());
}

#[tokio::test]
async fn revoking_on_the_other_hub_while_unreachable_stops_the_link_once_it_answers() {
    let l = linked(None).await;
    let navi = project("navi");
    let status = json!({ "op": "factory_status", "hub": "acme" });
    point(&l, &closed_url().await);
    tool(
        &l.acme,
        &l.you_acme,
        "hub_link_revoke",
        json!({ "linkId": l.link_there }),
    )
    .await
    .unwrap();
    // Acme never calls home: home only learns at its next call that gets through.
    let (code, why) = lead(&l.home, &navi, status.clone()).await.unwrap_err();
    assert_eq!(code, ErrorCode::Failed);
    assert!(why.contains("Can't reach acme"), "{why}");
    assert!(
        follow_once(&l.home, &l.link_here, 0).await.is_err(),
        "the follower retries"
    );
    point(&l, &l.url);
    // Nothing goes through: the follower hears it is dead, tells the Navi once and stops.
    assert_eq!(
        follow_once(&l.home, &l.link_here, 0).await.unwrap(),
        Followed::Stop
    );
    assert!(l.home.leads.wakes.pending(&navi));
    let (code, why) = lead(&l.home, &navi, status).await.unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    assert!(why.contains("revoked on this hub"), "{why}");
}

#[tokio::test]
async fn a_pasted_key_with_a_newline_is_kept_trimmed_and_works() {
    let l = linked(None).await;
    let minted = tool(
        &l.acme,
        &l.you_acme,
        "hub_link_mint",
        json!({ "label": "home" }),
    )
    .await
    .unwrap();
    let pasted = format!("{}\n", minted["key"].as_str().unwrap());
    let sealed = sealed(&l.home, &l.you_home, &pasted).await;
    let added = tool(
        &l.home,
        &l.you_home,
        "hub_link_add",
        json!({ "navi": project("navi"), "label": "acme-pasted", "url": l.url, "sealed": sealed }),
    )
    .await
    .unwrap();
    let id = added["link"]["linkId"].as_str().unwrap();
    let kept = super::kept_get(&l.home.db, id).unwrap().unwrap();
    let key = super::box_key(&l.home).unwrap().open(&kept.sealed).unwrap();
    assert_eq!(
        key.as_slice(),
        minted["key"].as_str().unwrap().as_bytes(),
        "kept trimmed"
    );
    let out = lead(
        &l.home,
        &project("navi"),
        json!({ "op": "project_message", "hub": "acme-pasted", "project": "storefront", "text": "Hi." }),
    )
    .await
    .unwrap();
    assert_eq!(out["hub"], "acme-pasted");
}

/// Answers every `/link/v1` call under `/<how>/` as a broken or hostile hub would: `unauth` a 401 without `dead`,
/// `redirect` a redirect to `to`, `big` 2 MB.
async fn stand_in(to: &str) -> String {
    use axum::response::IntoResponse;
    let to = to.to_owned();
    let router = axum::Router::new().route(
        "/{how}/link/v1/{op}",
        axum::routing::any(
            move |axum::extract::Path((how, op)): axum::extract::Path<(String, String)>| {
                let to = to.clone();
                async move {
                    match how.as_str() {
                        "unauth" => (
                            axum::http::StatusCode::UNAUTHORIZED,
                            axum::Json(json!({ "code": "forbidden", "message": "Sign in first." })),
                        )
                            .into_response(),
                        "redirect" => {
                            axum::response::Redirect::temporary(&format!("{to}/link/v1/{op}"))
                                .into_response()
                        }
                        _ => "x".repeat(2 * 1024 * 1024).into_response(),
                    }
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await });
    url
}

#[tokio::test]
async fn only_the_other_hubs_word_that_the_key_is_dead_revokes_the_link() {
    let l = linked(None).await;
    let navi = project("navi");
    let status = json!({ "op": "factory_status", "hub": "acme" });
    let state = |l: &Linked| {
        super::kept_get(&l.home.db, &l.link_here)
            .unwrap()
            .unwrap()
            .state
    };

    // A store failure on acme is a 500, not a revoke: the link works again once acme does.
    let rename = |from: &str, to: &str| {
        let sql = format!("ALTER TABLE {from} RENAME TO {to}");
        l.acme.db.with(|c| Ok(c.execute_batch(&sql)?)).unwrap();
    };
    rename("people", "people_away");
    let (code, why) = lead(&l.home, &navi, status.clone()).await.unwrap_err();
    assert_eq!(code, ErrorCode::Failed, "{why}");
    assert_eq!(state(&l), fleetd_contracts::hub_links::HubLinkState::Ok);
    assert!(
        follow_once(&l.home, &l.link_here, 0).await.is_err(),
        "the follower retries"
    );
    rename("people_away", "people");
    lead(&l.home, &navi, status.clone()).await.unwrap();

    // A 401 without `dead`, as a proxy in front of the hub might answer, is a refusal, not a revoke.
    let other = stand_in(&l.url).await;
    point(&l, &format!("{other}/unauth"));
    let (code, why) = lead(&l.home, &navi, status.clone()).await.unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden, "{why}");
    assert!(why.contains("acme: Sign in first."), "{why}");
    assert_ne!(
        state(&l),
        fleetd_contracts::hub_links::HubLinkState::Revoked
    );
    assert!(
        follow_once(&l.home, &l.link_here, 0).await.is_err(),
        "the follower retries"
    );

    // The key never follows a redirect, and an answer over 1 MB is refused.
    for (how, says) in [
        ("redirect", "answered 307"),
        ("big", "more than 1048576 bytes"),
    ] {
        point(&l, &format!("{other}/{how}"));
        let (code, why) = lead(&l.home, &navi, status.clone()).await.unwrap_err();
        assert_eq!(code, ErrorCode::Failed, "{how}: {why}");
        assert!(why.contains(says), "{how}: {why}");
    }
    assert_eq!(agent_posts(&l.acme, &project("storefront")), []);

    // The real refusal says `dead`, and only then is the link revoked here.
    point(&l, &l.url);
    tool(
        &l.acme,
        &l.you_acme,
        "hub_link_revoke",
        json!({ "linkId": l.link_there }),
    )
    .await
    .unwrap();
    let (code, _) = lead(&l.home, &navi, status).await.unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    assert_eq!(
        state(&l),
        fleetd_contracts::hub_links::HubLinkState::Revoked
    );
}

#[tokio::test]
async fn the_navis_hub_shows_who_a_link_acts_as_and_its_projects_as_the_other_hub_says() {
    let links = |l: &Linked| {
        let (hub, you) = (l.home.clone(), l.you_home.clone());
        async move {
            tool(
                &hub,
                &you,
                "hub_links_get",
                json!({ "navi": project("navi") }),
            )
            .await
            .unwrap()["links"][0]
                .clone()
        }
    };
    let l = linked(Some(json!([project("storefront")]))).await;
    let link = links(&l).await;
    assert_eq!(link["who"], "Alex");
    assert_eq!(
        link["projects"],
        json!([{ "projectRef": project("storefront"), "title": "Storefront" }])
    );
    // Read again when its follower starts: a rename there shows here.
    l.acme
        .db
        .with(|c| {
            c.execute("UPDATE people SET name = 'Alex Kim'", [])?;
            Ok(())
        })
        .unwrap();
    refresh(&l.home, &l.link_here).await;
    assert_eq!(links(&l).await["who"], "Alex Kim");
    // A link to every project of theirs names none.
    let all = linked(None).await;
    let link = links(&all).await;
    assert_eq!(link["who"], "Alex");
    assert!(link.get("projects").is_none(), "{link}");
}

#[test]
fn a_link_key_is_copied_with_an_address_another_hub_reaches_never_a_local_one() {
    use super::reachable_url;
    assert_eq!(
        reachable_url("https://hub.acme.example/").as_deref(),
        Some("https://hub.acme.example")
    );
    assert_eq!(
        reachable_url("http://100.101.102.103:4790").as_deref(),
        Some("http://100.101.102.103:4790")
    );
    for local in [
        "http://127.0.0.1:4790",
        "http://localhost:4790",
        "https://localhost:4790",
        "http://0.0.0.0:4790",
        "http://192.168.1.20:4790",
        "http://[::1]:4790",
    ] {
        assert_eq!(reachable_url(local), None, "{local}");
    }
}
