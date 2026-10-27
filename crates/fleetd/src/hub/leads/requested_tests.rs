//! When the human asked for an order the lead opens: the earliest human chat message of the run that opened it, or
//! when it opened, flagged; and every order's request time as the metrics read it.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::chat::{ChatAuthor, ChatDelivery, ChatHistorySource};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::ledger::{IntakeChannel, Workstream};
use serde_json::json;

use super::records::StoredLead;
use super::requested::{self, Requested, RequestedBasis};
use super::workstreams::IntakeInput;
use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::chat::NewMessage;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, NewEvent, iso_ms, now_ms};

const T0: i64 = 1_792_000_000_000;
const AT: &str = "2026-10-19T10:00:00.000Z";

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("app"),
    }
}

struct Lab {
    hub: Arc<Hub>,
    clock: Arc<ManualClock>,
    _home: tempfile::TempDir,
}

impl Lab {
    /// A hub with the project and its lead on `lead-thread`.
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0 as u64);
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
            queue_ttl_sec: None,
        };
        let hub = crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone())
            .unwrap();
        hub.store
            .projects_upsert_many(
                &project().machine_id,
                &[serde_json::from_value(json!({
                    "machineId": "devbox", "projectId": "app", "title": "app", "workspaceRoot": "/work/app",
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                }))
                .unwrap()],
            )
            .unwrap();
        let lab = Self {
            hub,
            clock,
            _home: home,
        };
        lab.lead_on("lead-thread");
        lab
    }

    fn now(&self) -> i64 {
        now_ms(self.clock.as_ref())
    }

    fn later(&self, secs: u64) {
        self.clock.advance(Duration::from_secs(secs));
    }

    fn lead_on(&self, thread: &str) {
        self.hub
            .leads
            .records
            .lead_put(&StoredLead {
                project_ref: project(),
                thread_id: ThreadId::unchecked(thread),
                started_at: iso_ms(self.now()).into(),
                last_wake_at: None,
                session_generation: 1,
            })
            .unwrap();
    }

    fn event(&self, r#type: HubEventType, thread: &str) {
        self.hub
            .events
            .append(NewEvent {
                at: iso_ms(self.now()).into(),
                r#type,
                machine_id: Some(project().machine_id),
                project_id: Some(project().project_id),
                thread_id: Some(ThreadId::unchecked(thread)),
                summary: "x".into(),
                data: None,
                attention: None,
            })
            .unwrap();
    }

    /// A message in the chat, written now; a human's went in as `delivery`.
    fn says(&self, author: ChatAuthor, delivery: Option<ChatDelivery>) -> i64 {
        let at = self.now();
        self.hub
            .chat
            .add(
                &project(),
                NewMessage {
                    author: Some(author),
                    text: "build schedules".into(),
                    delivery,
                    created_ms: Some(at),
                    ..Default::default()
                },
            )
            .unwrap();
        at
    }

    fn human(&self, delivery: ChatDelivery) -> i64 {
        self.says(ChatAuthor::Human, Some(delivery))
    }

    /// The lead's `brief` with no workstream: it opens one.
    async fn opens(&self) -> Workstream {
        let handler = self.hub.lead_calls.handler("brief_create").unwrap();
        let brief = json!({ "goal": "schedules", "why": "asked", "pointers": [], "constraints": [], "doneWhen": ["schedules ship"] });
        let call: LeadCall = serde_json::from_value(
            json!({ "op": "brief_create", "text": "build schedules", "brief": brief }),
        )
        .unwrap();
        let caller = LeadCaller {
            project_ref: project(),
            by: "lead:devbox/app".into(),
            agent: CallerAgent::Lead,
        };
        let Ok(LeadCallResult::BriefCreate(opened)) = handler.handle(caller, call).await else {
            panic!("not opened")
        };
        self.hub
            .leads
            .records
            .workstream_get(&opened.workstream_id)
            .unwrap()
            .unwrap()
    }

    fn requested(&self, w: &Workstream) -> Requested {
        requested::get(&self.hub.db, w).unwrap()
    }
}

fn chat(at_ms: i64) -> Requested {
    Requested {
        at_ms,
        basis: RequestedBasis::Chat,
    }
}

#[tokio::test]
async fn an_order_the_lead_opens_was_asked_for_by_the_message_that_woke_it() {
    let lab = Lab::new();
    lab.later(60);
    let asked = lab.human(ChatDelivery::Turn);
    lab.later(90);
    let w = lab.opens().await;
    assert_eq!(lab.requested(&w), chat(asked));
    assert!(
        asked < lab.now(),
        "earlier than it opened, by the lead's turn"
    );
}

#[tokio::test]
async fn the_earliest_human_message_of_the_run_counts_and_earlier_runs_dont() {
    let lab = Lab::new();
    lab.human(ChatDelivery::Turn);
    lab.later(30);
    lab.event(HubEventType::ThreadCompleted, "lead-thread");
    lab.later(60);
    let asked = lab.human(ChatDelivery::Turn);
    lab.later(10);
    lab.says(ChatAuthor::Lead, None);
    lab.later(10);
    lab.human(ChatDelivery::Steer);
    lab.later(10);
    let w = lab.opens().await;
    assert_eq!(lab.requested(&w), chat(asked));
}

