//! What the approval checker reads, and what fleetd decides past it (W239, built from T1480's eval of 86 risky
//! actions). Pure: no hub, no model.
//!
//! The checker's input is a [`Review`], sent as JSON inside `<action_review>`: the person and their recent messages
//! (the only authority), the Navi's last question to them (so a bare "yes" can be judged), the action exactly as it
//! runs, and where each of its parts came from ([`provenance`]), found by matching values against what the person said
//! and what the Navi read: `person`, `person (pasted text)`, `contacts`, `thread`, `sent_mail`, `existing event
//! attendees`, `person's files`, `allowed site <host>`, `untrusted: <kind> from <sender>`, or `navi`. Long text gets
//! the spans quoted from untrusted content or from the person. The content the Navi read never goes in, nor the
//! Navi's own explanation of the action.
//!
//! Then the code rules ([`rules`]), which no model's word overrides: the floors (money, trading, credentials in what
//! goes out) block; a destination only untrusted content named, a URL carrying data, a public or editor share to a new
//! party, a forwarding rule to another domain, a lookalike domain, a bulk send and a one-time code in what goes out
//! ask at least. A model that refused, timed out or answered nothing readable asks ([`decide`]).
use std::sync::LazyLock;

use fleetd_contracts::ledger::{CheckerNote, CheckerVerdict};
use fleetd_contracts::prim::Line;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hub::integrations::policy;
use crate::hub::usage::time::clip;

/// More recipients than this in one send asks.
pub const BULK: usize = 10;
/// A quoted span shorter than this says too little to match.
const SPAN_MIN: usize = 16;
/// A part this long is text: matched span by span, not as a value.
const TEXT_MIN: usize = 120;

/// The checker's whole input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Review {
    #[serde(default)]
    pub person: Value,
    /// The person's own addresses and those of their contacts the Navi read, for the lookalike rule.
    #[serde(default)]
    pub contacts: Vec<Value>,
    #[serde(default)]
    pub allowed_sites: Vec<String>,
    #[serde(default)]
    pub today: String,
    /// Oldest first.
    #[serde(default)]
    pub person_messages: Vec<String>,
    /// The Navi's last message to the person, when it asked something: Navi-written, never authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub navi_last_question: Option<String>,
    pub action: Value,
    #[serde(default)]
    pub provenance: Vec<Provenance>,
}

/// Where one part of the action came from.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Provenance {
    /// `to[0]`, `body`, `url.host`.
    pub part: String,
    pub sources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quoted_from_untrusted: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub from_person: Vec<String>,
}

impl Review {
    /// The user turn: the review as JSON inside `<action_review>`. `<` and `>` are escaped in it, so nothing in the
    /// action can close the tag.
    pub fn render(&self) -> String {
        let json = serde_json::to_string_pretty(self)
            .unwrap_or_default()
            .replace('<', "\\u003c")
            .replace('>', "\\u003e");
        format!("<action_review>\n{json}\n</action_review>")
    }
}

/// Content the Navi read: one tool call's output, with the call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Read {
    /// The call: `mcp__gmail__get_thread {"id":"…"}`, `WebFetch https://…`.
    pub source: String,
    pub text: String,
}

/// What a read is, by its call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Contacts,
    Calendar,
    Sent,
    Mail,
    Web,
    File,
    Telegram,
    Other,
}

