//! A Navi's purchases (D265 navi.purchases): the card it pays with, the person's purchase log, and its node's calls.
//! - `navi_card_set`, from the owner's own device: the Credit Card item in their 1Password the Navi pays with, kept as
//!   its `op://vault/item` reference only (the `assistants` table's `card_ref`).
//! - `navi_purchases`: the card and every purchase the Navi asked for, newest first, with what the person said.
//! - `purchase_open`, `purchase_claim`, `purchase_filled`: its node's calls for its lead's `purchase_request` and
//!   `purchase_fill` (node/browser/cards.rs). Only a Navi's lead buys; the approval itself is approvals/purchases.rs.
use std::sync::{Arc, Weak};

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult, RequestResult};
use fleetd_contracts::mcp::{
    ErrorCode, McpToolError, NaviCardSetInput, NaviCardSetOutput, NaviPurchasesInput,
    NaviPurchasesOutput,
};
use fleetd_contracts::purchase::{NaviCard, OpItemReference, PurchaseLogEntry};

use super::store;
use crate::hub::api::{Caller, Hub, Registry, ToolError, error, is_human, require};
use crate::hub::link::lead_calls::{CallerAgent, LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};
use crate::hub::usage::wire::convert;

pub const OPS: [&str; 3] = ["purchase_open", "purchase_claim", "purchase_filled"];

/// The most purchases `navi_purchases` lists.
const LOG_MAX: i64 = 200;

pub fn register(tools: &mut Registry) {
    tools.add("navi_purchases", purchases);
    tools.add("navi_card_set", card_set);
}

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                answer(&hub, &caller, call).await
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    for op in OPS {
        calls.register(op, handler.clone());
    }
}

/// The Navi's card, if its person picked one.
pub fn card(hub: &Hub, r: &ProjectRef) -> Result<Option<NaviCard>, crate::hub::store::StoreError> {
    let kept = hub.db.with(|c| Ok(store::card(c, r)?))?;
    Ok(kept
        .and_then(|k| OpItemReference::new(k).ok())
        .map(|reference| NaviCard { reference }))
}

/// What no purchase may be, even approved: trading (shares, crypto) or moving money (transfers, funds), by the words of
/// its shop and its items.
pub fn refused_purchase(
    p: &fleetd_contracts::purchase::PurchaseRequestCall,
) -> Option<crate::hub::integrations::policy::Never> {
    use crate::hub::integrations::policy::{Never, never};
    std::iter::once(p.shop.name.as_str())
        .chain(std::iter::once(p.shop.domain.as_str()))
        .chain(p.items.iter().map(|i| i.name.as_str()))
        .filter_map(never)
        .find(|n| matches!(n, Never::Money | Never::Trading))
}

fn refused(e: crate::hub::approvals::ApprovalRefused) -> McpToolError {
    let code = match e.code.as_str() {
        "not_found" => ErrorCode::NotFound,
        "forbidden" => ErrorCode::Forbidden,
        "failed" => ErrorCode::Failed,
        _ => ErrorCode::Invalid,
    };
    let refusal = McpToolError::new(code, e.message);
    match e.fix {
        Some(fix) => refusal.with_fix(fix),
        None => refusal,
    }
}

