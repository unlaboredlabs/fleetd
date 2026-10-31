//! A Navi's purchases in its browser (D265 navi.purchases; the wire types are fleetd-contracts' purchase.rs).
//! - [`purchase_request`]: on the checkout page, the node checks the page is on the shop's domain and opens the
//!   purchase on the hub, which asks the person, always. The session waits for them without idling out.
//! - [`purchase_fill`]: once approved, the node claims the purchase on the hub (once, within its window), reads the
//!   Navi's Credit Card item from 1Password with the session's token, seals the session as a login fill does
//!   (credentials.rs: its reads refused, every answer scrubbed of the card's number, expiry and code), then types each
//!   detail into its field: in the shop's page, its own frames, and frames of the payment providers checkouts embed
//!   (Stripe, Adyen, Braintree, ...; cross-origin, so the node attaches to them itself). Each filled field shows dots
//!   and a blur, in the video and in screenshots. The details pass only the node's own connection to the browser.
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use fleetd_contracts::browser::{BrowserCallResult, BrowserControl, Filled, PurchaseAsked};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::prim::Line;
use fleetd_contracts::purchase::{
    FILL_WINDOW_MINUTES, NaviCard, PurchaseClaimCall, PurchaseFillCall, PurchaseFilledCall,
    PurchaseOpenCall, PurchaseRequestCall, on_domain,
};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::credentials::page_url;
use super::onepassword::{Card, host_of};
use super::session::{PAUSED, Session};
use super::{Broker, agent_browser, lock, refuse};

/// The longest a session waits on a person (a purchase's approval, a takeover) before it may idle out again.
pub const WAIT_ON_PERSON: Duration = Duration::from_secs(2 * 60 * 60);

/// The payment providers whose card fields checkouts embed in frames of their own; a card fills in the shop's page,
/// its own frames, and frames on these (and their subdomains) only.
pub const PAYMENT_FRAMES: &[&str] = &[
    "stripe.com",
    "stripe.network",
    "adyen.com",
    "adyenpayments.com",
    "braintreegateway.com",
    "braintree-api.com",
    "checkout.com",
    "squarecdn.com",
    "squareup.com",
    "paypal.com",
    "mollie.com",
    "worldpay.com",
];

/// The broker's side of purchases: payment-provider hosts beyond [`PAYMENT_FRAMES`] (tests: a fake provider).
#[derive(Default)]
pub struct Cards {
    extra_frames: std::sync::Mutex<Vec<String>>,
    /// By browser session id and request id: the typed secure inputs it waits for (secure_input.rs).
    pub(super) waiting:
        std::sync::Mutex<std::collections::HashMap<String, super::secure_input::Waiting>>,
}

impl Broker {
    /// Lets a card fill in frames on `host` too (tests: a fake payment provider on another origin).
    pub fn allow_payment_frames(&self, host: &str) {
        lock(&self.cards.extra_frames).push(host.to_owned());
    }

    fn payment_frame(&self, host: &str) -> bool {
        PAYMENT_FRAMES.iter().any(|p| on_domain(host, p))
            || lock(&self.cards.extra_frames)
                .iter()
                .any(|p| on_domain(host, p))
    }
}

/// The Navi's live browser session, or why a purchase call can't use it.
pub(super) fn navi_session(broker: &Broker, thread: &str) -> Result<Arc<Session>, McpToolError> {
    if !broker.is_navi(thread) {
        return Err(refuse(
            ErrorCode::Forbidden,
            "Only a Navi pays at a checkout.",
            "leave the payment to the person and say so",
        ));
    }
    let session = broker.live(thread).ok_or_else(|| {
        refuse(
            ErrorCode::NotFound,
            "No browser session is open.",
            "open the shop's checkout in a browser session (session_start) first",
        )
    })?;
    if session.control() == BrowserControl::Human {
        return Err(refuse(
            ErrorCode::Invalid,
            PAUSED,
            "try again once they hand it back",
        ));
    }
    Ok(session)
}

