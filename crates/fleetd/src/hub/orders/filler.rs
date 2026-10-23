//! Max efficiency without compromising: a free slot goes to approved work. Whenever a slot frees (a task's or a lead's
//! turn ended, or the cap moved) the hub looks at each idle lead's project. If approved, unblocked plan items no task
//! has taken are waiting, or its finish-all order has room for another child, and its tasks could take a slot, the
//! lead is woken with the next of them.
//!
//! It is a wake, never a spawn: the lead decides, and the approval, review and train gates stay where they are.
//! Nothing qualifies, nothing is said; idle is fine then. A lead is told about the same runnable set once: it hears
//! again only when that set changes (an item taken, done, added or unblocked), so a lead that leaves work waiting on
//! purpose is not woken in a loop by its own turn ending.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::{LeadState, WorkstreamState};
use tokio::sync::Notify;

use crate::hub::api::Hub;
use crate::hub::leads::events::Event;
use crate::hub::leads::records::WorkstreamFilter;
use crate::hub::leads::wakes::{LineKind, Trigger};
use crate::hub::plan::Runnable;
use crate::hub::plan::store::pkey;

/// At most this many items are named in one wake; the rest are counted.
const MAX_NAMED: usize = 5;

/// One piece of work a free slot could start, as the lead is told it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    /// What identifies it across passes: a plan item's id, or a finish-all order with its open children.
    pub key: String,
    pub text: String,
}

pub fn item_offer(item: &Runnable) -> Offer {
    let size = match item.size {
        fleetd_contracts::plan::Size::S => "s",
        fleetd_contracts::plan::Size::M => "m",
        fleetd_contracts::plan::Size::L => "l",
    };
    Offer {
        key: item.item_id.clone(),
        text: format!(
            "{} '{}' ({}, size {size})",
            item.item_id, item.title, item.workstream_id
        ),
    }
}

/// A finish-all order with room: the lead takes its next item from `inventory`.
pub fn finish_all_offer(workstream_id: &str, open_children: usize, max_children: u32) -> Offer {
    let room = (max_children as usize).saturating_sub(open_children);
    Offer {
        key: format!("{workstream_id}+{open_children}"),
        text: format!(
            "finish-all {workstream_id} has room for {room} more child order{}: call `inventory` and start the next \
             item with a value source with `workstream_spawn`",
            if room == 1 { "" } else { "s" }
        ),
    }
}

/// What one pass reads of a project.
pub struct Facts {
    /// In the order the lead should take them.
    pub offers: Vec<Offer>,
    /// Slots the project's tasks could take now.
    pub room: i64,
    /// The lead's turn has ended (it is not running, starting, stalled or parked).
    pub lead_idle: bool,
}

/// The runnable set each project's lead was last woken with.
#[derive(Default)]
pub struct Memory(HashMap<String, Vec<String>>);

impl Memory {
    /// The offers to wake the lead with now: some approved work is runnable, a slot is free for it, the lead is idle,
    /// and it wasn't already told about exactly this set. Remembers the set it returns.
    pub fn decide<'a>(&mut self, project: &str, facts: &'a Facts) -> Option<&'a [Offer]> {
        if facts.offers.is_empty() {
            self.0.remove(project);
            return None;
        }
        if !facts.lead_idle || facts.room <= 0 {
            return None;
        }
        let keys: Vec<String> = facts.offers.iter().map(|o| o.key.clone()).collect();
        if self.0.get(project) == Some(&keys) {
            return None;
        }
        self.0.insert(project.to_owned(), keys);
        let named = (facts.room as usize).clamp(1, MAX_NAMED);
        Some(&facts.offers[..named.min(facts.offers.len())])
    }
}

/// The wake line: the next offers by name, how many more there are, and how many slots are free.
pub fn line(offers: &[Offer], total: usize, room: i64) -> String {
    let mut items = offers
        .iter()
        .map(|o| o.text.as_str())
        .collect::<Vec<_>>()
        .join("; ");
    if total > offers.len() {
        items.push_str(&format!("; and {} more", total - offers.len()));
    }
    Event::Runnable {
        items: &items,
        room,
    }
    .render()
}

