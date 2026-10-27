//! Google: the Gmail, Calendar and Drive tools of a server marked `integration: google`, by their names, which of them
//! read, and how each asking one reads on a card. The rule shapes here (names, and the input fields each card reads)
//! are what fleetd's own Google tools are read by; a tool it doesn't know asks, as its name says.
//!
//! Gmail and Calendar tools are named plainly (`search_threads`, `send_message`, `create_calendar_event`, …). Drive,
//! Docs, Sheets and Slides tools may come under a connection's prefix, `<connection>__<tool>`
//! (`workspace__drive_search`), and are read by the part after it.
use serde_json::Value;

use super::notion;
use super::policy::{Attachment, Draft, Rule, addresses, attachment_size, text_of};
use fleetd_contracts::integrations::ToolAction::{self, Delete, Send, Write};

/// The tools that only read: Gmail, Calendar, a call's status, and Drive, Docs, Sheets and Slides reads under their
/// default prefix.
pub const READS: &[&str] = &[
    "list_accounts",
    "list_labels",
    "search_threads",
    "get_thread",
    "get_message",
    "get_attachment",
    "list_attachments",
    "list_events",
    "wait_for_events",
    "ack_events",
    "get_send_status",
    "get_call_status",
    "search_tools",
    "list_calendars",
    "list_calendar_events",
    "get_calendar_event",
    "get_free_busy",
    "workspace__drive_search",
    "workspace__drive_list_folder",
    "workspace__drive_get",
    "workspace__drive_export",
    "workspace__docs_read",
    "workspace__docs_comments_list",
    "workspace__sheets_list_tabs",
    "workspace__sheets_read",
    "workspace__slides_read",
];

/// The tools that ask, and what each does.
const ASKS: &[(&str, ToolAction)] = &[
    ("send_message", Send),
    ("reply", Send),
    ("forward", Send),
    ("respond_to_invitation", Send),
    ("create_draft", Write),
    ("mark_read", Write),
    ("archive", Write),
    ("modify_labels", Write),
    ("trash", Delete),
    // Creating or changing an event with guests is a send: see [`rule`].
    ("create_calendar_event", Write),
    ("update_calendar_event", Write),
    ("delete_calendar_event", Delete),
];

/// The Drive, Docs, Sheets and Slides tools that remove something; their other writes change files the person can
/// restore.
const WORKSPACE_DELETES: &[&str] = &[
    "drive_trash",
    "docs_overwrite",
    "sheets_clear",
    "sheets_delete_tab",
    "slides_delete_slide",
];

/// An event write reaches its guests when it has any: a new event's are in its input; a changed one may have guests
/// already, whom Google emails unless told not to.
fn reaches_guests(tool: &str, input: &Value) -> bool {
    match tool {
        "create_calendar_event" => !addresses(&input["attendees"]).is_empty(),
        _ => input["notify_attendees"].as_bool() != Some(false),
    }
}

pub fn rule(tool: &str, input: &Value) -> Option<Rule> {
    if READS.contains(&tool) {
        return Some(Rule::Read);
    }
    if let Some((_, action)) = ASKS.iter().find(|(name, _)| *name == tool) {
        let send = matches!(tool, "create_calendar_event" | "update_calendar_event")
            && reaches_guests(tool, input);
        return Some(Rule::Ask(if send { Send } else { *action }));
    }
    // A tool under a connection's prefix: Drive, Docs, Sheets or Slides under any prefix, or Notion's hosted tools.
    let (_, inner) = tool.rsplit_once("__")?;
    if READS.contains(&format!("workspace__{inner}").as_str()) {
        return Some(Rule::Read);
    }
    if WORKSPACE_DELETES.contains(&inner) {
        return Some(Rule::Ask(Delete));
    }
    if ["drive_", "docs_", "sheets_", "slides_"]
        .iter()
        .any(|p| inner.starts_with(p))
    {
        // One the table doesn't list asks as what its name says: a share as a share.
        return Some(Rule::Ask(super::policy::guess(inner)));
    }
    notion::rule(inner, input)
}

fn titled(title: &str) -> Draft {
    Draft {
        title: Some(title.to_owned()),
        ..Draft::default()
    }
}

/// `start` → `end` of an event, each a date-time string or `{dateTime|date}`.
fn when(input: &Value) -> Option<String> {
    let at = |v: &Value| -> Option<String> {
        v.as_str()
            .map(str::to_owned)
            .or_else(|| text_of(v, &["dateTime", "date_time", "date"]))
    };
    let (start, end) = (at(&input["start"]), at(&input["end"]));
    match (start, end) {
        (Some(s), Some(e)) => Some(format!("{s} → {e}")),
        (Some(s), None) => Some(s),
        (None, Some(e)) => Some(format!("until {e}")),
        (None, None) => None,
    }
}

