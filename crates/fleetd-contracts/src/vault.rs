//! The vault (W549, design `vault-design`): logins, cards, addresses and environment variables, kept in the hub's
//! database sealed under a per-item data key that the vault's root key wraps. Values never cross a wire in the clear:
//!
//! - App -> hub (`vault_save`, `vault_unlock`): sealed to the hub's box key ([`VaultStatus::hub_box_key`]).
//! - Hub -> node (`vault_fill`, a purchase's `sealedCard`, env deliveries): sealed to the node's box key, per use.
//! - Hub -> app (`vault_reveal`): sealed to a one-time key the app makes for that reveal.
//! - Node -> hub (`vault_adopt`, `vault_import_read`): sealed to the hub's box key.
//!
//! Agents fill and inject values without reading them back; every use is a row of the audit log ([`VaultAuditEntry`]).
//! The readable metadata here ([`VaultMeta`]) is what listing needs: a label, a login's sites, a card's brand and last
//! four digits, an address's country, a variable's name and fingerprint. The hub works it out from the value itself.
//! The envelope ([`ENVELOPE_VERSION`]) and its additional data are pinned here so both runtimes open the
//! same rows (vectors in `tests/vault_vectors.json`).
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::browser::BrowserSessionId;
use crate::ids::{MachineId, ProjectId, ProjectRef, ThreadId};
use crate::ledger::{DecisionKey, WorkstreamId};
use crate::people::PersonId;
use crate::prim::{Count, Line, List, Positive};
use crate::project_settings::EnvVarName;
use crate::purchase::{OpItemReference, ShopDomain};
use crate::secrets::{SealedSecret, SecretFingerprint, SecretSinkKind};
use crate::tasks::TaskId;

/// The envelope's first byte: `0x01 ‖ len(keyId) ‖ keyId ‖ wrapNonce (12) ‖ AES-256-GCM(KEK, DEK) (48) ‖ itemNonce
/// (12) ‖ AES-256-GCM(DEK, utf8 JSON of the item's secret fields) (n + 16)`.
pub const ENVELOPE_VERSION: u8 = 1;
/// AES-256-GCM's nonce, for both the wrap and the item.
pub const NONCE_BYTES: usize = 12;
/// A wrapped 32-byte data key with its 16-byte tag.
pub const WRAPPED_KEY_BYTES: usize = 48;

/// The additional data that binds a data key to its item and version.
pub fn dek_aad(item_id: &str, version: u64) -> String {
    format!("fleetd-vault/dek/1|{item_id}|{version}")
}

/// The additional data that binds an item's ciphertext to its row: moving it into another item, kind, scope or
/// version fails to open.
pub fn item_aad(item_id: &str, kind: VaultKind, scope_key: &str, version: u64) -> String {
    format!(
        "fleetd-vault/item/1|{item_id}|{}|{scope_key}|{version}",
        kind.as_str()
    )
}

/// The additional data of a root key's check blob (`vault_keys.check_blob`: 16 zero bytes sealed under the key), which
/// tells a wrong key apart from a damaged item.
pub fn check_aad(key_id: &str) -> String {
    format!("fleetd-vault/check/1|{key_id}")
}

/// An item's scope as its additional data names it: `person:<personId>`, `project:<machine>/<project>`,
/// `order:<machine>/<project>/<W…>` or `hub`.
pub fn scope_key(
    scope: VaultScope,
    person_id: Option<&str>,
    project: Option<(&str, &str)>,
    workstream_id: Option<&str>,
) -> Option<String> {
    match scope {
        VaultScope::Person => Some(format!("person:{}", person_id?)),
        VaultScope::Project => {
            let (machine, project) = project?;
            Some(format!("project:{machine}/{project}"))
        }
        VaultScope::Order => {
            let (machine, project) = project?;
            Some(format!("order:{machine}/{project}/{}", workstream_id?))
        }
        VaultScope::Hub => Some("hub".to_owned()),
    }
}

