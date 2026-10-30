//! A final lead message's bubbles. The lead separates bubbles with a blank line, as it separates paragraphs, so a
//! reply reads the same in a client that shows `text` whole. A code fence is a bubble of its own and never split; a
//! list or table stays one bubble across the blank lines of a loose list. A ```fleetd-block fence becomes a block
//! when it passes [`block`], and otherwise shows as the fence it is.
use std::sync::LazyLock;

use fleetd_contracts::blocks::{
    AgentBlock, AskBlock, AttachmentBlock, BLOCK_FENCE, BLOCK_JSON_MAX, ChartBlock, ChatBlock,
    ChecklistBlock, DiffBlock, MESSAGE_BLOCKS_MAX, PrBlock, TableBlock,
};
use fleetd_contracts::chat::{CHAT_PARTS_MAX, ChatMessage, ChatPart};
use fleetd_contracts::prim::{Count, List, js_len};
use regex::Regex;
use serde_json::Value;

/// A tag (`<script`, `</div`, `<!--`), a script scheme, or a URL: a block's strings carry none, so a client that
/// slips and renders one as markup or a link has nothing to run or open.
static UNSAFE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)<[a-z!/?]|\b(javascript|vbscript):|\bdata:[a-z]|://").unwrap()
});

/// One block's JSON, checked: within [`BLOCK_JSON_MAX`], the schema, and no markup or URL in its strings (a diff's
/// hunks excepted: they are code, shown as text). The block, or the rule it broke, in words for the lead; an image or
/// clip whose caption alone is wrong shows without it, and the lead still hears why.
pub fn block(json: &str) -> (Option<ChatBlock>, Option<String>) {
    if json.len() > BLOCK_JSON_MAX {
        let why = format!(
            "it is {} bytes of JSON, over the {BLOCK_JSON_MAX} a block holds",
            json.len()
        );
        return (None, Some(why));
    }
    let mut value: Value = match serde_json::from_str(json) {
        Ok(value) => value,
        Err(error) => return (None, Some(format!("its JSON doesn't parse ({error})"))),
    };
    let why = match checked(&value) {
        Ok(block) => return (Some(block), None),
        Err(why) => why,
    };
    let media = matches!(value["kind"].as_str(), Some("image" | "clip"));
    let captioned = media
        && value
            .as_object_mut()
            .and_then(|m| m.remove("caption"))
            .is_some();
    (captioned.then(|| checked(&value).ok()).flatten(), Some(why))
}

fn checked(value: &Value) -> Result<ChatBlock, String> {
    if !safe(value) {
        return Err("a string in it holds markup, a script scheme or a URL".into());
    }
    serde_json::from_value(value.clone()).map_err(|e| why(value).unwrap_or(e.to_string()))
}

/// Why a block's fields don't fit its kind, naming the field: `ChatBlock` flattens its kind's fields, which loses
/// the path, so they are read again as that kind alone.
fn why(value: &Value) -> Option<String> {
    fn read<T: serde::de::DeserializeOwned>(fields: &Value) -> Option<String> {
        let e = serde_path_to_error::deserialize::<_, T>(fields).err()?;
        Some(match e.path().to_string().as_str() {
            "." | "" => e.into_inner().to_string(),
            path => format!("{path}: {}", e.into_inner()),
        })
    }
    let mut fields = value.clone();
    let map = fields.as_object_mut()?;
    map.remove("v");
    let kind = map.remove("kind")?;
    match kind.as_str()? {
        "chart" => read::<ChartBlock>(&fields),
        "table" => read::<TableBlock>(&fields),
        "diff" => read::<DiffBlock>(&fields),
        "pr" => read::<PrBlock>(&fields),
        "agent" => read::<AgentBlock>(&fields),
        "checklist" => read::<ChecklistBlock>(&fields),
        "image" | "clip" => read::<AttachmentBlock>(&fields),
        "ask" => read::<AskBlock>(&fields),
        _ => None,
    }
}

