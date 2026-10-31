//! A Navi's Telegram bridge (W237, decision navi.telegram): the person makes a bot with @BotFather, pastes its token
//! in the Navi's settings (sealed in the app to the Navi's machine; the hub keeps its fingerprint only), tests it, and
//! pairs their own Telegram account with one tap on `t.me/<bot>?start=<code>`. The Navi's node long-polls the Bot API
//! (no public URL, no webhook) and answers only the paired account: messages land in the Navi's chat, its replies and
//! approval cards go back.
//!
//! The node keeps the token, the paired account, its read offset and a short journal of what came in; the hub takes
//! the journal from it (`take`, a long call) and sends through it (`send`). The tools' types are the bridge as the app
//! shows it: never the token.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::Timestamp;
use crate::prim::{AnyInt, Line, Text};
use crate::secrets::{SealedSecret, SecretFingerprint};

/// The most of one file Telegram lets a bot download (`getFile`).
pub const TELEGRAM_FILE_MAX: usize = 20 * 1024 * 1024;
/// The most of one file the hub sends out through the node: a photo's cap on Telegram, and its base64 fits a frame.
pub const TELEGRAM_SEND_MAX: usize = 10 * 1024 * 1024;
/// The most of an incoming file one `file` reply carries, decoded.
pub const TELEGRAM_PIECE_BYTES: usize = 8 * 1024 * 1024;
/// How long a `take` waits on the node for something new.
pub const TELEGRAM_TAKE_WAIT_SECS: i64 = 25;
/// How long a pairing link works.
pub const TELEGRAM_PAIR_SECS: i64 = 15 * 60;

/// The bot, as Telegram's getMe and its profile photo describe it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelegramBot {
    pub id: AnyInt,
    /// Without the @.
    pub username: Line<1, 64>,
    pub name: Line<1, 128>,
    /// Its profile photo, small, as a `data:image/jpeg;base64,` URL; absent when it has none.
    pub photo: Option<Text<0, 65536>>,
}

/// The Telegram account the Navi answers.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelegramPerson {
    pub user_id: AnyInt,
    /// Their first and last name on Telegram.
    pub name: Line<1, 128>,
    /// Without the @; absent when they have none.
    pub username: Option<Line<1, 64>>,
    pub paired_at: Timestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum TelegramState {
    /// Asking Telegram for the first time since the node started or the token changed.
    Connecting,
    /// Reading Telegram: messages come in as they are sent.
    Connected,
    /// The person paused it: nothing is read or sent until they resume.
    Paused,
    /// Telegram failed or asked it to slow down: it tries again at `retryAt`.
    Retrying,
    /// It can't go on until a person acts: the token was revoked, or another program reads this bot.
    Stopped,
}

/// How the node's bridge stands now.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelegramStatus {
    pub state: TelegramState,
    pub since: Timestamp,
    /// The last thing that went wrong, in plain words with the token masked.
    pub error: Option<Text<0, 500>>,
    pub error_at: Option<Timestamp>,
    pub retry_at: Option<Timestamp>,
}

/// A Navi's bridge as the node holds it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelegramNode {
    pub fingerprint: Option<SecretFingerprint>,
    pub bot: Option<TelegramBot>,
    pub paired: Option<TelegramPerson>,
    /// A pairing link waits for its Start.
    #[serde(default)]
    pub pairing: bool,
    #[serde(default)]
    pub paused: bool,
    pub status: TelegramStatus,
}

/// A Navi's bridge as the tools show it: never the token.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelegramBridge {
    /// The token the Navi's node holds, by fingerprint.
    pub fingerprint: SecretFingerprint,
    pub saved_at: Timestamp,
    pub bot: Option<TelegramBot>,
    /// Absent until the person pairs their account.
    pub paired: Option<TelegramPerson>,
    #[serde(default)]
    pub pairing: bool,
    #[serde(default)]
    pub paused: bool,
    /// Absent until the node has said how it stands.
    pub status: Option<TelegramStatus>,
    /// The node is offline: what the bridge shows is what it last said, and nothing goes through it now.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub offline: bool,
}