/// The most items one person or one project keeps.
pub const ITEMS_MAX: usize = 1000;
/// A login's, card's or address's sealed fields, as JSON.
pub const FIELDS_MAX_BYTES: usize = 8 * 1024;
/// Fills of one item per project per hour, and of every item per machine per hour.
pub const FILLS_PER_ITEM_HOUR: u32 = 30;
pub const FILLS_PER_MACHINE_HOUR: u32 = 300;
/// Reveals per person per hour.
pub const REVEALS_PER_HOUR: u32 = 30;
/// Refused fills of one session within [`REFUSALS_WINDOW_MINUTES`] that put a line in the project's chat.
pub const REFUSALS_FOR_LINE: u32 = 3;
pub const REFUSALS_WINDOW_MINUTES: u32 = 10;
/// How long a deleted item stays in the trash, and an audit row in the log.
pub const TRASH_DAYS: u32 = 30;
pub const AUDIT_DAYS: u32 = 365;

/// Hosting suffixes whose subdomains belong to different people: a site on one matches only as its whole host.
pub const SHARED_HOSTING: &[&str] = &[
    "github.io",
    "vercel.app",
    "netlify.app",
    "pages.dev",
    "herokuapp.com",
    "web.app",
    "firebaseapp.com",
    "azurewebsites.net",
    "cloudfront.net",
    "appspot.com",
];

/// Whether a page on `host` is on an item's `site`: the same host or a subdomain of it. A site with no dot matches
/// nothing, and one on a [`SHARED_HOSTING`] suffix only its whole host.
pub fn on_site(host: &str, site: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let site = site.to_ascii_lowercase();
    if !site.contains('.') {
        return false;
    }
    if SHARED_HOSTING
        .iter()
        .any(|suffix| crate::purchase::on_domain(&site, suffix))
    {
        return host == site;
    }
    crate::purchase::on_domain(&host, &site)
}

brand!(
    /// A vault item: `V` and 32 lowercase hex characters.
    VaultItemId, name = "VaultItemId", pattern = r"^V[0-9a-f]{32}$"
);

brand!(
    /// A root key: `k1`, `k2`, … one more at each rotation.
    VaultKeyId, name = "VaultKeyId", pattern = r"^k[1-9][0-9]{0,8}$"
);

brand!(
    /// A lead's proposal to import items from 1Password: `VP` and 32 lowercase hex characters.
    VaultImportId, name = "VaultImportId", pattern = r"^VP[0-9a-f]{32}$"
);

brand!(
    /// What an agent names an item by: its id (`V…`), or its label when that's unique among the items it may use.
    VaultItemName, name = "VaultItemName", pattern = r"^[^\s!-/:-@\[-`{-~][^\r\n]{0,119}$",
    description = "an item's id or label: 1 to 120 characters on one line, not starting with a space or punctuation"
);

brand!(
    /// A card's last four digits.
    CardLast4, name = "CardLast4", pattern = r"^[0-9]{4}$"
);

/// An item's label, as the person reads it: `Amazon`, `Visa (Personal)`, `Home`, or a variable's name.
pub type VaultLabel = Line<1, 120>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum VaultKind {
    Login,
    Card,
    Address,
    /// An environment variable for agents' sessions.
    Env,
}

impl VaultKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Login => "login",
            Self::Card => "card",
            Self::Address => "address",
            Self::Env => "env",
        }
    }
}

/// Whose an item is, and so who lists, changes and reveals it, and which work uses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VaultScope {
    /// One person's: used by work they started, their Only me projects, and projects it's shared with.
    Person,
    /// One project's (`machineId`, `projectId`): its leads and agents use it.
    Project,
    /// One order's variable (`workstreamId` too): that order's agents. Gone when the order closes.
    Order,
    /// Everyone's on the hub, every project's work; only admins change it. Never a variable.
    Hub,
}

impl VaultScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Project => "project",
            Self::Order => "order",
            Self::Hub => "hub",
        }
    }
}