#[tokio::test]
async fn with_no_human_message_in_its_run_it_is_when_the_lead_opened_it() {
    let lab = Lab::new();
    lab.human(ChatDelivery::Turn);
    lab.later(30);
    lab.event(HubEventType::ThreadCompleted, "lead-thread");
    lab.later(60);
    // Not the human's: an agent's message, history, and one still held for the lead.
    lab.says(ChatAuthor::Agent, None);
    lab.hub
        .chat
        .add(
            &project(),
            NewMessage {
                author: Some(ChatAuthor::Human),
                text: "old order".into(),
                history: Some(ChatHistorySource::Order),
                created_ms: Some(lab.now()),
                ..Default::default()
            },
        )
        .unwrap();
    lab.hub
        .chat
        .add(
            &project(),
            NewMessage {
                author: Some(ChatAuthor::Human),
                text: "later".into(),
                held: true,
                created_ms: Some(lab.now()),
                ..Default::default()
            },
        )
        .unwrap();
    lab.later(30);
    let w = lab.opens().await;
    assert_eq!(
        lab.requested(&w),
        Requested {
            at_ms: lab.now(),
            basis: RequestedBasis::Opened
        }
    );
}

#[tokio::test]
async fn a_message_sent_now_belongs_to_the_run_it_interrupted_for() {
    let lab = Lab::new();
    lab.human(ChatDelivery::Turn);
    lab.later(30);
    let asked = lab.human(ChatDelivery::Now);
    lab.event(HubEventType::ThreadInterrupted, "lead-thread");
    lab.later(30);
    let w = lab.opens().await;
    assert_eq!(lab.requested(&w), chat(asked));
}

#[tokio::test]
async fn a_fresh_leads_first_run_starts_after_the_old_leads_last() {
    let lab = Lab::new();
    lab.event(HubEventType::LeadStarted, "lead-thread");
    lab.human(ChatDelivery::Turn);
    lab.later(30);
    lab.event(HubEventType::ThreadCompleted, "lead-thread");
    lab.later(60);
    lab.lead_on("lead-fresh");
    lab.event(HubEventType::LeadStarted, "lead-fresh");
    let asked = lab.human(ChatDelivery::Turn);
    lab.later(30);
    let w = lab.opens().await;
    assert_eq!(lab.requested(&w), chat(asked));
}

#[tokio::test]
async fn a_submitted_order_was_asked_for_when_submitted_and_an_older_lead_one_when_it_opened() {
    let lab = Lab::new();
    let submitted = lab
        .hub
        .leads
        .workstreams
        .intake(IntakeInput {
            project_ref: project(),
            text: "dark mode".into(),
            client_request_id: "c1".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
        })
        .unwrap();
    let w = lab
        .hub
        .leads
        .records
        .workstream_get(&submitted.workstream_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        lab.requested(&w),
        Requested {
            at_ms: T0,
            basis: RequestedBasis::Source
        }
    );
    // One the lead opened before the stamp existed.
    let old = lab
        .hub
        .leads
        .workstreams
        .open(
            IntakeInput {
                project_ref: project(),
                text: "schedules".into(),
                client_request_id: "c2".into(),
                channel: IntakeChannel::Lead,
                by: "lead:devbox/app".into(),
            },
            None,
        )
        .unwrap();
    lab.hub
        .db
        .with(|c| {
            c.execute(
                "UPDATE workstreams SET requested_ms = NULL, requested_basis = NULL",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let w = lab
        .hub
        .leads
        .records
        .workstream_get(&old.workstream_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        lab.requested(&w),
        Requested {
            at_ms: T0,
            basis: RequestedBasis::Opened
        }
    );
}

/// Teams: the order a person starts by writing to the lead in the app records them as who started it.
#[tokio::test]
async fn an_order_the_lead_opens_records_the_person_whose_message_started_it() {
    let lab = Lab::new();
    let alice = fleetd_contracts::people::PersonRef {
        person_id: fleetd_contracts::people::PersonId::unchecked("p_alice234"),
        name: fleetd_contracts::people::PersonName::unchecked("Alice"),
    };
    lab.later(60);
    lab.hub
        .chat
        .add(
            &project(),
            NewMessage {
                author: Some(ChatAuthor::Human),
                text: "build schedules".into(),
                delivery: Some(ChatDelivery::Turn),
                person: Some(alice.clone()),
                created_ms: Some(lab.now()),
                ..Default::default()
            },
        )
        .unwrap();
    lab.later(30);
    let w = lab.opens().await;
    assert_eq!(w.started_by.as_ref(), Some(&alice));

    // An order the lead opens on its own, with no person's message in its turn, names no one.
    lab.event(HubEventType::ThreadCompleted, "lead-thread");
    lab.later(60);
    let own = lab.opens().await;
    assert_eq!(own.started_by, None);
}
