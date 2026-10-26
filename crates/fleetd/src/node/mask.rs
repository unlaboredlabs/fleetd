//! Masking a project's secret variables in what its agents' sessions report: a command that prints one (`printenv`,
//! a stack trace, a config dump) would otherwise carry it into the node's store and on to the hub and the app. Every
//! exact occurrence of a secret's value, its standard and URL-safe base64, and its percent-encoding becomes
//! `***NAME***` in tool output and input, assistant text, live text and failure messages before the node keeps or
//! sends any of it. A value of several lines (a certificate chain, a key, a service account's JSON) is masked whole
//! and line by line, each line of [`MIN_LINE`] characters or more on its own, so a command that prints only part of it
//! still leaks none of it; PEM armor lines (`-----BEGIN CERTIFICATE-----`) are public and stay. Values under
//! [`MIN_LEN`] bytes are left alone: masking them would garble ordinary output.
use std::borrow::Cow;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use zeroize::Zeroize;

use super::runner::{RunOutcome, RunnerEvent};

/// The shortest value masked.
pub const MIN_LEN: usize = 4;

/// The shortest line of a value of several lines that is masked on its own.
pub const MIN_LINE: usize = 8;

/// `-----BEGIN …-----` / `-----END …-----`: the same in every PEM file, so no secret.
fn pem_armor(line: &str) -> bool {
    (line.starts_with("-----BEGIN ") || line.starts_with("-----END ")) && line.ends_with("-----")
}

/// A process's secrets, `(name, value)`, wiped when it goes.
#[derive(Default)]
pub struct Secrets(pub Vec<(String, String)>);

impl Drop for Secrets {
    fn drop(&mut self) {
        for (_, value) in &mut self.0 {
            value.zeroize();
        }
    }
}

/// The forms of each secret to replace, longest first, so a value inside another's form is not masked half-way.
#[derive(Default)]
pub struct Masker {
    patterns: Vec<(String, String)>,
}

impl Drop for Masker {
    fn drop(&mut self) {
        for (pattern, _) in &mut self.patterns {
            pattern.zeroize();
        }
    }
}

