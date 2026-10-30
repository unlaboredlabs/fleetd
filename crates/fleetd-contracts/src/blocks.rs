//! Blocks: what the lead shows in its chat beyond text (a chart, a table, a diff, a live PR or agent card, a
//! checklist, an image or clip, an ask). The lead writes one as a fenced code block whose info string is
//! [`BLOCK_FENCE`] and whose body is one [`ChatBlock`] as JSON:
//!
//! ````text
//! ```fleetd-block
//! {"v":1,"kind":"pr","repo":"acme/shop","number":412}
//! ```
//! ````
//!
//! The hub checks each block when the message is final (this schema, [`BLOCK_JSON_MAX`], and no HTML, script or URL
//! in its strings) and puts what passed on the message's part as `block`, re-serialized from this type. A block that
//! fails, or has a kind this hub doesn't know, is a part without `block`: its text is the fence as written, which a
//! client shows as a small "couldn't show this" chip, never as its JSON, and the lead hears which block and why.
//! Every string here is plain text: a client never renders one as HTML or markdown.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::checked;
use crate::ids::ThreadRef;
use crate::mcp::AttachmentId;
use crate::prim::{Finite, Int, Line, List, Positive, Text};
use crate::tasks::TaskId;
use crate::train::GitHubRepo;

/// The info string of a block's code fence.
pub const BLOCK_FENCE: &str = "fleetd-block";
/// The block schema this hub speaks: every block's `v`.
pub const BLOCK_VERSION: i64 = 1;
/// The largest block, in bytes of its JSON as written.
pub const BLOCK_JSON_MAX: usize = 16_000;
/// The most blocks one message carries; past it, a block shows as its fence and its lead hears why.
pub const MESSAGE_BLOCKS_MAX: usize = 24;

/// One block: `v`, the block schema's version (`BLOCK_VERSION`), and its kind's fields. A kind or version a client
/// doesn't know shows as the part's text.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ChatBlock {
    pub v: Int<1, BLOCK_VERSION>,
    #[serde(flatten)]
    pub body: BlockBody,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlockBody {
    Chart(ChartBlock),
    Table(TableBlock),
    Diff(DiffBlock),
    Pr(PrBlock),
    Agent(AgentBlock),
    Checklist(ChecklistBlock),
    Image(AttachmentBlock),
    Clip(AttachmentBlock),
    Ask(AskBlock),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChartType {
    Line,
    Bar,
    Area,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartSeries {
    pub name: Line<1, 60>,
    /// One per `x` label, in order.
    pub values: List<Finite, 1, 200>,
}

/// A line, bar or area chart: `x` labels along the bottom, one value per label in each series.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct ChartBlock {
    pub chart: ChartType,
    pub title: Line<1, 120>,
    pub x: List<Line<0, 40>, 1, 200>,
    pub series: List<ChartSeries, 1, 8>,
    /// The values' unit, e.g. "min", "%", "PRs".
    pub unit: Option<Line<1, 20>>,
}
checked!(ChartBlock, |c| {
    if c.series.iter().any(|s| s.values.len() != c.x.len()) {
        return Err("each series has one value per x label".into());
    }
    Ok(())
});

/// Rows of plain-text cells, one per column.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct TableBlock {
    pub title: Option<Line<1, 120>>,
    pub columns: List<Line<1, 60>, 1, 12>,
    pub rows: List<List<Line<0, 200>, 1, 12>, 0, 100>,
}
checked!(TableBlock, |t| {
    if t.rows.iter().any(|r| r.len() != t.columns.len()) {
        return Err("each row has one cell per column".into());
    }
    Ok(())
});

/// A pull request: the client fills in its live state (title, checks, review, merged) from the hub.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrBlock {
    pub repo: GitHubRepo,
    pub number: Positive,
    /// Shown until the live title is known.
    pub title: Option<Line<1, 200>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: Line<1, 300>,
    /// Unified-diff hunks, each from its `@@` line.
    pub hunks: List<Text<1, 4000>, 1, 20>,
}

/// Changes to show: the files with their hunks, or a PR whose diff the client reads. Exactly one of the two.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct DiffBlock {
    pub title: Option<Line<1, 120>>,
    pub files: Option<List<DiffFile, 1, 20>>,
    pub pr: Option<PrBlock>,
}
checked!(DiffBlock, |d| {
    if d.files.is_some() == d.pr.is_some() {
        return Err("a diff has files or a pr, not both".into());
    }
    Ok(())
});

/// An agent at work: the client fills in its live state. Exactly one of `taskId` and `threadRef`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct AgentBlock {
    pub task_id: Option<TaskId>,
    pub thread_ref: Option<ThreadRef>,
}
checked!(AgentBlock, |a| {
    if a.task_id.is_some() == a.thread_ref.is_some() {
        return Err("an agent block names a taskId or a threadRef, not both".into());
    }
    Ok(())
});

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub text: Line<1, 200>,
    pub done: bool,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistBlock {
    pub title: Option<Line<1, 120>>,
    pub items: List<ChecklistItem, 1, 30>,
}

/// An image or clip already uploaded to the hub: its bytes come from `attachment_get`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentBlock {
    pub attachment_id: AttachmentId,
    pub caption: Option<Line<1, 200>>,
}

/// A question for the human, as buttons: Approve and Deny without `options`, one of `options` with them. The
/// answer is the human's chat reply (`chat_send` with the button's label as its text), so only the human answers
/// it; an agent's message never does. A command that needs approval still goes through `gated_run`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AskBlock {
    pub question: Line<1, 300>,
    pub options: Option<List<Line<1, 80>, 2, 6>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn blocks_decode_by_kind_and_refuse_what_does_not_add_up() {
        let chart = json!({ "v": 1, "kind": "chart", "chart": "line", "title": "CI minutes",
            "x": ["Mon", "Tue"], "series": [{ "name": "main", "values": [12, 9.5] }], "unit": "min" });
        let decoded: ChatBlock = serde_json::from_value(chart.clone()).unwrap();
        assert!(matches!(decoded.body, BlockBody::Chart(_)));
        assert_eq!(serde_json::to_value(&decoded).unwrap(), chart);
        let mut short = chart.clone();
        short["series"][0]["values"] = json!([1]);
        assert!(serde_json::from_value::<ChatBlock>(short).is_err());
        let mut newer = chart;
        newer["v"] = json!(2);
        assert!(serde_json::from_value::<ChatBlock>(newer).is_err());
        let unknown = json!({ "v": 1, "kind": "map", "lat": 1 });
        assert!(serde_json::from_value::<ChatBlock>(unknown).is_err());
        let both = json!({ "v": 1, "kind": "diff", "files": [{ "path": "a", "hunks": ["@@ -1 +1 @@\n-a\n+b"] }],
            "pr": { "repo": "acme/shop", "number": 3 } });
        assert!(serde_json::from_value::<ChatBlock>(both).is_err());
        let ragged = json!({ "v": 1, "kind": "table", "columns": ["a", "b"], "rows": [["1"]] });
        assert!(serde_json::from_value::<ChatBlock>(ragged).is_err());
    }
}