/// An agent's `purchase_request`: the person is asked to approve exactly this purchase, on this checkout.
pub async fn purchase_request(
    broker: &Arc<Broker>,
    thread: &str,
    call: PurchaseRequestCall,
) -> Result<BrowserCallResult, McpToolError> {
    let session = navi_session(broker, thread)?;
    let page = page_url(&session).await.unwrap_or_default();
    let domain = call.shop.domain.as_str();
    let host = host_of(&page).unwrap_or_default();
    if !on_domain(&host, domain) {
        return Err(refuse(
            ErrorCode::Forbidden,
            format!(
                "The page is on {}, not {domain}.",
                if host.is_empty() { "no website" } else { &host }
            ),
            "open the shop's checkout page, then ask with its own domain",
        ));
    }
    let args = json!({
        "shop": call.shop.domain.as_str(),
        "total": format!("{} {}", call.total.amount, call.total.currency),
    });
    let opened = broker
        .in_turn(
            &session,
            LeadCall::PurchaseOpen(PurchaseOpenCall {
                session_id: session.id.clone(),
                page: Line::unchecked(
                    session
                        .scrub()
                        .text(&page)
                        .chars()
                        .take(2000)
                        .collect::<String>(),
                ),
                purchase: call,
            }),
        )
        .await?;
    let LeadCallResult::PurchaseOpen(opened) = opened else {
        return Err(refuse(
            ErrorCode::Failed,
            "The hub answered purchase_request with something else.",
            "try again",
        ));
    };
    // The person may take a while: the checkout, and what it holds, waits for them.
    session.hold_for_answer(WAIT_ON_PERSON);
    session.step("purchase_request", args, true, None, 0);
    let id = opened.request_id;
    Ok(BrowserCallResult::PurchaseRequest(PurchaseAsked {
        message: format!(
            "Asked the person to approve it ({id}). Stay on this checkout and end your turn: you are woken with their \
             answer. Approved, call purchase_fill with requestId {id} within {FILL_WINDOW_MINUTES} minutes, on this \
             page with its card fields showing; never type card details yourself."
        ),
        request_id: id,
    }))
}

/// An agent's `purchase_fill`: the approved purchase's card, typed into the checkout's card fields.
pub async fn purchase_fill(
    broker: &Arc<Broker>,
    thread: &str,
    call: PurchaseFillCall,
) -> Result<BrowserCallResult, McpToolError> {
    let started = Instant::now();
    let session = navi_session(broker, thread)?;
    let id = call.request_id.clone();
    let args = json!({ "requestId": id.as_str() });
    let failed = |error: McpToolError| {
        session.step(
            "purchase_fill",
            args.clone(),
            false,
            Some(&error.message),
            started.elapsed().as_millis() as u64,
        );
        error
    };
    let claimed = broker
        .in_turn(
            &session,
            LeadCall::PurchaseClaim(PurchaseClaimCall {
                request_id: id.clone(),
                session_id: session.id.clone(),
            }),
        )
        .await
        .map_err(failed)?;
    let LeadCallResult::PurchaseClaim(claimed) = claimed else {
        return Err(failed(refuse(
            ErrorCode::Failed,
            "The hub answered purchase_fill with something else.",
            "try again",
        )));
    };
    // Claimed: from here the hub hears how it went, so an untyped fill may be tried again.
    let outcome = fill_claimed(broker, &session, &claimed).await;
    let (ok, typed, message) = match &outcome {
        Ok(filled) => (true, true, filled.clone()),
        Err(e) => (false, e.typed, e.message.clone()),
    };
    let said = broker
        .in_turn(
            &session,
            LeadCall::PurchaseFilled(PurchaseFilledCall {
                request_id: id.clone(),
                ok,
                typed,
                message: Line::unchecked(one_line(&message)),
            }),
        )
        .await;
    if let Err(e) = said {
        tracing::warn!(session = %session.id, request = %id, error = e.message, "a purchase's fill was not reported");
    }
    session.hold(None);
    session.write_meta(None);
    match outcome {
        Ok(filled) => {
            let card = NaviCard {
                reference: claimed.card.clone(),
            }
            .label();
            let message = format!(
                "Filled {filled} from {card}; this browser session now refuses reading them back. Check the total \
                 is still what the person approved, then click the checkout's Pay or Book button yourself. If the \
                 bank asks to confirm the payment (3-D Secure, a code or its app), call request_takeover with \
                 \"Confirm the payment in your bank app\" and wait for them to hand it back. Then say in the chat \
                 whether the order went through."
            );
            let seq = session.step(
                "purchase_fill",
                args,
                true,
                Some(&message),
                started.elapsed().as_millis() as u64,
            );
            session.queue_capture(seq, None);
            Ok(BrowserCallResult::PurchaseFill(Filled {
                message: session.scrub().text(&message),
            }))
        }
        Err(e) => {
            let again = if e.typed {
                "the card may be partly in the page: tell the person, and ask again with purchase_request if they \
                 still want it"
            } else {
                "nothing was typed: open the checkout's card form and call purchase_fill again within the window"
            };
            Err(failed(refuse(
                ErrorCode::Invalid,
                format!("The card was not filled: {}.", e.message),
                again,
            )))
        }
    }
}