fn safe(value: &Value) -> bool {
    match value {
        Value::String(s) => !UNSAFE.is_match(s),
        Value::Array(items) => items.iter().all(safe),
        Value::Object(map) => map.iter().all(|(k, v)| k == "hunks" || safe(v)),
        _ => true,
    }
}

/// The opening line of a code fence: its marker (``` or ~~~, at least three) and its info string.
fn fence_open(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim_start();
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let c = trimmed.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let n = trimmed.len() - trimmed.trim_start_matches(c).len();
    (n >= 3).then(|| (&trimmed[..n], trimmed[n..].trim()))
}

fn fence_closes(line: &str, marker: &str) -> bool {
    let t = line.trim();
    t.starts_with(marker) && t.chars().all(|c| marker.starts_with(c))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Prose,
    List,
    Table,
}

/// A list item, or a line indented under one, is `List`; a table row is `Table`. A blank line between two lines of
/// the same list or table doesn't split them.
fn kind(line: &str) -> Kind {
    let t = line.trim_start();
    let numbered = t.split_once(['.', ')']).is_some_and(|(n, rest)| {
        !n.is_empty()
            && n.len() <= 3
            && n.bytes().all(|b| b.is_ascii_digit())
            && rest.starts_with(' ')
    });
    if t.starts_with('|') {
        Kind::Table
    } else if numbered
        || ["- ", "* ", "+ "].iter().any(|b| t.starts_with(b))
        || line.len() > t.len()
    {
        Kind::List
    } else {
        Kind::Prose
    }
}

struct Bubble {
    start: usize,
    end: usize,
    /// A fence: its info string, and where its body starts and ends.
    fence: Option<(String, usize, usize)>,
}

/// Byte ranges of the bubbles, in order.
fn bubbles(text: &str) -> Vec<Bubble> {
    let mut out: Vec<Bubble> = Vec::new();
    let mut open: Option<Bubble> = None;
    // The open text bubble's last line, and whether a blank line has come since.
    let (mut last, mut gap) = (Kind::Prose, false);
    let mut fence: Option<(String, String, usize, usize)> = None;
    let mut at = 0;
    for raw in text.split_inclusive('\n') {
        let (start, end) = (at, at + raw.trim_end_matches(['\n', '\r']).len());
        at += raw.len();
        let line = &text[start..end];
        if let Some((marker, info, fence_start, body)) = &fence {
            if fence_closes(line, marker) {
                out.push(Bubble {
                    start: *fence_start,
                    end,
                    fence: Some((info.clone(), *body, start)),
                });
                fence = None;
            }
            continue;
        }
        if let Some((marker, info)) = fence_open(line) {
            out.extend(open.take());
            fence = Some((marker.to_owned(), info.to_owned(), start, at));
            gap = false;
            continue;
        }
        if line.trim().is_empty() {
            gap = open.is_some();
            continue;
        }
        let now = kind(line);
        let joins = !gap || (now == last && now != Kind::Prose);
        match &mut open {
            Some(b) if joins => b.end = end,
            _ => {
                out.extend(open.take());
                open = Some(Bubble {
                    start,
                    end,
                    fence: None,
                });
            }
        }
        last = now;
        gap = false;
    }
    out.extend(open);
    // An unclosed fence runs to the end, as markdown renders it.
    if let Some((_, info, start, body)) = fence {
        let end = text.trim_end().len().max(start);
        out.push(Bubble {
            start,
            end,
            fence: Some((info, body.min(end), end)),
        });
    }
    out
}

/// The message's parts: None when it is one text bubble.
pub fn parts(text: &str) -> Option<List<ChatPart, 1, CHAT_PARTS_MAX>> {
    let (parts, _) = split(text);
    if parts.len() == 1 && parts[0].block.is_none() {
        return None;
    }
    List::new(parts).ok()
}