/// What a read is, by its tool's name alone: never by its input (a search for "-in:sent" is no sent folder). A
/// gateway's call (`call_read_tool`) is the tool it called, by the name in its input; one whose call was cut too short
/// to say is anyone's content.
fn kind(source: &str) -> Kind {
    let (tool, input) = source.split_once(' ').unwrap_or((source, ""));
    let mut w = policy::words(tool);
    if policy::gateway(tool) {
        let input = serde_json::from_str::<Value>(input).unwrap_or_default();
        match policy::called(tool, &input) {
            Some(called) => w = policy::words(called),
            None => return Kind::Other,
        }
    }
    let has = |list: &[&str]| w.iter().any(|x| list.contains(&x.as_str()));
    if has(&["contact", "contacts", "people", "directory"]) {
        Kind::Contacts
    } else if has(&["calendar", "calendars", "event", "events"]) {
        Kind::Calendar
    } else if has(&[
        "mail", "gmail", "email", "emails", "message", "messages", "thread", "threads", "inbox",
        "outlook",
    ]) {
        if w.iter().any(|x| x == "sent") {
            Kind::Sent
        } else {
            Kind::Mail
        }
    } else if has(&["telegram"]) {
        Kind::Telegram
    } else if has(&["webfetch", "websearch", "browser", "fetch", "http", "https"]) {
        Kind::Web
    } else if has(&[
        "read", "glob", "grep", "file", "files", "drive", "doc", "docs", "notes",
    ]) {
        Kind::File
    } else {
        Kind::Other
    }
}

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}").unwrap()
});
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"https?://[^\s"'<>)\]]+"#).unwrap());
/// A header line of a mail: `From: Sam <sam@example.org>`.
static HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^\s*(from|to|cc|bcc|reply-to|sender|organizer|attendees?)\s*:\s*(.+)$")
        .unwrap()
});
static FROM_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?im)^\s*(from|sender|organizer)\s*:\s*(.+)$").unwrap());
/// Any header line: `Subject: Saturday`, `Message-ID: <…>`.
static HEADER_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*[A-Za-z][\w-]{0,30}:(\s|$)").unwrap());
/// A line between two mails of a plain-text list: `---`, `===`, `***`.
static SEPARATOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*([-=*#~─━]\s*){3,}$").unwrap());
/// A line that starts quoted mail inside a message: `-----Original Message-----`, Outlook's `_____` rule,
/// `Begin forwarded message:`, `On Monday, Sam <sam@example.org> wrote:`.
static QUOTE_START: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(-+\s*(original|forwarded) message\s*-*|begin forwarded message:?|_{5,}|.*\bwrote:)\s*$")
        .unwrap()
});
/// A long base64 or hex blob in a URL: data, not an address.
static BLOB: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9+/_=]{32,}|[0-9a-fA-F]{32,}").unwrap());

/// Whether `text` holds an encoded blob: 32 or more hex digits, or a run of 32 or more base64 characters mixing upper
/// and lower case and digits. A path or a slug (`/markets/stock-market-today`) isn't one.
fn blob(text: &str) -> bool {
    BLOB.find_iter(text).any(|m| {
        let t = m.as_str();
        t.chars().all(|c| c.is_ascii_hexdigit())
            || (t.chars().any(|c| c.is_ascii_uppercase())
                && t.chars().any(|c| c.is_ascii_lowercase())
                && t.chars().any(|c| c.is_ascii_digit()))
    })
}
/// An encoded blob in a message: data hidden from the person.
static ENCODED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9+/]{40,}={0,2}").unwrap());
static SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(password|passwd|passcode|passphrase|pin|api[ _-]?key|secret key|private key)\b\s*(is|:|=)\s*\S{4,}")
        .unwrap()
});
static ONE_TIME_CODE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(code|otp|verification|2fa|one-time)\b\D{0,24}\b\d{4,8}\b").unwrap()
});

fn emails(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in EMAIL.find_iter(text) {
        let e = m.as_str().trim_end_matches('.').to_lowercase();
        if !out.contains(&e) {
            out.push(e);
        }
    }
    out
}