/// Where an item came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VaultSource {
    /// Typed or pasted by a person.
    Typed,
    /// Imported from 1Password; never read from it again.
    #[serde(rename = "1password", rename_all = "camelCase")]
    OnePassword {
        #[serde(rename = "ref")]
        reference: OpItemReference,
        imported_ms: Count,
    },
    /// Taken in by the migration from what a node held (`project-env`, `order-env`, a `request_secret` sink) or from
    /// the hub's `project_env` rows: `from` names it, `project_env`, `order_env` or `sink:<key>`.
    Adopted { from: Line<1, 200> },
}

/// A login's field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LoginField {
    Username,
    Password,
    /// The one-time code's seed: the hub makes each code, so the seed never leaves it.
    Totp,
    Notes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum CardBrand {
    Visa,
    Mastercard,
    Amex,
    Discover,
    Diners,
    Jcb,
    Unionpay,
    Other,
}

/// What an env variable is delivered to besides the sessions' environment: a `request_secret` sink's file.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultEnvSink {
    /// `env` (a line in an env file) or `file` (the whole file).
    pub kind: SecretSinkKind,
    /// The sink's machine, then its absolute path there.
    pub machine_id: MachineId,
    pub path: Line<1, 4096>,
    /// An `env` sink's variable, when not the item's name.
    pub env_name: Option<EnvVarName>,
    /// The `request_secret` key it answered: `stripe.test_key`.
    pub secret_key: Option<DecisionKey>,
}

/// An item's readable metadata (`vault_items.meta`), worked out by the hub from the value. Each kind sets its own:
/// login `sites` and `fields`; card `brand`, `last4` and `billingAddress`; address `country` (and `sites`); env
/// `secret`, `fingerprint` (secret only), `bytes` and `sink`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultMeta {
    /// The hosts it fills on (that host or a subdomain; shared-hosting suffixes as whole hosts only).
    pub sites: Option<List<ShopDomain, 0, 50>>,
    /// A login's fields that hold a value.
    pub fields: Option<Vec<LoginField>>,
    pub brand: Option<CardBrand>,
    pub last4: Option<CardLast4>,
    /// A card's billing address: an address item.
    pub billing_address: Option<VaultItemId>,
    /// An address's country, ISO 3166-1 alpha-2 when known: `DE`.
    pub country: Option<Line<1, 60>>,
    /// An env variable that is never shown in a list (it may be revealed).
    pub secret: Option<bool>,
    /// A secret variable's fingerprint, the same as the node reports for it.
    pub fingerprint: Option<SecretFingerprint>,
    /// A variable's value's size in bytes.
    pub bytes: Option<Count>,
    pub sink: Option<VaultEnvSink>,
    pub source: VaultSource,
}

// ---- the sealed fields: what an app seals to the hub, and the hub opens for a fill or a reveal ----

/// A login's sealed fields. In `vault_save` for an existing item, an absent field is kept and an empty one cleared.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LoginSecret {
    pub username: Option<String>,
    pub password: Option<String>,
    /// An `otpauth://` URI or a base32 seed.
    pub totp: Option<String>,
    pub notes: Option<String>,
}

/// A card's sealed fields, also the plain JSON of a purchase claim's `sealedCard`.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CardSecret {
    /// Digits only.
    pub number: Option<String>,
    /// `01`-`12`.
    pub month: Option<String>,
    /// Four digits: `2029`.
    pub year: Option<String>,
    pub cvc: Option<String>,
    /// The name on the card.
    pub name: Option<String>,
}

/// An address's sealed fields; each part a fill finds a field for.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddressSecret {
    pub name: Option<String>,
    pub organization: Option<String>,
    pub line1: Option<String>,
    pub line2: Option<String>,
    pub city: Option<String>,
    pub region: Option<String>,
    pub postal_code: Option<String>,
    pub country: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
}

