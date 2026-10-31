//! `confirm_step` (W239): a Navi's lead calls it right before the final Confirm or Submit click on a site that doesn't
//! pay or order: booking a table, cancelling a subscription, sending a form, an expense, a return, a post. Its lead
//! is always asked for the call (the node's `ASSISTANT_ASK`), so the call is a permission prompt the approvals relay
//! decides by the Navi's approval mode like a send: the checker's go, the person's approval on a card (with the page's
//! screenshot) or YOLO let it run, and running it only answers "click it now". A payment, a trade or an order never
//! goes through here: [`refused`] denies it, and the Navi hands it to the person.
use std::sync::{Arc, Weak};

use fleetd_contracts::integrations::{McpToolName, ToolAction, ToolPreview};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::mcp_servers::McpServerName;
use fleetd_contracts::navi::{ConfirmStepCall, ConfirmStepResult};
use fleetd_contracts::prim::{Line, Text};
use serde_json::Value;

use crate::hub::api::Hub;
use crate::hub::integrations::policy::{self, words};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::{CallerAgent, LeadCallFuture, op_of};

pub const OPS: [&str; 1] = ["confirm_step"];

/// The tool as a Navi's session asks for it.
pub const TOOL: &str = "mcp__fleetd__confirm_step";

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                answer(&hub, &caller, call)
            })
        },
    );
    for op in OPS {
        hub.lead_calls.register(op, handler.clone());
    }
}

/// The call ran: it was let through (by the checker, the person or YOLO), so the Navi clicks.
fn answer(hub: &Hub, caller: &LeadCaller, call: LeadCall) -> Result<LeadCallResult, McpToolError> {
    super::bridge::may_use(&hub.db, &caller.project_ref)?;
    if caller.agent != CallerAgent::Lead {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            "Only a Navi confirms a step on a site.",
        ));
    }
    let LeadCall::ConfirmStep(call) = call else {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            format!("{} is not a confirm step call.", op_of(&call)),
        ));
    };
    Ok(LeadCallResult::ConfirmStep(ConfirmStepResult {
        next: Some(format!(
            "Let through: click \"{}\" now, once, on {}. Then say in the chat what the page answered.",
            call.button, call.site
        )),
        button: call.button,
    }))
}

/// The words of a step that pays or trades: those go to the person, never through `confirm_step`.
const PAYS: &[&str] = &[
    "pay",
    "payment",
    "purchase",
    "buy",
    "checkout",
    "donate",
    "subscribe",
    "tip",
    "transfer",
    "send",
];

/// Words of a step that undoes an order rather than placing one.
const UNDO: &[&str] = &["cancel", "return", "refund"];

/// Verbs of a step that places, buys or pays: with any of them, the step is a purchase whatever else it says.
const PLACING: &[&str] = &[
    "place",
    "places",
    "placing",
    "buy",
    "buys",
    "buying",
    "purchase",
    "purchases",
    "pay",
    "pays",
    "paying",
    "checkout",
    "submit order",
    "confirm order",
    "complete order",
];

/// Why a `confirm_step` is refused: it pays, orders or trades (by its button or what it does), or it can't be read.
pub fn refused(input: &Value) -> Option<&'static str> {
    let Ok(call) = serde_json::from_value::<ConfirmStepCall>(input.clone()) else {
        return Some(
            "Blocked by fleetd: this confirm_step can't be read. Give site, button and does.",
        );
    };
    let text = format!("{} {}", call.button, call.does);
    let w = words(&text);
    let has = |list: &[&str]| w.iter().any(|x| list.contains(&x.as_str()));
    // Undoing an order goes through the Navi's mode like any final click (decision navi.final-confirm-by-mode), but
    // only when the button itself says so (Cancel, Return, Refund) and nothing in the step places, buys or pays: "free
    // returns" in what a Place order does undoes nothing.
    let button = words(call.button.as_str());
    let lower = text.to_lowercase();
    let placing = PLACING.iter().any(|p| {
        if p.contains(' ') {
            lower.contains(p)
        } else {
            w.iter().any(|x| x == p)
        }
    });
    let undoes = button.iter().any(|x| UNDO.contains(&x.as_str())) && !placing;
    let ordered = has(&["order", "orders", "ordering"]) && !undoes;
    let never = policy::never(&text).filter(|n| !undoes || *n == policy::Never::Money);
    let money = w.iter().any(|x| PAYS.contains(&x.as_str()) && x != "send")
        || ordered
        || w.windows(2)
            .any(|p| p[0] == "send" && ["money", "payment"].contains(&p[1].as_str()))
        || never.is_some();
    money.then_some(
        "Blocked by fleetd: this step pays, orders or trades, which confirm_step never does. Hand the final click \
         to the person with request_takeover.",
    )
}

/// The card's heading and everything it shows, for a `confirm_step` prompt.
pub fn preview(input: &Value) -> Option<ToolPreview> {
    let call: ConfirmStepCall = serde_json::from_value(input.clone()).ok()?;
    let title = format!("Click \"{}\" on {}", call.button, call.site);
    let (title, _) = policy::clip_utf16(&title, 200);
    Some(ToolPreview {
        server: McpServerName::new("fleetd").ok()?,
        tool: McpToolName::new("confirm_step").ok()?,
        action: ToolAction::Confirm,
        title: Line::new(title).ok()?,
        input: Text::new(serde_json::to_string_pretty(input).ok()?).ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_step_that_pays_or_orders_is_refused_and_the_rest_reads_as_a_card() {
        let step = |button: &str, does: &str| json!({ "site": "example.org", "button": button, "does": does });
        for pays in [
            step("Pay now", "Pays $40 for the tickets"),
            step("Place order", "Orders two pizzas"),
            step(
                "Place order",
                "Places the order for the lamp; free returns, tracking by email",
            ),
            step("Complete order", "Free returns within 30 days"),
            step(
                "Return and buy again",
                "Returns the lamp and buys the blue one",
            ),
            step(
                "Confirm",
                "Confirms order 8812 for the lamp; refund policy applies",
            ),
            step("Complete purchase", "Buys the jacket"),
            step("Confirm", "Sends money to Sam"),
            step("Submit", "Sells 10 shares of ACME"),
            json!({ "site": "example.org" }),
        ] {
            assert!(refused(&pays).is_some(), "{pays}");
        }
        for runs in [
            step(
                "Complete reservation",
                "Books a table for 2 at Lupa, Sat 8 pm",
            ),
            step(
                "Cancel subscription",
                "Cancels the gym membership at the end of the month",
            ),
            step("Submit", "Sends the expense report for October"),
            step("Post", "Posts the review of the plumber"),
            step("Cancel order", "Cancels order #4411 for the blue lamp"),
            step("Request refund", "Asks a refund for order 8812"),
            step(
                "Return the order for a refund",
                "Returns the jacket from order 8812",
            ),
            step(
                "Submit return",
                "Submits a return for order 8812, refund to the card",
            ),
        ] {
            assert_eq!(refused(&runs), None, "{runs}");
        }
        let card = preview(&step("Complete reservation", "Books a table")).unwrap();
        assert_eq!(
            card.title.as_str(),
            "Click \"Complete reservation\" on example.org"
        );
        assert_eq!(card.action, ToolAction::Confirm);
    }
}