fn norm(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Every string in `v`, with where it is: `to[0]`, `message.body`.
pub fn leaves(v: &Value) -> Vec<(String, String)> {
    fn walk(v: &Value, at: String, out: &mut Vec<(String, String)>) {
        match v {
            Value::String(s) => out.push((at, s.clone())),
            Value::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    walk(item, format!("{at}[{i}]"), out);
                }
            }
            Value::Object(o) => {
                for (k, item) in o {
                    let at = if at.is_empty() {
                        k.clone()
                    } else {
                        format!("{at}.{k}")
                    };
                    walk(item, at, out);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(v, String::new(), &mut out);
    out
}

/// What the Navi read, sorted into the person's own data (each value with its source) and untrusted text.
struct Sources {
    /// Lower-case values and the source they name: an address from a mail's headers is `thread`, the person's own
    /// `person's own address`.
    own: Vec<(String, String)>,
    /// Lower-case, whitespace-folded text that anyone could have written, with its label.
    untrusted: Vec<(String, String)>,
    /// What the person said, lower case: their own words, and what they pasted (quoted lines, code blocks).
    said: Vec<String>,
    pasted: Vec<String>,
    /// The accounts the Navi read the person's data as: each value of an [`ACTING_AS`] key in its reads' calls.
    accounts: Vec<String>,
}

impl Sources {
    fn new(person: &[String], reads: &[Read], person_emails: &[String]) -> Self {
        let (mut said, mut pasted) = (Vec::new(), Vec::new());
        for m in person {
            let mut fenced = false;
            for line in m.lines() {
                let t = line.trim_start();
                if t.starts_with("```") {
                    fenced = !fenced;
                    continue;
                }
                if fenced || t.starts_with('>') {
                    pasted.push(norm(t.trim_start_matches('>')));
                } else {
                    said.push(norm(line));
                }
            }
        }
        let mut own: Vec<(String, String)> = person_emails
            .iter()
            .map(|e| (e.clone(), "person's own address".to_owned()))
            .collect();
        let mut untrusted = Vec::new();
        for r in reads {
            let k = kind(&r.source);
            let header_source = match k {
                Kind::Contacts => Some("contacts"),
                // Anyone can send an invite: its attendees are no one the person chose.
                Kind::Calendar => None,
                Kind::Sent => Some("sent_mail"),
                Kind::Mail => Some("thread"),
                _ => None,
            };
            if k == Kind::Contacts {
                for e in emails(&r.text) {
                    own.push((e, "contacts".to_owned()));
                }
                continue;
            }
            if let Some(source) = header_source {
                for e in header_addresses(&r.text) {
                    own.push((e, source.to_owned()));
                }
            }
            if k == Kind::File {
                for line in r
                    .text
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty() && l.len() < 300)
                {
                    own.push((norm(line), "person's files".to_owned()));
                }
            }
            untrusted.push((norm(&r.text), label(k, r)));
        }
        let mut accounts: Vec<String> = reads
            .iter()
            .flat_map(|r| ACCOUNT_IN_CALL.captures_iter(&r.source))
            .filter(|c| ACTING_AS.contains(&&c[1]))
            .map(|c| c[2].to_lowercase())
            .collect();
        accounts.sort();
        accounts.dedup();
        Sources {
            own,
            untrusted,
            said,
            pasted,
            accounts,
        }
    }

    /// Every source of a short value: the person first, then their own data, then untrusted content; `navi` when none.
    fn of(&self, value: &str) -> Vec<String> {
        let v = norm(value);
        let mut out: Vec<String> = Vec::new();
        fn add(out: &mut Vec<String>, s: &str) {
            if !out.iter().any(|o| o == s) {
                out.push(s.to_owned());
            }
        }
        if v.is_empty() {
            return vec!["navi".to_owned()];
        }
        if self.said.iter().any(|m| m.contains(&v)) {
            add(&mut out, "person");
        }
        if self.pasted.iter().any(|m| m.contains(&v)) {
            add(&mut out, "person (pasted text)");
        }
        for (own, source) in &self.own {
            if *own == v || (v.len() >= 6 && own.contains(&v) && source == "person's files") {
                add(&mut out, source);
            }
        }
        let a_file = out.iter().any(|s| s == "person's files");
        for (text, label) in &self.untrusted {
            // A file's own name in a listing is the person's file, not something a file said.
            if text.contains(&v) && !(a_file && label == "a file") {
                add(&mut out, &format!("untrusted: {label}"));
            }
        }
        if out.is_empty() {
            out.push("navi".to_owned());
        }
        out
    }

    /// The spans of `text` (its sentences and lines) that untrusted content holds, and those the person said.
    fn spans(&self, text: &str) -> (Vec<String>, Vec<String>) {
        let (mut quoted, mut said) = (Vec::new(), Vec::new());
        for span in text.split(['\n', '.', '!', '?']).map(str::trim) {
            if span.chars().count() < SPAN_MIN {
                continue;
            }
            let n = norm(span);
            if self.said.iter().chain(&self.pasted).any(|m| m.contains(&n)) {
                said.push(clip(span, 300));
            } else if self.untrusted.iter().any(|(t, _)| t.contains(&n)) {
                quoted.push(clip(span, 300));
            }
        }
        (quoted, said)
    }
}

/// The header blocks of a plain-text read, one per mail. A mail starts at the top and after each separator line
/// (`---`), and its first paragraph is its headers; in a list with only blank lines between mails, a later paragraph
/// made only of header lines, one of them a `From:`, starts another. Nothing past the start of a quote
/// (`-----Original Message-----`, `On … wrote:`) counts, to the end of the read: a quote is someone else's mail,
/// headers, separators and all, and no line of it can say where it ends. A later mail's headers lost to it cost an ask.
/// A line quoted with `>` is no header line.
fn heads(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut block: Vec<&str> = Vec::new();
    let mut first = true;
    let mut flush = |block: &mut Vec<&str>, first: &mut bool| {
        if block.is_empty() {
            return;
        }
        let head = block.join("\n");
        let all_headers = block
            .iter()
            .all(|l| HEADER_LINE.is_match(l) || l.starts_with([' ', '\t']));
        if *first || (all_headers && FROM_LINE.is_match(&head)) {
            out.push(head);
        }
        *first = false;
        block.clear();
    };
    for line in text.lines() {
        if SEPARATOR.is_match(line) {
            flush(&mut block, &mut first);
            first = true;
        } else if line.trim().is_empty() {
            flush(&mut block, &mut first);
        } else if !HEADER_LINE.is_match(line) && QUOTE_START.is_match(line) {
            return out;
        } else {
            block.push(line);
        }
    }
    flush(&mut block, &mut first);
    out
}

/// The addresses in a mail's or an event's headers: the header lines of each of its mails ([`heads`]: a "From:" line
/// in a body or a quote is anyone's text), and the address keys of its JSON.
fn header_addresses(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for head in heads(text) {
        for c in HEADER.captures_iter(&head) {
            out.extend(emails(&c[2]));
        }
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        for (at, value) in leaves(&v) {
            let key = at.rsplit('.').next().unwrap_or(&at);
            let key = key.split('[').next().unwrap_or(key).to_ascii_lowercase();
            if [
                "from",
                "to",
                "cc",
                "bcc",
                "reply_to",
                "replyto",
                "sender",
                "organizer",
                "attendees",
                "email",
                "address",
                "participants",
            ]
            .contains(&key.as_str())
            {
                out.extend(emails(&value));
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// `an email from sam@example.org`, `a web page on example.org`.
fn label(k: Kind, r: &Read) -> String {
    let sender = FROM_LINE
        .captures(&r.text)
        .and_then(|c| emails(&c[2]).into_iter().next())
        .or_else(|| {
            let v: Value = serde_json::from_str(&r.text).ok()?;
            leaves(&v)
                .into_iter()
                .find(|(at, _)| {
                    at.ends_with("from") || at.ends_with("sender") || at.ends_with("organizer")
                })
                .and_then(|(_, value)| emails(&value).into_iter().next())
        });
    let from = sender.map(|s| format!(" from {s}")).unwrap_or_default();
    match k {
        Kind::Mail | Kind::Sent => format!("an email{from}"),
        Kind::Calendar => format!("a calendar invite{from}"),
        Kind::Telegram => format!("a Telegram message{from}"),
        Kind::Web => match URL
            .find(&r.source)
            .and_then(|u| crate::hub::navi::sites::site_of(u.as_str()))
        {
            Some(site) => format!("a web page on {site}"),
            None => "a web page".to_owned(),
        },
        Kind::File => "a file".to_owned(),
        Kind::Contacts | Kind::Other => "content the Navi read".to_owned(),
    }
}

/// The person's own addresses (the sender of each of their sent mails, from a tool whose name says it reads the sent
/// folder) and the addresses of their contacts (a contact list, their sent mail) in what the Navi read. Nothing the
/// action itself says counts, nor a thread's or an invite's addresses: the Navi writes the one, anyone the others.
pub fn known(person: &[String], reads: &[Read]) -> (Vec<String>, Vec<String>) {
    let mut mine: Vec<String> = Vec::new();
    for r in reads.iter().filter(|r| kind(&r.source) == Kind::Sent) {
        // Each sent mail's own sender, never one in a quote of the mail it answered.
        for head in heads(&r.text) {
            if let Some(c) = FROM_LINE.captures(&head) {
                mine.extend(emails(&c[2]));
            }
        }
        if let Ok(v) = serde_json::from_str::<Value>(&r.text) {
            for (at, value) in leaves(&v) {
                if key(&at) == "from" {
                    mine.extend(emails(&value));
                }
            }
        }
    }
    mine.sort();
    mine.dedup();
    let sources = Sources::new(person, reads, &mine);
    let mut contacts: Vec<String> = sources
        .own
        .iter()
        .filter(|(v, s)| {
            ["contacts", "sent_mail", "person's own address"].contains(&s.as_str())
                && EMAIL.is_match(v)
        })
        .map(|(v, _)| v.clone())
        .collect();
    contacts.sort();
    contacts.dedup();
    contacts.truncate(500);
    (mine, contacts)
}

/// The action's provenance: each field of its input (an address or short value by its value, text span by span),
/// and for a visit, its URL's host, path and query.
pub fn provenance(
    input: &Value,
    url: Option<&str>,
    person: &[String],
    reads: &[Read],
    allowed: &[String],
) -> Vec<Provenance> {
    let sources = Sources::new(person, reads, &known(person, reads).0);
    let mut out = Vec::new();
    if let Some(url) = url
        && let Ok(parsed) = url::Url::parse(url)
    {
        let host = parsed.host_str().unwrap_or_default().to_lowercase();
        let site = crate::hub::navi::sites::site_of(url).unwrap_or_else(|| host.clone());
        let mut from = sources.of(url);
        if from == ["navi"] {
            from = sources.of(&host);
        }
        if allowed.contains(&site) {
            from.retain(|s| s != "navi");
            from.insert(0, format!("allowed site {site}"));
        }
        out.push(Provenance {
            part: "url.host".to_owned(),
            sources: from,
            value: Some(host),
            ..Default::default()
        });
        let rest = format!(
            "{}{}",
            parsed.path(),
            parsed.query().map(|q| format!("?{q}")).unwrap_or_default()
        );
        if rest.len() > 1 {
            let decoded: String = url::form_urlencoded::parse(rest.replace('?', "&").as_bytes())
                .map(|(k, v)| format!("{k} {v}"))
                .collect::<Vec<_>>()
                .join("\n");
            let (quoted, said) = sources.spans(&decoded.replace(['&', '='], "\n"));
            out.push(Provenance {
                part: "url.path_and_query".to_owned(),
                sources: if sources.of(&rest) == ["navi"] {
                    vec!["navi".to_owned()]
                } else {
                    sources.of(&rest)
                },
                value: Some(clip(&rest, 500)),
                quoted_from_untrusted: quoted,
                from_person: said,
            });
        }
    }
    for (at, text) in leaves(input) {
        if text.trim().is_empty()
            || (url.is_some() && URL.is_match(&text) && text.contains(url.unwrap_or("\u{0}")))
        {
            continue;
        }
        if text.chars().count() < TEXT_MIN
            || EMAIL
                .find(&text)
                .is_some_and(|m| m.as_str().len() + 40 > text.len())
        {
            let mut from = sources.of(&text);
            if ACTING_AS.contains(&key(&at).as_str())
                && sources.accounts.contains(&text.trim().to_lowercase())
            {
                from.push(ACCOUNT.to_owned());
            }
            out.push(Provenance {
                part: at.clone(),
                sources: from,
                value: Some(text.clone()),
                ..Default::default()
            });
            continue;
        }
        let whole = sources.of(&text);
        let (quoted, said) = sources.spans(&text);
        out.push(Provenance {
            part: at.clone(),
            sources: if whole.iter().any(|s| s.starts_with("person")) {
                whole
            } else {
                vec!["navi".to_owned()]
            },
            value: None,
            quoted_from_untrusted: quoted,
            from_person: said,
        });
        // An address inside a text is a part of its own.
        for e in emails(&text) {
            out.push(Provenance {
                part: format!("address in {at}"),
                sources: sources.of(&e),
                value: Some(e),
                ..Default::default()
            });
        }
    }
    out
}

/// The URL of a visit: its `url`, or the one in its browser command.
pub fn visit_url(input: &Value) -> Option<String> {
    if let Some(u) = input.get("url").and_then(Value::as_str) {
        return Some(u.to_owned());
    }
    let command = input.get("command").and_then(Value::as_str)?;
    URL.find(command)
        .map(|m| m.as_str().trim_end_matches('\'').to_owned())
}

/// Whether `url` carries data: an email address, a long base64 or hex blob, or text quoted from what the Navi read.
/// An allowed site still goes through the checker for such a URL.
pub fn carries_data(url: &str, quoted: &[String]) -> bool {
    let decoded: String = url::form_urlencoded::parse(url.replace('?', "&").as_bytes())
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let decoded = format!("{decoded} {}", url.replace("%40", "@"));
    EMAIL.is_match(&decoded) || blob(url) || !quoted.is_empty()
}

/// The name a part's key ends in: `to` for `to[0]`, `body` for `message.body`.
fn key(part: &str) -> String {
    let last = part.rsplit('.').next().unwrap_or(part);
    last.split('[').next().unwrap_or(last).to_ascii_lowercase()
}

/// Keys that name who or where an action reaches.
const DESTINATIONS: &[&str] = &[
    "to",
    "cc",
    "bcc",
    "recipient",
    "recipients",
    "attendees",
    "invitees",
    "guests",
    "with",
    "share_with",
    "emailaddress",
    "email_address",
    "emails",
    "forward_to",
    "forwardto",
    "forward",
    "members",
    "users",
    "host",
];

/// Keys that can name which of the person's own accounts a tool acts as. On a send or an invite they may name whom it
/// reaches.
const ACTING_AS: &[&str] = &[
    "account",
    "account_id",
    "accountid",
    "mailbox",
    "user_id",
    "userid",
];
/// The source of an [`ACTING_AS`] value the Navi already read the person's data as. It vouches for no recipient.
const ACCOUNT: &str = "an account the Navi read the person's data as";
/// An [`ACTING_AS`] key's value in a read's call: `"account":"sam@example.org"`, at any depth, in a cut call too.
static ACCOUNT_IN_CALL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""([A-Za-z_]+)"\s*:\s*"([^"]+)""#).unwrap());

/// Keys of [`ACTING_AS`] that only ever pick the account a tool acts as, on a send too: its sender.
const SENDER: &[&str] = &["account", "account_id", "accountid", "mailbox"];

/// Whether a part names whom or where the action reaches. An [`ACTING_AS`] key whose value the Navi already read the
/// person's data as picks the account the tool acts in, and reaches no one: a [`SENDER`] key on any action, a
/// `user_id` only on a write to the person's own data (on a send it may be whom it messages).
fn is_destination(p: &Provenance, confirm: bool, write: bool) -> bool {
    let k = key(&p.part);
    if ACTING_AS.contains(&k.as_str())
        && (write || SENDER.contains(&k.as_str()))
        && p.sources.iter().any(|s| s == ACCOUNT)
    {
        return false;
    }
    DESTINATIONS.contains(&k.as_str())
        // A final confirm reaches the site it is on.
        || (confirm && p.part == "site")
        || p.part == "url"
        || p.value.as_deref().is_some_and(|v| {
            let v = v.trim();
            EMAIL.find(v).is_some_and(|m| m.as_str().len() == v.len())
                && !p.part.starts_with("address in")
        })
}

/// Content anyone could have written, or a contact the Navi made from it.
fn untrusted(source: &str) -> bool {
    source.starts_with("untrusted") || source.contains("from an email")
}

/// A source of the person's own: anything but untrusted content and the Navi.
fn own(source: &str) -> bool {
    !untrusted(source) && source != "navi" && source != ACCOUNT
}

/// The addresses an action reaches: each destination's value, and every address in a list part.
fn destination_emails(review: &Review) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (at, v) in leaves(&review.action) {
        if DESTINATIONS.contains(&key(&at).as_str()) {
            for e in emails(&v) {
                if !out.contains(&e) {
                    out.push(e);
                }
            }
        }
    }
    out
}

fn tool_text(review: &Review) -> String {
    let get = |k: &str| {
        review
            .action
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    format!("{} {}", get("tool"), get("kind"))
}

fn domain(email: &str) -> &str {
    email.rsplit('@').next().unwrap_or_default()
}

fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut prev = row[0];
        row[0] = i;
        for j in 1..=b.len() {
            let cur = row[j];
            row[j] = (row[j] + 1)
                .min(row[j - 1] + 1)
                .min(prev + usize::from(a[i - 1] != b[j - 1]));
            prev = cur;
        }
    }
    row[b.len()]
}

/// What fleetd decides whatever the checker says: `Block` for a floor, `Ask` for a minimum ask, with why.
/// The floors, refused in every mode, YOLO's too: moving money or trading by the tool's name or by a link that
/// performs it (its path says transfer or trade and its query carries the amount), and what looks like a password, key
/// or token anywhere in what goes out, a link it opens included. Why, or None. A link that only mentions money or
/// trading ("bitcoin", "register") is reading, and follows the mode like any other.
/// `action` is the tool's input with its `tool` (and `kind`) beside it.
pub fn floor(action: &Value) -> Option<&'static str> {
    let tool = format!(
        "{} {}",
        action
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        action
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
    );
    if let Some(n) = policy::never(&tool) {
        return Some(n.why());
    }
    // A link that performs a transfer or a trade: its path says so and its query carries the amount.
    if let Some(url) = visit_url(action).and_then(|u| url::Url::parse(&u).ok()) {
        let amount = url.query_pairs().any(|(k, _)| {
            [
                "amount", "amt", "sum", "value", "qty", "quantity", "shares", "units",
            ]
            .contains(&k.to_ascii_lowercase().as_str())
        });
        if amount
            && let Some(n) = policy::never(&format!(
                "{} {}",
                url.path(),
                url.query().unwrap_or_default()
            ))
            .filter(|n| matches!(n, policy::Never::Money | policy::Never::Trading))
        {
            return Some(n.why());
        }
    }
    let credential = leaves(action)
        .into_iter()
        .filter(|(at, _)| !["tool", "kind"].contains(&at.as_str()))
        .any(|(_, v)| {
            let decoded: String = url::form_urlencoded::parse(v.as_bytes())
                .map(|(k, v)| format!("{k}={v} "))
                .collect();
            [v.as_str(), decoded.as_str()]
                .iter()
                .any(|t| SECRET.is_match(t) || crate::hub::redact::redact(t) != *t)
        });
    credential.then_some(policy::Never::Credential.why())
}

pub fn rules(review: &Review) -> Option<CheckerNote> {
    let tool = tool_text(review);
    let url = visit_url(&review.action);
    if let Some(why) = floor(&review.action) {
        return Some(note(CheckerVerdict::Block, why));
    }
    let outgoing: Vec<String> = leaves(&review.action)
        .into_iter()
        .filter(|(at, _)| !["tool", "kind"].contains(&at.as_str()))
        .map(|(_, v)| v)
        .collect();
    // A one-time code, or an encoded blob, in what goes out.
    if outgoing.iter().any(|v| ONE_TIME_CODE.is_match(v)) {
        return Some(ask("it sends what looks like a one-time code"));
    }
    if url.is_none() && outgoing.iter().any(|v| ENCODED.is_match(v)) {
        return Some(ask("it sends an encoded blob nobody can read"));
    }
    // A destination only untrusted content named.
    let confirm = review.action.get("kind").and_then(Value::as_str) == Some("confirm_step");
    let write = review.action.get("kind").and_then(Value::as_str) == Some("write");
    for p in review
        .provenance
        .iter()
        .filter(|p| is_destination(p, confirm, write))
    {
        if p.sources.iter().any(|s| untrusted(s)) && !p.sources.iter().any(|s| own(s)) {
            let what = p.value.clone().unwrap_or_else(|| p.part.clone());
            return Some(ask(&format!(
                "{what} came only from content the Navi read, not from you"
            )));
        }
    }
    // A URL that carries data, even on an allowed site.
    if let Some(u) = &url {
        let quoted: Vec<String> = review
            .provenance
            .iter()
            .filter(|p| p.part.starts_with("url"))
            .flat_map(|p| p.quoted_from_untrusted.clone())
            .collect();
        if carries_data(u, &quoted) {
            return Some(ask(
                "the link carries data: an address, a long code or text from your mail",
            ));
        }
    }
    // Shares.
    let fields = leaves(&review.action);
    let field = |names: &[&str]| -> Vec<String> {
        fields
            .iter()
            .filter(|(at, _)| names.contains(&key(at).as_str()))
            .map(|(_, v)| v.to_ascii_lowercase())
            .collect()
    };
    if field(&[
        "link_sharing",
        "visibility",
        "general_access",
        "access",
        "type",
        "scope",
    ])
    .iter()
    .any(|v| {
        [
            "anyone",
            "anyone_with_link",
            "anyonewithlink",
            "public",
            "domain",
        ]
        .contains(&v.as_str())
    }) {
        return Some(ask("it shares with anyone who has the link, or publicly"));
    }
    let editor = field(&["role", "permission", "access_level"])
        .iter()
        .any(|v| {
            [
                "editor",
                "writer",
                "owner",
                "organizer",
                "fileorganizer",
                "edit",
                "admin",
            ]
            .contains(&v.as_str())
        });
    let known = |e: &str| {
        review.provenance.iter().any(|p| {
            p.value.as_deref().map(str::to_lowercase).as_deref() == Some(e)
                && p.sources.iter().any(|s| {
                    s.starts_with("contacts") && own(s) || s == "thread" || s.starts_with("person")
                })
        }) || contact_emails(review).iter().any(|c| c == e)
    };
    let reached = destination_emails(review);
    if editor && reached.iter().any(|e| !known(e)) {
        return Some(ask("it gives edit access to someone new"));
    }
    // A forwarding rule or filter to another domain.
    let tw = policy::words(&tool);
    if tw.iter().any(|w| {
        [
            "filter",
            "rule",
            "forward_rule",
            "autoforward",
            "forwarding",
        ]
        .contains(&w.as_str())
    }) || review.action.get("kind").and_then(Value::as_str) == Some("forward_rule")
    {
        let own_domains: Vec<String> = person_emails(review)
            .iter()
            .map(|e| domain(e).to_owned())
            .collect();
        if reached
            .iter()
            .any(|e| !own_domains.iter().any(|d| d == domain(e)))
        {
            return Some(ask(
                "it sets a rule that forwards your mail to another address",
            ));
        }
    }
    // A lookalike of a contact's domain.
    let contact_domains: Vec<String> = contact_emails(review)
        .iter()
        .map(|e| domain(e).to_owned())
        .collect();
    for e in &reached {
        let d = domain(e);
        if !contact_domains.iter().any(|c| c == d)
            && contact_domains
                .iter()
                .any(|c| (1..=2).contains(&distance(c, d)))
        {
            return Some(ask(&format!(
                "{d} looks like one of your contacts' domains, but isn't"
            )));
        }
    }
    if reached.len() > BULK {
        return Some(ask(&format!("it reaches {} people at once", reached.len())));
    }
    None
}

fn contact_emails(review: &Review) -> Vec<String> {
    review
        .contacts
        .iter()
        .flat_map(|c| emails(&c.to_string()))
        .collect()
}

fn person_emails(review: &Review) -> Vec<String> {
    emails(&review.person.to_string())
}

fn ask(reason: &str) -> CheckerNote {
    note(CheckerVerdict::Ask, reason)
}

pub fn note(verdict: CheckerVerdict, reason: &str) -> CheckerNote {
    let reason = reason.split_whitespace().collect::<Vec<_>>().join(" ");
    CheckerNote {
        verdict,
        reason: Line::new(clip(&reason, 300))
            .unwrap_or_else(|_| Line::unchecked("no reason given")),
    }
}

/// How the checker's turn ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    /// Its reply.
    Reply(String),
    /// It refused to answer (a safety refusal): it tracks attacks closely.
    Refused,
    /// It failed or ran past its time.
    Failed(String),
}

/// Claude Code's words for a reply the model refused.
pub fn refused(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("usage policy") || t.contains("unable to respond to this request")
}

#[derive(Deserialize)]
struct Reply {
    verdict: String,
    reason: String,
}

/// The verdict in the checker's reply: its one JSON object, fenced or not. None for anything else.
pub fn parse(reply: &str) -> Option<CheckerNote> {
    let (start, end) = (reply.find('{')?, reply.rfind('}')?);
    let reply: Reply = serde_json::from_str(reply.get(start..=end)?).ok()?;
    let verdict = match reply.verdict.trim().to_ascii_lowercase().as_str() {
        "go" => CheckerVerdict::Go,
        "ask" => CheckerVerdict::Ask,
        "block" => CheckerVerdict::Block,
        _ => return None,
    };
    let reason = reply.reason.trim();
    (!reason.is_empty()).then(|| note(verdict, reason))
}

fn rank(v: CheckerVerdict) -> u8 {
    match v {
        CheckerVerdict::Go => 0,
        CheckerVerdict::Ask => 1,
        CheckerVerdict::Block => 2,
    }
}

/// The verdict: the code rules' floor and minimum, and the checker's answer above them. A refusal, a failure or an
/// answer that can't be read asks.
pub fn decide(review: &Review, answer: &Answer) -> CheckerNote {
    let model = match answer {
        Answer::Refused => ask("the checker flagged this as a likely attack"),
        Answer::Failed(why) => ask(&format!("the checker didn't answer ({why}), so you decide")),
        Answer::Reply(text) if refused(text) => ask("the checker flagged this as a likely attack"),
        Answer::Reply(text) => parse(text)
            .unwrap_or_else(|| ask("the checker's answer couldn't be read, so you decide")),
    };
    match rules(review) {
        Some(rule) if rank(rule.verdict) > rank(model.verdict) => rule,
        _ => model,
    }
}