/// A variable's sealed field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct EnvSecret {
    pub value: String,
}

/// The plain JSON inside the vault's sealed boxes, each by what it's for, so apps and both runtimes seal and open the
/// same shapes. Never sent as it is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultSealedShapes {
    /// `vault_save` and `vault_reveal`, by kind; a purchase claim's `sealedCard` is a card.
    pub login: LoginSecret,
    pub card: CardSecret,
    pub address: AddressSecret,
    pub env: EnvSecret,
    /// `vault_fill`'s answer.
    pub fill: VaultFillPlain,
    /// `vault_import_read`'s items.
    pub imported: VaultImportedFields,
}

// ---- listing ----

/// One item as a person's app lists it: metadata only, never a value (a plain variable's `value` aside).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultItemSummary {
    pub item_id: VaultItemId,
    pub kind: VaultKind,
    pub scope: VaultScope,
    pub label: VaultLabel,
    pub meta: VaultMeta,
    /// kind env only.
    pub env_name: Option<EnvVarName>,
    /// A person item's owner; for other scopes its creator.
    pub person_id: Option<PersonId>,
    pub machine_id: Option<MachineId>,
    pub project_id: Option<ProjectId>,
    pub workstream_id: Option<WorkstreamId>,
    /// The projects a person item is shared with: their agents fill it, never reveal it.
    pub shared_with: Option<Vec<ProjectRef>>,
    /// A plain (not secret) variable's value, which lists show without a reveal.
    pub value: Option<String>,
    /// Bumped at each change of its value.
    pub version: Positive,
    pub created_ms: Count,
    pub updated_ms: Count,
    /// Who changed it last: `human:<device>`, or `system` for the migration.
    pub updated_by: String,
    /// In the trash since; purged [`TRASH_DAYS`] later.
    pub deleted_ms: Option<Count>,
    /// What the caller may do, by the scope table: change (edit, delete, share) and reveal.
    pub can_edit: bool,
    pub can_reveal: bool,
}

// ---- audit ----

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum VaultAuditAction {
    Fill,
    FillRefused,
    /// A session launched with the item among its variables.
    Inject,
    /// The item's value was sent to a machine (env file or sink).
    Deliver,
    Reveal,
    Create,
    Update,
    Delete,
    Restore,
    Share,
    Import,
    Rotate,
    Unlock,
    /// A card filled for a recorded purchase.
    Purchase,
    /// The migration took it in (`vault_adopt`), or found the node's value differs from the hub's record.
    Adopt,
}

impl VaultAuditAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fill => "fill",
            Self::FillRefused => "fill_refused",
            Self::Inject => "inject",
            Self::Deliver => "deliver",
            Self::Reveal => "reveal",
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
            Self::Restore => "restore",
            Self::Share => "share",
            Self::Import => "import",
            Self::Rotate => "rotate",
            Self::Unlock => "unlock",
            Self::Purchase => "purchase",
            Self::Adopt => "adopt",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VaultAuditOutcome {
    /// A fill handed to the node, until its `vault_filled`.
    Pending,
    Ok,
    Refused,
    Failed,
}

impl VaultAuditOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ok => "ok",
            Self::Refused => "refused",
            Self::Failed => "failed",
        }
    }
}