/// `text`'s first line, at most 500 characters, for a report's line.
pub(super) fn one_line(text: &str) -> String {
    let line: String = text
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(500)
        .collect();
    if line.trim().is_empty() {
        "no word on it".to_owned()
    } else {
        line
    }
}

/// Why a card fill stopped, and whether any of it reached the page.
#[derive(Debug)]
pub struct CardError {
    pub message: String,
    pub typed: bool,
}

pub(super) fn not_typed(message: impl Into<String>) -> CardError {
    CardError {
        message: message.into(),
        typed: false,
    }
}

/// Reads the claimed purchase's card and types it in. Ok: what it filled, in words.
async fn fill_claimed(
    broker: &Arc<Broker>,
    session: &Arc<Session>,
    claimed: &fleetd_contracts::purchase::PurchaseClaimed,
) -> Result<String, CardError> {
    let domain = claimed.domain.to_string();
    let page = page_url(session).await.unwrap_or_default();
    let host = host_of(&page).unwrap_or_default();
    if !on_domain(&host, &domain) {
        return Err(not_typed(format!(
            "the page is on {}, not the approved shop's {domain}",
            if host.is_empty() { "no website" } else { &host }
        )));
    }
    let vault = broker
        .vault(session)
        .await
        .map_err(|e| not_typed(e.message.trim_end_matches('.').to_owned()))?;
    let card = vault.vault.card(claimed.card.as_str()).await.map_err(|e| {
        not_typed(format!(
            "{} was not read: {}",
            claimed.card,
            e.message.trim_end_matches('.')
        ))
    })?;
    // Sealed before any of it is near the page: from here every answer to the driver, and the agent's transcript, is
    // scrubbed of each form of it, and its reads are refused.
    let reference = claimed.card.as_str();
    for (name, value) in secret_forms(&card) {
        let name = format!("{reference} {name}");
        session.add_secret(&name, &value);
        broker.credentials.filled(&session.thread, &name, &value);
    }
    session.credentials_filled.fetch_add(1, Ordering::Relaxed);
    if let Err(e) = agent_browser::write_policy(&broker.home, &session.thread, true) {
        tracing::warn!(session = %session.id, error = %e, "agent-browser's sealed policy not written");
    }
    let allowed = |url: &str| {
        host_of(url).is_some_and(|h| on_domain(&h, &domain) || broker.payment_frame(&h))
    };
    let filled = fill_card(session, &card, &allowed).await;
    if filled.as_ref().is_err_and(|e| !e.typed) {
        session.credentials_filled.fetch_sub(1, Ordering::Relaxed);
    }
    filled
}

