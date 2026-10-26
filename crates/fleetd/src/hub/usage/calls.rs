//! The lead's `usage_resume`: the same resume as the MCP tool, scoped to the machine its project runs on and at most
//! once per [`LEAD_RESUME_EVERY_MS`] per machine, recorded as the lead's (`lead:<machine>/<project>`). A task can't
//! make it (`tasks::policy`). The human resumes from the app's Resume or `fleetd usage resume <machine>`.
use std::sync::{Arc, Weak};

use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult, UsageResumeResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::prim::Count;

use crate::hub::api::Hub;
use crate::hub::link::lead_calls::LeadCallFuture;
use crate::hub::link::{LeadCaller, LeadCalls};
use crate::hub::store::{iso_ms, now_ms};

pub const OPS: [&str; 1] = ["usage_resume"];
/// How often a lead may lift one machine's pause: a login still limited parks again on the next turn, so a lead
/// that kept resuming would only spend requests.
pub const LEAD_RESUME_EVERY_MS: i64 = 10 * 60_000;

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                match call {
                    LeadCall::UsageResume(call) => {
                        resume(&hub, &caller, call.machine_id.as_ref().map(|m| m.as_str())).await
                    }
                    _ => Err(McpToolError::new(
                        ErrorCode::Invalid,
                        "The usage area handles only usage_resume.",
                    )),
                }
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    for op in OPS {
        calls.register(op, handler.clone());
    }
}

