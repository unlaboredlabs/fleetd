//! The Navi's Markdown as Telegram HTML (parse_mode HTML): `&`, `<`, `>` and `"` escaped everywhere, then bold, italic,
//! strikethrough, inline code, links, code fences, headings, lists and quotes in the tags Telegram takes. A reply
//! longer than one Telegram message is split between paragraphs, a long paragraph between lines or words, and a long
//! code block into several, so every piece is whole HTML. And an approval card: what the person approves, exactly.
use std::sync::LazyLock;

use fleetd_contracts::chat::CommandApprovalItem;
use fleetd_contracts::ledger::CheckerVerdict;
use fleetd_contracts::prim::js_len;
use regex::Regex;

/// Telegram's most characters in one message, with room to spare for what escaping adds.
pub const LIMIT: usize = 4000;
/// A piece of source cut to fit: rendered, it stays under [`LIMIT`].
const SOURCE_PIECE: usize = 3000;

pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`([^`\n]+)`").unwrap());
static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]\n]+)\]\((https?://[^\s)]+)\)").unwrap());
static BOLD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*\*(\S(?:[^\n]*?\S)?)\*\*|__(\S(?:[^\n]*?\S)?)__").unwrap());
static ITALIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(^|[^\w*])\*(\S(?:[^*\n]*?\S)?)\*($|[^\w*])|(^|[^\w])_(\S(?:[^_\n]*?\S)?)_($|[^\w])",
    )
    .unwrap()
});
static STRIKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"~~(\S(?:[^\n]*?\S)?)~~").unwrap());
static HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#{1,6}\s+(.+?)\s*#*\s*$").unwrap());
static BULLET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\s*)[-*+]\s+(.*)$").unwrap());
static RULE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*([-*_])(\s*[-*_]){2,}\s*$").unwrap());

/// One line's inline Markdown as Telegram HTML; code spans are taken as they are.
pub fn inline(text: &str) -> String {
    let mut out = String::new();
    let mut last = 0;
    for m in CODE.captures_iter(text) {
        let whole = m.get(0).expect("a match");
        out.push_str(&styled(&text[last..whole.start()]));
        out.push_str(&format!("<code>{}</code>", escape(&m[1])));
        last = whole.end();
    }
    out.push_str(&styled(&text[last..]));
    out
}

fn styled(text: &str) -> String {
    let escaped = escape(text);
    let linked = LINK.replace_all(&escaped, r#"<a href="$2">$1</a>"#);
    let bold = BOLD.replace_all(&linked, "<b>$1$2</b>");
    let strike = STRIKE.replace_all(&bold, "<s>$1</s>");
    ITALIC
        .replace_all(&strike, |c: &regex::Captures| {
            if c.get(2).is_some() {
                format!("{}<i>{}</i>{}", &c[1], &c[2], &c[3])
            } else {
                format!("{}<i>{}</i>{}", &c[4], &c[5], &c[6])
            }
        })
        .into_owned()
}

enum Block {
    /// Lines of prose (a paragraph, a list, a quote): rendered line by line.
    Text(Vec<String>),
    /// A fence's body, and its language when it names one.
    Code(Option<String>, Vec<String>),
}

fn blocks(markdown: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut text: Vec<String> = Vec::new();
    let mut code: Option<(Option<String>, Vec<String>)> = None;
    for line in markdown.lines() {
        if let Some((lang, body)) = &mut code {
            if line.trim_start().starts_with("```") {
                out.push(Block::Code(lang.take(), std::mem::take(body)));
                code = None;
            } else {
                body.push(line.to_owned());
            }
            continue;
        }
        if let Some(rest) = line.trim_start().strip_prefix("```") {
            if !text.is_empty() {
                out.push(Block::Text(std::mem::take(&mut text)));
            }
            let lang = rest.trim();
            code = Some((
                (!lang.is_empty()
                    && lang
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '+'))
                .then(|| lang.to_owned()),
                Vec::new(),
            ));
            continue;
        }
        if line.trim().is_empty() {
            if !text.is_empty() {
                out.push(Block::Text(std::mem::take(&mut text)));
            }
            continue;
        }
        text.push(line.to_owned());
    }
    if let Some((lang, body)) = code {
        out.push(Block::Code(lang, body));
    }
    if !text.is_empty() {
        out.push(Block::Text(text));
    }
    out
}

fn code_html(lang: Option<&str>, body: &str) -> String {
    match lang {
        Some(lang) => format!(
            "<pre><code class=\"language-{lang}\">{}</code></pre>",
            escape(body)
        ),
        None => format!("<pre>{}</pre>", escape(body)),
    }
}