/// The card's values in every form a page shows them: scrubbed from all the driver sees.
fn secret_forms(card: &Card) -> Vec<(&'static str, String)> {
    let number = card.number.as_str();
    let grouped = number
        .as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    let (month, year) = (card.month.as_str(), card.year.as_str());
    let short = &year[year.len().saturating_sub(2)..];
    let mut forms = vec![
        ("number", number.to_owned()),
        ("number", grouped.clone()),
        ("number", grouped.replace(' ', "-")),
        ("expiry", format!("{month}/{short}")),
        ("expiry", format!("{month} / {short}")),
        ("expiry", format!("{month}/{year}")),
        ("expiry", format!("{month}{short}")),
    ];
    if !card.cvc.is_empty() {
        forms.push(("code", card.cvc.to_string()));
    }
    forms
}

/// Which detail of a card a field takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Number,
    Expiry,
    Month,
    Year,
    Code,
    Name,
}

impl Role {
    const ALL: [Role; 6] = [
        Role::Number,
        Role::Expiry,
        Role::Month,
        Role::Year,
        Role::Code,
        Role::Name,
    ];

    fn key(self) -> &'static str {
        match self {
            Role::Number => "number",
            Role::Expiry => "expiry",
            Role::Month => "month",
            Role::Year => "year",
            Role::Code => "code",
            Role::Name => "name",
        }
    }

    fn words(self) -> &'static str {
        match self {
            Role::Number => "number",
            Role::Expiry | Role::Month | Role::Year => "expiry",
            Role::Code => "security code",
            Role::Name => "name on the card",
        }
    }
}

/// The card fields of one document, by role: its autocomplete tokens first (cc-number, cc-exp, ...), else what its
/// name, id, placeholder, label or aria-label says. Only fields a person could type in, shown on the page.
const FIND: &str = r#"(() => {
  const skip = ["hidden", "checkbox", "radio", "submit", "button", "file", "image", "reset", "color", "range"];
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const fields = [...document.querySelectorAll("input, select")].filter(
    (el) => !el.disabled && !el.readOnly && !skip.includes((el.type || "").toLowerCase()) && shown(el),
  );
  const said = (el) =>
    [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.getAttribute("data-fieldtype"),
      ...[...(el.labels || [])].map((l) => l.textContent)]
      .filter(Boolean).join(" ").toLowerCase();
  const tokens = (el) => (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
  const roles = [
    ["number", "cc-number", /card.?num|cc.?num|cardnumber|credit.?card.?number|encryptedcardnumber/],
    ["month", "cc-exp-month", /exp\w*.?month|encryptedexpirymonth|^mm$/],
    ["year", "cc-exp-year", /exp\w*.?year|encryptedexpiryyear|^yy(yy)?$/],
    ["expiry", "cc-exp", /expir|exp.?date|mm.?\/.?yy|encryptedexpirydate/],
    ["code", "cc-csc", /cvc|cvv|csc|security.?code|verification|encryptedsecuritycode/],
    ["name", "cc-name", /name.?on.?card|card.?holder|holder.?name|cardholder/],
  ];
  const found = {};
  const used = new Set();
  for (const [role, token] of roles) {
    const el = fields.find((f) => !used.has(f) && tokens(f).includes(token));
    if (el) { found[role] = el; used.add(el); }
  }
  for (const [role, , words] of roles) {
    if (found[role]) continue;
    if (role === "expiry" && (found.month || found.year)) continue;
    const el = fields.find((f) => !used.has(f) && words.test(said(f)));
    if (el) { found[role] = el; used.add(el); }
  }
  return found;
})()"#;

/// What the node reads of a field before it types: its tag, its length limit, its placeholder and its document's
/// address.
const FIELD: &str = "function() { return { tag: this.tagName.toLowerCase(), max: this.maxLength, \
     placeholder: (this.placeholder || '').toLowerCase(), url: this.ownerDocument.location.href }; }";

/// Hides what is typed: dots, as a password field shows, and blurred, in the video, the live view and screenshots.
pub(super) const HIDE: &str = "function() { \
     this.style.setProperty('-webkit-text-security', 'disc', 'important'); \
     this.style.setProperty('filter', 'blur(6px)', 'important'); }";

pub(super) const FOCUS: &str = "function() { this.focus(); try { this.select(); } catch (e) {} }";

