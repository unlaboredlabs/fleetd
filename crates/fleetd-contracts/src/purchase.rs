//! Purchases (D265 navi.purchases): a Navi pays at a checkout with the card its person picked from 1Password, after the
//! person approves that exact purchase.
//!
//! - The Navi, on the checkout page, calls [`PurchaseRequestCall`] (`purchase_request`, a browser tool its node
//!   answers): the shop, the total, what it buys. Its node checks the page is on the shop's domain and opens the
//!   request on the hub ([`PurchaseOpenCall`]), which shows the person a purchase card with the Navi's card. A purchase
//!   always asks a person: no approval mode, checker or rule answers it.
//! - Approved, the Navi calls [`PurchaseFillCall`] (`purchase_fill`) within [`FILL_WINDOW_MINUTES`]: its node claims the
//!   approval once ([`PurchaseClaimCall`]), reads the card from 1Password and types it into the checkout's card fields,
//!   in the shop's page and its payment provider's frames only, then says how it went ([`PurchaseFilledCall`]). The
//!   card's number, expiry and code never reach the Navi, the chat, a transcript, a recording or a log.
//! - The Navi clicks Pay itself; a bank's confirmation (3-D Secure) goes to the person with `request_takeover`.
//!
//! fleetd keeps only the card's `op://vault/item` reference, per Navi ([`NaviCard`]).
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::browser::BrowserSessionId;
use crate::chat::ChatRequestId;
use crate::ids::Timestamp;
use crate::ledger::RequestState;
use crate::prim::{Line, List};

/// How long after the person approves a purchase its card may be filled.
pub const FILL_WINDOW_MINUTES: i64 = 15;

brand!(
    /// A 1Password item: `op://<vault>/<item>`, a Credit Card item's whole, by its vault's and its own name or ID.
    OpItemReference, name = "OpItemReference", pattern = r"^op://[^/?\r\n]+/[^/?\r\n]+$"
);

brand!(
    /// A website's host, lowercase, with no scheme, port or path, of two labels at least: `shop.example.com`, never a
    /// bare suffix such as `com`, which every shop is on.
    ShopDomain, name = "ShopDomain",
    pattern = r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?){1,20}$"
);

brand!(
    /// An amount in the currency's units, as the checkout shows it, with a dot: `129.90`.
    Amount, name = "Amount", pattern = r"^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$"
);

brand!(
    /// An ISO 4217 currency code: `EUR`, `USD`.
    Currency, name = "Currency", pattern = r"^[A-Z]{3}$"
);

/// The shop the Navi buys from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PurchaseShop {
    /// The checkout page's host: `shop.example.com`. The card fills only on it (and its subdomains) and in its
    /// payment provider's frames.
    pub domain: ShopDomain,
    /// Its name, as the shop calls itself: `Hotel Adlon`.
    pub name: Line<1, 120>,
}

/// The total the checkout shows, with everything in it (taxes, fees, shipping).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PurchaseTotal {
    pub amount: Amount,
    pub currency: Currency,
}

/// One thing in the basket.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PurchaseItem {
    /// What it is, as the checkout names it: `Double room, 12-14 Nov, 2 nights`.
    pub name: Line<1, 200>,
    /// How many; absent: 1.
    pub quantity: Option<crate::prim::Int<1, 10_000>>,
    /// Its price in the total's currency, when the checkout shows one.
    pub amount: Option<Amount>,
}

/// `purchase_request`: ask the person to approve paying at this checkout with the Navi's card. Call it on the
/// checkout page, once the basket and the total are final.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PurchaseRequestCall {
    pub shop: PurchaseShop,
    pub total: PurchaseTotal,
    /// Everything being bought.
    pub items: List<PurchaseItem, 1, 50>,
}

/// `purchase_fill`: once the person approved the purchase, fill its card into the checkout's card fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseFillCall {
    /// The purchase's request, as purchase_request returned it: `Q12`.
    pub request_id: ChatRequestId,
}

/// The node's lead call for an agent's `purchase_request`: the call, the session it is for and the page it was on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOpenCall {
    pub session_id: BrowserSessionId,
    /// The checkout page's address, as the node read it.
    pub page: Line<1, 2000>,
    pub purchase: PurchaseRequestCall,
}

