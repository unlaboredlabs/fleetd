//! A final lead message's bubbles. The lead separates bubbles with a blank line, as it separates paragraphs, so a
//! reply reads the same in a client that shows `text` whole. A code fence is a bubble of its own and never split; a
//! list or table stays one bubble across the blank lines of a loose list. A ```fleetd-block fence becomes a block
//! when it passes [`block`], and otherwise shows as the fence it is.
use std::sync::LazyLock;

use fleetd_contracts::blocks::{BLOCK_FENCE, BLOCK_JSON_MAX, ChatBlock, MESSAGE_BLOCKS_MAX};
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
/// hunks excepted: they are code, shown as text). None shows the fence as text.
pub fn block(json: &str) -> Option<ChatBlock> {
    if json.len() > BLOCK_JSON_MAX {
        return None;
    }
    let value: Value = serde_json::from_str(json).ok()?;
    if !safe(&value) {
        return None;
    }
    serde_json::from_value(value).ok()
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
    let mut found = bubbles(text);
    if found.len() > CHAT_PARTS_MAX {
        let end = found[found.len() - 1].end;
        found.truncate(CHAT_PARTS_MAX);
        let last = &mut found[CHAT_PARTS_MAX - 1];
        last.end = end;
        last.fence = None;
    }
    let mut blocks = 0;
    let utf16 = |byte: usize| Count::unchecked(js_len(&text[..byte]) as i64);
    let parts: Vec<ChatPart> = found
        .into_iter()
        .map(|b| {
            let block = b
                .fence
                .filter(|(info, _, _)| info == BLOCK_FENCE && blocks < MESSAGE_BLOCKS_MAX)
                .and_then(|(_, body, body_end)| block(&text[body..body_end]));
            blocks += usize::from(block.is_some());
            ChatPart {
                start: utf16(b.start),
                end: utf16(b.end),
                block,
            }
        })
        .collect();
    if parts.len() == 1 && parts[0].block.is_none() {
        return None;
    }
    List::new(parts).ok()
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
