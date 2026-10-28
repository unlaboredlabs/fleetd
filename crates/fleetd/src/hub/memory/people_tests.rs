//! D212: each person's "You" memory is their own. Only they edit it; the agents of work they start, their Navi, and a
//! project's lead only on a one-person hub read it; the shared user.md went to the owner and stays for admins.
use std::sync::Arc;

use fleetd_contracts::auth::{Grant, KeyKind};
use fleetd_contracts::chat::{ChatAuthor, ChatDelivery};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId};
use fleetd_contracts::lead_calls::LeadCall;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::people::{HubRole, PersonId, PersonName};
use serde_json::{Value, json};

use super::{Target, You};
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::chat::NewMessage;
use crate::hub::leads::records::{NewWorkstream, StoredLead};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::people::People;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, iso_ms};

const AT: &str = "2026-10-25T10:00:00.000Z";

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(id),
    }
}

fn config(home: &tempfile::TempDir) -> HubConfig {
    HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    }
}

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config(&home),
        ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    for id in ["fleetd", "console"] {
        hub.store
            .projects_upsert_many(
                &MachineId::unchecked("devbox"),
                &[serde_json::from_value(json!({
                    "machineId": "devbox", "projectId": id, "title": id, "workspaceRoot": format!("/work/{id}"),
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                }))
                .unwrap()],
            )
            .unwrap();
    }
    (hub, home)
}

fn people(hub: &Hub) -> People {
    People::new(hub.db.clone(), hub.clock.clone())
}

fn owner(hub: &Hub) -> PersonId {
    people(hub).ensure_owner().unwrap().person_id
}

fn person(hub: &Hub, name: &str, role: HubRole) -> PersonId {
    people(hub)
        .create(&PersonName::unchecked(name), role)
        .unwrap()
        .person_id
}

/// A device of `person`: Admin on every machine for an owner or admin, else Operate.
fn device(hub: &Hub, person: &PersonId, role: &str) -> Caller {
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": role, "machines": "*" }])).unwrap();
    hub.auth
        .create_key_for("desk", &grants, KeyKind::Human, Some(person))
        .unwrap()
        .info
}

fn mine(hub: &Hub, p: &PersonId) -> String {
    hub.db.memory().read(&Target::user(Some(p)))
}

fn write(hub: &Hub, p: Option<&PersonId>, text: &str) {
    hub.db.memory().set(&Target::user(p), text).unwrap();
}

async fn call(
    hub: &Arc<Hub>,
    caller: &Caller,
    tool: &str,
    input: Value,
) -> Result<Value, ErrorCode> {
    registry()
        .call(hub, caller, tool, input)
        .await
        .map_err(|e| match e {
            CallError::Tool(e) => e.code,
            other => panic!("{tool}: {other:?}"),
        })
}

