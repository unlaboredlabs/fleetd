//! Secure input: something a page needs that only the person may give, and the Navi must never see (a passport
//! number, a code texted to them, an ID number).
//! - The Navi, on that page, calls [`SecureInputCall`] (`request_secure_input`, a browser tool its node answers) with the
//!   site, the field and why. Its node checks the page is on the site and the field is there, then opens the request on
//!   the hub ([`SecureInputOpenCall`]).
//! - Typed by the person: a secret request with a `fill:<machine>:<browser session>` sink. The app seals what they
//!   type to the node, which types it straight into that field on that site (frames included), once. Telegram never
//!   asks for the value: a chat there isn't sealed, so its card says to open fleetd.
//! - From 1Password (`ref`, an Identity, Passport or similar item's field): an approval; once approved, the Navi calls
//!   [`SecureInputFillCall`] (`secure_input_fill`) within [`FILL_WINDOW_MINUTES`], and the node claims it once and fills
//!   it.
//!
//! The value never reaches the Navi, the chat, a transcript, a recording or a log.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::browser::{BrowserSessionId, OpReference};
use crate::chat::ChatRequestId;
use crate::ids::Timestamp;
use crate::prim::{Line, Text};
use crate::purchase::ShopDomain;

pub use crate::purchase::FILL_WINDOW_MINUTES;

/// The site the field is on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SecureInputSite {
    /// The page's host: `passport.gov.example`. The value fills only on it (and its subdomains).
    pub domain: ShopDomain,
    /// Its name, as it calls itself.
    pub name: Line<1, 120>,
}

/// `request_secure_input`: ask the person for something only they may give, filled into the page's field without you
/// seeing it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SecureInputCall {
    pub site: SecureInputSite,
    /// The field: a CSS selector on the page or one of its frames (`input[name=passport]`, `#otp`).
    pub target: Text<1, 500>,
    /// What it is, in the person's words: `Passport number`, `The code texted to you`.
    pub label: Line<1, 120>,
    /// Why the page needs it, in one line.
    pub why: Line<1, 300>,
    /// Fill it from this 1Password field instead (an Identity, Passport, Driver License or Social Security item's):
    /// the person approves, then call secure_input_fill. Absent: the person types it.
    #[serde(rename = "ref")]
    pub reference: Option<OpReference>,
}

/// `secure_input_fill`: once the person approved a 1Password secure input, fill it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecureInputFillCall {
    pub request_id: ChatRequestId,
}

/// A secure input as its request keeps it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecureInput {
    pub site: SecureInputSite,
    pub target: Text<1, 500>,
    pub label: Line<1, 120>,
    pub why: Line<1, 300>,
    #[serde(rename = "ref")]
    pub reference: Option<OpReference>,
    /// The browser session that asked, the one it fills in.
    pub session_id: BrowserSessionId,
    /// When it was filled; absent until then. A secure input fills once.
    pub filled_at: Option<Timestamp>,
}

/// The node's lead call for an agent's `request_secure_input`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecureInputOpenCall {
    pub session_id: BrowserSessionId,
    pub input: SecureInputCall,
}

/// The node's lead call for an agent's `secure_input_fill`: claims an approved 1Password secure input for one fill.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecureInputClaimCall {
    pub request_id: ChatRequestId,
    pub session_id: BrowserSessionId,
}

/// What the node may fill for a claimed secure input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecureInputClaimed {
    pub request_id: ChatRequestId,
    pub domain: ShopDomain,
    pub target: Text<1, 500>,
    #[serde(rename = "ref")]
    pub reference: OpReference,
}

/// The node's lead call once a claimed fill is done; `typed` false gives the claim back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecureInputFilledCall {
    pub request_id: ChatRequestId,
    pub ok: bool,
    pub typed: bool,
    pub message: Line<1, 500>,
}

/// A secure input the person was asked for.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecureInputAsked {
    pub request_id: ChatRequestId,
    pub message: String,
}
