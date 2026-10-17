//! `inbox_reply`: a terse human reply applied to a batch in one transaction (TS `Inbox.ts`).
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::{
    Ask, AskAnswer, AskKind, AskState, BatchId, BatchState, Decision, DecisionKey, DecisionScope,
    DecisionSource,
};
use fleetd_contracts::mcp::{
    InboxReplyApplied as Applied, InboxReplyOutcome, InboxReplyOutput as ReplyOutput,
};
use fleetd_contracts::prim::Positive;

use super::decisions::recorded_event;
use super::grammar::{Action, parse_reply, resolve_plan};
use super::repo::{self, RecordInput, batch_n};
use super::{Actor, Ctx, Fail, LedgerCode, LedgerError, iso_at, project_key};
use crate::clock::Clock;
use crate::hub::store::{EventLog, HubDb};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnswerOutcome {
    Answered,
    Withdrawn,
}

/// One answered or withdrawn ask, as delivered to its project's lead.
#[derive(Clone, Debug)]
pub struct Answer {
    /// The ask after the answer was applied.
    pub ask: Ask,
    pub outcome: AnswerOutcome,
    /// The answer value; absent for a withdrawal.
    pub value: Option<String>,
    pub decision: Option<Decision>,
}

/// Where applied answers go: the lead-wake code provides this to wake each project's lead with its answers inline.
/// Called once per project per reply, after the reply is committed. Must not block: queue or spawn the work.
pub trait AnswerSink: Send + Sync {
    fn on_answered(&self, project_ref: &ProjectRef, answers: Vec<Answer>);
}

/// Records the `misfiled_ask` incident for a product ask the lead filed and the human dropped (the incidents area
/// provides it). Called after the commit.
pub trait MisfiledSink: Send + Sync {
    fn misfiled(&self, ask: &Ask);
}

/// Answers whose lead wake waits for the hub to act on them first: an approve ask's "go" (the node runs the command,
/// and the result goes with the answer) and a do ask's "done" with a verify check (passing it goes with the answer).
pub fn followed_up(answer: &Answer) -> bool {
    answer.outcome == AnswerOutcome::Answered
        && ((answer.ask.kind == AskKind::Approve && answer.value.as_deref() == Some("go"))
            || (answer.ask.kind == AskKind::Do
                && answer.ask.verify.is_some()
                && answer.value.as_deref() == Some("done")))
}

/// Kinds only a person may answer: the hub acts on these answers, so an agent's reply must not stand in for a human.
fn human_only(kind: AskKind) -> bool {
    matches!(kind, AskKind::Secret | AskKind::Approve | AskKind::Do)
}
const HUMAN_ONLY_FIX: &str = "Answer it from a paired device (the fleetd phone or desktop app) or with a --human key; agent keys cannot enter secrets, approve commands or tick checklists.";

/// The caller's grants: whether it may write in a project, or globally when the project is absent ("pref:" and
/// "forget"). A reply touching anything it may not write changes nothing.
pub type Allows = Box<dyn Fn(Option<&ProjectRef>) -> bool + Send + Sync>;

pub struct ReplyInput {
    pub raw: String,
    pub batch_id: Option<BatchId>,
    /// Absent: everything is allowed.
    pub allows: Option<Allows>,
}

impl ReplyInput {
    pub fn new(raw: impl Into<String>) -> Self {
        Self {
            raw: raw.into(),
            batch_id: None,
            allows: None,
        }
    }
}

const PREF_SLUG_MAX: usize = 75;

/// `pref.<slug>` from the preference text, so restating a preference supersedes it.
pub fn pref_key(text: &str) -> DecisionKey {
    let lower = text.to_lowercase();
    let mut slug = String::new();
    for word in lower
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|w| !w.is_empty())
    {
        let next = if slug.is_empty() {
            word.to_string()
        } else {
            format!("{slug}-{word}")
        };
        if next.len() > PREF_SLUG_MAX {
            break;
        }
        slug = next;
    }
    if slug.is_empty() {
        // Text with no latin letters or digits: a stable hash keeps the key valid and repeatable.
        let mut hash: u32 = 0x811c_9dc5;
        for c in text.chars() {
            hash = (hash ^ c as u32).wrapping_mul(0x0100_0193);
        }
        slug = format!("p{hash:x}");
    }
    DecisionKey::unchecked(format!("pref.{slug}"))
}