/// `value` percent-encoded as `encodeURIComponent` does: every byte outside `A-Za-z0-9-_.!~*'()`.
fn percent(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 3);
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl Masker {
    /// From each secret's `(name, value)`.
    pub fn new(secrets: &[(String, String)]) -> Self {
        let mut patterns: Vec<(String, String)> = Vec::new();
        for (name, value) in secrets.iter().filter(|(_, v)| v.len() >= MIN_LEN) {
            let shown = format!("***{name}***");
            for form in [
                value.clone(),
                STANDARD.encode(value),
                URL_SAFE.encode(value),
                URL_SAFE_NO_PAD.encode(value),
                percent(value),
            ]
            .into_iter()
            .chain(
                value
                    .lines()
                    .map(str::trim)
                    .filter(|line| {
                        line.len() >= MIN_LINE && !pem_armor(line) && line.len() < value.len()
                    })
                    .map(str::to_owned),
            ) {
                if !patterns.iter().any(|(p, _)| *p == form) {
                    patterns.push((form, shown.clone()));
                }
            }
        }
        patterns.sort_by_key(|(p, _)| std::cmp::Reverse(p.len()));
        Self { patterns }
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    pub fn text<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let mut out = Cow::Borrowed(text);
        for (pattern, shown) in &self.patterns {
            if out.contains(pattern.as_str()) {
                out = Cow::Owned(out.replace(pattern.as_str(), shown));
            }
        }
        out
    }

    fn string(&self, text: &mut String) {
        if let Cow::Owned(masked) = self.text(text) {
            text.zeroize();
            *text = masked;
        }
    }

    /// Every string in `value`, object keys included.
    pub fn value(&self, value: &mut Value) {
        match value {
            Value::String(s) => self.string(s),
            Value::Array(items) => items.iter_mut().for_each(|v| self.value(v)),
            Value::Object(map) => {
                let keyed = map.keys().any(|k| matches!(self.text(k), Cow::Owned(_)));
                if keyed {
                    *map = std::mem::take(map)
                        .into_iter()
                        .map(|(k, v)| (self.text(&k).into_owned(), v))
                        .collect();
                }
                map.values_mut().for_each(|v| self.value(v));
            }
            _ => {}
        }
    }

    /// `item` with every string in it masked; `None` when the masked form no longer decodes (a length limit the
    /// replacement broke), so the caller drops it rather than send the value.
    pub fn serde<T: Serialize + DeserializeOwned>(&self, item: T) -> Option<T> {
        if self.is_empty() {
            return Some(item);
        }
        let mut value = serde_json::to_value(&item).ok()?;
        let before = value.clone();
        self.value(&mut value);
        if value == before {
            return Some(item);
        }
        serde_json::from_value(value).ok()
    }

    /// How many bytes at the end of `text` could start a form not yet complete: live text holds them back until the
    /// next piece shows whether they are a secret.
    pub fn held(&self, text: &str) -> usize {
        let longest = self.patterns.first().map_or(0, |(p, _)| p.len());
        let floor = text.len().saturating_sub(longest.saturating_sub(1));
        (floor..text.len())
            .filter(|&at| text.is_char_boundary(at))
            .find(|&at| {
                let tail = &text[at..];
                self.patterns
                    .iter()
                    .any(|(p, _)| p.len() > tail.len() && p.starts_with(tail))
            })
            .map_or(0, |at| text.len() - at)
    }

    /// The runner's event with every text in it masked; `None` to drop it (see [`Self::serde`]). Live text is masked
    /// where it is flushed, which holds back a partial form.
    pub fn event(&self, event: RunnerEvent) -> Option<RunnerEvent> {
        if self.is_empty() {
            return Some(event);
        }
        Some(match event {
            RunnerEvent::AssistantText {
                message_id,
                mut text,
            } => {
                self.string(&mut text);
                RunnerEvent::AssistantText { message_id, text }
            }
            RunnerEvent::Item(item) => RunnerEvent::Item(self.serde(item)?),
            RunnerEvent::PermissionRequest {
                request_id,
                tool_use_id,
                tool_name,
                mut input,
                mut summary,
            } => {
                self.value(&mut input);
                self.string(&mut summary);
                RunnerEvent::PermissionRequest {
                    request_id,
                    tool_use_id,
                    tool_name,
                    input,
                    summary,
                }
            }
            RunnerEvent::Spans(spans) => RunnerEvent::Spans(
                spans
                    .into_iter()
                    .filter_map(|span| self.serde(span))
                    .collect(),
            ),
            RunnerEvent::RunEnded {
                run_id,
                outcome,
                usage,
            } => RunnerEvent::RunEnded {
                run_id,
                outcome: match outcome {
                    RunOutcome::Completed { mut text } => {
                        self.string(&mut text);
                        RunOutcome::Completed { text }
                    }
                    RunOutcome::Failed(failure) => RunOutcome::Failed(self.serde(failure)?),
                    other => other,
                },
                usage,
            },
            RunnerEvent::Exited(mut exit) => {
                self.string(&mut exit.stderr_tail);
                RunnerEvent::Exited(exit)
            }
            other => other,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masker() -> Masker {
        Masker::new(&[
            ("STRIPE_KEY".into(), "sk_test_4242/x+y=".into()),
            ("PIN".into(), "123".into()),
        ])
    }

    #[test]
    fn every_form_of_a_secret_becomes_its_name() {
        let m = masker();
        let value = "sk_test_4242/x+y=";
        let printenv = format!(
            "HOME=/home/w\nSTRIPE_KEY={value}\nB64={}\nURL={}\nQUERY=?key={}&x=1\nPIN=123\n",
            STANDARD.encode(value),
            URL_SAFE_NO_PAD.encode(value),
            percent(value),
        );
        let masked = m.text(&printenv);
        assert!(!masked.contains(value), "{masked}");
        assert!(!masked.contains(&STANDARD.encode(value)));
        assert!(!masked.contains(&percent(value)));
        assert_eq!(masked.matches("***STRIPE_KEY***").count(), 4, "{masked}");
        // Too short to mask without garbling output.
        assert!(masked.contains("PIN=123"));
        assert!(matches!(m.text("nothing here"), Cow::Borrowed(_)));
    }

    #[test]
    fn a_certificate_chain_is_masked_whole_and_line_by_line() {
        let chain = crate::node::project_env::tests::PEM;
        let m = Masker::new(&[("TLS_CHAIN".into(), chain.into())]);
        let whole = m.text(&format!("TLS_CHAIN={chain}")).into_owned();
        assert_eq!(whole, "TLS_CHAIN=***TLS_CHAIN***");
        // `head -3` of the file, then a stack trace quoting the second cert's middle line, indented.
        let head: String = chain.lines().take(3).map(|l| format!("{l}\n")).collect();
        let line = chain.lines().nth(6).unwrap();
        let partial = m
            .text(&format!("{head}error: bad cert near\n    {line}\n"))
            .into_owned();
        for secret in chain.lines().filter(|l| !l.starts_with("-----")) {
            assert!(!partial.contains(secret), "{partial}");
        }
        // The armor is the same in every PEM file: it stays readable.
        assert!(
            partial.starts_with("-----BEGIN CERTIFICATE-----\n***TLS_CHAIN***"),
            "{partial}"
        );
    }

    #[test]
    fn json_strings_and_keys_are_masked() {
        let m = masker();
        let mut v = serde_json::json!({ "output": "key: sk_test_4242/x+y=", "sk_test_4242/x+y=": [1, "sk_test_4242/x+y="] });
        m.value(&mut v);
        assert!(!v.to_string().contains("sk_test_4242"), "{v}");
    }

    #[test]
    fn live_text_holds_back_what_could_start_a_secret() {
        let m = masker();
        assert_eq!(m.held("the key is sk_te"), "sk_te".len());
        assert_eq!(m.held("the key is s"), 1);
        assert_eq!(m.held("the key is ok"), 0);
        assert_eq!(m.held(""), 0);
        assert_eq!(Masker::default().held("sk_te"), 0);
    }
}