async fn resume(
    hub: &Hub,
    caller: &LeadCaller,
    machine: Option<&str>,
) -> Result<LeadCallResult, McpToolError> {
    let own = caller.project_ref.machine_id.as_str();
    let machine = machine.unwrap_or(own);
    if machine != own {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            format!("A lead resumes only the machine its project runs on ({own}), not {machine}."),
        )
        .with_fix(format!(
            "Ask the human to press Resume in the app, or to run fleetd usage resume {machine}."
        )));
    }
    let before = hub.usage.status(machine, Err(String::new())).await;
    let now = now_ms(hub.clock.as_ref());
    if let Some(at) = hub
        .usage
        .last_resumed_by(machine, &caller.by)
        .filter(|at| now - at < LEAD_RESUME_EVERY_MS)
    {
        let again = iso_ms(at + LEAD_RESUME_EVERY_MS);
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            format!(
                "You resumed {machine} at {}; a lead may once every {} minutes.",
                iso_ms(at),
                LEAD_RESUME_EVERY_MS / 60_000
            ),
        )
        .with_fix(format!(
            "If the login is still limited, the agents parked again with its reset: wait for it. To go on sooner, ask \
             the human to press Resume in the app (or run fleetd usage resume {machine}); you may again from {again}."
        )));
    }
    let open = before.breaker.state == "open";
    let resumed = hub.usage.resume(machine, &caller.by).await;
    let next = if !open && resumed == 0 {
        format!("Nothing was paused on {machine}.")
    } else {
        format!(
            "Resumed {machine}: sent \"continue\" to {}. If its login is still limited, they park again on their \
             next turn with the real reset.",
            super::time::plural(resumed, "parked agent")
        )
    };
    Ok(LeadCallResult::UsageResume(UsageResumeResult {
        machine_id: caller.project_ref.machine_id.clone(),
        resumed: Count::unchecked(resumed as i64),
        breaker_cleared: open,
        next: Some(next),
    }))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
    use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult, UsageResumeCall};
    use serde_json::{Value, json};

    use crate::hub::api::{Caller, Hub, HubConfig, Listen};
    use crate::hub::leads::records::StoredLead;
    use crate::hub::link::LeadCaller;
    use crate::hub::link::lead_calls::{CallerAgent, lead_by};
    use crate::hub::store::test_clock::ManualClock;
    use crate::hub::store::{HubDb, NewEvent};

    /// 2026-10-25T22:40:38Z.
    const T0: u64 = 1_792_968_038_000;

    fn forge() -> ProjectRef {
        ProjectRef {
            machine_id: MachineId::unchecked("forge"),
            project_id: ProjectId::unchecked("fleetd"),
        }
    }

    /// A hub whose project's lead runs on forge, with forge's login paused: the lead and two other threads hit
    /// its limit within a minute.
    async fn paused() -> (Arc<Hub>, Arc<ManualClock>, tempfile::TempDir) {
        let home = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let hub = crate::hub::serve::build_on(
            HubDb::open_memory().unwrap(),
            HubConfig {
                home: home.path().to_path_buf(),
                listen: Listen::default(),
                url: None,
                queue_ttl_sec: None,
            },
            clock.clone(),
        )
        .unwrap();
        hub.ops.bind(&hub);
        hub.leads
            .records
            .lead_put(&StoredLead {
                project_ref: forge(),
                thread_id: fleetd_contracts::ids::ThreadId::unchecked("lead"),
                started_at: crate::hub::store::iso_ms(T0 as i64 - 3_600_000).into(),
                last_wake_at: None,
                session_generation: 1,
            })
            .unwrap();
        for (i, thread) in ["lead", "w1", "w2"].iter().enumerate() {
            let event: NewEvent = serde_json::from_value(json!({
                "at": crate::hub::store::iso_ms(T0 as i64 + i as i64 * 1000), "type": "thread.usage_limited",
                "machineId": "forge", "projectId": "fleetd", "threadId": thread, "summary": "hit the usage limit",
                "data": { "usageClass": "usage_limit", "resumeAt": "2026-10-25T23:40:38.000Z",
                          "error": { "class": "usage_limit", "message": "You've hit your limit" } },
            }))
            .unwrap();
            hub.events.append(event).unwrap();
        }
        hub.usage.drain().await;
        assert!(hub.usage.gate("forge").is_some(), "paused");
        (hub, clock, home)
    }

    /// Each usage.resumed so far: whether it lifted the pause, and by whom.
    async fn resumed_by(hub: &Hub) -> Vec<(bool, String)> {
        let page = hub
            .events
            .wait(crate::hub::store::WaitInput {
                cursor: Some(0),
                types: Some(vec![
                    serde_json::from_value(json!("usage.resumed")).unwrap(),
                ]),
                machine_id: None,
                timeout_sec: 0,
            })
            .await
            .unwrap();
        page.events
            .into_iter()
            .map(|e| {
                let d = e.data.unwrap_or(Value::Null);
                (
                    d["breakerCleared"] == true,
                    d["by"].as_str().unwrap_or("").to_owned(),
                )
            })
            .collect()
    }

    /// Resume in the app and `fleetd usage resume forge` both call usage_resume with the person's key.
    #[tokio::test]
    async fn a_persons_usage_resume_lifts_the_pause_recorded_as_theirs() {
        let (hub, _clock, _home) = paused().await;
        let person: Caller = serde_json::from_value(json!({
            "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": "2026-10-25T10:00:00.000Z",
            "grants": [{ "role": "operate", "machines": "*" }], "kind": "human",
        }))
        .unwrap();
        let machine = json!({
            "machineId": "forge", "name": "forge", "tags": [], "status": "online",
            "lastSeenAt": crate::hub::store::iso_ms(T0 as i64), "nodeVersion": "0.0.0",
        });
        hub.store
            .machine_upsert(&serde_json::from_value(machine).unwrap(), None)
            .unwrap();
        let out = crate::hub::api::registry()
            .call(
                &hub,
                &person,
                "usage_resume",
                json!({ "machineId": "forge" }),
            )
            .await
            .unwrap_or_else(|e| panic!("{e:?}"));
        assert_eq!(out["status"]["breaker"]["state"], "closed");
        assert_eq!(hub.usage.gate("forge"), None);
        assert_eq!(resumed_by(&hub).await, [(true, "desk".to_owned())]);
    }

    async fn lead_resume(hub: &Hub, machine: Option<&str>) -> Result<LeadCallResult, String> {
        let caller = LeadCaller {
            project_ref: forge(),
            by: lead_by(&forge()),
            agent: CallerAgent::Lead,
        };
        let call = LeadCall::UsageResume(UsageResumeCall {
            machine_id: machine.map(MachineId::unchecked),
        });
        hub.lead_calls
            .handler("usage_resume")
            .unwrap()
            .handle(caller, call)
            .await
            .map_err(|e| format!("{}: {}", e.message, e.fix.unwrap_or_default()))
    }

    #[tokio::test]
    async fn the_lead_resumes_only_its_projects_machine_once_per_10_minutes_as_itself() {
        let (hub, clock, _home) = paused().await;
        let elsewhere = lead_resume(&hub, Some("lab-a")).await.unwrap_err();
        assert!(
            elsewhere.starts_with("A lead resumes only the machine its project runs on (forge)"),
            "{elsewhere}"
        );

        let LeadCallResult::UsageResume(r) = lead_resume(&hub, None).await.unwrap() else {
            panic!("not a usage_resume result");
        };
        assert!(r.breaker_cleared);
        assert_eq!(hub.usage.gate("forge"), None);
        assert_eq!(
            resumed_by(&hub).await,
            [(true, "lead:forge/fleetd".to_owned())]
        );

        // Twelve agents hit it again, more than the usage layer's recent events per machine keep: the lead still may
        // not lift it again within 10 minutes.
        for thread in (1..=12).map(|n| format!("w{n}")) {
            let event: NewEvent = serde_json::from_value(json!({
                "at": crate::hub::store::iso_ms(T0 as i64 + 60_000), "type": "thread.usage_limited",
                "machineId": "forge", "threadId": thread, "summary": "hit the usage limit",
                "data": { "usageClass": "usage_limit", "resumeAt": "2026-10-25T23:40:38.000Z" },
            }))
            .unwrap();
            hub.events.append(event).unwrap();
        }
        hub.usage.drain().await;
        assert!(hub.usage.gate("forge").is_some());
        let again = lead_resume(&hub, Some("forge")).await.unwrap_err();
        assert!(
            again.contains("a lead may once every 10 minutes"),
            "{again}"
        );
        assert!(
            again.contains("ask the human to press Resume in the app"),
            "{again}"
        );
        clock.advance(std::time::Duration::from_secs(600));
        assert!(lead_resume(&hub, None).await.is_ok());
        assert_eq!(hub.usage.gate("forge"), None);
    }
}