/// The blocks of the message that didn't show as written, as one line for its lead: which block (counting the
/// message's ```fleetd-block fences from 1) and the rule it broke. None when every block showed.
pub fn unshown(text: &str) -> Option<String> {
    let (_, failed) = split(text);
    if failed.is_empty() {
        return None;
    }
    let all = failed
        .iter()
        .map(|(n, why)| format!("block {n}: {why}"))
        .collect::<Vec<_>>()
        .join("; ");
    Some(format!(
        "- your last message had {} the person couldn't see as written (a \"couldn't show this\" chip stands in): {all}; fix and send again if it matters",
        if failed.len() == 1 {
            "a block".to_owned()
        } else {
            format!("{} blocks", failed.len())
        }
    ))
}

// Every bubble may be a block: the bubble cap is the only one a message's blocks meet.
const _: () = assert!(MESSAGE_BLOCKS_MAX >= CHAT_PARTS_MAX);

/// The parts, and each block that failed: its number among the message's blocks, and why.
fn split(text: &str) -> (Vec<ChatPart>, Vec<(usize, String)>) {
    let mut found = bubbles(text);
    let is_block = |b: &Bubble| {
        b.fence
            .as_ref()
            .is_some_and(|(info, _, _)| info == BLOCK_FENCE)
    };
    // Past the cap, the tail is the last bubble's text, its blocks shown as their fences.
    let mut over = 0;
    if found.len() > CHAT_PARTS_MAX {
        over = found[CHAT_PARTS_MAX - 1..]
            .iter()
            .filter(|b| is_block(b))
            .count();
        let end = found[found.len() - 1].end;
        found.truncate(CHAT_PARTS_MAX);
        let last = &mut found[CHAT_PARTS_MAX - 1];
        last.end = end;
        last.fence = None;
    }
    let (mut blocks, mut failed) = (0, Vec::new());
    let utf16 = |byte: usize| Count::unchecked(js_len(&text[..byte]) as i64);
    let parts: Vec<ChatPart> = found
        .into_iter()
        .map(|b| {
            let mut block = None;
            if let Some((_, body, body_end)) = b.fence.filter(|(info, _, _)| info == BLOCK_FENCE) {
                blocks += 1;
                let why;
                (block, why) = self::block(&text[body..body_end]);
                failed.extend(why.map(|why| (blocks, why)));
            }
            ChatPart {
                start: utf16(b.start),
                end: utf16(b.end),
                block,
            }
        })
        .collect();
    let past = format!(
        "a message shows at most {CHAT_PARTS_MAX} bubbles (paragraphs, fences and blocks); send the rest in another"
    );
    failed.extend((blocks + 1..=blocks + over).map(|n| (n, past.clone())));
    (parts, failed)
}