async fn answer(
    hub: &Hub,
    caller: &LeadCaller,
    call: LeadCall,
) -> Result<LeadCallResult, McpToolError> {
    let r = &caller.project_ref;
    let navi = matches!(super::of(&hub.db, r), Ok(Some(n)) if n.archived_at.is_none());
    if caller.agent != CallerAgent::Lead || !navi {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            "Only a Navi pays at a checkout, and this session is none.",
        )
        .with_fix("leave the payment to the person and say so"));
    }
    let project = convert(r).expect("a project ref reads back");
    match call {
        LeadCall::PurchaseOpen(call) => {
            if let Some(never) = refused_purchase(&call.purchase) {
                return Err(McpToolError::new(ErrorCode::Forbidden, never.why())
                    .with_fix("don't buy it another way; tell the person what you wanted to do"));
            }
            let card = card(hub, r)
                .map_err(|e| McpToolError::new(ErrorCode::Failed, e.to_string()))?
                .ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "You have no card to pay with.").with_fix(
                        "ask the person to pick one: the Navi's Settings › Payments, from a Credit Card item in their \
                         1Password; then ask again",
                    )
                })?;
            let opened = hub
                .approvals
                .open_purchase(&project, call, card)
                .await
                .map_err(refused)?;
            Ok(LeadCallResult::PurchaseOpen(RequestResult {
                request_id: opened.request_id,
                state: opened.state,
                next: Some(
                    "end your turn on the checkout: the person approves or denies it in the chat, and you are woken \
                     with the answer"
                        .into(),
                ),
            }))
        }
        LeadCall::PurchaseClaim(call) => hub
            .approvals
            .claim_purchase(&project, &call.request_id, &call.session_id)
            .await
            .map(LeadCallResult::PurchaseClaim)
            .map_err(refused),
        LeadCall::PurchaseFilled(call) => {
            let r = hub
                .approvals
                .purchase_filled(&project, call)
                .await
                .map_err(refused)?;
            Ok(LeadCallResult::PurchaseFilled(RequestResult {
                request_id: r.request_id,
                state: r.state,
                next: None,
            }))
        }
        other => Err(McpToolError::new(
            ErrorCode::Invalid,
            format!("{} is not a purchase call.", op_of(&other)),
        )),
    }
}

fn navi_ref(
    hub: &Hub,
    machine_id: fleetd_contracts::ids::MachineId,
    project_id: fleetd_contracts::ids::ProjectId,
) -> Result<ProjectRef, ToolError> {
    let r = ProjectRef {
        machine_id,
        project_id,
    };
    super::navi_of(hub, &r)?;
    Ok(r)
}

async fn purchases(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviPurchasesInput,
) -> Result<NaviPurchasesOutput, ToolError> {
    require(&caller, Role::Read, Some(&input.machine_id))?;
    let r = navi_ref(&hub, input.machine_id, input.project_id)?;
    let card = card(&hub, &r)?;
    let project = convert(&r).expect("a project ref reads back");
    let purchases: Vec<PurchaseLogEntry> = hub
        .approvals
        .purchases(&project, LOG_MAX)
        .into_iter()
        .filter_map(|q| {
            Some(PurchaseLogEntry {
                purchase: q.purchase?,
                request_id: q.request_id,
                state: q.state,
                asked_at: q.created_at,
                answered_at: q.answered_at,
                answered_by: q.answered_by,
                note: q.evidence.map(|e| e.to_string()),
            })
        })
        .collect();
    let next = match (&card, purchases.is_empty()) {
        (None, _) => Some(
            "No card yet: pick a Credit Card item from your 1Password (onepassword_cards, then navi_card_set) so the \
             Navi can pay, after you approve each purchase."
                .to_owned(),
        ),
        (Some(_), true) => Some("No purchases yet.".to_owned()),
        _ => None,
    };
    Ok(NaviPurchasesOutput {
        card,
        purchases,
        next,
        truncated: None,
    })
}

async fn card_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: NaviCardSetInput,
) -> Result<NaviCardSetOutput, ToolError> {
    require(&caller, Role::Operate, Some(&input.machine_id))?;
    if !is_human(&caller) {
        return Err(error(
            ErrorCode::Forbidden,
            "Only a person picks the card a Navi pays with.",
            "Pick it in the app: the Navi's Settings › Payments.",
        ));
    }
    let r = navi_ref(&hub, input.machine_id, input.project_id)?;
    let reference = input.card.as_ref().map(|c| c.as_str());
    hub.db.with(|c| Ok(store::set_card(c, &r, reference)?))?;
    let card = input.card.map(|reference| NaviCard { reference });
    let next = Some(match &card {
        Some(card) => format!(
            "The Navi pays with {} from now on, after you approve each purchase.",
            card.label()
        ),
        None => "The Navi has no card now: it can't pay at a checkout.".to_owned(),
    });
    Ok(NaviCardSetOutput {
        card,
        next,
        truncated: None,
    })
}