/// Picks the option of a select that is one of `values`, by its value or its text, as a person's pick would.
const PICK: &str = "function(values) { const options = [...this.options]; \
     const o = options.find(o => values.includes(o.value.trim())) || \
       options.find(o => values.includes(o.text.trim())); \
     if (!o) return false; this.value = o.value; \
     this.dispatchEvent(new Event('input', { bubbles: true })); \
     this.dispatchEvent(new Event('change', { bubbles: true })); return true; }";

/// One document the card may fill in: the CDP session it is reached through, and its frame.
pub(super) struct Doc {
    pub(super) session: String,
    /// The target the document is in: the page's, or a frame's in another process.
    pub(super) target: String,
    pub(super) frame: String,
}

/// Every frame of the followed page the card may fill in, the page's own first: frames in its process through the
/// page's session, frames in other processes (a payment provider's, cross-origin) through a session of the node's own,
/// hidden from the driver.
pub(super) async fn docs(
    session: &Session,
    page_target: &str,
    page_session: &str,
    allowed: &(dyn Fn(&str) -> bool + Sync),
) -> Vec<Doc> {
    let mut docs = Vec::new();
    let mut known = std::collections::HashSet::new();
    let walk = |tree: &Value,
                via: &str,
                in_target: &str,
                docs: &mut Vec<Doc>,
                known: &mut std::collections::HashSet<String>| {
        let mut stack = vec![tree.clone()];
        while let Some(node) = stack.pop() {
            let frame = &node["frame"];
            if let Some(id) = frame["id"].as_str() {
                known.insert(id.to_owned());
                if allowed(frame["url"].as_str().unwrap_or_default()) {
                    docs.push(Doc {
                        session: via.to_owned(),
                        target: in_target.to_owned(),
                        frame: id.to_owned(),
                    });
                }
            }
            if let Some(children) = node["childFrames"].as_array() {
                stack.extend(children.iter().rev().cloned());
            }
        }
    };
    if let Ok(tree) = session
        .cdp
        .call(Some(page_session), "Page.getFrameTree", json!({}))
        .await
    {
        walk(
            &tree["frameTree"],
            page_session,
            page_target,
            &mut docs,
            &mut known,
        );
    }
    // Frames in other processes are targets of their own: attached here, their own frames added, until none is new.
    let mut attached = std::collections::HashSet::new();
    loop {
        let Ok(targets) = session.cdp.call(None, "Target.getTargets", json!({})).await else {
            break;
        };
        let next: Vec<String> = targets["targetInfos"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| t["type"] == "iframe")
            // Its frame is in the page's tree, or its parent is (where the tree leaves other processes' frames out).
            .filter(|t| {
                [&t["targetId"], &t["parentFrameId"]]
                    .iter()
                    .any(|id| id.as_str().is_some_and(|id| known.contains(id)))
            })
            .filter_map(|t| t["targetId"].as_str())
            .filter(|t| !attached.contains(*t))
            .map(str::to_owned)
            .collect();
        if next.is_empty() {
            break;
        }
        for target in next {
            attached.insert(target.clone());
            let Ok(own) = session.cdp.attach(&target).await else {
                continue;
            };
            // Its frame in the page's tree is now its own document: filled through its session.
            docs.retain(|d| d.frame != target);
            if let Ok(tree) = session
                .cdp
                .call(Some(&own), "Page.getFrameTree", json!({}))
                .await
            {
                walk(&tree["frameTree"], &own, &target, &mut docs, &mut known);
            }
        }
    }
    docs
}

