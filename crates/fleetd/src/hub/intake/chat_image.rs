//! `chat_file`: a lead or task puts an image it made (a screenshot of a UI change), or any file the chat takes (a PDF,
//! a CSV, a document), in its project's chat, and is told which block shows it. `chat_image`, its images-only
//! forerunner, comes only from older nodes now. The hub asks the caller's own node for the file,
//! which reads it only from that session's working directory, as the node started it, and only a png, jpeg, webp or
//! gif by its bytes, or for `chat_file` a file whose bytes fit the type its name says
//! ([`crate::node::sessions::files::read_image`]). It is stored as an attachment `by` the project's lead
//! (`lead:<project>`), so no person's key reads it and no other project shows it: a lead message's `image` or `file`
//! block of it marks it the project's ([`super::attachments::show`]), and one never shown goes with the other unused
//! uploads after 24 h.
use std::sync::{Arc, Weak};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::chat::ChatImageResult;
use fleetd_contracts::ids::ThreadRef;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ATTACHMENT_MAX_BYTES, AttachmentMime, ErrorCode, McpToolError};
use fleetd_contracts::prim::Count;

use crate::hub::api::{Hub, ToolError};
use crate::hub::executor::ExecutorError;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::{CallerAgent, LeadCallFuture, op_of};

pub const OPS: [&str; 2] = ["chat_image", "chat_file"];

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                match call {
                    LeadCall::ChatImage(call) => {
                        chat_image(&hub, &caller, call.path.as_str(), false)
                            .await
                            .map(LeadCallResult::ChatImage)
                    }
                    LeadCall::ChatFile(call) => chat_image(&hub, &caller, call.path.as_str(), true)
                        .await
                        .map(LeadCallResult::ChatFile),
                    other => Err(McpToolError::new(
                        ErrorCode::Invalid,
                        format!("{} is not a chat image call.", op_of(&other)),
                    )),
                }
            })
        },
    );
    for op in OPS {
        hub.lead_calls.register(op, handler.clone());
    }
}

/// The session the caller runs in, by the hub's own records: its working directory is the only place its image is
/// read from.
fn session_of(hub: &Hub, caller: &LeadCaller) -> Result<ThreadRef, ToolError> {
    let thread = match &caller.agent {
        CallerAgent::Lead => crate::hub::chat::flow::lead_thread(hub, &caller.project_ref),
        CallerAgent::Task(task) => hub.tasks.get(task)?.and_then(|t| t.thread_ref),
        _ => {
            return Err(ToolError::new(
                ErrorCode::Forbidden,
                "Only a lead or a task's agent puts an image or file in the chat.",
            ));
        }
    };
    thread.ok_or_else(|| {
        ToolError::new(
            ErrorCode::NotFound,
            "The hub knows no session of yours to read the file from.",
        )
        .with_fix("Call chat_file from your own session.")
    })
}

fn refused(error: ExecutorError, file: bool) -> ToolError {
    match error {
        ExecutorError::NodeRequestFailed { message, .. } => {
            ToolError::new(ErrorCode::Invalid, message).with_fix(if file {
                "Save the file (image, PDF, text or CSV, .docx, .xlsx, .pptx or zip) inside your working directory \
                 and pass its path."
            } else {
                "Save the image (png, jpeg, webp or gif) inside your working directory and pass its path."
            })
        }
        e => crate::hub::executor::tools::from_executor(e),
    }
}

fn changed(path: &str) -> ToolError {
    ToolError::new(
        ErrorCode::Failed,
        format!("{path} changed while it was read."),
    )
    .with_fix("Call it again once the file is written.")
}

async fn chat_image(
    hub: &Hub,
    caller: &LeadCaller,
    path: &str,
    file: bool,
) -> Result<ChatImageResult, ToolError> {
    let thread = session_of(hub, caller)?;
    let mut data: Vec<u8> = Vec::new();
    let (name, mime) = loop {
        let (name, mime, total, piece) = hub
            .executors
            .read_image(&thread, path, data.len(), file)
            .await
            .map_err(|e| refused(e, file))?;
        let piece = B64.decode(piece.as_bytes()).map_err(|_| changed(path))?;
        if total > ATTACHMENT_MAX_BYTES as u64 || (piece.is_empty() && (data.len() as u64) < total)
        {
            return Err(changed(path));
        }
        data.extend_from_slice(&piece);
        if data.len() as u64 >= total {
            if data.len() as u64 != total {
                return Err(changed(path));
            }
            break (name, mime);
        }
    };
    // The node checked the bytes; the hub checks what it holds again.
    let fits = if file {
        mime.fits(&data)
    } else {
        AttachmentMime::of_image(&data) == Some(mime)
    };
    if !fits {
        return Err(changed(path));
    }
    let name = super::attachments::safe_name(&name);
    let (attachment_id, len, _) =
        super::attachments::store(hub, data, &name, mime, &caller.by).await?;
    // An image shows inline in an image block, anything else as a file card.
    let kind = if mime.is_image() { "image" } else { "file" };
    let next = match caller.agent {
        CallerAgent::Task(_) => format!(
            "Put {attachment_id} in your result for your lead to show in {a} {kind} block. Unshown, it is deleted after 24 h.",
            a = if mime.is_image() { "an" } else { "a" }
        ),
        _ => format!(
            "Show it in your chat message with a fleetd-block {{\"v\":1,\"kind\":\"{kind}\",\"attachmentId\":\"{attachment_id}\",\"caption\":\"…\"}}. Unshown, it is deleted after 24 h."
        ),
    };
    Ok(ChatImageResult {
        attachment_id,
        mime,
        bytes: Count::unchecked(len as i64),
        next: Some(next),
    })
}

#[cfg(test)]
#[path = "chat_image_tests.rs"]
mod tests;