fn short(value: &str) -> String {
    if value.encode_utf16().count() > 40 {
        format!("{}…", super::js_prefix(value, 39))
    } else {
        value.to_string()
    }
}

struct Done {
    batch_id: Option<BatchId>,
    applied: Vec<Applied>,
    echo: Vec<String>,
    decisions: Vec<Decision>,
    answers: Vec<Answer>,
    misfiled: Vec<Ask>,
}

pub struct Inbox {
    ctx: Ctx,
    sink: RwLock<Option<Arc<dyn AnswerSink>>>,
    misfiled: RwLock<Option<Arc<dyn MisfiledSink>>>,
}

impl Inbox {
    pub fn new(db: Arc<HubDb>, events: Arc<EventLog>, clock: Arc<dyn Clock>) -> Self {
        Self {
            ctx: Ctx { db, events, clock },
            sink: RwLock::new(None),
            misfiled: RwLock::new(None),
        }
    }

    // PORT: leads (LeadWakes) calls this when it is built; until then answers reach no lead.
    /// The lead-wake code's sink; answers are dropped until one is set.
    pub fn set_answer_sink(&self, sink: Arc<dyn AnswerSink>) {
        *self.sink.write().unwrap_or_else(|p| p.into_inner()) = Some(sink);
    }

    // PORT: incidents calls this to record `misfiled_ask`; until then no incident is recorded.
    /// The incidents area's hook for misfiled asks.
    pub fn set_misfiled_sink(&self, sink: Arc<dyn MisfiledSink>) {
        *self.misfiled.write().unwrap_or_else(|p| p.into_inner()) = Some(sink);
    }

