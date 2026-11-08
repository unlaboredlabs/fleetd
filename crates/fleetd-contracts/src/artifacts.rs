//! Artifacts (W367, D292): reports a lead, task or Navi publishes for the person, too long for a chat bubble: a
//! Markdown or HTML document under a name, in its project's chat. Publishing a name again keeps a new version, the
//! older ones kept. The app lists them in the chat's Artifacts tab, Markdown rendered in its own style and HTML in a
//! sandboxed frame with scripts and no network. Any chat text links to one as `[Title](artifact:<name>)`, or to one
//! version as `artifact:<name>@<version>`: the app opens it in the tab.

use std::sync::LazyLock;

use regex::Regex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::Timestamp;
use crate::prim::{Count, Line, Positive, Text};

/// One artifact's content, in UTF-16 units: room for a report with its chart's script inlined.
pub const ARTIFACT_TEXT_CAP: usize = 2_000_000;
/// The versions the hub keeps of one artifact, newest first; an older one is dropped as a new one is kept.
pub const ARTIFACT_VERSIONS_KEPT: usize = 50;
/// The artifacts one list returns, newest first.
pub const ARTIFACTS_LISTED: usize = 500;
/// The files one list returns, newest first.
pub const CHAT_FILES_LISTED: usize = 200;
/// What `artifact_read` returns of one artifact's content, in UTF-16 units; a longer one is cut with a note saying so.
pub const ARTIFACT_READ_CAP: usize = 64 * 1024;
/// A link's scheme: `[Title](artifact:<name>)`.
pub const ARTIFACT_SCHEME: &str = "artifact:";

static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9]+(-[a-z0-9]+)*$").unwrap());

crate::brand!(
    /// An artifact's name in its project, which links name it by: lowercase letters, digits and single hyphens, at
    /// most 64 characters.
    ArtifactName,
    name = "ArtifactName",
    check = |s| s.len() <= 64 && NAME.is_match(s),
    expected = "lowercase letters, digits and single hyphens, at most 64 characters",
    pattern = r"^[a-z0-9]+(-[a-z0-9]+)*$",
    description = "Lowercase letters, digits and single hyphens, at most 64 characters"
);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ArtifactFormat {
    /// Markdown, rendered in the app's own style.
    Md,
    /// A whole HTML page, rendered sandboxed: its scripts run, with no network and no reach into the app.
    Html,
}

impl ArtifactFormat {
    /// The format a file's extension names: `.html` and `.htm` are HTML, anything else Markdown.
    pub fn of_path(path: &str) -> Self {
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".html") || lower.ends_with(".htm") {
            Self::Html
        } else {
            Self::Md
        }
    }
}

/// `artifact_publish`: a lead, task or Navi publishes a report in its project's chat. With `path`, the agent's own
/// fleetd tool reads the file and sends it as `content`; the hub takes `content` only.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPublishCall {
    /// Its name in the project, which links use: `sweep-report`. The same name again keeps a new version.
    pub name: ArtifactName,
    /// What the person reads in the chat and the tab: `Dependency sweep, November`.
    pub title: Line<1, 120>,
    /// `md` or `html`; absent, `html` for a `.html` or `.htm` path, else `md`.
    pub format: Option<ArtifactFormat>,
    /// The whole document. Give this or `path`.
    pub content: Option<Text<1, ARTIFACT_TEXT_CAP>>,
    /// A file to publish instead of `content`: relative to your working directory, or absolute.
    pub path: Option<Line<1, 1000>>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPublishResult {
    pub name: ArtifactName,
    pub version: Positive,
    pub next: Option<String>,
}

/// `artifact_read`: a lead, task or Navi reads back an artifact published in its own project (its own or another
/// agent's), the same ones `artifact_publish` writes to.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReadCall {
    /// Its name in the project: `sweep-report`, as in a link `artifact:sweep-report`.
    pub name: ArtifactName,
    /// One version (`artifact:sweep-report@2`); absent, the newest.
    pub version: Option<Positive>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReadResult {
    pub name: ArtifactName,
    pub artifact: ArtifactVersion,
    /// Its Markdown or HTML source as published, at most [`ARTIFACT_READ_CAP`] units: a longer one ends in a line
    /// saying where it was cut.
    pub content: Text<0, { ARTIFACT_READ_CAP + 200 }>,
    /// The content was cut.
    pub truncated: Option<bool>,
    /// Every kept version's number, newest first.
    pub versions: Vec<Positive>,
    pub next: Option<String>,
}

/// One kept version of an artifact, without its content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersion {
    /// 1 for its first, one more for each publish after.
    pub version: Positive,
    pub title: Line<1, 120>,
    pub format: ArtifactFormat,
    /// Who published it: the lead, a task's title, or a Navi's name.
    pub by: Line<1, 200>,
    pub at: Timestamp,
    /// Its content's size in bytes.
    pub bytes: Count,
}

/// One artifact as the tab lists it: its name and its newest version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSummary {
    pub name: ArtifactName,
    pub newest: ArtifactVersion,
}

/// A file sent in the chat, as the Artifacts tab lists it beside the artifacts: one a person attached, or one its lead
/// or agents showed (`chat_image`, `chat_file`). Its bytes come from `attachment_get`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatFile {
    pub attachment_id: crate::mcp::AttachmentId,
    pub name: Line<1, 120>,
    pub mime: crate::mcp::AttachmentMime,
    pub bytes: Count,
    /// When it was uploaded.
    pub at: Timestamp,
}

/// A chat line's artifact: one was published (`artifact_publish`). The app shows it as a card that opens it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPublished {
    pub name: ArtifactName,
    pub version: Positive,
    pub title: Line<1, 120>,
    pub format: ArtifactFormat,
    pub by: Line<1, 200>,
}

/// An artifact link's target: `artifact:<name>`, the newest version, or `artifact:<name>@<version>`.
pub fn link_target(href: &str) -> Option<(ArtifactName, Option<i64>)> {
    let rest = href.strip_prefix(ARTIFACT_SCHEME)?;
    let (name, version) = match rest.split_once('@') {
        Some((name, v)) => (name, Some(v.parse::<i64>().ok().filter(|v| *v > 0)?)),
        None => (rest, None),
    };
    Some((ArtifactName::new(name).ok()?, version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_link_names_an_artifact_and_maybe_its_version() {
        let (name, version) = link_target("artifact:sweep-report").unwrap();
        assert_eq!((name.as_str(), version), ("sweep-report", None));
        let (name, version) = link_target("artifact:sweep-report@3").unwrap();
        assert_eq!((name.as_str(), version), ("sweep-report", Some(3)));
        for bad in [
            "artifact:",
            "artifact:Sweep",
            "artifact:a@0",
            "artifact:a@x",
            "https://x.dev",
            "artifact:a b",
        ] {
            assert!(link_target(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_publish_takes_a_name_title_and_content_or_a_path() {
        let call: ArtifactPublishCall = serde_json::from_value(json!({
            "name": "sweep-report", "title": "Sweep", "path": "out/sweep.html"
        }))
        .unwrap();
        assert_eq!(call.content, None);
        assert!(
            serde_json::from_value::<ArtifactPublishCall>(
                json!({ "name": "Sweep", "title": "S", "content": "x" })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<ArtifactPublishCall>(
                json!({ "name": "s", "title": "", "content": "x" })
            )
            .is_err()
        );
        assert_eq!(
            ArtifactFormat::of_path("out/Sweep.HTML"),
            ArtifactFormat::Html
        );
        assert_eq!(ArtifactFormat::of_path("out/sweep.md"), ArtifactFormat::Md);
    }
}