/// An audit row's `data` column (`vault_audit.data`), the same JSON in both runtimes. Never a value.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultAuditData {
    /// The item's label when it was used.
    pub label: Option<String>,
    pub kind: Option<VaultKind>,
    /// The page's host and the frame's, for a fill.
    pub site: Option<String>,
    pub frame: Option<String>,
    /// `username`, `password`, `otp`, `address`, `card`, or the revealed fields.
    pub fields: Option<Vec<String>>,
    /// The variable names a launch got, for `inject`.
    pub names: Option<Vec<EnvVarName>>,
    pub session_id: Option<BrowserSessionId>,
    /// The machine hosting the browser, for a fill: the per-machine rate limit counts it.
    pub host: Option<MachineId>,
    /// A card fill's purchase: `purchase_filled` closes its row by it.
    pub purchase_id: Option<crate::chat::ChatRequestId>,
    /// Whether a fill reached the page.
    pub typed: Option<bool>,
    /// A share's projects, `<machine>/<project>`.
    pub to: Option<Vec<String>>,
    /// How many, for an import or a rotation.
    pub count: Option<Count>,
    /// The path it came by, in a word: `fill_credential`, `purchase_fill`, `fill_address`, `env`, `sink`.
    pub via: Option<String>,
    /// Who did it in words: `human:<device>`, `system`, or the agent's session.
    pub by: Option<String>,
    /// Why it was refused or failed, or what happened, in one line.
    pub message: Option<String>,
}

/// One row of the audit log, as `vault_audit` and `vault_get` list it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultAuditEntry {
    pub n: Positive,
    pub at_ms: Count,
    /// Absent for a row of no single item (`item_id` "" in the table): a refused fill that named no usable item, an
    /// unlock, a rotation, a launch's `inject` row listing `data.names`.
    pub item_id: Option<VaultItemId>,
    pub action: VaultAuditAction,
    pub outcome: VaultAuditOutcome,
    pub person_id: Option<PersonId>,
    pub device_id: Option<String>,
    pub machine_id: Option<MachineId>,
    pub project_id: Option<ProjectId>,
    pub thread_id: Option<ThreadId>,
    pub task_id: Option<TaskId>,
    pub workstream_id: Option<WorkstreamId>,
    pub data: VaultAuditData,
}

// ---- status ----

/// Where the root key is kept (`~/.fleetd/vault/root.key`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VaultKeyMode {
    /// In the file, 0600 in a 0700 directory: opens at every start.
    File,
    /// In the OS keychain; the file points at it.
    Keyring,
    /// Wrapped by a passphrase (scrypt): locked after every start until an owner or admin unlocks it.
    Passphrase,
}

/// How the migration of one machine's variables and sinks into the vault stands.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultMigrationMachine {
    pub machine_id: MachineId,
    /// Taken in: plain variables from the hub's rows, secrets and sinks from the node.
    pub adopted: Count,
    /// Still on the node: it's offline, or runs a node that can't adopt (`waitingFor`).
    pub waiting: Count,
    /// The node's value differed from the hub's record: the node's won, and the conflict is in the audit log.
    pub mismatched: Count,
    /// fleetd's own order variables (`GH_TOKEN` from the GitHub App), which stay on their own path.
    pub skipped_system: Count,
    /// Why some wait, in words: "offline", "its node needs fleetd's Bun build".
    pub waiting_for: Option<Line<1, 200>>,
    pub updated_ms: Count,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultMigration {
    /// Nothing is left to take in.
    pub done: bool,
    pub machines: Vec<VaultMigrationMachine>,
}

/// The vault's state, for the app and the doctor.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// The hub's box key (`~/.fleetd/hub/node-box-key.pem`'s public half): what an app seals `vault_save`'s fields and
    /// `vault_unlock`'s passphrase to.
    pub hub_box_key: crate::secrets::BoxPublicKey,
    pub key_mode: VaultKeyMode,
    /// The root key in use; absent while locked or missing.
    pub key_id: Option<VaultKeyId>,
    /// Passphrase mode after a start: fills fail until an owner or admin unlocks it; delivered env keeps working.
    pub locked: bool,
    /// The key the items were sealed with is gone: they can't be opened until it's restored.
    pub key_missing: bool,
    /// An owner saved the recovery code (`fleetd vault recovery-code`).
    pub recovery_saved: bool,
    pub migration: VaultMigration,
}

// ---- 1Password, for import only ----