pub fn draft(tool: &str, input: &Value) -> Draft {
    let account = text_of(input, &["account"]);
    let message = text_of(input, &["message_id"]).map(|m| format!("Message {m}"));
    let thread = text_of(input, &["thread_id"]).map(|t| format!("Thread {t}"));
    let mut d = match tool {
        "send_message" | "create_draft" => Draft {
            title: Some(
                if tool == "send_message" {
                    "Send an email"
                } else {
                    "Save a draft in Gmail"
                }
                .into(),
            ),
            to: addresses(&input["to"]),
            cc: addresses(&input["cc"]),
            bcc: addresses(&input["bcc"]),
            subject: text_of(input, &["subject"]),
            body: text_of(input, &["body"]),
            target: thread,
            ..Draft::default()
        },
        "reply" => Draft {
            title: Some("Reply to an email".into()),
            audience: Some(
                if input["reply_all"].as_bool() == Some(true) {
                    "Everyone on that message: its sender, and its To and Cc in Cc"
                } else {
                    "That message's sender (its Reply-To when it has one)"
                }
                .into(),
            ),
            body: text_of(input, &["body"]),
            target: message,
            ..Draft::default()
        },
        "forward" => Draft {
            title: Some(
                if input["include_attachments"].as_bool() == Some(true) {
                    "Forward an email with its attachments"
                } else {
                    "Forward an email"
                }
                .into(),
            ),
            to: addresses(&input["to"]),
            body: text_of(input, &["body"]),
            target: message,
            ..Draft::default()
        },
        "trash" => Draft {
            target: thread.or(message),
            ..titled("Move email to the Trash")
        },
        "archive" => Draft {
            target: thread.or(message),
            ..titled("Archive email")
        },
        "mark_read" => Draft {
            target: thread.or(message),
            ..titled("Mark email as read")
        },
        "modify_labels" => {
            let list = |k: &str| -> String {
                input[k]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default()
            };
            let (add, remove) = (list("add"), list("remove"));
            let change = [("Add", add), ("Remove", remove)]
                .into_iter()
                .filter(|(_, l)| !l.is_empty())
                .map(|(what, l)| format!("{what}: {l}"))
                .collect::<Vec<_>>()
                .join("\n");
            Draft {
                target: thread.or(message),
                body: (!change.is_empty()).then_some(change),
                ..titled("Change Gmail labels")
            }
        }
        "create_calendar_event" | "update_calendar_event" => {
            let guests = addresses(&input["attendees"]);
            let quiet = input["notify_attendees"].as_bool() == Some(false);
            Draft {
                title: Some(
                    if tool == "create_calendar_event" {
                        "Create a calendar event"
                    } else {
                        "Change a calendar event"
                    }
                    .into(),
                ),
                audience: match (guests.is_empty(), quiet, tool) {
                    (false, true, _) => Some(
                        "Guests see it in their calendars; Google doesn't email them".to_owned(),
                    ),
                    (false, false, _) => Some("Google emails each guest".to_owned()),
                    (true, false, "update_calendar_event") => Some(
                        "Its guests, if it has any: Google emails them about the change".to_owned(),
                    ),
                    (true, _, _) => None,
                },
                to: guests,
                subject: text_of(input, &["summary"]),
                body: text_of(input, &["description"]),
                when: when(input),
                target: text_of(input, &["event_id"])
                    .map(|e| format!("Event {e}"))
                    .or_else(|| text_of(input, &["location"])),
                ..Draft::default()
            }
        }
        "delete_calendar_event" => Draft {
            audience: (input["notify_attendees"].as_bool() != Some(false))
                .then(|| "Google tells its guests it's cancelled".to_owned()),
            target: text_of(input, &["event_id"]).map(|e| format!("Event {e}")),
            ..titled("Delete a calendar event")
        },
        "respond_to_invitation" => Draft {
            subject: text_of(input, &["response", "status"]),
            body: text_of(input, &["comment", "note"]),
            audience: Some("The event's organizer".into()),
            target: text_of(input, &["event_id"]).map(|e| format!("Event {e}")),
            ..titled("Answer an invitation")
        },
        _ => workspace(tool, input),
    };
    if d.account.is_none() {
        d.account = account;
    }
    if d.attachments.is_empty() {
        d.attachments = attachments(&input["attachments"]);
    }
    d
}

/// The files a send, draft, reply or forward attaches, from each source: bytes in the call, a path, another message's
/// attachment, a Drive file. A path's file is shown by its name.
fn attachments(v: &Value) -> Vec<Attachment> {
    let Some(items) = v.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .map(|a| {
            let path = text_of(a, &["path"]);
            let base = path
                .as_deref()
                .and_then(|p| p.rsplit('/').next())
                .map(str::to_owned);
            let message = text_of(a, &["message_id"]);
            let drive = text_of(a, &["drive_file_id"]);
            let name = text_of(a, &["filename"])
                .or(base)
                .or_else(|| text_of(a, &["attachment_id"]).map(|id| format!("Attachment {id}")))
                .or_else(|| drive.as_ref().map(|id| format!("Drive file {id}")))
                .unwrap_or_else(|| "A file".to_owned());
            Attachment {
                name,
                bytes: a["content_base64"].as_str().map(attachment_size),
                from: if let Some(p) = &path {
                    Some(format!("from {p}"))
                } else if let Some(m) = message {
                    Some(format!("from message {m}"))
                } else {
                    drive.map(|_| "from Drive".to_owned())
                },
            }
        })
        .collect()
}

/// A Drive, Docs, Sheets or Slides tool's card: the file it acts on and what goes in.
fn workspace(tool: &str, input: &Value) -> Draft {
    let Some((_, inner)) = tool.rsplit_once("__") else {
        return Draft::default();
    };
    if !["drive_", "docs_", "sheets_", "slides_"]
        .iter()
        .any(|p| inner.starts_with(p))
    {
        return notion::draft(inner, input);
    }
    let target = text_of(
        input,
        &[
            "documentId",
            "spreadsheetId",
            "presentationId",
            "fileId",
            "folderId",
            "parentId",
        ],
    );
    let name = text_of(input, &["title", "name"]);
    let body = text_of(
        input,
        &["markdown", "text", "content", "replaceText", "comment"],
    )
    .or_else(|| {
        input
            .get("values")
            .or(input.get("rows"))
            .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
    });
    Draft {
        title: Some(format!(
            "Use Google Workspace's {}",
            inner.replace('_', " ")
        )),
        subject: name,
        body,
        target,
        ..Draft::default()
    }
}