/// Types the card into the card fields of the followed page and its allowed frames, each detail once, over the node's
/// own connection. Every document is checked to be `allowed` just before its field is typed in, so a frame that moved
/// since gets nothing.
pub async fn fill_card(
    session: &Session,
    card: &Card,
    allowed: &(dyn Fn(&str) -> bool + Sync),
) -> Result<String, CardError> {
    let Some((page_target, page)) = session.page() else {
        return Err(not_typed("the browser has no page"));
    };
    let mut typed = false;
    let mut filled: Vec<Role> = Vec::new();
    for doc in docs(session, &page_target, &page, allowed).await {
        if Role::ALL.iter().all(|r| filled.contains(r)) {
            break;
        }
        let call = |method: &'static str, params: Value| {
            let via = doc.session.clone();
            async move { session.cdp.call(Some(&via), method, params).await }
        };
        let Ok(world) = call(
            "Page.createIsolatedWorld",
            json!({ "frameId": doc.frame, "worldName": "fleetd card" }),
        )
        .await
        else {
            continue;
        };
        let Some(context) = world["executionContextId"].as_i64() else {
            continue;
        };
        let Ok(found) = call(
            "Runtime.evaluate",
            json!({ "expression": FIND, "contextId": context, "returnByValue": false }),
        )
        .await
        else {
            continue;
        };
        let Some(object) = found.pointer("/result/objectId").cloned() else {
            continue;
        };
        let Ok(props) = call(
            "Runtime.getProperties",
            json!({ "objectId": object, "ownProperties": true }),
        )
        .await
        else {
            continue;
        };
        for role in Role::ALL {
            if filled.contains(&role)
                || (role == Role::Expiry
                    && (filled.contains(&Role::Month) || filled.contains(&Role::Year)))
                || (matches!(role, Role::Month | Role::Year) && filled.contains(&Role::Expiry))
            {
                continue;
            }
            let Some(field) = props["result"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|p| p["name"] == role.key())
                .and_then(|p| p.pointer("/value/objectId").cloned())
            else {
                continue;
            };
            let on = |function: &'static str| {
                call(
                    "Runtime.callFunctionOn",
                    json!({ "objectId": field, "functionDeclaration": function, "returnByValue": true }),
                )
            };
            let about = on(FIELD)
                .await
                .map_err(|e| CardError { message: e, typed })?;
            let about = &about["result"]["value"];
            if !allowed(about["url"].as_str().unwrap_or_default()) {
                return Err(CardError {
                    message: "a card field's frame left the shop's checkout".into(),
                    typed,
                });
            }
            let value = value_for(role, card, about);
            if value.is_empty() {
                continue;
            }
            // From here the driver may not write to this field (credentials.rs, filled_field_refusal).
            if let Ok(described) = call("DOM.describeNode", json!({ "objectId": field })).await
                && let Some(backend) = described
                    .pointer("/node/backendNodeId")
                    .and_then(Value::as_i64)
            {
                let site = host_of(about["url"].as_str().unwrap_or_default()).unwrap_or_default();
                session.filled_field(&doc.target, &site, backend);
            }
            if about["tag"] == "select" {
                let values = select_values(role, card);
                typed = true;
                let picked = session
                    .cdp
                    .call_secret(
                        Some(&doc.session),
                        "Runtime.callFunctionOn",
                        json!({ "objectId": field, "functionDeclaration": PICK,
                                "arguments": [{ "value": values }], "returnByValue": true }),
                    )
                    .await
                    .map_err(|e| CardError { message: e, typed })?;
                if picked.pointer("/result/value") == Some(&Value::Bool(true)) {
                    filled.push(role);
                }
                continue;
            }
            on(HIDE)
                .await
                .map_err(|e| CardError { message: e, typed })?;
            on(FOCUS)
                .await
                .map_err(|e| CardError { message: e, typed })?;
            typed = true;
            // The one copy of the detail the node makes for the page, wiped once sent. A frame in another process
            // takes its input through its own session; the page's session routes it to the focused frame otherwise.
            let mut sent = session
                .cdp
                .call_secret(
                    Some(&doc.session),
                    "Input.insertText",
                    json!({ "text": value.as_str() }),
                )
                .await;
            if sent.is_err() && doc.session != page {
                sent = session
                    .cdp
                    .call_secret(
                        Some(&page),
                        "Input.insertText",
                        json!({ "text": value.as_str() }),
                    )
                    .await;
            }
            sent.map_err(|e| CardError { message: e, typed })?;
            filled.push(role);
        }
    }
    if !filled.contains(&Role::Number) {
        return Err(CardError {
            message: if typed {
                "the checkout's card number field took nothing".into()
            } else {
                "no card number field on the checkout: open its card form first".into()
            },
            typed,
        });
    }
    let mut said: Vec<&str> = Vec::new();
    for role in Role::ALL.iter().filter(|r| filled.contains(r)) {
        if !said.contains(&role.words()) {
            said.push(role.words());
        }
    }
    Ok(format!("the card's {}", said.join(", ")))
}

