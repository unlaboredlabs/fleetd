//! A Navi's purchases as approvals (D265 navi.purchases). A purchase is a class of its own: it never comes through the
//! tool prompt relay (permissions.rs), so no rule, checker or approval mode answers it; only a person does
//! ([`person_only`], which every automatic answer must ask first). Approved, its card may be filled once, by the
//! Navi's node, within [`FILL_WINDOW_MINUTES`] of the approval: the node claims it ([`Approvals::claim_purchase`]),
//! then says how the fill went ([`Approvals::purchase_filled`]); a fill that typed nothing gives the claim back.
use fleetd_contracts::chat::ChatRequestId;
use fleetd_contracts::ledger::{HumanRequest, RequestKind, RequestState};
use fleetd_contracts::purchase::{
    FILL_WINDOW_MINUTES, NaviCard, Purchase, PurchaseClaimed, PurchaseFilledCall, PurchaseOpenCall,
};

use super::store::NewRequest;
use super::{ApprovalRefused, Approvals, contract_project, project_of, refuse};
use crate::hub::store::{iso_ms, parse_ms, system_ms};
use crate::hub::usage::ports::ProjectRef;
use crate::hub::usage::time::clip;

/// Payment command-line tools: a `gated_run` of one of these spends money, so it is a purchase's class too.
pub const PAYMENT_CLIS: &[&str] = &[
    "stripe",
    "shopify",
    "link-cli",
    "paypal",
    "braintree",
    "square",
];

/// Whether only a person may answer this request, whatever the approval mode: a purchase, a spending tool of an
/// MCP server, and a command that spends (classed `money`, or a payment CLI's). A checker or a YOLO mode must leave these to the person.
pub fn person_only(r: &HumanRequest) -> bool {
    if r.purchase.is_some() {
        return true;
    }
    if let Some(p) = &r.permission
        && p.preview.as_ref().is_some_and(|preview| {
            preview.action == fleetd_contracts::integrations::ToolAction::Spend
        })
    {
        return true;
    }
    r.gated.as_ref().is_some_and(|g| {
        g.class == fleetd_contracts::ledger::GatedClass::Money
            || g.argv.iter().next().is_some_and(|program| pays(program))
    })
}

/// Whether `program` (a command's first word, a path or a name) is a payment CLI.
pub fn pays(program: &str) -> bool {
    let name = program.rsplit('/').next().unwrap_or(program);
    PAYMENT_CLIS.contains(&name)
}

impl Approvals {
    /// A Navi's `purchase_request`, from its node: opens the purchase card for the person, with the Navi's card.
    pub async fn open_purchase(
        &self,
        project: &ProjectRef,
        call: PurchaseOpenCall,
        card: NaviCard,
    ) -> Result<HumanRequest, ApprovalRefused> {
        let PurchaseOpenCall {
            session_id,
            purchase,
            ..
        } = call;
        let now = system_ms(self.deps.clock.now());
        let text = format!(
            "Pay {} {} at {} ({}) with {}",
            purchase.total.amount,
            purchase.total.currency,
            purchase.shop.name,
            purchase.shop.domain,
            card.label()
        );
        self.create(NewRequest {
            project_ref: contract_project(project),
            workstream_id: None,
            kind: RequestKind::Approval,
            text: clip(&text, 500),
            secret: None,
            gated: None,
            permission: None,
            preview_config: None,
            purchase: Some(Purchase {
                shop: purchase.shop,
                total: purchase.total,
                items: purchase.items,
                card,
                session_id,
                filled_at: None,
            }),
            at: fleetd_contracts::ids::Timestamp(iso_ms(now)),
            at_ms: now,
        })
        .await
    }

    /// The Navi's request `request_id` as its own purchase, or why not.
    fn own_purchase(
        &self,
        project: &ProjectRef,
        request_id: &str,
    ) -> Result<(HumanRequest, Purchase), ApprovalRefused> {
        let unknown = || {
            refuse(
                "not_found",
                format!("{request_id} is none of your purchases."),
                Some("Use the requestId purchase_request returned."),
            )
        };
        let r = self
            .get(request_id)
            .filter(|r| project_of(r) == *project)
            .ok_or_else(unknown)?;
        let purchase = r.purchase.clone().ok_or_else(unknown)?;
        Ok((r, purchase))
    }