/// A paragraph's lines: headings bold, list items with a bullet, quoted lines in one blockquote, a table as it is in
/// monospace.
fn text_html(lines: &[String]) -> String {
    if lines.len() >= 2 && lines.iter().all(|l| l.trim_start().starts_with('|')) {
        return format!("<pre>{}</pre>", escape(&lines.join("\n")));
    }
    let mut out: Vec<String> = Vec::new();
    let mut quote: Vec<String> = Vec::new();
    let flush = |quote: &mut Vec<String>, out: &mut Vec<String>| {
        if !quote.is_empty() {
            out.push(format!("<blockquote>{}</blockquote>", quote.join("\n")));
            quote.clear();
        }
    };
    for line in lines {
        if let Some(rest) = line.trim_start().strip_prefix('>') {
            quote.push(inline(rest.strip_prefix(' ').unwrap_or(rest)));
            continue;
        }
        flush(&mut quote, &mut out);
        if let Some(c) = HEADING.captures(line) {
            out.push(format!("<b>{}</b>", inline(&c[1])));
        } else if RULE.is_match(line) {
            out.push("──────".to_owned());
        } else if let Some(c) = BULLET.captures(line) {
            out.push(format!("{}• {}", &c[1], inline(&c[2])));
        } else {
            out.push(inline(line));
        }
    }
    flush(&mut quote, &mut out);
    out.join("\n")
}

/// `text` cut into pieces of at most `max` characters, between words where it can.
fn cut(text: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while js_len(rest) > max {
        let mut end = 0;
        let mut units = 0;
        for (i, c) in rest.char_indices() {
            units += c.len_utf16();
            if units > max {
                break;
            }
            end = i + c.len_utf8();
        }
        let at = rest[..end]
            .rfind(char::is_whitespace)
            .filter(|&i| i > end / 2)
            .unwrap_or(end);
        out.push(rest[..at].trim_end().to_owned());
        rest = rest[at..].trim_start();
    }
    if !rest.is_empty() {
        out.push(rest.to_owned());
    }
    out
}

/// Each block's HTML, those too long for one message cut into several.
fn rendered(block: &Block) -> Vec<String> {
    match block {
        Block::Code(lang, body) => {
            let mut pieces = Vec::new();
            let mut piece: Vec<String> = Vec::new();
            let mut size = 0;
            for line in body {
                let parts = if line.is_empty() {
                    vec![String::new()]
                } else {
                    cut(line, SOURCE_PIECE)
                };
                for part in parts {
                    let len = js_len(&escape(&part)) + 1;
                    if size + len > SOURCE_PIECE && !piece.is_empty() {
                        pieces.push(code_html(lang.as_deref(), &piece.join("\n")));
                        piece.clear();
                        size = 0;
                    }
                    size += len;
                    piece.push(part);
                }
            }
            pieces.push(code_html(lang.as_deref(), &piece.join("\n")));
            pieces
        }
        Block::Text(lines) => {
            let html = text_html(lines);
            if js_len(&html) <= LIMIT {
                return vec![html];
            }
            let mut pieces = Vec::new();
            let mut piece: Vec<String> = Vec::new();
            let mut size = 0;
            for line in lines {
                for part in cut(line, SOURCE_PIECE) {
                    let len = js_len(&escape(&part)) + 1;
                    if size + len > SOURCE_PIECE && !piece.is_empty() {
                        pieces.push(text_html(&piece));
                        piece.clear();
                        size = 0;
                    }
                    size += len;
                    piece.push(part);
                }
            }
            if !piece.is_empty() {
                pieces.push(text_html(&piece));
            }
            pieces
        }
    }
}