fn order(
    hub: &Hub,
    r: &ProjectRef,
    by: Option<&PersonId>,
) -> fleetd_contracts::ledger::WorkstreamId {
    let records = &hub.leads.records;
    let (w, _) = records
        .workstream_create(NewWorkstream {
            project_ref: r.clone(),
            title: "Ship it".into(),
            text: "Ship it".into(),
            channel: fleetd_contracts::ledger::IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    let started_by = by.map(|id| people(hub).person_ref(id).unwrap().unwrap());
    records
        .workstream_put(&fleetd_contracts::ledger::Workstream {
            started_by,
            ..w.clone()
        })
        .unwrap();
    w.workstream_id
}

/// `key`'s Navi, as project `id`.
fn navi(hub: &Hub, key: &Caller, id: &str) -> ProjectRef {
    let r = project(id);
    hub.db
        .with(|c| {
            crate::hub::navi::store::put(
                c,
                &r,
                &fleetd_contracts::model::ProjectCreator {
                    key_id: key.key_id.to_string(),
                    name: "desk".into(),
                },
                0,
            )?;
            Ok(())
        })
        .unwrap();
    r
}

fn lead_on(hub: &Hub, r: &ProjectRef) {
    hub.leads
        .records
        .lead_put(&StoredLead {
            project_ref: r.clone(),
            thread_id: ThreadId::unchecked("lead-1"),
            started_at: iso_ms(1_791_000_000_000).into(),
            last_wake_at: None,
            session_generation: 1,
        })
        .unwrap();
}

/// `p` writes to the lead of `r`, now.
fn writes(hub: &Hub, r: &ProjectRef, p: &PersonId) {
    hub.chat
        .add(
            r,
            NewMessage {
                author: Some(ChatAuthor::Human),
                text: "use tables".into(),
                delivery: Some(ChatDelivery::Turn),
                person: people(hub).person_ref(p).unwrap(),
                ..Default::default()
            },
        )
        .unwrap();
}

async fn lead_call(
    hub: &Hub,
    r: &ProjectRef,
    agent: CallerAgent,
    call: Value,
) -> Result<(), String> {
    let call: LeadCall = serde_json::from_value(call).unwrap();
    let op = fleetd_contracts::lead_calls::op_name(&call);
    let caller = LeadCaller {
        project_ref: r.clone(),
        by: crate::hub::link::lead_calls::lead_by(r),
        agent,
    };
    hub.lead_calls
        .handler(&op)
        .unwrap()
        .handle(caller, call)
        .await
        .map(|_| ())
        .map_err(|e| format!("{}: {}", e.message, e.fix.unwrap_or_default()))
}

#[tokio::test]
async fn each_person_edits_only_their_own_memory_and_an_admin_only_deletes_a_removed_persons() {
    let (hub, home) = hub();
    let alice = owner(&hub);
    let bob = person(&hub, "Bob", HubRole::Member);
    let carol = person(&hub, "Carol", HubRole::Admin);
    let (alice_desk, bob_desk, carol_desk) = (
        device(&hub, &alice, "admin"),
        device(&hub, &bob, "operate"),
        device(&hub, &carol, "admin"),
    );
    let set = |text: &str| json!({ "scope": "user", "text": text });
    call(&hub, &alice_desk, "memory_set", set("- Terse.\n"))
        .await
        .unwrap();
    call(&hub, &bob_desk, "memory_set", set("- Tables.\n"))
        .await
        .unwrap();
    assert_eq!(mine(&hub, &alice), "- Terse.\n");
    assert_eq!(mine(&hub, &bob), "- Tables.\n");
    assert!(
        home.path()
            .join(format!("memory/people/{alice}.md"))
            .exists()
    );
    assert!(!home.path().join("memory/user.md").exists());

    // memory_get shows each their own, and nobody else's.
    let got = call(&hub, &bob_desk, "memory_get", json!({}))
        .await
        .unwrap();
    assert_eq!(got["user"]["text"], "- Tables.\n");
    let got = call(&hub, &carol_desk, "memory_get", json!({}))
        .await
        .unwrap();
    assert_eq!(got["user"]["text"], "");

    // Nobody else edits it, an admin no more than a member, and not to empty it either.
    for (desk, text) in [
        (&bob_desk, "- Mine now.\n"),
        (&carol_desk, ""),
        (&carol_desk, "x"),
    ] {
        let e = call(
            &hub,
            desk,
            "memory_set",
            json!({ "scope": "user", "personId": alice, "text": text }),
        )
        .await
        .unwrap_err();
        assert_eq!(e, ErrorCode::Forbidden);
    }
    assert_eq!(mine(&hub, &alice), "- Terse.\n");

    // Once Bob is removed, an admin deletes his memory, and only deletes it; a member can't.
    people(&hub).remove(&bob).unwrap();
    let delete_bobs = |text: &str| json!({ "scope": "user", "personId": bob, "text": text });
    assert_eq!(
        call(&hub, &carol_desk, "memory_set", delete_bobs("- Kept.\n"))
            .await
            .unwrap_err(),
        ErrorCode::Forbidden
    );
    call(&hub, &carol_desk, "memory_set", delete_bobs(""))
        .await
        .unwrap();
    assert_eq!(mine(&hub, &bob), "");
}

#[tokio::test]
async fn the_agents_of_work_a_person_started_and_their_navi_read_their_memory() {
    let (hub, _home) = hub();
    let alice = owner(&hub);
    let bob = person(&hub, "Bob", HubRole::Member);
    write(&hub, Some(&alice), "- Alice: terse.\n");
    write(&hub, Some(&bob), "- Bob: tables.\n");
    let r = project("fleetd");
    let injected = |you: &You| hub.db.memory().injected(&r, false, you);

    // A writer of Bob's order reads Bob's memory, and only his.
    let bobs = You::for_task(&hub.db, &r, &order(&hub, &r, Some(&bob))).unwrap();
    assert_eq!(bobs, You::Person(bob.clone()));
    assert!(injected(&bobs).contains("- Bob: tables."));
    assert!(!injected(&bobs).contains("Alice"));
    // An order no person started (an automation's, a train fix's) reads nobody's on a hub of several people.
    let nobodys = You::for_task(&hub.db, &r, &order(&hub, &r, None)).unwrap();
    assert_eq!(nobodys, You::Nobody);
    assert_eq!(injected(&nobodys), "");

    // Bob's Navi, its lead and its tasks, read Bob's.
    let bobs_navi = navi(&hub, &device(&hub, &bob, "operate"), "navi-bob");
    assert_eq!(
        You::for_lead(&hub.db, &bobs_navi).unwrap(),
        You::Person(bob.clone())
    );
    assert_eq!(
        You::for_task(&hub.db, &bobs_navi, &order(&hub, &bobs_navi, None)).unwrap(),
        You::Person(bob)
    );
}

/// A project's lead answers everyone in one long session: anyone's memory in it would be read while it answers the
/// others. So it gets none on a hub of several people, and the one person's on a one-person hub, as before people.
#[tokio::test]
async fn a_projects_lead_reads_personal_memory_only_on_a_one_person_hub() {
    let (hub, _home) = hub();
    let alice = owner(&hub);
    write(&hub, Some(&alice), "- Alice: terse.\n");
    let r = project("fleetd");
    let you = You::for_lead(&hub.db, &r).unwrap();
    assert_eq!(you, You::Person(alice.clone()));
    assert!(
        hub.db
            .memory()
            .injected(&r, true, &you)
            .contains("- Alice: terse.")
    );

    person(&hub, "Bob", HubRole::Member);
    let you = You::for_lead(&hub.db, &r).unwrap();
    assert_eq!(you, You::Nobody);
    assert!(!hub.db.memory().injected(&r, true, &you).contains("Alice"));
}

#[tokio::test]
async fn a_leads_remember_in_user_scope_goes_to_the_person_it_answers_and_only_they_undo_it() {
    let (hub, _home) = hub();
    let alice = owner(&hub);
    let bob = person(&hub, "Bob", HubRole::Member);
    let r = project("fleetd");
    lead_on(&hub, &r);
    writes(&hub, &r, &bob);
    let remember =
        json!({ "op": "remember", "scope": "user", "text": "Bob reads tables, not prose." });
    lead_call(&hub, &r, CallerAgent::Lead, remember)
        .await
        .unwrap();
    assert_eq!(mine(&hub, &bob), "- Bob reads tables, not prose.\n");
    assert_eq!(mine(&hub, &alice), "");

    // The chat line's Undo is Bob's alone.
    let line = hub
        .chat
        .page(&r, None, None, 100)
        .unwrap()
        .0
        .into_iter()
        .find(|m| m.remembered.is_some())
        .unwrap();
    assert_eq!(
        line.remembered.as_ref().unwrap().person.as_ref(),
        Some(&bob)
    );
    let undo = json!({ "projectRef": r, "messageId": line.message_id });
    let alice_desk = device(&hub, &alice, "admin");
    assert_eq!(
        call(&hub, &alice_desk, "memory_undo", undo.clone())
            .await
            .unwrap_err(),
        ErrorCode::Forbidden
    );
    // Its note shows in Bob's memory, not in Alice's.
    let bob_desk = device(&hub, &bob, "operate");
    let got = call(&hub, &bob_desk, "memory_get", json!({}))
        .await
        .unwrap();
    assert_eq!(got["user"]["notes"].as_array().unwrap().len(), 1);
    let got = call(&hub, &alice_desk, "memory_get", json!({}))
        .await
        .unwrap();
    assert_eq!(got["user"]["notes"].as_array().unwrap().len(), 0);
    call(&hub, &bob_desk, "memory_undo", undo).await.unwrap();
    assert_eq!(mine(&hub, &bob), "");

    // A turn no person's message is behind, on a hub of several people, writes nobody's.
    let console = project("console");
    lead_on(&hub, &console);
    let refused = lead_call(
        &hub,
        &console,
        CallerAgent::Lead,
        json!({ "op": "remember", "scope": "user", "text": "Someone likes tables." }),
    )
    .await
    .unwrap_err();
    assert!(refused.contains("no one person"), "{refused}");
    // Project scope stays the project's, whoever asked.
    lead_call(
        &hub,
        &console,
        CallerAgent::Lead,
        json!({ "op": "remember", "scope": "project", "text": "Tests run with make test." }),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn the_nightly_refresh_adds_to_the_one_writers_memory_and_skips_when_several_wrote() {
    let (hub, _home) = hub();
    let alice = owner(&hub);
    let bob = person(&hub, "Bob", HubRole::Member);
    let r = project("fleetd");
    writes(&hub, &r, &bob);
    assert_eq!(
        super::refresh::you(&hub.db, &r).unwrap(),
        You::Person(bob.clone())
    );
    let add = json!({ "op": "remember", "scope": "user", "text": "Bob reads tables." });
    lead_call(&hub, &r, CallerAgent::MemoryRefresh, add.clone())
        .await
        .unwrap();
    assert_eq!(mine(&hub, &bob), "- Bob reads tables.\n");

    writes(&hub, &r, &alice);
    assert_eq!(super::refresh::you(&hub.db, &r).unwrap(), You::Nobody);
    let refused = lead_call(&hub, &r, CallerAgent::MemoryRefresh, add)
        .await
        .unwrap_err();
    assert!(refused.contains("leave user memory as it is"), "{refused}");
    assert_eq!(mine(&hub, &alice), "");
}

#[tokio::test]
async fn the_shared_user_md_goes_to_the_owner_at_the_first_start_and_stays_for_admins() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("memory")).unwrap();
    std::fs::write(home.path().join("memory/user.md"), "- Old rule.\n").unwrap();
    let hub = crate::hub::serve::build(config(&home), ManualClock::at(1_792_000_000_000)).unwrap();
    let owner = owner(&hub);
    assert_eq!(mine(&hub, &owner), "- Old rule.\n");
    assert_eq!(hub.db.memory().read(&Target::user(None)), "- Old rule.\n");

    // Once: the owner's own edits stand, even emptied.
    write(&hub, Some(&owner), "");
    assert!(!hub.db.memory().migrate_shared(&hub.db, &owner).unwrap());
    assert_eq!(mine(&hub, &owner), "");

    // "Shared memory" is the admins' to read and retire; a member's device gets neither.
    let member = person(&hub, "Bob", HubRole::Member);
    let member_desk = device(&hub, &member, "operate");
    for (tool, input) in [
        ("memory_shared_get", json!({})),
        ("memory_shared_set", json!({ "text": "" })),
    ] {
        assert_eq!(
            call(&hub, &member_desk, tool, input).await.unwrap_err(),
            ErrorCode::Forbidden
        );
    }
    let admin_desk = device(&hub, &owner, "admin");
    let got = call(&hub, &admin_desk, "memory_shared_get", json!({}))
        .await
        .unwrap();
    assert_eq!(got["file"]["text"], "- Old rule.\n");
    call(
        &hub,
        &admin_desk,
        "memory_shared_set",
        json!({ "text": "" }),
    )
    .await
    .unwrap();
    assert!(!home.path().join("memory/user.md").exists());
}

#[tokio::test]
async fn a_hub_before_people_keeps_its_one_shared_user_md() {
    let (hub, home) = hub();
    let r = project("fleetd");
    assert_eq!(You::of(&hub.db, None).unwrap(), You::Shared);
    assert_eq!(
        You::for_task(&hub.db, &r, &order(&hub, &r, None)).unwrap(),
        You::Shared
    );
    lead_call(
        &hub,
        &r,
        CallerAgent::Lead,
        json!({ "op": "remember", "scope": "user", "text": "Concise." }),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(home.path().join("memory/user.md")).unwrap(),
        "- Concise.\n"
    );
    assert!(
        hub.db
            .memory()
            .injected(&r, true, &You::for_lead(&hub.db, &r).unwrap())
            .contains("- Concise.")
    );
}
