//! What becomes of one update: the gate (only the paired account's private chat, or a Start with a live pairing
//! code), then its text, who a forward came from, and its photo or document fetched into the bridge's files.
use std::path::Path;

use fleetd_contracts::ids::ProjectId;
use fleetd_contracts::mcp::AttachmentMime;
use fleetd_contracts::prim::{AnyInt, Line};
use fleetd_contracts::telegram::{
    TELEGRAM_FILE_MAX, TelegramEvent, TelegramEventKind, TelegramFile, TelegramPerson,
};
use serde_json::Value;

use super::api::Api;
use super::store::{self, State};

pub const PAIRED: &str =
    "Paired. Messages you send here now reach your Navi, and its replies come back here.";
pub const VOICE: &str =
    "Voice notes aren't supported yet. Type your message, or send a photo or a file.";
pub const UNSUPPORTED: &str =
    "Your Navi reads text, photos and files here. This kind of message isn't supported yet.";

/// A message from the paired account, before its file is fetched.
pub struct Incoming {
    pub message_id: i64,
    pub text: String,
    pub forwarded_from: Option<String>,
    /// Telegram's file id, its name, the type Telegram gave and its size when known.
    pub file: Option<(String, String, Option<String>, Option<u64>)>,
}

pub enum Decision {
    /// Not the paired account, or nothing to do: no word back.
    Drop,
    /// A line back to the paired account, and nothing else.
    Reply(&'static str),
    Pair(TelegramPerson),
    Button(TelegramEventKind),
    Message(Incoming),
}

fn name_of(user: &Value) -> Option<String> {
    let first = user["first_name"].as_str().unwrap_or_default();
    let last = user["last_name"].as_str().unwrap_or_default();
    let name = format!("{first} {last}").trim().to_owned();
    if !name.is_empty() {
        return Some(name);
    }
    user["username"].as_str().map(|u| format!("@{u}"))
}

/// Who a forwarded message came from, as Telegram names them: `forward_origin` (Bot API 7), else the older fields.
fn forwarded(message: &Value) -> Option<String> {
    let origin = &message["forward_origin"];
    if origin.is_object() {
        let named = match origin["type"].as_str() {
            Some("user") => name_of(&origin["sender_user"]),
            Some("hidden_user") => origin["sender_user_name"].as_str().map(str::to_owned),
            Some("chat") => origin["sender_chat"]["title"].as_str().map(str::to_owned),
            Some("channel") => origin["chat"]["title"].as_str().map(str::to_owned),
            _ => None,
        };
        return Some(named.unwrap_or_else(|| "someone".to_owned()));
    }
    if message["forward_from"].is_object() {
        return Some(name_of(&message["forward_from"]).unwrap_or_else(|| "someone".into()));
    }
    message["forward_sender_name"]
        .as_str()
        .or_else(|| message["forward_from_chat"]["title"].as_str())
        .map(str::to_owned)
        .or_else(|| {
            message["forward_date"]
                .is_number()
                .then(|| "someone".into())
        })
}

fn person(user: &Value, now_ms: i64) -> Option<TelegramPerson> {
    let id = user["id"].as_i64()?;
    let name = name_of(user).unwrap_or_else(|| format!("user {id}"));
    Some(TelegramPerson {
        user_id: AnyInt::new(id).ok()?,
        name: Line::new(name.chars().take(128).collect::<String>()).ok()?,
        username: user["username"]
            .as_str()
            .and_then(|u| Line::new(u.chars().take(64).collect::<String>()).ok()),
        paired_at: super::iso(now_ms),
    })
}

/// The gate, and what an update from the paired account is.
pub fn decide(state: &State, update: &Value, now_ms: i64) -> Decision {
    let paired = state.paired.as_ref().map(|p| p.user_id.get());
    if let Some(press) = update.get("callback_query") {
        if press["from"]["id"].as_i64().is_none() || press["from"]["id"].as_i64() != paired {
            return Decision::Drop;
        }
        let (Some(id), Some(data)) = (press["id"].as_str(), press["data"].as_str()) else {
            return Decision::Drop;
        };
        return Decision::Button(TelegramEventKind::Button {
            callback_id: id.to_owned(),
            data: data.to_owned(),
            message_id: press["message"]["message_id"].as_i64().unwrap_or_default(),
        });
    }
    let Some(message) = update.get("message") else {
        return Decision::Drop;
    };
    // Only a private chat with the bot: a group it was added to is anyone's.
    if message["chat"]["type"].as_str() != Some("private") {
        return Decision::Drop;
    }
    let from = &message["from"];
    let text = message["text"]
        .as_str()
        .or_else(|| message["caption"].as_str())
        .unwrap_or_default();
    if let Some(code) = text.strip_prefix("/start ").map(str::trim)
        && let Some(pairing) = &state.pairing
        && pairing.expires_ms > now_ms
        && !code.is_empty()
        && super::sha256_hex(code) == pairing.code_sha256
        && let Some(person) = person(from, now_ms)
    {
        return Decision::Pair(person);
    }
    if from["id"].as_i64().is_none() || from["id"].as_i64() != paired {
        return Decision::Drop;
    }
    // Start again, or a stale link: nothing for the Navi.
    if text == "/start" || text.starts_with("/start ") {
        return Decision::Drop;
    }
    if message.get("voice").is_some()
        || message.get("audio").is_some()
        || message.get("video_note").is_some()
    {
        return Decision::Reply(VOICE);
    }
    let file = if let Some(sizes) = message["photo"].as_array() {
        // Sizes come smallest first: the largest Telegram lets a bot download.
        sizes
            .iter()
            .rev()
            .find(|s| {
                s["file_size"]
                    .as_u64()
                    .is_none_or(|n| n <= TELEGRAM_FILE_MAX as u64)
            })
            .or(sizes.last())
            .and_then(|s| {
                Some((
                    s["file_id"].as_str()?.to_owned(),
                    format!(
                        "photo-{}.jpg",
                        message["message_id"].as_i64().unwrap_or_default()
                    ),
                    Some("image/jpeg".to_owned()),
                    s["file_size"].as_u64(),
                ))
            })
    } else if let Some(doc) = message.get("document") {
        doc["file_id"].as_str().map(|id| {
            (
                id.to_owned(),
                doc["file_name"].as_str().unwrap_or("file").to_owned(),
                doc["mime_type"].as_str().map(str::to_owned),
                doc["file_size"].as_u64(),
            )
        })
    } else {
        None
    };
    if text.trim().is_empty() && file.is_none() {
        return Decision::Reply(UNSUPPORTED);
    }
    Decision::Message(Incoming {
        message_id: message["message_id"].as_i64().unwrap_or_default(),
        text: text.to_owned(),
        forwarded_from: forwarded(message),
        file,
    })
}

/// A file's type as fleetd keeps attachments: an image by its bytes, a PDF, or UTF-8 text.
fn kind_of(bytes: &[u8], name: &str, mime: Option<&str>) -> Option<AttachmentMime> {
    if let Some(image) = AttachmentMime::of_image(bytes) {
        return Some(image);
    }
    if bytes.starts_with(b"%PDF") {
        return Some(AttachmentMime::Pdf);
    }
    let lower = name.to_ascii_lowercase();
    let texty = mime.is_some_and(|m| m.starts_with("text/") || m == "application/json")
        || [".txt", ".md", ".csv", ".json", ".log"]
            .iter()
            .any(|e| lower.ends_with(e));
    (texty && std::str::from_utf8(bytes).is_ok()).then_some(AttachmentMime::Text)
}

/// The message's event, with its file fetched into the bridge's files; a line back when the file couldn't come.
pub async fn fetch(
    home: &Path,
    project: &ProjectId,
    api: &Api,
    update_id: i64,
    incoming: Incoming,
) -> (Option<TelegramEventKind>, Option<&'static str>) {
    let mut files = Vec::new();
    let mut said = None;
    if let Some((file_id, name, mime, size)) = incoming.file {
        if size.is_some_and(|n| n > TELEGRAM_FILE_MAX as u64) {
            said = Some(
                "That file is over 20 MB, more than Telegram lets a bot download. Send a smaller one.",
            );
        } else {
            match api.file(&file_id, TELEGRAM_FILE_MAX).await {
                Ok(bytes) => match kind_of(&bytes, &name, mime.as_deref()) {
                    Some(kind) => {
                        let key = format!("u{update_id}-0");
                        let saved = store::file_path(home, project, &key).and_then(|path| {
                            let dir = path.parent()?;
                            crate::node::config::mkdir_private(dir).ok()?;
                            crate::node::secrets::write_atomic(&path, &bytes).ok()
                        });
                        if saved.is_some() {
                            files.push(TelegramFile {
                                key: Line::unchecked(key),
                                name: name.chars().take(120).collect(),
                                mime: kind,
                                bytes: bytes.len() as u64,
                            });
                        } else {
                            said = Some(
                                "That file couldn't be kept on your Navi's machine. Try it again.",
                            );
                        }
                    }
                    None => {
                        said = Some(
                            "Your Navi takes photos, images, PDFs and text files. That file wasn't passed on.",
                        );
                    }
                },
                Err(e) => {
                    tracing::warn!(%project, "telegram: a file didn't come: {}", e.words());
                    said = Some("That file didn't come through from Telegram. Send it again.");
                }
            }
        }
    }
    if incoming.text.trim().is_empty() && files.is_empty() {
        return (None, said);
    }
    (
        Some(TelegramEventKind::Message {
            message_id: incoming.message_id,
            text: incoming.text,
            forwarded_from: incoming.forwarded_from,
            files,
        }),
        said,
    )
}

/// Deletes an event's files, once the hub has them or the journal let them go.
pub fn remove_files(home: &Path, project: &ProjectId, event: &TelegramEvent) {
    if let TelegramEventKind::Message { files, .. } = &event.event {
        for f in files {
            if let Some(path) = store::file_path(home, project, f.key.as_str()) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// Telegram HTML as plain text: the tags dropped, the entities read back.
pub fn plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}