/// A 1Password item a person's token reads, for the import list: never a value.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultImportCandidate {
    #[serde(rename = "ref")]
    pub reference: OpItemReference,
    pub title: String,
    /// What it becomes in the vault.
    pub kind: VaultKind,
    pub vault: String,
    /// Its websites' hosts.
    pub sites: Option<Vec<String>>,
    /// Already in the vault, imported from it: that item.
    pub imported: Option<VaultItemId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VaultImportState {
    Open,
    Imported,
    Dismissed,
}

/// One item of an import card.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct VaultImportCardItem {
    #[serde(rename = "ref")]
    pub reference: OpItemReference,
    pub title: String,
    pub kind: VaultKind,
    pub site: Option<String>,
}

/// A chat message's import card (`ChatMessage.vaultImport`): a lead proposed importing these items; the person ticks
/// and taps Import (the `vault_import` tool with `proposalId`) or Dismiss. The only confirm in the vault.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultImportCard {
    pub proposal_id: VaultImportId,
    /// The lead's reason, one line.
    pub why: Line<1, 500>,
    /// Where the items go unless the person picks another: the person's own by default.
    pub scope: VaultScope,
    pub items: List<VaultImportCardItem, 1, 50>,
    pub state: VaultImportState,
    /// How many were imported, once answered.
    pub imported: Option<Count>,
    pub answered_ms: Option<Count>,
}

/// What an imported item holds, sealed to the hub (`vault_import_read`'s `sealed`): its title, sites and the fields of
/// its kind.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct VaultImportedFields {
    pub title: String,
    pub sites: Option<Vec<String>>,
    pub login: Option<LoginSecret>,
    pub card: Option<CardSecret>,
    pub address: Option<AddressSecret>,
}

// ---- events ----

/// `vault.changed`: an item was made, changed, deleted, restored or shared. Never a value; vault_list reads it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultChangedData {
    pub item_id: VaultItemId,
    pub scope: VaultScope,
    pub person_id: Option<PersonId>,
    pub machine_id: Option<MachineId>,
    pub project_id: Option<ProjectId>,
}

/// `vault.used`: an audit row was written. vault_audit reads it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultUsedData {
    pub item_id: VaultItemId,
    pub n: Positive,
    pub action: VaultAuditAction,
    pub outcome: VaultAuditOutcome,
    pub machine_id: Option<MachineId>,
    pub project_id: Option<ProjectId>,
}

// ---- node -> hub: fills (lead calls the node makes for its browser sessions, never the session itself) ----

/// What a `vault_fill` fills.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VaultFillField {
    Username,
    Password,
    /// A one-time code the hub makes from the login's seed.
    Otp,
    /// An address item's fields.
    Address,
}

impl VaultFillField {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Username => "username",
            Self::Password => "password",
            Self::Otp => "otp",
            Self::Address => "address",
        }
    }
}

/// `vault_fill`: the node hosting a browser session asks for one item's field for the page it's on. The hub knows the
/// session's project, order and person from its own records, never from the call; it checks the item is visible to
/// them, of the right kind and on the page's site, within the rate limits, writes an audit row (`pending`), and
/// answers with the value sealed to the node hosting the session.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct VaultFillCall {
    pub session_id: BrowserSessionId,
    /// The item, by id or unique label; or `ref`.
    pub item: Option<VaultItemName>,
    /// An `op://` reference (one release): the item imported from it.
    #[serde(rename = "ref")]
    pub reference: Option<crate::browser::OpReference>,
    pub field: VaultFillField,
    /// The page's address, as the node read it.
    pub page: Line<1, 2000>,
    /// The frame's address, when the field is in a frame.
    pub frame: Option<Line<1, 2000>>,
}
crate::checked!(VaultFillCall, |call| {
    if call.item.is_some() == call.reference.is_some() {
        return Err("give item or ref, not both".into());
    }
    Ok(())
});

/// `vault_fill`'s answer. `sealed` is `crypto_box_seal(hostNodeBoxKey, utf8 JSON of` [`VaultFillPlain`]`)`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultFillResult {
    pub item_id: VaultItemId,
    pub label: VaultLabel,
    pub audit_id: Positive,
    pub sealed: SealedSecret,
}