/// One bubble's text, trimmed: `part` of the message's `parts`, or the whole text for a message of one bubble.
pub fn bubble(message: &ChatMessage, part: usize) -> Option<String> {
    let text = message.text.as_str();
    let Some(parts) = &message.parts else {
        return (part == 0 && !text.trim().is_empty()).then(|| text.trim().to_owned());
    };
    let p = parts.get(part)?;
    let units: Vec<u16> = text.encode_utf16().collect();
    let slice = units.get(p.start.get() as usize..p.end.get() as usize)?;
    Some(String::from_utf16_lossy(slice).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::blocks::BlockBody;

    use super::*;

    /// The parts as the app slices them: (text, kind of block).
    fn sliced(text: &str) -> Vec<(String, Option<&'static str>)> {
        let units: Vec<u16> = text.encode_utf16().collect();
        parts(text)
            .map(|p| p.into_inner())
            .unwrap_or_default()
            .into_iter()
            .map(|p| {
                let s = String::from_utf16(&units[p.start.get() as usize..p.end.get() as usize])
                    .unwrap();
                let kind = p.block.map(|b| match b.body {
                    BlockBody::Chart(_) => "chart",
                    BlockBody::Table(_) => "table",
                    BlockBody::Ask(_) => "ask",
                    _ => "other",
                });
                (s, kind)
            })
            .collect()
    }

    fn texts(text: &str) -> Vec<String> {
        sliced(text).into_iter().map(|(s, _)| s).collect()
    }

    #[test]
    fn a_one_liner_is_one_bubble_and_blank_lines_split_the_rest() {
        assert!(parts("merged, it's in the next Edge build").is_none());
        assert!(parts("line one\nline two").is_none());
        assert_eq!(
            texts(
                "oof 😬\n\nCI's red on `main`: `cargo test` fails in `hub::chat`.\n\n\nwant me to revert?"
            ),
            [
                "oof 😬",
                "CI's red on `main`: `cargo test` fails in `hub::chat`.",
                "want me to revert?"
            ]
        );
    }

    #[test]
    fn code_lists_tables_and_diffs_are_never_split() {
        let text = "here's the fix:\n```diff\n-let ttl = 60;\n\n+let ttl = 3600;\n```\nthree left:\n\n- one\n\n- two\n  still two\n\n- three\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nnice";
        assert_eq!(
            texts(text),
            [
                "here's the fix:",
                "```diff\n-let ttl = 60;\n\n+let ttl = 3600;\n```",
                "three left:",
                "- one\n\n- two\n  still two\n\n- three",
                "| a | b |\n|---|---|\n| 1 | 2 |",
                "nice",
            ]
        );
        // An unclosed fence runs to the end, blank lines and all.
        assert_eq!(texts("ugh\n```\na\n\nb\n"), ["ugh", "```\na\n\nb"]);
    }

    #[test]
    fn a_valid_block_is_a_block_and_anything_else_shows_as_its_fence() {
        let chart = r#"{"v":1,"kind":"chart","chart":"bar","title":"PRs merged","x":["Mon","Tue"],"series":[{"name":"main","values":[3,5]}]}"#;
        let text = format!("nice week\n\n```fleetd-block\n{chart}\n```");
        let got = sliced(&text);
        assert_eq!(
            got[1],
            (format!("```fleetd-block\n{chart}\n```"), Some("chart"))
        );
        // A block alone is still a part, so the app knows to draw it.
        assert_eq!(sliced(&format!("```fleetd-block\n{chart}\n```")).len(), 1);

        let fallback = |json: &str| sliced(&format!("ok\n\n```fleetd-block\n{json}\n```"))[1].1;
        // Invalid: a series one value short, bad JSON, and v2.
        assert_eq!(fallback(&chart.replace("[3,5]", "[3]")), None);
        assert_eq!(fallback("{\"v\":1,"), None);
        assert_eq!(fallback(&chart.replace("\"v\":1", "\"v\":2")), None);
        // A kind this hub doesn't know.
        assert_eq!(fallback(r#"{"v":1,"kind":"map","lat":52.1}"#), None);
        // Markup, a script scheme or a URL in a string.
        for bad in [
            "<script>alert(1)</script>",
            "javascript:alert(1)",
            "see https://evil.example",
        ] {
            assert_eq!(fallback(&chart.replace("PRs merged", bad)), None, "{bad}");
        }
        // A diff's hunks are code: markup in them is fine.
        let diff = r#"{"v":1,"kind":"diff","files":[{"path":"index.html","hunks":["@@ -1 +1 @@\n-<p>a</p>\n+<p>b</p>"]}]}"#;
        assert_eq!(fallback(diff), Some("other"));
        // Over the size cap.
        let rows = vec![r#"["x"]"#; 100].join(",");
        let big = format!(
            r#"{{"v":1,"kind":"table","columns":["{}"],"rows":[{rows}]}}"#,
            "c".repeat(60)
        );
        assert_eq!(fallback(&big), Some("table"));
        let over = format!(
            r#"{{"v":1,"kind":"ask","question":"go?","pad":"{}"}}"#,
            " ".repeat(BLOCK_JSON_MAX)
        );
        assert_eq!(fallback(&over), None);
        // Another language's fence is a text part, whatever it holds.
        assert_eq!(sliced(&format!("ok\n\n```json\n{chart}\n```"))[1].1, None);
    }

    #[test]
    fn many_blocks_show_and_the_lead_hears_of_each_one_that_did_not() {
        let image = |n: usize| {
            format!(
                "```fleetd-block\n{{\"v\":1,\"kind\":\"image\",\"attachmentId\":\"F{n}\"}}\n```"
            )
        };
        // Nine images, past the old cap of 8: every one is a block, and the lead hears nothing.
        let nine = (1..=9).map(image).collect::<Vec<_>>().join("\n\n");
        assert!(sliced(&nine).iter().all(|(_, kind)| *kind == Some("other")));
        assert_eq!(unshown(&nine), None);
        // Past the bubble cap, the tail's images are the last bubble's text, and the lead hears which.
        let many = (1..=CHAT_PARTS_MAX + 1)
            .map(image)
            .collect::<Vec<_>>()
            .join("\n\n");
        let got = sliced(&many);
        assert_eq!(got.len(), CHAT_PARTS_MAX);
        assert_eq!(got[CHAT_PARTS_MAX - 1].1, None);
        assert_eq!(
            unshown(&many).unwrap(),
            "- your last message had 2 blocks the person couldn't see as written (a \"couldn't show this\" chip stands in): \
             block 24: a message shows at most 24 bubbles (paragraphs, fences and blocks); send the rest in another; \
             block 25: a message shows at most 24 bubbles (paragraphs, fences and blocks); send the rest in another; \
             fix and send again if it matters"
        );
    }

    #[test]
    fn a_table_with_an_empty_header_is_named_with_its_rule() {
        let table = r##"{"v":1,"kind":"table","columns":["PR",""],"rows":[["#1","ok"]]}"##;
        let text = format!("ok\n\n```fleetd-block\n{table}\n```");
        assert_eq!(sliced(&text)[1].1, None);
        assert_eq!(
            unshown(&text).unwrap(),
            "- your last message had a block the person couldn't see as written (a \"couldn't show this\" chip stands in): \
             block 1: columns[1]: expected a non-empty string; fix and send again if it matters"
        );
        let ragged = r#"{"v":1,"kind":"table","columns":["a","b"],"rows":[["1"]]}"#;
        assert_eq!(block(ragged).1.unwrap(), "each row has one cell per column");
        assert_eq!(
            block("{\"v\":1,").1.unwrap(),
            "its JSON doesn't parse (EOF while parsing a value at line 1 column 7)"
        );
    }

    #[test]
    fn an_image_whose_caption_is_wrong_still_shows_its_image() {
        let long = format!(
            r#"{{"v":1,"kind":"image","attachmentId":"F3","caption":"{}"}}"#,
            "c".repeat(201)
        );
        let (shown, why) = block(&long);
        let Some(BlockBody::Image(image)) = shown.map(|b| b.body) else {
            panic!("no image")
        };
        assert_eq!((image.attachment_id.as_str(), image.caption), ("F3", None));
        assert_eq!(why.unwrap(), "caption: expected at most 200 characters");
        let linked =
            r#"{"v":1,"kind":"image","attachmentId":"F3","caption":"see https://x.example"}"#;
        assert!(matches!(block(linked), (Some(_), Some(_))));
        // Without a caption to drop, a bad image is a fence like any other block.
        assert!(matches!(
            block(r#"{"v":1,"kind":"image","attachmentId":""}"#),
            (None, Some(_))
        ));
    }

    #[test]
    fn offsets_count_utf16_units_and_a_long_reply_keeps_its_tail_in_the_last_bubble() {
        let text = "😬😬\n\nnext";
        let p = parts(text).unwrap();
        assert_eq!((p[1].start.get(), p[1].end.get()), (6, 10));
        let many: Vec<String> = (0..30).map(|i| format!("line {i}")).collect();
        let got = texts(&many.join("\n\n"));
        assert_eq!(got.len(), CHAT_PARTS_MAX);
        assert!(
            got[CHAT_PARTS_MAX - 1].starts_with("line 23\n\n")
                && got[CHAT_PARTS_MAX - 1].ends_with("line 29")
        );
    }
}
