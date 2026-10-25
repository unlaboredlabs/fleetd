//! Lead memory: plain markdown files in the hub home, never in a repo. `user.md` is how the human works everywhere;
//! each project has its `MEMORY.md` (a short always-on part and one index line per topic) and topic files. The lead
//! writes through `remember`, the human edits in the app; leads and writers get `user.md` and their own project's
//! `MEMORY.md` at session start.

use std::sync::LazyLock;

use regex::Regex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::chat::ChatMessageId;
use crate::checked;
use crate::ids::{ProjectRef, Timestamp};
use crate::prim::{Count, Line, List, Text};

pub const USER_CAP: usize = 4_000;
pub const INDEX_CAP: usize = 4_000;
pub const TOPIC_CAP: usize = 8_000;
pub const PROJECT_CAP: usize = 32_000;

static TOPIC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,47}$").unwrap());

crate::brand!(
    /// A topic file's name without `.md`: a lowercase slug such as "deploys". "memory" is the index itself.
    MemoryTopic,
    name = "MemoryTopic",
    check = |s| s != "memory" && TOPIC.is_match(s),
    expected = "a lowercase slug, [a-z0-9][a-z0-9-]{0,47}, other than memory",
    pattern = r"^[a-z0-9][a-z0-9-]{0,47}$",
    description = "Lowercase slug, [a-z0-9][a-z0-9-]{0,47}, other than memory"
);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    /// `user.md`: how the human works across every project.
    User,
    /// This project's `MEMORY.md`, or one of its topic files.
    Project,
}

/// One remembered line: at most 1,000 characters, no line breaks.
pub type MemoryEntry = Line<1, 1000>;

/// `remember`: one entry, appended, or put in place of the entry that contains `replaces`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct RememberCall {
    pub scope: MemoryScope,
    /// Project scope only: the topic file; absent, `MEMORY.md`.
    pub topic: Option<MemoryTopic>,
    pub text: MemoryEntry,
    /// Words of the entry this one replaces, quoted exactly; it must match one entry of the file.
    pub replaces: Option<MemoryEntry>,
}
checked!(RememberCall, |call| {
    if call.scope == MemoryScope::User && call.topic.is_some() {
        return Err("user.md has no topics; leave topic out with scope user".into());
    }
    Ok(())
});

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RememberResult {
    /// `user.md`, `MEMORY.md` or `<topic>.md`.
    pub file: Line<1, 60>,
    /// The file's length now, and its cap.
    pub chars: Count,
    pub cap: Count,
    pub next: Option<String>,
}

/// `memory_read`: one of this project's topic files.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MemoryReadCall {
    pub topic: MemoryTopic,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MemoryReadResult {
    pub topic: MemoryTopic,
    pub text: Text<0, TOPIC_CAP>,
    pub next: Option<String>,
}

/// What a `remember` call wrote, as a line in the project's chat. Undone with `memory_undo`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RememberedItem {
    pub scope: MemoryScope,
    pub topic: Option<MemoryTopic>,
    pub text: MemoryEntry,
    /// The whole entry it replaced, which Undo puts back.
    pub replaced: Option<MemoryEntry>,
    pub undone: Option<bool>,
}

/// An entry `remember` wrote that is still in its file: when, and the chat line that said so.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryNote {
    pub text: MemoryEntry,
    pub at: Timestamp,
    pub project_ref: ProjectRef,
    pub message_id: ChatMessageId,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    pub scope: MemoryScope,
    /// A project's topic file; absent for `user.md` and `MEMORY.md`.
    pub topic: Option<MemoryTopic>,
    pub text: Text<0, TOPIC_CAP>,
    pub chars: Count,
    pub cap: Count,
    pub updated_at: Option<Timestamp>,
    /// Newest first.
    pub notes: List<MemoryNote, 0, 200>,
}