    /// The Navi's node claims an approved purchase for one fill: refused unless it is approved, unfilled, within its
    /// window and asked for in this browser session. Claimed, it is `ran` (filled) until the node says nothing was typed.
    pub async fn claim_purchase(
        &self,
        project: &ProjectRef,
        request_id: &ChatRequestId,
        session_id: &fleetd_contracts::browser::BrowserSessionId,
    ) -> Result<PurchaseClaimed, ApprovalRefused> {
        let (r, purchase) = self.own_purchase(project, request_id.as_str())?;
        match r.state {
            RequestState::Approved => {}
            RequestState::Open => {
                return Err(refuse(
                    "invalid",
                    format!("The person hasn't answered {request_id} yet."),
                    Some("End your turn: you are woken with their answer."),
                ));
            }
            RequestState::Ran => {
                return Err(refuse(
                    "forbidden",
                    format!("{request_id}'s card was filled already: a purchase fills once."),
                    Some(
                        "Finish that checkout; for another purchase, ask again with purchase_request.",
                    ),
                ));
            }
            other => {
                return Err(refuse(
                    "forbidden",
                    format!("{request_id} is {}: its card isn't filled.", other.as_str()),
                    Some("Don't buy it another way; say so in the chat."),
                ));
            }
        }
        if purchase.session_id != *session_id {
            return Err(refuse(
                "forbidden",
                format!("{request_id} was asked for in another browser session."),
                Some("Ask again with purchase_request from this checkout."),
            ));
        }
        let now = system_ms(self.deps.clock.now());
        let approved = r
            .answered_at
            .as_ref()
            .and_then(|a| parse_ms(a.as_str()))
            .unwrap_or_default();
        if now - approved > FILL_WINDOW_MINUTES * 60_000 {
            let why = format!(
                "expired: its card wasn't filled within {FILL_WINDOW_MINUTES} minutes of the approval"
            );
            let _ = self
                .change_from(&r.request_id, RequestState::Approved, |r| {
                    r.state = RequestState::Failed;
                    r.evidence = Some(fleetd_contracts::prim::Text::unchecked(why.clone()));
                    r.finished_at = Some(fleetd_contracts::ids::Timestamp(iso_ms(now)));
                })
                .await;
            return Err(refuse(
                "forbidden",
                format!("{request_id} {why}."),
                Some("Ask again with purchase_request if the person still wants it."),
            ));
        }
        // Guarded on approved: of two claims at once only one moves it, so a purchase fills at most once.
        let at = iso_ms(now);
        let claimed = self
            .change_from(&r.request_id, RequestState::Approved, |r| {
                r.state = RequestState::Ran;
                r.evidence = Some(fleetd_contracts::prim::Text::unchecked(
                    "filling the card into the checkout".to_owned(),
                ));
                r.finished_at = Some(fleetd_contracts::ids::Timestamp(at.clone()));
                if let Some(p) = r.purchase.as_mut() {
                    p.filled_at = Some(fleetd_contracts::ids::Timestamp(at));
                }
            })
            .await?;
        Ok(PurchaseClaimed {
            request_id: claimed.request_id,
            domain: purchase.shop.domain,
            card: purchase.card.reference,
        })
    }

    /// How a claimed fill went. One that typed nothing goes back to approved, to be filled again within its window.
    pub async fn purchase_filled(
        &self,
        project: &ProjectRef,
        call: PurchaseFilledCall,
    ) -> Result<HumanRequest, ApprovalRefused> {
        let (r, _) = self.own_purchase(project, call.request_id.as_str())?;
        let said = clip(call.message.as_str(), 300);
        if call.ok || call.typed {
            let evidence = if call.ok {
                format!("card filled into the checkout: {said}")
            } else {
                format!("card partly filled, then: {said}")
            };
            return self
                .change_from(&r.request_id, RequestState::Ran, |r| {
                    r.evidence = Some(fleetd_contracts::prim::Text::unchecked(evidence));
                })
                .await;
        }
        let evidence = format!("not filled: {said}; it may be filled again within its window");
        self.change_from(&r.request_id, RequestState::Ran, |r| {
            r.state = RequestState::Approved;
            r.evidence = Some(fleetd_contracts::prim::Text::unchecked(evidence));
            r.finished_at = None;
            if let Some(p) = r.purchase.as_mut() {
                p.filled_at = None;
            }
        })
        .await
    }

    /// Every purchase of the project, newest first.
    pub fn purchases(&self, project: &ProjectRef, limit: i64) -> Vec<HumanRequest> {
        self.deps
            .requests
            .list(&super::store::RequestFilter {
                project_ref: Some(contract_project(project)),
                kind: Some(RequestKind::Approval),
                limit: i64::MAX,
                ..Default::default()
            })
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "approvals: purchases not listed");
                Vec::new()
            })
            .into_iter()
            .filter(|r| r.purchase.is_some())
            .take(limit.max(0) as usize)
            .collect()
    }
}
