//! fleetd's own Google server (`fleetd google-mcp`, node/google/tools.rs; the hub gives it to a Navi with an account,
//! hub/google): its tool names, which of them read, and how each asking one reads on a card. A read, and a draft,
//! which sends nothing, run unasked; a send, a reply, an event change, an upload and a share ask, showing everyone it
//! reaches and everything that goes out.
use serde_json::Value;

use super::policy::{Draft, Rule, addresses, text_of};
use fleetd_contracts::integrations::ToolAction::{Send, Share, Write};

/// The tools that run unasked: node/google/tools.rs marks the same ones `readOnlyHint`.
pub const READS: &[&str] = &[
    "search_threads",
    "get_thread",
    "create_draft",
    "list_calendar_events",
    "get_calendar_event",
    "drive_search",
    "drive_read",
];

/// Whether an event write emails its guests: a new event emails the guests it names unless told not to; a change
/// emails only when told to.
fn emails_guests(tool: &str, input: &Value) -> bool {
    match tool {
        "create_calendar_event" => {
            !addresses(&input["attendees"]).is_empty()
                && input["notify_attendees"].as_bool() != Some(false)
        }
        _ => input["notify_attendees"].as_bool() == Some(true),
    }
}

pub fn rule(tool: &str, input: &Value) -> Option<Rule> {
    if READS.contains(&tool) {
        return Some(Rule::Read);
    }
    Some(Rule::Ask(match tool {
        "send_message" | "reply" => Send,
        "create_calendar_event" | "update_calendar_event" if emails_guests(tool, input) => Send,
        "create_calendar_event" | "update_calendar_event" | "drive_upload" => Write,
        "drive_share" => Share,
        // A tool added later, unknown here, asks as its name says.
        _ => return None,
    }))
}

/// `start` → `end` of an event: date-times or dates, as the tool takes them.
fn when(input: &Value) -> Option<String> {
    match (text_of(input, &["start"]), text_of(input, &["end"])) {
        (Some(s), Some(e)) => Some(format!("{s} → {e}")),
        (Some(s), None) => Some(s),
        (None, Some(e)) => Some(format!("until {e}")),
        (None, None) => None,
    }
}

fn titled(title: impl Into<String>) -> Draft {
    Draft {
        title: Some(title.into()),
        ..Draft::default()
    }
}

pub fn draft(tool: &str, input: &Value) -> Draft {
    let message = |d: Draft| Draft {
        to: addresses(&input["to"]),
        cc: addresses(&input["cc"]),
        bcc: addresses(&input["bcc"]),
        subject: text_of(input, &["subject"]),
        body: text_of(input, &["body"]),
        ..d
    };
    match tool {
        "send_message" => message(Draft {
            target: text_of(input, &["thread_id"]).map(|t| format!("In thread {t}")),
            ..titled("Send an email")
        }),
        "reply" => message(Draft {
            target: text_of(input, &["message_id"]).map(|m| format!("Reply to message {m}")),
            ..titled("Reply to an email")
        }),
        "create_calendar_event" | "update_calendar_event" => {
            let guests = addresses(&input["attendees"]);
            let removed = addresses(&input["removed_attendees"]);
            let emailed = emails_guests(tool, input);
            let audience = match (emailed, tool) {
                (true, "create_calendar_event") => {
                    Some("Google emails each guest an invitation".to_owned())
                }
                (true, _) if removed.is_empty() => {
                    Some("Google emails each guest about the change".to_owned())
                }
                (true, _) => Some(format!(
                    "Google emails each guest about the change, and a cancellation to the {} removed: {}",
                    removed.len(),
                    removed.join(", ")
                )),
                (false, _) if !guests.is_empty() => {
                    Some("Guests see it in their calendars; Google doesn't email them".to_owned())
                }
                (false, _) => None,
            };
            // Everyone Google emails is on the card: the guests, and those removed.
            let mut to = guests;
            if emailed {
                to.extend(removed);
            }
            Draft {
                to,
                audience,
                subject: text_of(input, &["summary"]),
                body: text_of(input, &["description"]),
                when: when(input),
                target: text_of(input, &["event_id"])
                    .map(|e| format!("Event {e}"))
                    .or_else(|| text_of(input, &["location"])),
                ..titled(if tool == "create_calendar_event" {
                    "Create a calendar event"
                } else {
                    "Change a calendar event"
                })
            }
        }
        "drive_upload" => {
            let name = text_of(input, &["name"]).unwrap_or_else(|| "a file".into());
            let bytes = input["content"].as_str().map_or(0, str::len);
            Draft {
                subject: Some(format!("{name} ({bytes} bytes)")),
                body: input["content"].as_str().map(str::to_owned),
                target: Some(match text_of(input, &["folder_id"]) {
                    Some(f) => format!("Folder {f}"),
                    None => "My Drive".to_owned(),
                }),
                ..titled(format!("Upload {name} to Drive"))
            }
        }
        "drive_share" => {
            let role = text_of(input, &["role"]).unwrap_or_else(|| "reader".into());
            let notify = input["notify"].as_bool() != Some(false);
            Draft {
                to: addresses(&input["emails"]),
                audience: Some(
                    if notify {
                        "Google emails each of them a link"
                    } else {
                        "Shared without an email"
                    }
                    .into(),
                ),
                body: notify.then(|| text_of(input, &["message"])).flatten(),
                target: text_of(input, &["file_id"]).map(|f| format!("File {f}")),
                ..titled(format!("Share a Drive file as {role}"))
            }
        }
        _ => Draft::default(),
    }
}
