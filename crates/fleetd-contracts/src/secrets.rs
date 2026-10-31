//! M8 secrets: the desktop app seals a value to the target node's X25519 key (libsodium `crypto_box_seal`); the hub only
//! relays the ciphertext and keeps the fingerprint the node reports back.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::brand;
use crate::ids::MachineId;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Base64Alphabet {
    Base64,
    Base64Url,
}

const STANDARD: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Decoded byte length of canonical base64, or `None` for anything else: wrong alphabet, impossible length, or
/// nonzero unused bits in the last character (so each byte string has exactly one encoding). Standard base64 must be
/// padded; base64url may be unpadded.
pub fn base64_bytes(text: &str, alphabet: Base64Alphabet) -> Option<usize> {
    let body = text
        .strip_suffix("==")
        .or_else(|| text.strip_suffix('='))
        .unwrap_or(text);
    let padded = body.len() != text.len();
    let chars = match alphabet {
        Base64Alphabet::Base64 => STANDARD,
        Base64Alphabet::Base64Url => URL_SAFE,
    };
    if !body.bytes().all(|b| chars.contains(&b)) || body.len() % 4 == 1 {
        return None;
    }
    if (alphabet == Base64Alphabet::Base64 || padded) && !text.len().is_multiple_of(4) {
        return None;
    }
    if let Some(last) = body.bytes().last() {
        let index = chars.iter().position(|&c| c == last)?;
        if index % (1 << ((body.len() * 6) % 8)) != 0 {
            return None;
        }
    }
    Some(body.len() * 6 / 8)
}

fn standard_base64_of(text: &str, min: usize, max: usize) -> bool {
    base64_bytes(text, Base64Alphabet::Base64).is_some_and(|bytes| bytes >= min && bytes <= max)
}

brand!(
    /// The node's X25519 public key for sealed boxes: standard base64 of 32 bytes.
    BoxPublicKey,
    name = "BoxPublicKey",
    check = |s| standard_base64_of(s, 32, 32),
    expected = "standard base64 of a 32-byte X25519 public key"
);

/// Plaintext limit for one secret.
pub const SECRET_MAX_BYTES: usize = 64 * 1024;
/// `crypto_box_seal` adds an ephemeral public key (32) and a MAC (16).
pub const SEAL_OVERHEAD: usize = 48;

brand!(
    /// A `crypto_box_seal` ciphertext, standard base64; at least one plaintext byte, at most SECRET_MAX_BYTES.
    SealedSecret,
    name = "SealedSecret",
    check = |s| standard_base64_of(s, SEAL_OVERHEAD + 1, SEAL_OVERHEAD + SECRET_MAX_BYTES),
    expected = "standard base64 of a sealed box holding 1 to 65536 bytes"
);

brand!(
    /// The first 8 hex characters of sha256 over the plaintext, computed by the node.
    SecretFingerprint,
    name = "SecretFingerprint",
    pattern = r"^[0-9a-f]{8}$",
    description = "8 lowercase hex characters: the sha256 prefix of the plaintext"
);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SecretSinkKind {
    Env,
    File,
    /// One variable for one order's agents (`order:<machine>:<order id>`): the node adds it to the environment of
    /// that order's sessions on the machine, masks it in what they report, and drops it when the order closes.
    Order,
    /// A Navi's secure input (`fill:<machine>:<browser session>`, secure_input.rs): the node types the value straight
    /// into the field the Navi asked about, on its site, in that browser session, and keeps it nowhere.
    Fill,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedSecretSink {
    pub kind: SecretSinkKind,
    pub machine_id: MachineId,
    /// The file, an `order:` sink's order id, or a `fill:` sink's browser session id.
    pub path: String,
}

/// Splits a valid sink; `None` for anything else. The path must be absolute with no empty, "." or ".." segment and
/// no control characters, so the node can check it against its command roots by prefix.
pub fn parse_secret_sink(sink: &str) -> Option<ParsedSecretSink> {
    static ORDER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^order:([a-z0-9-]{1,32}):(W[1-9][0-9]{0,9})$").unwrap()
    });
    static FILL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^fill:([a-z0-9-]{1,32}):(B[0-9a-f]{32})$").unwrap()
    });
    if let Some(captures) = FILL.captures(sink) {
        return Some(ParsedSecretSink {
            kind: SecretSinkKind::Fill,
            machine_id: MachineId::unchecked(&captures[1]),
            path: captures[2].to_owned(),
        });
    }
    if let Some(captures) = ORDER.captures(sink) {
        return Some(ParsedSecretSink {
            kind: SecretSinkKind::Order,
            machine_id: MachineId::unchecked(&captures[1]),
            path: captures[2].to_owned(),
        });
    }
    static SINK: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^(env|file):([a-z0-9-]{1,32}):(/.*)$").unwrap()
    });
    // JS `.` does not match line terminators; `(\/.*)$` then fails on them, as the control check would anyway.
    let captures = SINK.captures(sink)?;
    if crate::prim::js_len(sink) > 1000 {
        return None;
    }
    let kind = if &captures[1] == "env" {
        SecretSinkKind::Env
    } else {
        SecretSinkKind::File
    };
    let path = &captures[3];
    if path.chars().any(|c| {
        ('\u{0}'..='\u{1f}').contains(&c) || matches!(c, '\u{7f}' | '\u{2028}' | '\u{2029}')
    }) {
        return None;
    }
    if path[1..]
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    Some(ParsedSecretSink {
        kind,
        machine_id: MachineId::unchecked(&captures[2]),
        path: path.to_owned(),
    })
}