/// Hub -> node, for one Navi's bridge.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum TelegramCall {
    /// Save (`sealed`) or forget (none) the bot token, opened with the node's box key. A new token starts afresh:
    /// no paired account, no offset.
    Token {
        sealed: Option<SealedSecret>,
    },
    /// getMe and the bot's photo.
    Test,
    /// From now until `TELEGRAM_PAIR_SECS` pass, a Start with this code from any account makes it the paired one.
    Pair {
        code: Line<8, 64>,
    },
    Unpair,
    Pause {
        paused: bool,
    },
    /// How it stands.
    State,
    /// What came in after `after` (a journal seq), waiting up to `waitSecs` for something when nothing has.
    #[serde(rename_all = "camelCase")]
    Take {
        after: i64,
        wait_secs: i64,
    },
    /// Send to the paired account.
    Send {
        send: TelegramSend,
    },
    /// A piece of a file that came in, from `offset`; the last piece read deletes it.
    File {
        key: Line<1, 120>,
        offset: u64,
    },
}

/// Something to send to the paired account. Text is Telegram HTML, already escaped, at most 4096 characters.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TelegramSend {
    Text {
        html: String,
        /// Inline buttons, in rows.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        buttons: Vec<Vec<TelegramButton>>,
    },
    /// Replace a message's text, and its buttons (none: they go).
    #[serde(rename_all = "camelCase")]
    Edit {
        message_id: i64,
        html: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        buttons: Vec<Vec<TelegramButton>>,
    },
    /// A file: as a photo when `photo`, else as a document.
    #[serde(rename_all = "camelCase")]
    File {
        name: String,
        mime: String,
        data_b64: String,
        caption_html: Option<String>,
        #[serde(default)]
        photo: bool,
    },
    /// "typing…" for the next few seconds.
    Typing,
    /// Answer a button press, with a short toast.
    #[serde(rename_all = "camelCase")]
    Answer {
        callback_id: String,
        text: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TelegramButton {
    pub text: String,
    /// At most 64 bytes, as Telegram takes it.
    pub data: String,
}

/// Node -> hub: the answer to a [`TelegramCall`].
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "is", rename_all = "snake_case")]
pub enum TelegramAnswer {
    Saved {
        fingerprint: Option<SecretFingerprint>,
    },
    Tested {
        bot: Option<TelegramBot>,
        /// Telegram's words, the token masked.
        error: Option<String>,
    },
    State {
        state: TelegramNode,
    },
    Taken {
        events: Vec<TelegramEvent>,
        state: TelegramNode,
    },
    #[serde(rename_all = "camelCase")]
    Sent {
        message_ids: Vec<i64>,
    },
    #[serde(rename_all = "camelCase")]
    Piece {
        bytes: u64,
        data_b64: String,
    },
}

/// One thing that came in from the paired account, in the node's journal. Anything from anyone else never gets this
/// far: the node drops it without a word.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelegramEvent {
    pub seq: i64,
    pub at: Timestamp,
    pub event: TelegramEventKind,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TelegramEventKind {
    /// A message: its text or caption, and the files it carried, kept on the node until the hub reads them.
    #[serde(rename_all = "camelCase")]
    Message {
        message_id: i64,
        text: String,
        /// Forwarded from someone: who, as Telegram names them. Their words, not the person's.
        forwarded_from: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        files: Vec<TelegramFile>,
    },
    /// A press on one of the bot's inline buttons.
    #[serde(rename_all = "camelCase")]
    Button {
        callback_id: String,
        data: String,
        message_id: i64,
    },
    /// The person pressed Start on a pairing link.
    Paired { person: TelegramPerson },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelegramFile {
    /// What `file` reads it by.
    pub key: Line<1, 120>,
    pub name: String,
    pub mime: crate::mcp::AttachmentMime,
    pub bytes: u64,
}