/// The Markdown as Telegram messages, in order, each at most [`LIMIT`] characters of HTML.
pub fn messages(markdown: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for block in blocks(markdown) {
        for html in rendered(&block) {
            if current.is_empty() {
                current = html;
            } else if js_len(&current) + 2 + js_len(&html) <= LIMIT {
                current.push_str("\n\n");
                current.push_str(&html);
            } else {
                out.push(std::mem::take(&mut current));
                current = html;
            }
        }
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out
}

/// What an approval card shows: who asks, what for, and exactly what approving it runs.
pub struct Card {
    /// The card's text, with the full content when it fits one message.
    pub html: String,
    /// The full content as a file, when it doesn't fit: sent just before the card.
    pub file: Option<String>,
}

/// The exact content an approval runs, as plain text.
fn content(item: &CommandApprovalItem) -> (String, String) {
    if let Some(p) = &item.permission {
        if let Some(preview) = &p.preview {
            let input = serde_json::from_str::<serde_json::Value>(preview.input.as_str())
                .ok()
                .and_then(|v| serde_json::to_string_pretty(&v).ok())
                .unwrap_or_else(|| preview.input.as_str().to_owned());
            let what = format!(
                "use {} on {}",
                preview.tool.as_str(),
                preview.server.as_str()
            );
            return (what, input);
        }
        let input = p
            .input
            .as_ref()
            .map(|i| serde_json::to_string_pretty(i).unwrap_or_default())
            .unwrap_or_default();
        let summary = p.summary.as_str().trim();
        let what = if summary.is_empty() {
            format!("use {}", p.tool_name.as_str())
        } else {
            summary.to_owned()
        };
        return (what, input);
    }
    if let Some(g) = &item.gated {
        let mut text = crate::hub::approvals::shown_argv(
            &g.argv.iter().map(|a| a.to_string()).collect::<Vec<_>>(),
        );
        if let Some(cwd) = &g.cwd {
            text.push_str(&format!("\n\nin {}", cwd.as_str()));
        }
        text.push_str(&format!("\n\nwhy: {}", g.reason.as_str()));
        return ("run a command".to_owned(), text);
    }
    if let Some(p) = &item.preview_config {
        return (
            "save how Try it runs this project".to_owned(),
            serde_json::to_string_pretty(&p.config).unwrap_or_default(),
        );
    }
    if let Some(p) = &item.purchase {
        let mut text = format!("{} ({})\n", p.shop.name, p.shop.domain);
        for i in p.items.iter() {
            let many = i
                .quantity
                .map(|q| q.get())
                .filter(|q| *q > 1)
                .map(|q| format!("{q} × "))
                .unwrap_or_default();
            let price = i
                .amount
                .as_ref()
                .map(|a| format!("  {a} {}", p.total.currency))
                .unwrap_or_default();
            text.push_str(&format!("\n{many}{}{price}", i.name));
        }
        text.push_str(&format!(
            "\n\nTotal {} {}\nwith {} from 1Password, filled into this checkout once",
            p.total.amount,
            p.total.currency,
            p.card.label()
        ));
        return (
            format!(
                "pay {} {} at {}",
                p.total.amount, p.total.currency, p.shop.name
            ),
            text,
        );
    }
    if let Some(i) = &item.secure_input {
        let text = format!(
            "{} on {} ({})\nfrom {}\n\nwhy: {}",
            i.label,
            i.site.name,
            i.site.domain,
            i.reference.as_ref().map_or("1Password", |r| r.as_str()),
            i.why
        );
        return (format!("fill {} from 1Password", i.label), text);
    }
    ("do something".to_owned(), String::new())
}

/// A secret request: never asked for here, where a chat isn't sealed. A Navi's secure input says what and where.
pub fn secret(navi: &str, item: &fleetd_contracts::chat::SecretRequestItem) -> String {
    match &item.secure_input {
        Some(i) => format!(
            "<b>{} needs {} for {}</b>\n{}\nOpen fleetd to enter it: it is typed only there, sealed, never in this chat.",
            escape(navi),
            escape(i.label.as_str()),
            escape(i.site.name.as_str()),
            escape(i.why.as_str())
        ),
        None => format!(
            "<b>{} needs a secret: {}</b>\nSecrets are entered only in the fleetd app, never here. Open the Navi there to enter it.",
            escape(navi),
            escape(item.text.as_str())
        ),
    }
}

pub fn card(navi: &str, item: &CommandApprovalItem) -> Card {
    let (what, exact) = content(item);
    let mut head = format!(
        "<b>{} asks to {}</b> ({})",
        escape(navi),
        escape(&what),
        escape(item.request_id.as_str())
    );
    // The Navi's approval checker judged it first: why it asks, or why it refused it, as the desktop card says.
    if let Some(c) = item.permission.as_ref().and_then(|p| p.checker.as_ref()) {
        let reason = c.reason.as_str().trim();
        let line = if c.verdict == CheckerVerdict::Block {
            let reason = if reason.ends_with(['.', '!', '?']) {
                reason.to_owned()
            } else {
                format!("{reason}.")
            };
            format!(
                "The checker refused it: {reason} Approve it anyway and {navi} runs exactly this, once."
            )
        } else {
            format!("The checker asks you: {reason}")
        };
        head.push_str(&format!("\n{}", escape(&line)));
    }
    let full = format!("{head}\n<pre>{}</pre>", escape(&exact));
    if js_len(&full) <= LIMIT - 200 {
        return Card {
            html: full,
            file: None,
        };
    }
    Card {
        html: format!(
            "{head}\nIt is too long to show here: the file above holds exactly what it runs."
        ),
        file: Some(exact),
    }
}

/// The card once answered: what was decided, by whom, without buttons.
pub fn answered(navi: &str, item: &CommandApprovalItem) -> String {
    use fleetd_contracts::chat::CommandApprovalState as S;
    let base = card(navi, item).html;
    let by = item
        .by
        .as_ref()
        .map(|b| b.as_str().trim_start_matches("human:").to_owned());
    let by = by
        .map(|b| format!(" by {}", escape(&b)))
        .unwrap_or_default();
    let outcome = match item.state {
        S::Approved | S::Ran => format!("✅ <b>Approved</b>{by}"),
        S::Failed => match &item.note {
            Some(note) => format!("⚠️ <b>Not run</b>: {}", escape(note.as_str())),
            None => format!("✅ <b>Approved</b>{by}, but it failed"),
        },
        S::Denied => match &item.note {
            Some(note) if item.by.is_none() => {
                format!("✖️ <b>Closed</b>: {}", escape(note.as_str()))
            }
            _ => format!("✖️ <b>Denied</b>{by}"),
        },
        _ => return base,
    };
    format!("{base}\n\n{outcome}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_purchase_and_a_secure_input_show_whole_and_a_typed_one_is_never_asked_for_here() {
        let purchase: CommandApprovalItem = serde_json::from_value(serde_json::json!({
            "requestId": "Q4", "machineId": "devbox", "state": "open",
            "purchase": {
                "shop": { "domain": "hotel.example", "name": "Hotel <Example>" },
                "total": { "amount": "264.40", "currency": "EUR" },
                "items": [{ "name": "City tax", "quantity": 2, "amount": "3.20" }],
                "card": { "ref": "op://Personal/Visa" },
                "sessionId": "B00000000000000000000000000000022",
            },
        }))
        .unwrap();
        let shown = card("Ada", &purchase).html;
        assert!(
            shown.starts_with("<b>Ada asks to pay 264.40 EUR at Hotel &lt;Example&gt;</b>"),
            "{shown}"
        );
        for part in [
            "hotel.example",
            "2 × City tax  3.20 EUR",
            "Total 264.40 EUR",
            "Visa (Personal)",
        ] {
            assert!(shown.contains(part), "{part}: {shown}");
        }
        let typed: fleetd_contracts::chat::SecretRequestItem =
            serde_json::from_value(serde_json::json!({
                "requestId": "Q5", "name": "navi.secure_input", "text": "Enter Passport number",
                "sink": "fill:devbox:B00000000000000000000000000000022", "state": "open",
                "secureInput": {
                    "site": { "domain": "visas.example", "name": "Visa application" },
                    "target": "#passport", "label": "Passport number", "why": "The form needs it",
                    "sessionId": "B00000000000000000000000000000022",
                },
            }))
            .unwrap();
        let line = secret("Ada", &typed);
        assert!(
            line.contains("needs Passport number for Visa application"),
            "{line}"
        );
        assert!(line.contains("Open fleetd to enter it"), "{line}");
    }

    #[test]
    fn markdown_becomes_telegram_html_with_everything_escaped() {
        let md = "# Plan\n\nThe **3 < 4** case & a *quick* fix, see [docs](https://x.dev/a?b=1&c=2) and `a<b>`.\n\n\
                  - one_two_three\n- ~~old~~ new\n\n> quoted\n\n```rust\nfn main() { 1 < 2 }\n```";
        let out = messages(md);
        assert_eq!(out.len(), 1);
        let html = &out[0];
        assert!(html.starts_with("<b>Plan</b>\n\n"), "{html}");
        assert!(
            html.contains("<b>3 &lt; 4</b> case &amp; a <i>quick</i> fix"),
            "{html}"
        );
        assert!(
            html.contains(r#"<a href="https://x.dev/a?b=1&amp;c=2">docs</a>"#),
            "{html}"
        );
        assert!(html.contains("<code>a&lt;b&gt;</code>"), "{html}");
        assert!(html.contains("• one_two_three"), "snake_case stays: {html}");
        assert!(html.contains("• <s>old</s> new"), "{html}");
        assert!(html.contains("<blockquote>quoted</blockquote>"), "{html}");
        assert!(
            html.contains("<pre><code class=\"language-rust\">fn main() { 1 &lt; 2 }</code></pre>"),
            "{html}"
        );
    }

    #[test]
    fn a_long_reply_splits_into_whole_messages_under_the_limit() {
        let para = "word ".repeat(500);
        let code = (0..400)
            .map(|i| format!("line {i} <x>"))
            .collect::<Vec<_>>()
            .join("\n");
        let md = format!(
            "{para}\n\n{para}\n\n```\n{code}\n```\n\n{}",
            "x".repeat(9000)
        );
        let out = messages(&md);
        assert!(out.len() >= 5, "{}", out.len());
        for m in &out {
            assert!(js_len(m) <= 4096, "{}", js_len(m));
            assert_eq!(
                m.matches("<pre>").count(),
                m.matches("</pre>").count(),
                "{m}"
            );
        }
        let lines: usize = out.iter().map(|m| m.matches("&lt;x&gt;").count()).sum();
        assert_eq!(lines, 400, "every code line arrives once");
        let xs: usize = out.iter().map(|m| m.matches('x').count()).sum();
        assert!(xs >= 9000);
    }
}