/// The node's lead call for an agent's `purchase_fill`: claims an approved purchase for one fill. The hub refuses it
/// unless the purchase is this Navi's, approved, unfilled and within its window; claimed, nothing else can fill it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseClaimCall {
    pub request_id: ChatRequestId,
    pub session_id: BrowserSessionId,
}

/// What the node may fill for a claimed purchase.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseClaimed {
    pub request_id: ChatRequestId,
    pub domain: ShopDomain,
    pub card: OpItemReference,
}

/// The node's lead call once a claimed fill is done. `typed` false: nothing reached the page, and the purchase may
/// be filled again within its window.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseFilledCall {
    pub request_id: ChatRequestId,
    pub ok: bool,
    pub typed: bool,
    /// What it filled, or why not, in plain words; never a card value.
    pub message: Line<1, 500>,
}

/// A purchase as its request keeps it: what the person approves.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Purchase {
    pub shop: PurchaseShop,
    pub total: PurchaseTotal,
    pub items: List<PurchaseItem, 1, 50>,
    /// The Navi's card when it asked.
    pub card: NaviCard,
    /// The browser session that asked, the one its fill is for.
    pub session_id: BrowserSessionId,
    /// When its card was filled into the checkout; absent until then. A purchase fills once.
    pub filled_at: Option<Timestamp>,
}

/// The card a Navi pays with: a Credit Card item in its person's 1Password. Only the reference is kept.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NaviCard {
    #[serde(rename = "ref")]
    pub reference: OpItemReference,
}

impl NaviCard {
    /// How the card is named to the person: its item and its vault, `Visa (Personal)`.
    pub fn label(&self) -> String {
        let rest = self.reference.trim_start_matches("op://");
        match rest.split_once('/') {
            Some((vault, item)) => format!("{item} ({vault})"),
            None => rest.to_owned(),
        }
    }
}

/// One purchase in a Navi's log: what it was, and what the person and the node did with it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseLogEntry {
    pub request_id: ChatRequestId,
    pub purchase: Purchase,
    pub state: RequestState,
    pub asked_at: Timestamp,
    pub answered_at: Option<Timestamp>,
    /// Who approved or denied it: `human:<device>`.
    pub answered_by: Option<String>,
    /// What happened last, in one line.
    pub note: Option<String>,
}

/// A Credit Card item a person's 1Password token reads, for the Navi's card picker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct OnePasswordCard {
    #[serde(rename = "ref")]
    pub reference: OpItemReference,
    pub title: String,
    pub vault: String,
}

/// Whether `host` is `domain` or one of its subdomains.
pub fn on_domain(host: &str, domain: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|rest| rest.ends_with('.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_purchase_names_its_shop_total_and_items() {
        let call: PurchaseRequestCall = serde_json::from_value(json!({
            "shop": { "domain": "hotel.example.com", "name": "Hotel Example" },
            "total": { "amount": "129.90", "currency": "EUR" },
            "items": [{ "name": "Double room, 2 nights", "quantity": 1, "amount": "129.90" }],
        }))
        .unwrap();
        assert_eq!(call.total.amount.as_str(), "129.90");
        for bad in [
            json!({ "domain": "https://hotel.example.com", "name": "x" }),
            json!({ "domain": "Hotel.example.com", "name": "x" }),
            json!({ "domain": "hotel.example.com/pay", "name": "x" }),
            json!({ "domain": "com", "name": "x" }),
        ] {
            assert!(
                serde_json::from_value::<PurchaseShop>(bad.clone()).is_err(),
                "{bad}"
            );
        }
        for bad in ["12,90", "-5", "1e3", "007"] {
            assert!(Amount::new(bad).is_err(), "{bad}");
        }
        assert!(Currency::new("eur").is_err());
        let no_items = json!({
            "shop": { "domain": "a.test", "name": "A" },
            "total": { "amount": "1", "currency": "EUR" },
            "items": [],
        });
        assert!(serde_json::from_value::<PurchaseRequestCall>(no_items).is_err());
    }

    #[test]
    fn a_card_is_a_whole_item_and_reads_as_its_name() {
        let card: NaviCard =
            serde_json::from_value(json!({ "ref": "op://Personal/Visa" })).unwrap();
        assert_eq!(card.label(), "Visa (Personal)");
        assert!(OpItemReference::new("op://Personal/Visa/number").is_err());
        assert!(on_domain("pay.shop.example.com", "shop.example.com"));
        assert!(!on_domain("evilshop.example.com", "shop.example.com"));
    }
}
