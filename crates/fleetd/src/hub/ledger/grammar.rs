//! The terse reply grammar (m3-spec "Reply grammar"). Pure: `parse_reply` reads text into a plan, `resolve_plan`
//! checks the plan against a batch's items. Neither touches state; the inbox applies the result.
//!
//! ```text
//! reply := item ((";"|","|newline|" ") item)*
//! item  := sel verb [note] | "recs" ["fine"|"ok"] | "all" verb | "#B" n (first only) | "pref:" text | "forget" Dn
//! sel   := n | n "-" n | sel "," sel
//! verb  := go|yes|y|ok|rec|recs | no|nvm|drop|skip|n | a-f | done | later | ":" text | "quoted text"
//! note  := ":" text | "quoted text"        (kept as the decision's why)
//! ```
//!
//! Free text after ":" (and after "pref:") runs to the end of the line or the next ";".
use std::collections::{HashMap, HashSet};

use fleetd_contracts::ledger::{Ask, AskClass, AskKind, AskState};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verb {
    Accept,
    Reject,
    Option(usize),
    Done,
    Later,
    Text(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanItem {
    pub number: u64,
    pub verb: Verb,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReplyPlan {
    /// From a leading "#B<n>".
    pub batch: Option<u64>,
    /// One per mentioned item number, in reply order.
    pub items: Vec<PlanItem>,
    /// "recs fine" or "all <verb>": applies to every open item the reply does not mention.
    pub rest: Option<Verb>,
    pub prefs: Vec<String>,
    /// Decision numbers from "forget Dn".
    pub forgets: Vec<u64>,
}

pub const GRAMMAR_HINT: &str = r##"Reply like "1 go 2 nvm 3 b", "1-3 go", "recs fine", "2: your own answer", "#B4 1 go", "pref: <text>" or "forget D12"."##;

const MAX_TEXT: usize = 2000;
const MAX_NUMBER: u64 = 999;
const LETTERS: &str = "abcdef";

fn verb_word(word: &str) -> Option<Verb> {
    Some(match word {
        "go" | "yes" | "y" | "ok" | "rec" | "recs" => Verb::Accept,
        "no" | "nvm" | "drop" | "skip" | "n" => Verb::Reject,
        "done" => Verb::Done,
        "later" => Verb::Later,
        w if w.len() == 1 && LETTERS.contains(w) => Verb::Option(LETTERS.find(w)?),
        _ => return None,
    })
}

/// `Ok(plan)`, or `Err(hint)` naming what could not be read, followed by [`GRAMMAR_HINT`].
pub fn parse_reply(raw: &str) -> Result<ReplyPlan, String> {
    Parser { raw, pos: 0 }
        .parse()
        .map_err(|message| format!("{message} {GRAMMAR_HINT}"))
}

/// JavaScript's `\s` with the `u` flag.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JavaScript's `String.prototype.trim`.
fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `Number(digits)` for comparison: digits too long for u64 are larger than any bound we check.
fn digits_value(text: &str) -> u64 {
    text.parse().unwrap_or(u64::MAX)
}

struct Parser<'a> {
    raw: &'a str,
    pos: usize,
}

type Step<T> = Result<T, String>;

impl<'a> Parser<'a> {
    fn rest(&self) -> &'a str {
        &self.raw[self.pos..]
    }
    fn peek(&self) -> Option<char> {
        self.rest().chars().next()
    }
    fn skip_while(&mut self, f: impl Fn(char) -> bool) -> &'a str {
        let rest = self.rest();
        let len = rest.find(|c: char| !f(c)).unwrap_or(rest.len());
        self.pos += len;
        &rest[..len]
    }
    fn skip_blanks(&mut self) {
        self.skip_while(|c| c == ' ' || c == '\t');
    }
    fn eat_char(&mut self, c: char) -> bool {
        if self.peek() == Some(c) {
            self.pos += c.len_utf8();
            true
        } else {
            false
        }
    }
    /// Case-insensitive ASCII keyword at `pos`; does not advance on a miss.
    fn eat_keyword(&mut self, word: &str) -> bool {
        let rest = self.rest().as_bytes();
        if rest.len() >= word.len() && rest[..word.len()].eq_ignore_ascii_case(word.as_bytes()) {
            self.pos += word.len();
            true
        } else {
            false
        }
    }
    fn next_is(&self, f: impl Fn(char) -> bool) -> bool {
        self.peek().is_some_and(f)
    }
    fn digits(&mut self) -> &'a str {
        self.skip_while(|c| c.is_ascii_digit())
    }

    fn snippet(&self) -> String {
        let first = self
            .rest()
            .split(|c: char| is_js_space(c) || c == ';' || c == ',')
            .next()
            .unwrap_or("");
        if !first.is_empty() {
            return first.to_string();
        }
        // raw.slice(pos, pos + 12), in UTF-16 units.
        let units: Vec<u16> = self.rest().encode_utf16().take(12).collect();
        String::from_utf16_lossy(&units)
    }

    /// Text up to the end of the line or the next ";".
    fn line_text(&mut self, what: &str) -> Step<String> {
        let text = js_trim(self.skip_while(|c| c != ';' && c != '\n'));
        if text.is_empty() {
            return Err(format!("{what} is empty."));
        }
        if js_len(text) > MAX_TEXT {
            return Err(format!("{what} is longer than {MAX_TEXT} characters."));
        }
        Ok(text.to_string())
    }

    fn quoted(&mut self) -> Step<Option<String>> {
        let close = match self.peek() {
            Some('"') => '"',
            Some('“') => '”',
            _ => return Ok(None),
        };
        let open_len = self.peek().map_or(0, char::len_utf8);
        let body_start = self.pos + open_len;
        let Some(end) = self.raw[body_start..].find(close) else {
            return Err("A quote is not closed.".into());
        };
        let text = js_trim(&self.raw[body_start..body_start + end]);
        self.pos = body_start + end + close.len_utf8();
        if text.is_empty() {
            return Err("A quoted answer is empty.".into());
        }
        if js_len(text) > MAX_TEXT {
            return Err(format!("An answer is longer than {MAX_TEXT} characters."));
        }
        Ok(Some(text.to_string()))
    }

    fn number(text: &str) -> Step<u64> {
        let n = digits_value(text);
        if !(1..=MAX_NUMBER).contains(&n) {
            return Err(format!("There is no item {text}."));
        }
        Ok(n)
    }

    /// n, n-n, and comma lists of either.
    fn selection(&mut self) -> Step<Vec<u64>> {
        let mut numbers = Vec::new();
        loop {
            let from = Self::number(self.digits())?;
            let before = self.pos;
            self.skip_blanks();
            let to = if self.eat_char('-') {
                self.skip_blanks();
                if self.next_is(|c| c.is_ascii_digit()) {
                    Self::number(self.digits())?
                } else {
                    self.pos = before;
                    from
                }
            } else {
                self.pos = before;
                from
            };
            if to < from {
                return Err(format!("The range {from}-{to} runs backwards."));
            }
            if to - from >= 100 {
                return Err(format!("The range {from}-{to} is too long."));
            }
            numbers.extend(from..=to);
            // [ \t]*,[ \t]*(?=\d)
            let before = self.pos;
            self.skip_blanks();
            if self.eat_char(',') {
                self.skip_blanks();
                if self.next_is(|c| c.is_ascii_digit()) {
                    continue;
                }
            }
            self.pos = before;
            return Ok(numbers);
        }
    }

    /// A verb; `subject` names what it answers, for hints.
    fn verb(&mut self, subject: &str) -> Step<Verb> {
        self.skip_blanks();
        if self.eat_char(':') {
            return Ok(Verb::Text(
                self.line_text(&format!("The answer to {subject}"))?,
            ));
        }
        if let Some(text) = self.quoted()? {
            return Ok(Verb::Text(text));
        }
        let word = self.skip_while(|c| c.is_ascii_alphabetic());
        if word.is_empty() {
            return Err(format!(
                r#"{subject} needs an answer such as go, nvm, a, done, later or ": text"."#
            ));
        }
        let lower = word.to_ascii_lowercase();
        let Some(found) = verb_word(&lower) else {
            return Err(format!(r#""{word}" is not an answer word."#));
        };
        if lower == "recs" {
            // [ \t]+(?:fine|ok)(?![a-z])
            let before = self.pos;
            let blanks = self.skip_while(|c| c == ' ' || c == '\t');
            let tail = !blanks.is_empty() && (self.eat_keyword("fine") || self.eat_keyword("ok"));
            if !tail || self.next_is(|c| c.is_ascii_alphabetic()) {
                self.pos = before;
            }
        }
        Ok(found)
    }

    /// An optional `: why` or quoted why after a word verb.
    fn note(&mut self) -> Step<Option<String>> {
        let before = self.pos;
        self.skip_blanks();
        if self.eat_char(':') {
            return self.line_text("The note").map(Some);
        }
        if let Some(text) = self.quoted()? {
            return Ok(Some(text));
        }
        self.pos = before;
        Ok(None)
    }

    /// `word` (case-insensitive) not followed by `[a-z]`, or by `[a-z0-9]` when `no_digit`.
    fn eat_word(&mut self, word: &str, no_digit: bool) -> bool {
        let before = self.pos;
        if self.eat_keyword(word)
            && !self.next_is(|c| c.is_ascii_alphabetic() || (no_digit && c.is_ascii_digit()))
        {
            return true;
        }
        self.pos = before;
        false
    }

    fn parse(mut self) -> Step<ReplyPlan> {
        let mut plan = ReplyPlan::default();
        let mut seen = HashSet::new();
        let mut first = true;
        let set_rest = |plan: &mut ReplyPlan, next: Verb| -> Step<()> {
            if plan.rest.is_some() {
                return Err(r#"Use only one of "recs fine" and "all <answer>"."#.into());
            }
            plan.rest = Some(next);
            Ok(())
        };

        loop {
            self.skip_while(|c| is_js_space(c) || c == ',' || c == ';');
            if self.pos >= self.raw.len() {
                break;
            }
            let start = self.pos;
            if self.eat_keyword("#b") {
                self.skip_blanks();
                let digits = self.digits();
                if !digits.is_empty() && !self.next_is(|c| c.is_ascii_alphanumeric()) {
                    if !first {
                        return Err("#B<n> must come first.".into());
                    }
                    let batch = digits_value(digits);
                    if batch < 1 {
                        return Err("There is no batch B0.".into());
                    }
                    plan.batch = Some(batch);
                    first = false;
                    continue;
                }
                self.pos = start;
            }
            if self.eat_keyword("pref") {
                self.skip_blanks();
                if self.eat_char(':') {
                    plan.prefs.push(self.line_text("The preference")?);
                    first = false;
                    continue;
                }
                self.pos = start;
            }
            if self.eat_keyword("forget") {
                let blanks = self.skip_while(|c| c == ' ' || c == '\t');
                if !blanks.is_empty() && self.eat_keyword("d") {
                    let digits = self.digits();
                    if !digits.is_empty() && !self.next_is(|c| c.is_ascii_alphanumeric()) {
                        let n = digits_value(digits);
                        if n < 1 {
                            return Err("There is no decision D0.".into());
                        }
                        plan.forgets.push(n);
                        first = false;
                        continue;
                    }
                }
                self.pos = start;
                if self.eat_word("forget", false) {
                    return Err(r#""forget" needs a decision id, like "forget D12"."#.into());
                }
            }
            if self.eat_keyword("recs") {
                // recs(?:[ \t]+(?:fine|ok))?(?![a-z0-9])
                let after_recs = self.pos;
                let blanks = self.skip_while(|c| c == ' ' || c == '\t');
                let tail =
                    !blanks.is_empty() && (self.eat_keyword("fine") || self.eat_keyword("ok"));
                if !tail || self.next_is(|c| c.is_ascii_alphanumeric()) {
                    self.pos = after_recs;
                }
                if !self.next_is(|c| c.is_ascii_alphanumeric()) {
                    set_rest(&mut plan, Verb::Accept)?;
                    first = false;
                    continue;
                }
                self.pos = start;
            }
            if self.eat_word("all", false) {
                let verb = self.verb(r#""all""#)?;
                set_rest(&mut plan, verb)?;
            } else if self.next_is(|c| c.is_ascii_digit()) {
                let numbers = self.selection()?;
                let subject = format!(
                    "Item {}",
                    numbers
                        .iter()
                        .map(u64::to_string)
                        .collect::<Vec<_>>()
                        .join(",")
                );
                let verb = self.verb(&subject)?;
                let why = if matches!(verb, Verb::Text(_)) {
                    None
                } else {
                    self.note()?
                };
                for n in numbers {
                    if !seen.insert(n) {
                        return Err(format!("Item {n} is answered twice."));
                    }
                    plan.items.push(PlanItem {
                        number: n,
                        verb: verb.clone(),
                        note: why.clone(),
                    });
                }
            } else {
                return Err(format!(r#"Could not read "{}"."#, self.snippet()));
            }
            first = false;
        }

        if first {
            return Err("The reply is empty.".into());
        }
        Ok(plan)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Answer {
        number: u64,
        ask: Ask,
        value: String,
        note: Option<String>,
    },
    Withdraw {
        number: u64,
        ask: Ask,
    },
    Later {
        number: u64,
        ask: Ask,
    },
}

impl Action {
    pub fn number(&self) -> u64 {
        match self {
            Action::Answer { number, .. }
            | Action::Withdraw { number, .. }
            | Action::Later { number, .. } => *number,
        }
    }
    pub fn ask(&self) -> &Ask {
        match self {
            Action::Answer { ask, .. }
            | Action::Withdraw { ask, .. }
            | Action::Later { ask, .. } => ask,
        }
    }
}

fn state_text(state: &AskState) -> &'static str {
    match state {
        AskState::Open => "open",
        AskState::Auto => "auto",
        AskState::Answered => "answered",
        AskState::Defaulted => "defaulted",
        AskState::Withdrawn => "withdrawn",
    }
}

/// Checks `plan` against the batch's items and turns it into actions. An item is open when its ask is open and
/// still in this batch. "recs fine" skips open items with no recommendation (do-asks) and approve and secret asks;
/// every other mismatch refuses the whole reply with `Err(hint)`.
pub fn resolve_plan(
    plan: &ReplyPlan,
    batch_id: &str,
    items: &[(u64, Ask)],
) -> Result<Vec<Action>, String> {
    let by_number: HashMap<u64, &Ask> = items.iter().map(|(n, ask)| (*n, ask)).collect();
    let is_open =
        |ask: &Ask| ask.state == AskState::Open && ask.batch_id.as_deref() == Some(batch_id);
    let mut actions = Vec::new();
    let mut hints: Vec<String> = Vec::new();

    let act = |actions: &mut Vec<Action>,
               hints: &mut Vec<String>,
               number: u64,
               ask: &Ask,
               verb: &Verb,
               note: Option<&String>,
               from_rest: bool| {
        let answer = |actions: &mut Vec<Action>, value: String| {
            actions.push(Action::Answer {
                number,
                ask: ask.clone(),
                value,
                note: note.cloned(),
            })
        };
        // A stored command or a secret is never settled in bulk: "recs fine" and "all <answer>" pass over them.
        if from_rest && matches!(ask.kind, AskKind::Approve | AskKind::Secret) {
            return;
        }
        let rejects_or_later = matches!(verb, Verb::Reject | Verb::Later);
        if ask.kind == AskKind::Secret && !rejects_or_later {
            hints.push(format!(
                "Item {number} asks for a secret: enter it in the fleetd app, which seals it to its machine. Never put a secret in a reply."
            ));
            return;
        }
        if ask.kind == AskKind::Approve && !rejects_or_later {
            if *verb == Verb::Accept {
                return answer(actions, "go".into());
            }
            hints.push(format!(
                r#"Item {number} runs a stored command: reply "{number} go" to run it or "{number} no" to refuse it."#
            ));
            return;
        }
        match verb {
            Verb::Accept => match &ask.recommendation {
                None => {
                    if !from_rest {
                        hints.push(format!(
                            r#"Item {number} is a do-ask with no recommendation: reply "{number} done" once finished."#
                        ));
                    }
                }
                Some(rec) => answer(actions, rec.to_string()),
            },
            // A product call the human hands back is withdrawn ("your call"); a refused money, credential or
            // irreversible step is logged as "no" so it is not asked again.
            Verb::Reject => {
                if ask.class == AskClass::Product {
                    actions.push(Action::Withdraw {
                        number,
                        ask: ask.clone(),
                    });
                } else {
                    answer(actions, "no".into());
                }
            }
            Verb::Option(index) => {
                match ask.options.as_ref().and_then(|options| options.get(*index)) {
                    None => hints.push(format!(
                        "Item {number} has no option {}.",
                        &LETTERS[*index..*index + 1]
                    )),
                    Some(option) => answer(actions, option.to_string()),
                }
            }
            Verb::Done => {
                if ask.kind != AskKind::Do {
                    if !from_rest {
                        hints.push(format!(
                            r#"Item {number} is a question, not a checklist: answer it instead of "done"."#
                        ));
                    }
                } else {
                    answer(actions, "done".into());
                }
            }
            Verb::Later => actions.push(Action::Later {
                number,
                ask: ask.clone(),
            }),
            Verb::Text(text) => answer(actions, text.clone()),
        }
    };

    for item in &plan.items {
        match by_number.get(&item.number) {
            None => hints.push(format!("{batch_id} has no item {}.", item.number)),
            Some(ask) if !is_open(ask) => hints.push(format!(
                "Item {} of {batch_id} is already {}.",
                item.number,
                if ask.state == AskState::Open {
                    "moved"
                } else {
                    state_text(&ask.state)
                }
            )),
            Some(ask) => act(
                &mut actions,
                &mut hints,
                item.number,
                ask,
                &item.verb,
                item.note.as_ref(),
                false,
            ),
        }
    }
    if let Some(rest) = &plan.rest {
        let mentioned: HashSet<u64> = plan.items.iter().map(|item| item.number).collect();
        for (number, ask) in items {
            if !mentioned.contains(number) && is_open(ask) {
                act(&mut actions, &mut hints, *number, ask, rest, None, true);
            }
        }
    }
    if hints.is_empty() {
        Ok(actions)
    } else {
        Err(hints.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::ledger::{Ask, AskClass, AskKind, AskState};

    use Verb::{Accept as Go, Done, Later, Reject as Nvm};

    fn opt(i: usize) -> Verb {
        Verb::Option(i)
    }
    fn txt(t: &str) -> Verb {
        Verb::Text(t.into())
    }
    fn items(pairs: &[(u64, Verb)]) -> Vec<PlanItem> {
        pairs
            .iter()
            .map(|(n, v)| PlanItem {
                number: *n,
                verb: v.clone(),
                note: None,
            })
            .collect()
    }
    fn noted(n: u64, verb: Verb, note: &str) -> PlanItem {
        PlanItem {
            number: n,
            verb,
            note: Some(note.into()),
        }
    }
    fn plan(items: Vec<PlanItem>) -> ReplyPlan {
        ReplyPlan {
            items,
            ..Default::default()
        }
    }

    #[test]
    fn parses_every_form() {
        let cases: Vec<(&str, ReplyPlan)> = vec![
            ("1 go", plan(items(&[(1, Go)]))),
            (
                "1 go 2 nvm 3 recs fine",
                plan(items(&[(1, Go), (2, Nvm), (3, Go)])),
            ),
            ("1 yes", plan(items(&[(1, Go)]))),
            ("1 y", plan(items(&[(1, Go)]))),
            ("1 ok", plan(items(&[(1, Go)]))),
            ("1 rec", plan(items(&[(1, Go)]))),
            ("1 recs ok", plan(items(&[(1, Go)]))),
            ("1 GO", plan(items(&[(1, Go)]))),
            (
                "1 no 2 drop 3 skip 4 n",
                plan(items(&[(1, Nvm), (2, Nvm), (3, Nvm), (4, Nvm)])),
            ),
            (
                "1 a 2 b 3 f",
                plan(items(&[(1, opt(0)), (2, opt(1)), (3, opt(5))])),
            ),
            ("1a2b", plan(items(&[(1, opt(0)), (2, opt(1))]))),
            ("1 done", plan(items(&[(1, Done)]))),
            ("4 later", plan(items(&[(4, Later)]))),
            ("1-3 go", plan(items(&[(1, Go), (2, Go), (3, Go)]))),
            ("1 - 2 nvm", plan(items(&[(1, Nvm), (2, Nvm)]))),
            ("1,3 go", plan(items(&[(1, Go), (3, Go)]))),
            (
                "1, 3 , 5 b",
                plan(items(&[(1, opt(1)), (3, opt(1)), (5, opt(1))])),
            ),
            ("1-2,4 go", plan(items(&[(1, Go), (2, Go), (4, Go)]))),
            ("1 go, 2 nvm", plan(items(&[(1, Go), (2, Nvm)]))),
            ("1 go; 2 nvm", plan(items(&[(1, Go), (2, Nvm)]))),
            ("1 go\n2 nvm\n", plan(items(&[(1, Go), (2, Nvm)]))),
            ("  1   go   ", plan(items(&[(1, Go)]))),
            ("1: /status", plan(items(&[(1, txt("/status"))]))),
            (
                "1 : use pnpm, not npm; 2 go",
                plan(items(&[(1, txt("use pnpm, not npm")), (2, Go)])),
            ),
            (
                "2 \"keep email sign-in\" 3 go",
                plan(items(&[(2, txt("keep email sign-in")), (3, Go)])),
            ),
            ("2 “curly quotes”", plan(items(&[(2, txt("curly quotes"))]))),
            ("1 go: cheaper", plan(vec![noted(1, Go, "cheaper")])),
            (
                "1 no \"too pricey\" 2 go",
                plan(vec![
                    noted(1, Nvm, "too pricey"),
                    PlanItem {
                        number: 2,
                        verb: Go,
                        note: None,
                    },
                ]),
            ),
            (
                "recs fine",
                ReplyPlan {
                    rest: Some(Go),
                    ..Default::default()
                },
            ),
            (
                "recs",
                ReplyPlan {
                    rest: Some(Go),
                    ..Default::default()
                },
            ),
            (
                "RECS OK",
                ReplyPlan {
                    rest: Some(Go),
                    ..Default::default()
                },
            ),
            (
                "1 nvm recs fine",
                ReplyPlan {
                    items: items(&[(1, Nvm)]),
                    rest: Some(Go),
                    ..Default::default()
                },
            ),
            (
                "all nvm",
                ReplyPlan {
                    rest: Some(Nvm),
                    ..Default::default()
                },
            ),
            (
                "all later",
                ReplyPlan {
                    rest: Some(Later),
                    ..Default::default()
                },
            ),
            (
                "all: ship it",
                ReplyPlan {
                    rest: Some(txt("ship it")),
                    ..Default::default()
                },
            ),
            (
                "#B3 1 go",
                ReplyPlan {
                    batch: Some(3),
                    items: items(&[(1, Go)]),
                    ..Default::default()
                },
            ),
            (
                "#b12 recs fine",
                ReplyPlan {
                    batch: Some(12),
                    rest: Some(Go),
                    ..Default::default()
                },
            ),
            (
                "pref: always use pnpm",
                ReplyPlan {
                    prefs: vec!["always use pnpm".into()],
                    ..Default::default()
                },
            ),
            (
                "pref: dark mode first; 1 go",
                ReplyPlan {
                    prefs: vec!["dark mode first".into()],
                    items: items(&[(1, Go)]),
                    ..Default::default()
                },
            ),
            (
                "forget D12",
                ReplyPlan {
                    forgets: vec![12],
                    ..Default::default()
                },
            ),
            (
                "forget d3 forget D4",
                ReplyPlan {
                    forgets: vec![3, 4],
                    ..Default::default()
                },
            ),
            (
                "1 go forget D2",
                ReplyPlan {
                    items: items(&[(1, Go)]),
                    forgets: vec![2],
                    ..Default::default()
                },
            ),
        ];
        for (raw, expected) in cases {
            assert_eq!(parse_reply(raw), Ok(expected), "parsing {raw:?}");
        }
    }

    #[test]
    fn refuses_with_a_hint() {
        let long = format!("1: {}", "x".repeat(2001));
        let cases: Vec<(&str, &str)> = vec![
            ("", "empty"),
            ("   \n ", "empty"),
            ("1", "needs an answer"),
            ("1 2 go", "needs an answer"),
            ("1 maybe", "\"maybe\" is not an answer word"),
            ("1 good", "\"good\" is not an answer word"),
            ("1 g", "\"g\" is not an answer word"),
            ("0 go", "no item 0"),
            ("3-1 go", "backwards"),
            ("1 go 1 nvm", "answered twice"),
            ("1-3 go 2 nvm", "answered twice"),
            ("1:", "empty"),
            ("1: ; 2 go", "empty"),
            ("1 \"unclosed", "not closed"),
            ("1 \"\"", "empty"),
            ("1 go #B2", "must come first"),
            ("recs fine all nvm", "only one of"),
            ("all", "needs an answer"),
            ("forget", "needs a decision id"),
            ("forget 12", "needs a decision id"),
            ("pref:", "empty"),
            ("hello", "Could not read \"hello\""),
            ("go 1", "Could not read \"go\""),
            ("1 go!", "Could not read \"!\""),
            (&long, "longer than 2000"),
            ("1-500 go", "too long"),
        ];
        for (raw, hint) in cases {
            let error = parse_reply(raw).expect_err(raw);
            assert!(error.contains(hint), "{raw:?}: {error}");
            assert!(error.contains("Reply like"), "{raw:?}: {error}");
        }
    }

    fn ask(n: i64) -> Ask {
        serde_json::from_value(serde_json::json!({
            "askId": format!("A{n}"),
            "projectRef": { "machineId": "lab-a", "projectId": "p1" },
            "kind": "decide",
            "key": format!("k.{n}"),
            "class": "product",
            "text": format!("Question {n}?"),
            "recommendation": format!("rec{n}"),
            "blocks": "nothing",
            "proceededOnRec": true,
            "state": "open",
            "batchId": "B1",
            "number": n,
            "createdAt": "2026-10-17T09:00:00.000Z",
        }))
        .unwrap()
    }

    fn with(base: Ask, extra: serde_json::Value) -> Ask {
        let mut value = serde_json::to_value(base).unwrap();
        for (k, v) in extra.as_object().unwrap() {
            if v.is_null() {
                value.as_object_mut().unwrap().remove(k);
            } else {
                value[k] = v.clone();
            }
        }
        serde_json::from_value(value).unwrap()
    }

    fn summary(raw: &str, batch: &[Ask]) -> Result<Vec<String>, String> {
        let plan = parse_reply(raw).unwrap();
        let items: Vec<(u64, Ask)> = batch
            .iter()
            .map(|a| (a.number.unwrap().get() as u64, a.clone()))
            .collect();
        resolve_plan(&plan, "B1", &items).map(|actions| {
            actions
                .iter()
                .map(|a| match a {
                    Action::Answer { number, value, .. } => format!("{number}={value}"),
                    Action::Withdraw { number, .. } => format!("{number}:withdraw"),
                    Action::Later { number, .. } => format!("{number}:later"),
                })
                .collect()
        })
    }

    fn ok(list: &[&str]) -> Result<Vec<String>, String> {
        Ok(list.iter().map(|s| s.to_string()).collect())
    }

    fn hint(result: Result<Vec<String>, String>, needle: &str) {
        let error = result.expect_err(needle);
        assert!(error.contains(needle), "{error}");
    }

    fn batch() -> Vec<Ask> {
        let money = with(
            ask(2),
            serde_json::json!({ "class": "money", "options": ["Team", "Free"], "recommendation": "Free" }),
        );
        let todo = with(
            ask(3),
            serde_json::json!({
                "kind": "do", "class": "credential", "recommendation": null,
                "steps": [{ "text": "Create the token", "where": "browser" }],
            }),
        );
        vec![ask(1), money, todo]
    }

    #[test]
    fn resolves_against_the_batch() {
        let b = batch();
        assert_eq!(summary("1 go 2 a", &b), ok(&["1=rec1", "2=Team"]));
        assert_eq!(summary("1: my own", &b), ok(&["1=my own"]));
        assert_eq!(summary("3 done", &b), ok(&["3=done"]));
        // A rejected product ask is withdrawn; a rejected money ask is logged as no.
        assert_eq!(summary("1 nvm 2 no", &b), ok(&["1:withdraw", "2=no"]));
        // recs fine accepts every open item with a recommendation and leaves do-asks open.
        assert_eq!(summary("recs fine", &b), ok(&["1=rec1", "2=Free"]));
        assert_eq!(
            summary("1 nvm recs fine", &b),
            ok(&["1:withdraw", "2=Free"])
        );
        assert_eq!(summary("2 b", &b), ok(&["2=Free"]));
        assert_eq!(
            summary("1 go all later", &b),
            ok(&["1=rec1", "2:later", "3:later"])
        );
        hint(summary("5 go", &b), "B1 has no item 5");
        hint(summary("1 c", &b), "Item 1 has no option c");
        hint(summary("2 c", &b), "Item 2 has no option c");
        hint(summary("3 go", &b), "do-ask");
        hint(summary("1 done", &b), "not a checklist");
    }

    #[test]
    fn skips_answered_and_moved_items_for_recs_but_refuses_naming_them() {
        let todo = batch().remove(2);
        let answered = with(ask(1), serde_json::json!({ "state": "answered" }));
        let moved = with(ask(2), serde_json::json!({ "batchId": "B2" }));
        let b = [answered, moved, todo];
        assert_eq!(summary("recs fine", &b), ok(&[]));
        hint(summary("1 go", &b), "Item 1 of B1 is already answered");
        hint(summary("2 go", &b), "already moved");
    }

    #[test]
    fn approve_and_secret_asks() {
        let approve = with(
            ask(4),
            serde_json::json!({
                "kind": "approve", "class": "irreversible", "recommendation": null,
                "gated": { "argv": ["sh", "-c", "deploy"], "cwd": "/w/p1", "class": "irreversible", "reason": "prod deploy", "timeoutSec": 1800 },
            }),
        );
        let secret = with(
            ask(5),
            serde_json::json!({ "kind": "secret", "class": "credential", "recommendation": null, "sink": "env:lab-a:/w/p1/.env" }),
        );
        assert_eq!(approve.kind, AskKind::Approve);
        assert_eq!(secret.class, AskClass::Credential);
        let g = [ask(1), approve, secret];
        assert_eq!(summary("4 go", &g), ok(&["4=go"]));
        assert_eq!(summary("4 yes", &g), ok(&["4=go"]));
        assert_eq!(summary("4 no", &g), ok(&["4=no"]));
        assert_eq!(summary("4 nvm", &g), ok(&["4=no"]));
        assert_eq!(summary("4 later", &g), ok(&["4:later"]));
        // Never approved or answered in bulk.
        assert_eq!(summary("recs fine", &g), ok(&["1=rec1"]));
        assert_eq!(summary("all go", &g), ok(&["1=rec1"]));
        assert_eq!(summary("all no", &g), ok(&["1:withdraw"]));
        hint(summary("4: go ahead", &g), "\"4 go\" to run it or \"4 no\"");
        hint(summary("4 a", &g), "stored command");
        hint(summary("4 done", &g), "stored command");
        let leaked = summary("5: not-a-real-secret-123", &g).unwrap_err();
        assert!(
            leaked.contains("Never put a secret in a reply")
                && !leaked.contains("not-a-real-secret-123"),
            "{leaked}"
        );
        hint(summary("5 go", &g), "asks for a secret");
        assert_eq!(summary("5 no", &g), ok(&["5=no"]));
        assert_eq!(g[0].state, AskState::Open);
    }
}