/// What a field of `role` takes, shaped by what it says it holds: an expiry `MM/YY` (or `MM/YYYY` where it asks for
/// that), a year in two digits where only two fit.
fn value_for(role: Role, card: &Card, about: &Value) -> Zeroizing<String> {
    let max = about["max"].as_i64().unwrap_or(-1);
    let placeholder = about["placeholder"].as_str().unwrap_or_default();
    let (month, year) = (card.month.as_str(), card.year.as_str());
    let short = &year[year.len().saturating_sub(2)..];
    Zeroizing::new(match role {
        Role::Number => card.number.to_string(),
        Role::Expiry if placeholder.contains("yyyy") && !(0..7).contains(&max) => {
            format!("{month}/{year}")
        }
        Role::Expiry if max == 4 => format!("{month}{short}"),
        Role::Expiry => format!("{month}/{short}"),
        Role::Month => month.to_owned(),
        Role::Year if max == 2 || placeholder == "yy" => short.to_owned(),
        Role::Year => year.to_owned(),
        Role::Code => card.cvc.to_string(),
        Role::Name => card.name.to_string(),
    })
}

/// The options a select of `role` may name the detail by.
fn select_values(role: Role, card: &Card) -> Vec<String> {
    let (month, year) = (card.month.as_str(), card.year.as_str());
    let short = &year[year.len().saturating_sub(2)..];
    match role {
        Role::Month => vec![month.to_owned(), month.trim_start_matches('0').to_owned()],
        Role::Year => vec![year.to_owned(), short.to_owned()],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card() -> Card {
        Card {
            number: Zeroizing::new("4242424242424242".into()),
            month: Zeroizing::new("03".into()),
            year: Zeroizing::new("2030".into()),
            cvc: Zeroizing::new("737".into()),
            name: Zeroizing::new("Ada Devbox".into()),
        }
    }

    #[test]
    fn each_field_gets_the_detail_in_the_shape_it_takes() {
        let card = card();
        let about = |max: i64, placeholder: &str| json!({ "max": max, "placeholder": placeholder });
        let value =
            |role, max, placeholder| value_for(role, &card, &about(max, placeholder)).to_string();
        assert_eq!(value(Role::Expiry, -1, "mm / yy"), "03/30");
        assert_eq!(value(Role::Expiry, 7, "mm/yyyy"), "03/2030");
        assert_eq!(value(Role::Expiry, 4, ""), "0330");
        assert_eq!(value(Role::Year, 2, ""), "30");
        assert_eq!(value(Role::Year, -1, "yyyy"), "2030");
        assert_eq!(select_values(Role::Month, &card), ["03", "3"]);
        let forms: Vec<String> = secret_forms(&card).into_iter().map(|(_, v)| v).collect();
        for form in [
            "4242424242424242",
            "4242 4242 4242 4242",
            "03/30",
            "03 / 30",
            "737",
        ] {
            assert!(forms.iter().any(|f| f == form), "{form}");
        }
    }

    #[test]
    fn a_card_fills_in_the_payment_providers_frames_only() {
        let cards = Cards::default();
        lock(&cards.extra_frames).push("pay.devbox.test".into());
        let frame = |host: &str| {
            PAYMENT_FRAMES.iter().any(|p| on_domain(host, p))
                || lock(&cards.extra_frames).iter().any(|p| on_domain(host, p))
        };
        assert!(frame("js.stripe.com"));
        assert!(frame("checkoutshopper-live.adyen.com"));
        assert!(frame("assets.braintreegateway.com"));
        assert!(frame("pay.devbox.test"));
        assert!(!frame("stripe.com.evil.test"));
        assert!(!frame("notstripe.com"));
    }
}
