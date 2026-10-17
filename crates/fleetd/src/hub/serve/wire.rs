//! Cross-area links that belong to no single area: the ledger's lead calls, the human digest's train and retro
//! feeds, and the leads hooks over usage, the train and GitHub. Run once in `build_on`, after the `Hub` exists.
use std::sync::{Arc, Weak};

use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::lead_calls::LeadCall;
use fleetd_contracts::mcp::McpToolError;
use fleetd_contracts::usage::UsageParked;

use crate::hub::api::Hub;
use crate::hub::leads::error::LeadError;
use crate::hub::leads::hooks::{BoxFuture, GitHubHook, TrainHook, UsageHook};
use crate::hub::link::lead_calls::LeadCallFuture;
use crate::hub::link::{LeadCallHandler, LeadCaller};
use crate::hub::usage::wire::convert;

pub fn wire(hub: &Arc<Hub>) {
    register_ledger_calls(hub);
    feed_digests(hub);
    let hooks = &hub.leads.ctx.hooks;
    let _ = hooks
        .usage
        .set(Arc::new(UsageForLeads(Arc::downgrade(hub))));
    let _ = hooks
        .train
        .set(Arc::new(TrainForLeads(Arc::downgrade(hub))));
    let _ = hooks
        .github
        .set(Arc::new(GitHubForLeads(crate::hub::checks::GitHub::new(
            Arc::new(crate::hub::checks::GhCli),
        ))));
}

/// TS LeadCallHandler's ledger cases: `ask`, `ask_withdraw`, `decide`, `decisions_search`.
struct LedgerCalls(Weak<Hub>);

impl LeadCallHandler for LedgerCalls {
    fn handle(&self, caller: LeadCaller, call: LeadCall) -> LeadCallFuture {
        let hub = self.0.upgrade();
        Box::pin(async move {
            let hub = hub.ok_or_else(|| {
                McpToolError::new(
                    fleetd_contracts::mcp::ErrorCode::T3Error,
                    "the hub is stopping",
                )
            })?;
            crate::hub::ledger::lead_call(&hub, &caller.project_ref, &caller.by, call)
                .map_err(|e| McpToolError::from(LeadError::from(e)))
        })
    }
}

fn register_ledger_calls(hub: &Arc<Hub>) {
    let calls: Arc<dyn LeadCallHandler> = Arc::new(LedgerCalls(Arc::downgrade(hub)));
    for op in ["ask", "ask_withdraw", "decide", "decisions_search"] {
        hub.lead_calls.register(op, Arc::clone(&calls));
    }
}

/// TS HumanDigests: `humanTrainLines(trainFacts(shown), sinceMs)` and `suggestedLines` of the visible proposals.
fn feed_digests(hub: &Arc<Hub>) {
    let (train, retro) = (Arc::downgrade(&hub.train), Arc::downgrade(&hub.retro));
    hub.digests.feed(move |f| {
        f.train_lines = Some(Box::new(move |shown, since_ms| {
            let Some(train) = train.upgrade() else {
                return Vec::new();
            };
            let facts = crate::hub::train::digest::train_facts(train.records(), shown);
            crate::hub::train::digest::human_train_lines(&facts, since_ms)
        }));
        f.suggested_lines = Some(Box::new(move |visible| {
            let Some(retro) = retro.upgrade() else {
                return Vec::new();
            };
            let shown: Vec<_> = retro
                .proposals(Some("suggested"), 20)
                .into_iter()
                .filter(|p| {
                    p.machines
                        .iter()
                        .all(|m| MachineId::try_from(m.clone()).is_ok_and(|m| visible(&m)))
                })
                .map(|p| p.proposal)
                .collect();
            crate::hub::retro::digest::suggested_lines(&shown)
        }));
    });
}

struct UsageForLeads(Weak<Hub>);

fn usage_ref(thread: &ThreadRef) -> Option<crate::hub::usage::ports::ThreadRef> {
    convert(thread)
}

impl UsageHook for UsageForLeads {
    fn gate(&self, machine_id: &MachineId) -> Option<String> {
        self.0.upgrade()?.usage.gate(machine_id.as_str())
    }
    fn parked_of(&self, thread: &ThreadRef) -> Option<UsageParked> {
        convert(&self.0.upgrade()?.usage.parked_of(&usage_ref(thread)?)?)
    }
    fn hold(&self, thread: &ThreadRef) -> Option<String> {
        self.0.upgrade()?.usage.hold(&usage_ref(thread)?)
    }
    fn when_clear(&self, thread: &ThreadRef) -> BoxFuture<()> {
        let (hub, r) = (self.0.upgrade(), usage_ref(thread));
        Box::pin(async move {
            if let (Some(hub), Some(r)) = (hub, r) {
                hub.usage.when_clear(&r).await;
            }
        })
    }
}

/// TS LeadWakes: the section is left out when the project has no train and no Change.
struct TrainForLeads(Weak<Hub>);

impl TrainHook for TrainForLeads {
    fn lead_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
    ) -> Option<Vec<String>> {
        let hub = self.0.upgrade()?;
        let facts = crate::hub::train::digest::train_facts(hub.train.records(), |r| {
            r.machine_id == project_ref.machine_id && r.project_id == project_ref.project_id
        });
        if facts.trains.is_empty() && facts.changes.is_empty() {
            return None;
        }
        Some(crate::hub::train::digest::lead_train_lines(
            &facts,
            since.map(|s| s.0.as_str()),
        ))
    }
}

struct GitHubForLeads(crate::hub::checks::GitHub);

impl GitHubHook for GitHubForLeads {
    fn api(&self, path: &str) -> BoxFuture<Result<serde_json::Value, String>> {
        let (runner, path) = (Arc::clone(self.0.runner()), path.to_owned());
        Box::pin(async move {
            crate::hub::checks::GitHub::new(runner)
                .api(&path)
                .await
                .map_err(|e| e.message)
        })
    }
}