/// The orders whose items are approved work: running on a brief, so the human asked for them.
fn approved(hub: &Hub, r: &ProjectRef) -> HashSet<String> {
    hub.leads
        .records
        .workstreams_list(&WorkstreamFilter {
            project_ref: Some(r.clone()),
            open: true,
            limit: 200,
            ..Default::default()
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|w| {
            w.brief.is_some()
                && matches!(
                    w.state,
                    WorkstreamState::Running | WorkstreamState::Converging
                )
        })
        .map(|w| w.workstream_id.to_string())
        .collect()
}

pub async fn facts(hub: &Hub, r: &ProjectRef) -> Option<Facts> {
    let lead = hub.leads.leads.get(r).ok().flatten()?;
    let lead_idle = lead.state == LeadState::Idle && lead.parked.is_none();
    let mut offers: Vec<Offer> = match hub.plans.runnable(r, &approved(hub, r)) {
        Ok(items) => items.iter().map(item_offer).collect(),
        Err(error) => {
            tracing::warn!(%error, "slot filler: plan not read");
            return None;
        }
    };
    match hub.leads.finish_all.room(r).await {
        Ok(Some((id, open, max))) => offers.push(finish_all_offer(id.as_str(), open, max)),
        Ok(None) => {}
        Err(error) => tracing::warn!(?error, "slot filler: finish-all room not read"),
    }
    Some(Facts {
        offers,
        room: hub.slots.room(r),
        lead_idle,
    })
}

/// One pass over every project with a lead.
pub async fn pass(hub: &Hub, memory: &mut Memory) {
    let leads = match hub.leads.records.leads_list() {
        Ok(leads) => leads,
        Err(error) => {
            tracing::warn!(%error, "slot filler: leads not listed");
            return;
        }
    };
    for stored in leads {
        let r = stored.project_ref;
        let Some(facts) = facts(hub, &r).await else {
            continue;
        };
        if let Some(offers) = memory.decide(&pkey(&r), &facts) {
            let text = line(offers, facts.offers.len(), facts.room);
            tracing::info!(project = %pkey(&r), offers = facts.offers.len(), "slot filler: waking the lead");
            hub.leads.wakes.trigger(
                &r,
                Trigger::Line {
                    kind: LineKind::Runnable,
                    text,
                },
            );
        }
    }
}

/// Runs a pass after every slot release, coalescing bursts: releases while a pass runs make one more pass.
pub async fn run(hub: Arc<Hub>) {
    let freed = Arc::new(Notify::new());
    let notify = freed.clone();
    if let Err(error) = hub.slots.on_release(Arc::new(move || notify.notify_one())) {
        tracing::error!(%error, "slot filler: slot listener not registered");
        return;
    }
    let mut memory = Memory::default();
    loop {
        freed.notified().await;
        pass(&hub, &mut memory).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer(key: &str) -> Offer {
        Offer {
            key: key.into(),
            text: format!("{key} work"),
        }
    }

    fn facts(keys: &[&str], room: i64, lead_idle: bool) -> Facts {
        Facts {
            offers: keys.iter().map(|k| offer(k)).collect(),
            room,
            lead_idle,
        }
    }

    fn keys(offers: Option<&[Offer]>) -> Option<Vec<&str>> {
        offers.map(|o| o.iter().map(|o| o.key.as_str()).collect())
    }

    #[test]
    fn a_free_slot_offers_the_next_approved_items_up_to_the_room() {
        let mut m = Memory::default();
        assert_eq!(
            keys(m.decide("p", &facts(&["P4", "P5", "P6"], 2, true))),
            Some(vec!["P4", "P5"])
        );
        let mut m = Memory::default();
        let many: Vec<String> = (1..=9).map(|n| format!("P{n}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert_eq!(
            m.decide("p", &facts(&many, 40, true)).unwrap().len(),
            MAX_NAMED
        );
    }

    #[test]
    fn nothing_runnable_no_free_slot_or_a_busy_lead_means_no_wake() {
        let mut m = Memory::default();
        assert!(
            m.decide("p", &facts(&[], 5, true)).is_none(),
            "idle is fine"
        );
        assert!(m.decide("p", &facts(&["P4"], 0, true)).is_none());
        assert!(m.decide("p", &facts(&["P4"], 3, false)).is_none());
        // Not remembered while it couldn't be said: the next free slot says it.
        assert!(m.decide("p", &facts(&["P4"], 1, true)).is_some());
    }

    #[test]
    fn a_lead_hears_about_a_runnable_set_once_and_again_only_when_it_changes() {
        let mut m = Memory::default();
        assert!(m.decide("p", &facts(&["P4", "P5"], 2, true)).is_some());
        // Its own turn ending frees a slot again, and again: no loop.
        for _ in 0..3 {
            assert!(m.decide("p", &facts(&["P4", "P5"], 2, true)).is_none());
        }
        // It took P4; P5 still waits, which is new.
        assert_eq!(
            keys(m.decide("p", &facts(&["P5"], 1, true))),
            Some(vec!["P5"])
        );
        assert!(m.decide("p", &facts(&["P5"], 1, true)).is_none());
        // Everything taken, later something new: said again.
        assert!(m.decide("p", &facts(&[], 1, true)).is_none());
        assert!(m.decide("p", &facts(&["P5"], 1, true)).is_some());
        // Projects are apart.
        assert!(m.decide("q", &facts(&["P5"], 1, true)).is_some());
    }

    #[test]
    fn a_finish_all_offer_changes_with_its_open_children() {
        assert_ne!(
            finish_all_offer("W5", 1, 3).key,
            finish_all_offer("W5", 2, 3).key
        );
        assert!(
            finish_all_offer("W5", 2, 3)
                .text
                .contains("room for 1 more child order:")
        );
    }

    #[test]
    fn the_line_names_the_offers_counts_the_rest_and_never_a_time() {
        let text = line(&[offer("P4")], 3, 1);
        assert_eq!(
            text,
            "- 1 slot free; approved work can start: P4 work; and 2 more"
        );
        for word in ["minute", "hour", "ETA", "soon"] {
            assert!(!text.contains(word), "{word} in {text}");
        }
    }
}

/// Over a real in-memory hub: which plan items count as approved and runnable, and that a pass only wakes the lead.
#[cfg(test)]
mod hub_tests {
    use fleetd_contracts::ids::{MachineId, ProjectId, ThreadId};
    use fleetd_contracts::ledger::IntakeChannel;
    use fleetd_contracts::plan::{PlanAddCall, PlanItemId, PlanMilestoneCall};
    use fleetd_contracts::tasks::TaskId;
    use serde_json::json;

    use super::*;
    use crate::hub::api::{HubConfig, Listen};
    use crate::hub::leads::records::{NewWorkstream, StoredLead};
    use crate::hub::store::test_clock::ManualClock;
    use crate::hub::store::{HubDb, StoredThread};
    use crate::hub::tasks::TaskFilter;

    const AT: &str = "2026-10-19T10:00:00.000Z";

    fn project() -> ProjectRef {
        ProjectRef {
            machine_id: MachineId::unchecked("lab-a"),
            project_id: ProjectId::unchecked("p1"),
        }
    }

    fn order(hub: &Hub, title: &str, frozen: bool) -> String {
        let (w, _) = hub
            .leads
            .records
            .workstream_create(NewWorkstream {
                project_ref: project(),
                title: title.into(),
                text: title.into(),
                channel: IntakeChannel::App,
                by: "human".into(),
                at: AT.into(),
                client_request_id: None,
                playbook: None,
                parent: None,
            })
            .unwrap();
        if frozen {
            let mut stored = hub
                .leads
                .records
                .workstream_get(&w.workstream_id)
                .unwrap()
                .unwrap();
            stored.brief = Some(
                serde_json::from_value(json!({
                    "goal": title, "why": "asked", "pointers": [], "constraints": [], "tier": "M",
                    "doneWhen": [{ "type": "ci_green", "repo": "acme/app" }],
                }))
                .unwrap(),
            );
            stored.state = WorkstreamState::Running;
            hub.leads.records.workstream_put(&stored).unwrap();
        }
        w.workstream_id.to_string()
    }

    fn lead_thread(hub: &Hub, status: &str) {
        hub.store
            .thread_upsert(&StoredThread {
                thread: serde_json::from_value(json!({
                    "machineId": "lab-a", "threadId": "lead-thread", "projectId": "p1", "title": "lead",
                    "status": status, "headline": "", "latestMessageTail": "", "lastProgressAt": AT,
                    "stale": false, "asOf": AT,
                }))
                .unwrap(),
                last_sequence: None,
                last_run_id: None,
                last_run_status: None,
            })
            .unwrap();
    }

    fn hub() -> (Arc<Hub>, tempfile::TempDir) {
        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
            queue_ttl_sec: None,
        };
        let hub = crate::hub::serve::build_on(
            HubDb::open_memory().unwrap(),
            config,
            ManualClock::at(1_792_000_000_000),
        )
        .unwrap();
        hub.store
            .projects_upsert_many(
                &project().machine_id,
                &[serde_json::from_value(json!({
                    "machineId": "lab-a", "projectId": "p1", "title": "app", "workspaceRoot": "/work/app",
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                }))
                .unwrap()],
            )
            .unwrap();
        hub.leads
            .records
            .lead_put(&StoredLead {
                project_ref: project(),
                thread_id: ThreadId::unchecked("lead-thread"),
                started_at: AT.into(),
                last_wake_at: None,
                session_generation: 1,
            })
            .unwrap();
        (hub, home)
    }

    fn add(hub: &Hub, title: &str, ws: &str, after: &[&str]) -> String {
        let call: PlanAddCall = serde_json::from_value(json!({
            "title": title, "milestoneId": "M1", "workstreamId": ws, "after": after,
        }))
        .unwrap();
        hub.plans
            .add(&project(), "lead:lab-a/p1", call)
            .unwrap()
            .item
            .item_id
            .to_string()
    }

    #[tokio::test]
    async fn only_approved_unblocked_untaken_items_are_offered_and_a_pass_only_wakes_the_lead() {
        let (hub, _home) = hub();
        let w1 = order(&hub, "Checkout", true);
        let draft = order(&hub, "Not yet briefed", false);
        hub.plans
            .milestone(
                &project(),
                serde_json::from_value::<PlanMilestoneCall>(json!({ "title": "Checkout" }))
                    .unwrap(),
            )
            .unwrap();
        let cart = add(&hub, "cart page", &w1, &[]);
        add(&hub, "pay page", &w1, &[&cart]);
        add(&hub, "draft work", &draft, &[]);
        let taken = add(&hub, "taken work", &w1, &[]);
        hub.db
            .with(|c| {
                crate::hub::plan::Plans::link_task(
                    c,
                    &PlanItemId::unchecked(&taken),
                    &fleetd_contracts::ledger::WorkstreamId::new(&w1).unwrap(),
                    &TaskId::unchecked("T1"),
                )?;
                Ok(())
            })
            .unwrap();

        lead_thread(&hub, "running");
        let busy = facts(&hub, &project()).await.unwrap();
        assert!(!busy.lead_idle, "a lead mid-turn is not interrupted");
        lead_thread(&hub, "completed");
        let f = facts(&hub, &project()).await.unwrap();
        let keys: Vec<&str> = f.offers.iter().map(|o| o.key.as_str()).collect();
        assert_eq!(
            keys,
            [cart.as_str()],
            "the pay page waits on the cart, the draft isn't approved, one is taken"
        );
        assert!(f.lead_idle && f.room > 0);
        assert!(f.offers[0].text.contains("'cart page' (W1, size m)"));

        let mut memory = Memory::default();
        pass(&hub, &mut memory).await;
        assert!(hub.leads.wakes.pending(&project()), "the lead is woken");
        let tasks = hub
            .tasks
            .list(&TaskFilter {
                project_ref: Some(project()),
                state: None,
                workstream_id: None,
                limit: 10,
            })
            .unwrap();
        assert!(tasks.is_empty(), "nothing is spawned for it");
    }
}
