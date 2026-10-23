//! Secrets out of text the app shows from places the hub doesn't control: an agent's transcript, a PR's description,
//! reviews and diff. The node already scrubs the values it knows (a project's secrets in command output); this catches
//! credentials by their shape, so a token an agent printed or a diff added is never shown.
use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;

pub const SECRET: &str = "[secret]";

/// Credentials recognised by their prefix or shape, replaced whole.
static TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?s:.*?)(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\z)",
        r"|\bfld_[a-z2-7]{16,}",
        r"|\bgh[pousr]_[A-Za-z0-9]{20,}",
        r"|\bgithub_pat_[A-Za-z0-9_]{20,}",
        r"|\bsk-ant-[A-Za-z0-9_-]{16,}",
        r"|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}",
        r"|\bxox[abposr]-[A-Za-z0-9-]{10,}",
        r"|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
        r"|\bAIza[0-9A-Za-z_-]{35}",
        r"|\bnpm_[A-Za-z0-9]{36}",
        r"|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
    ))
    .expect("token patterns")
});

/// `Bearer <token>`, `https://user:pass@host` and `SOME_TOKEN=value`: the name stays, the value goes. A value must
/// look like one (8+ characters with a digit), so `password: string` in code stays as it is.
static ASSIGNED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(?P<pre>\bbearer\s+)(?P<bearer>[A-Za-z0-9._~+/=-]{16,})",
        r"|(?P<scheme>\b[a-z][a-z0-9+.-]*://)(?P<userinfo>[^\s/@:]+:[^\s/@]+)@",
        r#"|(?P<name>\b[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)(?P<value>[^\s"'`,;)}\]]{8,})"#,
    ))
    .expect("assignment patterns")
});

/// `text` with every credential it recognises replaced by `[secret]`; borrowed when there is none.
pub fn redact(text: &str) -> Cow<'_, str> {
    let tokens = TOKENS.replace_all(text, SECRET);
    if !ASSIGNED.is_match(&tokens) {
        return tokens;
    }
    let out = ASSIGNED.replace_all(&tokens, |c: &regex::Captures<'_>| {
        if let Some(pre) = c.name("pre") {
            format!("{}{SECRET}", pre.as_str())
        } else if let Some(scheme) = c.name("scheme") {
            format!("{}{SECRET}@", scheme.as_str())
        } else {
            let value = c.name("value").map_or("", |v| v.as_str());
            let name = c.name("name").map_or("", |n| n.as_str());
            if value.bytes().any(|b| b.is_ascii_digit()) && value != SECRET {
                format!("{name}{SECRET}")
            } else {
                c[0].to_owned()
            }
        }
    });
    Cow::Owned(out.into_owned())
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn credentials_are_replaced_by_their_shape() {
        let cases = [
            (
                "export GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
                "export GH=[secret]",
            ),
            (
                "key fld_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst",
                "key [secret]",
            ),
            (
                "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789_xyz",
                "ANTHROPIC_API_KEY=[secret]",
            ),
            (
                "curl -H 'Authorization: Bearer abc123def456ghi789jkl'",
                "curl -H 'Authorization: Bearer [secret]'",
            ),
            (
                "git clone https://bot:hunter2token@github.com/o/r",
                "git clone https://[secret]@github.com/o/r",
            ),
            (
                "DATABASE_PASSWORD=s3cr3t-v4lue npm test",
                "DATABASE_PASSWORD=[secret] npm test",
            ),
            (
                r#"{"api_key": "a1b2c3d4e5f6g7"}"#,
                r#"{"api_key": "[secret]"}"#,
            ),
            ("aws AKIAABCDEFGHIJKLMNOP", "aws [secret]"),
        ];
        for (input, want) in cases {
            assert_eq!(redact(input), want, "{input}");
        }
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nnext";
        assert_eq!(redact(key), "[secret]\nnext");
        assert_eq!(
            redact("-----BEGIN RSA PRIVATE KEY-----\nMIIE cut off"),
            "[secret]"
        );
    }

    #[test]
    fn ordinary_code_and_prose_stay() {
        for text in [
            "fn token(&self) -> &str { &self.token }",
            "password: string;",
            "const TOKEN_LIMIT = 4000;",
            "The token budget is spent; see https://github.com/o/r/pull/12",
            "let secret = read_secret(path)?;",
            "cargo test -p fleetd --lib",
        ] {
            assert_eq!(redact(text), text);
        }
    }
}