    fn apply(&self, input: &ReplyInput, actor: &Actor, now: i64) -> Result<Done, LedgerError> {
        let allows =
            |project: Option<&ProjectRef>| input.allows.as_ref().is_none_or(|f| f(project));
        self.ctx.write(|db| {
            let plan = parse_reply(&input.raw).map_err(LedgerError::invalid)?;
            if (!plan.prefs.is_empty() || !plan.forgets.is_empty()) && !allows(None) {
                return Err(LedgerError::forbidden(
                    "\"pref:\" and \"forget\" change decisions for every machine, and this caller may not write on all of them.",
                    "Use a key with an operate grant on all machines (*).",
                )
                .into());
            }
            if let (Some(named), Some(requested)) = (plan.batch, &input.batch_id)
                && batch_n(requested) != i64::try_from(named).ok() {
                    return Err(LedgerError::invalid(format!(
                        "The reply names B{named} but the request names {requested}."
                    ))
                    .into());
                }
            let mut done = Done {
                batch_id: None,
                applied: Vec::new(),
                echo: Vec::new(),
                decisions: Vec::new(),
                answers: Vec::new(),
                misfiled: Vec::new(),
            };
            let answer_of = |value: &str| AskAnswer {
                value: value.to_string(),
                by: actor.by.clone(),
                at: Timestamp(iso_at(now)),
                raw: input.raw.clone(),
            };
            let applied = |number: Option<u64>, ask_id, outcome, value, decision_id| Applied {
                number: number.map(|n| Positive::unchecked(n as i64)),
                ask_id,
                outcome,
                value,
                decision_id,
                source: Some(actor.source),
                by: Some(actor.by.clone()),
            };

            if !plan.items.is_empty() || plan.rest.is_some() {
                let wanted = plan.batch.map(|n| i64::try_from(n).unwrap_or(i64::MAX)).or_else(|| input.batch_id.as_deref().and_then(batch_n));
                let stored = match wanted {
                    None => repo::latest_open_batch(db)?,
                    Some(n) => repo::get_batch(db, n)?,
                };
                let Some(stored) = stored else {
                    return Err(LedgerError::invalid(match wanted {
                        None => "There is no open batch to answer.".to_string(),
                        Some(n) => format!("There is no batch B{n}."),
                    })
                    .into());
                };
                if stored.batch.state == BatchState::Closed {
                    return Err(LedgerError::invalid(format!(
                        "{} is closed; every item in it is handled.",
                        stored.batch.batch_id
                    ))
                    .into());
                }
                let batch_id = stored.batch.batch_id.clone();
                let mut items = Vec::with_capacity(stored.batch.items.len());
                for item in &stored.batch.items {
                    let ask = repo::get_ask(db, &item.ask_id)?.ok_or_else(|| Fail::Internal(format!("batch item {} has no ask", item.ask_id)))?;
                    items.push((item.number.get() as u64, ask));
                }
                let mut actions = resolve_plan(&plan, &batch_id, &items).map_err(LedgerError::invalid)?;
                actions.sort_by_key(Action::number);
                if let Some(denied) = actions.iter().find(|a| !allows(a.ask().project_ref.as_ref())) {
                    let message = match &denied.ask().project_ref {
                        None => format!("Item {} picks a project for a new intent, which needs a grant on every machine.", denied.number()),
                        Some(r) => format!("Item {} is about {}, where this caller may not answer.", denied.number(), project_key(r)),
                    };
                    return Err(LedgerError::forbidden(
                        message,
                        "Answer only the items of your own machines, or ask the hub admin for an operate grant there.",
                    )
                    .into());
                }
                let hands_on = actions.iter().find(|a| !matches!(a, Action::Later { .. }) && human_only(a.ask().kind));
                if let Some(hands_on) = hands_on
                    && actor.source != DecisionSource::Human {
                        let kind = hands_on.ask().kind;
                        let kind_text = match kind {
                            AskKind::Approve => "approve",
                            AskKind::Secret => "secret",
                            AskKind::Do => "do",
                            AskKind::Decide => "decide",
                        };
                        return Err(LedgerError::forbidden(
                            format!(
                                "Item {} is {} {kind_text} ask, which only a person may answer.",
                                hands_on.number(),
                                if kind == AskKind::Approve { "an" } else { "a" }
                            ),
                            HUMAN_ONLY_FIX,
                        )
                        .into());
                    }
                for action in actions {
                    match action {
                        Action::Answer { number, ask, value, note } => {
                            let decision = repo::record_decision(
                                db,
                                &RecordInput {
                                    key: ask.key.clone(),
                                    // An unrouted ask has no project yet; its answer names one, and intake acts on it.
                                    scope: match &ask.project_ref {
                                        None => DecisionScope::Global,
                                        Some(project_ref) => DecisionScope::Project { project_ref: project_ref.clone() },
                                    },
                                    value: value.clone(),
                                    why: note,
                                    ask_id: Some(ask.ask_id.clone()),
                                    project_ref: None,
                                },
                                actor,
                                now,
                            )?;
                            let answered = Ask {
                                state: AskState::Answered,
                                answer: Some(answer_of(&value)),
                                decision_id: Some(decision.decision_id.clone()),
                                ..ask.clone()
                            };
                            repo::put_ask(db, &answered)?;
                            done.echo.push(format!("{number} → {} ({})", short(&value), decision.decision_id));
                            done.applied.push(applied(
                                Some(number),
                                Some(ask.ask_id.clone()),
                                InboxReplyOutcome::Answered,
                                Some(value.clone()),
                                Some(decision.decision_id.clone()),
                            ));
                            done.answers.push(Answer {
                                ask: answered,
                                outcome: AnswerOutcome::Answered,
                                value: Some(value),
                                decision: Some(decision.clone()),
                            });
                            done.decisions.push(decision);
                        }
                        Action::Withdraw { number, ask } => {
                            let withdrawn = Ask { state: AskState::Withdrawn, answer: Some(answer_of("dropped")), ..ask.clone() };
                            repo::put_ask(db, &withdrawn)?;
                            let filed_by = repo::get_ask_row(db, &ask.ask_id)?.map(|row| row.filed_by);
                            // The lead filed a product call the human hands back: a misfiled ask.
                            if filed_by.is_some_and(|by| by.starts_with("lead:")) && ask.project_ref.is_some() {
                                done.misfiled.push(ask.clone());
                            }
                            done.answers.push(Answer { ask: withdrawn, outcome: AnswerOutcome::Withdrawn, value: None, decision: None });
                            done.applied.push(applied(Some(number), Some(ask.ask_id.clone()), InboxReplyOutcome::Withdrawn, None, None));
                            done.echo.push(format!("{number} → dropped"));
                        }
                        Action::Later { number, ask } => {
                            let moved = repo::move_to_later_batch(db, &ask, stored.n, now)?;
                            done.applied.push(applied(Some(number), Some(ask.ask_id.clone()), InboxReplyOutcome::Later, None, None));
                            done.echo.push(format!(
                                "{number} → later ({}#{})",
                                moved.batch_id.as_deref().unwrap_or(""),
                                moved.number.map(|n| n.get()).unwrap_or(0)
                            ));
                        }
                    }
                }
                repo::close_if_done(db, stored.n)?;
                done.batch_id = Some(batch_id);
            }

            for n in &plan.forgets {
                let retired = repo::retire_decision(db, &format!("D{n}"))?;
                done.applied.push(applied(None, None, InboxReplyOutcome::Retired, None, Some(retired.decision_id.clone())));
                done.echo.push(format!("{} → forgotten", retired.decision_id));
            }
            for text in &plan.prefs {
                let decision = repo::record_decision(db, &RecordInput::new(pref_key(text), DecisionScope::Global, text.clone()), actor, now)?;
                done.applied.push(applied(None, None, InboxReplyOutcome::Pref, Some(text.to_string()), Some(decision.decision_id.clone())));
                done.echo.push(format!("{} → {}", decision.key, decision.decision_id));
                done.decisions.push(decision);
            }
            Ok(done)
        })
    }