/// What a fill's `sealed` opens to: `value` for a login's field, the address fields for an address; and the sites the
/// node checks the page against again.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct VaultFillPlain {
    pub value: Option<String>,
    #[serde(flatten)]
    pub address: AddressSecret,
    pub sites: Vec<String>,
}

/// `vault_filled`: how the fill went, for its audit row. `typed` false: nothing reached the page.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultFilledCall {
    pub audit_id: Positive,
    pub ok: bool,
    pub typed: bool,
    /// What it filled, or why not, in plain words; never a value.
    pub message: Option<Line<1, 500>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultFilledResult {
    pub audit_id: Positive,
}

// ---- agents' lead calls ----

/// `vault_items`: the items this session may use, optionally only those for a site or of a kind. Labels, kinds,
/// sites and fields present; cards by label only; never a value.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VaultItemsCall {
    /// A host: `amazon.com`.
    pub site: Option<Line<1, 253>>,
    pub kind: Option<VaultKind>,
}

/// One item an agent may use.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultUsable {
    pub item_id: VaultItemId,
    pub kind: VaultKind,
    pub label: VaultLabel,
    pub sites: Option<Vec<String>>,
    pub fields: Option<Vec<LoginField>>,
    /// A variable's name: it's already in the session's environment.
    pub env_name: Option<EnvVarName>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VaultItemsResult {
    pub items: Vec<VaultUsable>,
}

/// `vault_import_search` (leads only): search the person's 1Password for items to import. Titles, kinds and sites,
/// never values.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VaultImportSearchCall {
    pub query: Line<0, 200>,
    pub kinds: Option<Vec<VaultKind>>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VaultImportSearchResult {
    pub items: Vec<VaultImportCandidate>,
    /// Why nothing could be searched: no token saved, no machine holding it online.
    pub error: Option<String>,
}

/// `vault_import_propose` (leads only): put an import card in the chat for the person to confirm with one tap.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VaultImportProposeCall {
    #[serde(rename = "refs")]
    pub references: List<OpItemReference, 1, 50, true>,
    pub why: Line<1, 500>,
    /// Where they go; absent: the person's own.
    pub scope: Option<VaultScope>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultImportProposeResult {
    pub proposal_id: VaultImportId,
    pub next: Option<String>,
}

// ---- hub -> node: session calls (only nodes listing CAP_VAULT get them) ----

/// One variable a node holds, sealed to the hub, in `vault_adopt`'s answer.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultAdoptVar {
    /// `project` (`project-env/<project>.json`) or `order` (`order-env/<project>/<order>.json`).
    pub scope: VaultScope,
    pub project_id: ProjectId,
    pub order_id: Option<WorkstreamId>,
    pub name: EnvVarName,
    pub secret: bool,
    /// The value, sealed to the hub's box key.
    pub sealed: SealedSecret,
    pub fingerprint: SecretFingerprint,
    pub bytes: Count,
}

/// One `env:` or `file:` sink a node holds (`secret-sinks.json`), its value read from the sink and sealed to the hub.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultAdoptSink {
    pub secret_key: DecisionKey,
    pub kind: SecretSinkKind,
    pub path: Line<1, 4096>,
    pub env_name: Option<EnvVarName>,
    pub sealed: SealedSecret,
    pub fingerprint: SecretFingerprint,
}

/// One item `vault_import_read` read: `sealed` opens to [`VaultImportedFields`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VaultImportRead {
    #[serde(rename = "ref")]
    pub reference: OpItemReference,
    pub kind: VaultKind,
    pub sealed: SealedSecret,
}