brand!(
    /// Where the node writes a secret, mode 0600, under its command roots. `env:<machine>:<path>` adds or replaces
    /// one KEY=VALUE line in an env file; `file:<machine>:<path>` writes the raw value; `order:<machine>:<order id>`
    /// makes it one variable of that order's agents on the machine, until the order closes; `fill:<machine>:<browser
    /// session>` types it into the field a Navi's secure input names, once.
    SecretSink,
    name = "SecretSink",
    check = |s| parse_secret_sink(s).is_some(),
    expected = "env:<machine>:<absolute path>, file:<machine>:<absolute path> (with no empty, . or .. path segment) order:<machine>:<order id> or fill:<machine>:<browser session id>"
);

/// The variable an `env:` sink writes for a secret ask without `--env-name`: its key uppercased, with `.` and `-` as
/// `_` (`stripe.test_key` is `STRIPE_TEST_KEY`). `None` when that is no valid name (a key starting with a digit).
pub fn secret_env_name(secret_key: &str) -> Option<String> {
    static ENV_NAME: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$").unwrap());
    let name = secret_key.to_uppercase().replace(['.', '-'], "_");
    ENV_NAME.is_match(&name).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_is_canonical_only() {
        assert_eq!(base64_bytes("AAAA", Base64Alphabet::Base64), Some(3));
        assert_eq!(base64_bytes("AA==", Base64Alphabet::Base64), Some(1));
        // Nonzero unused bits.
        assert_eq!(base64_bytes("AB==", Base64Alphabet::Base64), None);
        // Standard base64 must be padded; base64url may not be.
        assert_eq!(base64_bytes("AA", Base64Alphabet::Base64), None);
        assert_eq!(base64_bytes("AA", Base64Alphabet::Base64Url), Some(1));
        assert_eq!(base64_bytes("A-==", Base64Alphabet::Base64), None);
        assert_eq!(base64_bytes("AAAAA", Base64Alphabet::Base64Url), None);
        assert_eq!(base64_bytes("+/8=", Base64Alphabet::Base64Url), None);
        for bad in ["qw", "q", "qw=", "q===", "qx==", "a-b_", "a b=", "qw==qw=="] {
            assert_eq!(base64_bytes(bad, Base64Alphabet::Base64), None, "{bad}");
        }
    }

    #[test]
    fn sink_paths_are_absolute_and_plain() {
        let parsed = parse_secret_sink("env:devbox:/home/w/.env").unwrap();
        assert_eq!(parsed.kind, SecretSinkKind::Env);
        assert_eq!(parsed.machine_id.as_str(), "devbox");
        assert_eq!(parsed.path, "/home/w/.env");
        for bad in [
            "env:devbox:relative",
            "env:devbox:/a//b",
            "env:devbox:/a/./b",
            "file:devbox:/a/../b",
            "file:devbox:/a/",
            "env:Devbox:/a",
            "vault:devbox:/a",
            "file:devbox:/a\u{7}b",
            "env:devbox:/a\nb",
            "env:devbox:",
            "env:devbox:/",
            "env:/a",
        ] {
            assert!(parse_secret_sink(bad).is_none(), "{bad}");
        }
        assert!(parse_secret_sink(&format!("file:devbox:/{}", "a".repeat(1000))).is_none());
        let order = parse_secret_sink("order:devbox:W27").unwrap();
        assert_eq!(order.kind, SecretSinkKind::Order);
        assert_eq!(order.machine_id.as_str(), "devbox");
        assert_eq!(order.path, "W27");
        for bad in [
            "order:devbox:27",
            "order:devbox:W0",
            "order:devbox:/W27",
            "order:devbox:W27/x",
        ] {
            assert!(parse_secret_sink(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn env_names_follow_the_key() {
        assert_eq!(
            secret_env_name("stripe.test_key").as_deref(),
            Some("STRIPE_TEST_KEY")
        );
        assert_eq!(secret_env_name("gh-token").as_deref(), Some("GH_TOKEN"));
        assert_eq!(secret_env_name("1password"), None);
    }
}