    /// Applies a terse human reply. A reply that does not apply comes back with a hint (`parsed: false`); only an
    /// agent answering a secret, approve or do ask fails, with `forbidden`.
    pub fn reply(&self, input: &ReplyInput, actor: &Actor) -> Result<ReplyOutput, LedgerError> {
        let now = self.ctx.now_ms();
        let done = match self.apply(input, actor, now) {
            Ok(done) => done,
            Err(error)
                if error.code == LedgerCode::Internal
                    || error.fix.as_deref() == Some(HUMAN_ONLY_FIX) =>
            {
                return Err(error);
            }
            // Every other refusal is a hint the caller can act on; an agent standing in for a person is an error.
            Err(error) => {
                let hint = match &error.fix {
                    None => error.message,
                    Some(fix) => format!("{} {fix}", error.message),
                };
                return Ok(ReplyOutput {
                    parsed: false,
                    batch_id: None,
                    echo: None,
                    applied: Vec::new(),
                    hint: Some(hint),
                    next: None,
                    truncated: None,
                });
            }
        };
        for decision in &done.decisions {
            self.ctx.emit(recorded_event(decision, None));
        }
        if let Some(sink) = self
            .misfiled
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        {
            for ask in &done.misfiled {
                sink.misfiled(ask);
            }
        }
        // No lead to wake for an unrouted ask: intake follows its decision.recorded instead.
        let mut order: Vec<String> = Vec::new();
        let mut by_project: HashMap<String, (ProjectRef, Vec<Answer>)> = HashMap::new();
        for answer in done.answers {
            let Some(project_ref) = answer.ask.project_ref.clone() else {
                continue;
            };
            let key = project_key(&project_ref);
            if !by_project.contains_key(&key) {
                order.push(key.clone());
            }
            by_project
                .entry(key)
                .or_insert_with(|| (project_ref, Vec::new()))
                .1
                .push(answer);
        }
        if let Some(sink) = self.sink.read().unwrap_or_else(|p| p.into_inner()).clone() {
            for key in order {
                let (project_ref, answers) = by_project.remove(&key).expect("grouped");
                sink.on_answered(&project_ref, answers);
            }
        }
        Ok(ReplyOutput {
            parsed: true,
            batch_id: done.batch_id,
            echo: Some(if done.echo.is_empty() {
                "Nothing to log: no open item needed an answer.".into()
            } else {
                format!("Logged: {}", done.echo.join(", "))
            }),
            applied: done.applied,
            hint: None,
            next: None,
            truncated: None,
        })
    }
}