/// One item it couldn't read, and why in words (the token masked).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VaultImportError {
    #[serde(rename = "ref")]
    pub reference: OpItemReference,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn additional_data_is_pinned() {
        let id = "V0123456789abcdef0123456789abcdef";
        assert_eq!(dek_aad(id, 3), format!("fleetd-vault/dek/1|{id}|3"));
        let scope = scope_key(VaultScope::Order, None, Some(("devbox", "p1")), Some("W7")).unwrap();
        assert_eq!(scope, "order:devbox/p1/W7");
        assert_eq!(
            item_aad(id, VaultKind::Env, &scope, 1),
            format!("fleetd-vault/item/1|{id}|env|order:devbox/p1/W7|1")
        );
        assert_eq!(check_aad("k1"), "fleetd-vault/check/1|k1");
        assert_eq!(scope_key(VaultScope::Hub, None, None, None).unwrap(), "hub");
        assert_eq!(
            scope_key(VaultScope::Person, Some("p_abcdefgh"), None, None).unwrap(),
            "person:p_abcdefgh"
        );
        assert!(scope_key(VaultScope::Project, None, None, None).is_none());
    }

    #[test]
    fn a_site_matches_its_host_and_subdomains_but_never_a_shared_hosts_neighbours() {
        assert!(on_site("www.amazon.example", "amazon.example"));
        assert!(on_site("Amazon.Example", "amazon.example"));
        assert!(!on_site("amazon.example.evil.test", "amazon.example"));
        assert!(!on_site("evilamazon.example", "amazon.example"));
        assert!(!on_site("localhost", "localhost"));
        assert!(on_site("me.github.io", "me.github.io"));
        assert!(!on_site("x.me.github.io", "me.github.io"));
        assert!(!on_site("other.github.io", "github.io"));
    }

    #[test]
    fn ids_are_checked() {
        assert!(VaultItemId::new("V0123456789abcdef0123456789abcdef").is_ok());
        for bad in [
            "V0123",
            "v0123456789abcdef0123456789abcdef",
            "V0123456789ABCDEF0123456789ABCDEF",
        ] {
            assert!(VaultItemId::new(bad).is_err(), "{bad}");
        }
        assert!(VaultKeyId::new("k1").is_ok());
        assert!(VaultKeyId::new("k0").is_err());
        assert!(VaultItemName::new("Amazon").is_ok());
        assert!(VaultItemName::new("a\nb").is_err());
        assert!(VaultItemName::new("Ölberg Bank").is_ok());
        assert!(VaultItemName::new("!").is_err());
        assert!(CardLast4::new("424").is_err());
    }

    #[test]
    fn a_fill_names_an_item_or_a_reference() {
        let session = "B0123456789abcdef0123456789abcdef";
        let call: VaultFillCall = serde_json::from_value(json!({
            "sessionId": session, "item": "Amazon", "field": "password", "page": "https://www.amazon.example/ap/signin",
        }))
        .unwrap();
        assert_eq!(call.field, VaultFillField::Password);
        for bad in [
            json!({ "sessionId": session, "field": "password", "page": "https://a.example/" }),
            json!({ "sessionId": session, "item": "A", "ref": "op://v/i/password", "field": "password", "page": "https://a.example/" }),
        ] {
            assert!(
                serde_json::from_value::<VaultFillCall>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_fills_plain_json_carries_address_fields_at_the_top() {
        let plain = VaultFillPlain {
            address: AddressSecret {
                city: Some("Springfield".into()),
                postal_code: Some("00000".into()),
                ..Default::default()
            },
            sites: vec!["shop.example".into()],
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&plain).unwrap(),
            json!({ "city": "Springfield", "postalCode": "00000", "sites": ["shop.example"] })
        );
    }

    #[test]
    fn a_source_reads_as_pinned() {
        let imported: VaultSource = serde_json::from_value(
            json!({ "kind": "1password", "ref": "op://Personal/Visa", "importedMs": 1 }),
        )
        .unwrap();
        assert!(matches!(imported, VaultSource::OnePassword { .. }));
        assert_eq!(
            serde_json::to_value(VaultSource::Typed).unwrap(),
            json!({ "kind": "typed" })
        );
    }
}
