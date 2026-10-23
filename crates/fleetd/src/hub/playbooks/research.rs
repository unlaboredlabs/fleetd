//! Research verdicts: the judge reports the metric for baseline and candidate, and the hub applies the brief's
//! decision rule. Every outcome ends the workstream as done; STOP and INCONCLUSIVE answer the question too.
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ledger::{
    MetricValues, ResearchVerdict, Workstream, WorkstreamId, WorkstreamState, research_outcome,
};
use fleetd_contracts::mcp::ErrorCode;
use tokio::sync::Mutex;

use super::verdict::verdict_text;
use crate::hub::leads::digest::state_text;
use crate::hub::leads::error::LeadError;
use crate::hub::leads::records::LeadRecords;
use crate::hub::leads::wakes::{LeadWakes, Trigger};
use crate::hub::leads::{Ctx, now_iso};
use crate::hub::store::NewEvent;

pub struct Research {
    ctx: Arc<Ctx>,
    records: Arc<LeadRecords>,
    wakes: Arc<LeadWakes>,
    lock: Mutex<()>,
}

impl Research {
    pub fn new(ctx: Arc<Ctx>, records: Arc<LeadRecords>, wakes: Arc<LeadWakes>) -> Arc<Self> {
        Arc::new(Self {
            ctx,
            records,
            wakes,
            lock: Mutex::new(()),
        })
    }

    /// Computes and stores the verdict for the judge's numbers, marks the workstream done with its outcome, emits
    /// `research.verdict` and tells the lead. A verdict is final: a second call returns the stored one.
    pub async fn record_verdict(
        &self,
        workstream_id: &WorkstreamId,
        metric_values: MetricValues,
    ) -> Result<(Workstream, String), LeadError> {
        let _guard = self.lock.lock().await;
        let Some(stored) = self.records.workstream_get(workstream_id)? else {
            return Err(LeadError::bare(
                ErrorCode::NotFound,
                format!("There is no workstream {workstream_id}."),
            ));
        };
        let w = &stored;
        let metric = w
            .brief
            .as_ref()
            .and_then(|b| b.metric.as_ref())
            .map(|m| m.to_string());
        let line_of = |v: &ResearchVerdict| {
            verdict_text(
                w.workstream_id.as_str(),
                v.outcome,
                &v.rule,
                &v.metric_values,
                metric.as_deref(),
            )
        };
        // The tool result is the event line without its list marker.
        let text_of = |v: &ResearchVerdict| line_of(v).trim_start_matches("- ").to_owned();
        if let Some(v) = &w.verdict {
            return Ok((w.clone(), text_of(v)));
        }
        if !w
            .playbook
            .as_ref()
            .is_some_and(|p| p.as_str().starts_with("research@"))
        {
            return Err(LeadError::bare(
                ErrorCode::Invalid,
                format!(
                    "{workstream_id} is not a research workstream; only research gets a verdict."
                ),
            ));
        }
        let Some(rule) = w.brief.as_ref().and_then(|b| b.decision_rule.clone()) else {
            return Err(LeadError::bare(
                ErrorCode::Invalid,
                format!("{workstream_id} has no decision rule, so its numbers decide nothing."),
            ));
        };
        if matches!(w.state, WorkstreamState::Stopped | WorkstreamState::Failed) {
            return Err(LeadError::bare(
                ErrorCode::Invalid,
                format!(
                    "{workstream_id} is {}; it gets no verdict.",
                    state_text(w.state)
                ),
            ));
        }
        let at = now_iso(&self.ctx);
        let verdict = ResearchVerdict {
            outcome: research_outcome(&rule, &metric_values),
            metric_values: metric_values.clone(),
            rule,
            computed_at: at.clone().into(),
        };
        let done = Workstream {
            state: WorkstreamState::Done,
            outcome: Some(verdict.outcome),
            verdict: Some(verdict.clone()),
            updated_at: at.clone().into(),
            ..w.clone()
        };
        let text = text_of(&verdict);
        self.records.workstream_put(&done)?;
        let event = |r#type, summary: String, data| NewEvent {
            at: at.clone().into(),
            r#type,
            machine_id: Some(w.project_ref.machine_id.clone()),
            project_id: Some(w.project_ref.project_id.clone()),
            thread_id: None,
            summary,
            data: Some(data),
            attention: None,
        };
        self.ctx.events.append(event(
            HubEventType::ResearchVerdict,
            text.chars().take(500).collect(),
            serde_json::json!({ "workstreamId": workstream_id, "outcome": verdict.outcome, "metricValues": metric_values }),
        ))?;
        if w.state != WorkstreamState::Done {
            self.ctx.events.append(event(
                HubEventType::WorkstreamDone,
                format!(
                    "{workstream_id} is done ({}): {}",
                    verdict.outcome.as_str(),
                    w.title
                ),
                serde_json::json!({ "workstreamId": workstream_id }),
            ))?;
        }
        self.wakes.trigger(
            &w.project_ref,
            Trigger::research_verdict(&format!("- {text}")),
        );
        Ok((done, text))
    }
}
