//! Standard Webhooks signing (https://www.standardwebhooks.com): HMAC-SHA256 over `id.timestamp.body`, with a
//! `whsec_`-prefixed base64 secret. TS spec: apps/hub/src/webhooks/Signing.ts.
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;

const PREFIX: &str = "whsec_";

/// 32 random bytes, base64, `whsec_`-prefixed: the format Standard Webhooks libraries accept as-is.
pub fn new_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{PREFIX}{}", STANDARD.encode(bytes))
}

fn key_bytes(secret: &str) -> Vec<u8> {
    STANDARD
        .decode(secret.strip_prefix(PREFIX).unwrap_or(secret))
        .unwrap_or_default()
}

fn mac(secret: &str, id: &str, timestamp_sec: i64, body: &str) -> Hmac<Sha256> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&key_bytes(secret)).expect("hmac takes any key length");
    mac.update(format!("{id}.{timestamp_sec}.{body}").as_bytes());
    mac
}

/// The `webhook-signature` value for one delivery attempt: `v1,<base64 hmac-sha256>`.
pub fn sign(secret: &str, id: &str, timestamp_sec: i64, body: &str) -> String {
    format!(
        "v1,{}",
        STANDARD.encode(mac(secret, id, timestamp_sec, body).finalize().into_bytes())
    )
}

/// Receiver-side check: one of the space-separated `v1` signatures matches and the timestamp is within tolerance.
pub fn verify(
    secret: &str,
    id: &str,
    timestamp: &str,
    signature: &str,
    body: &str,
    now_sec: i64,
    tolerance_sec: i64,
) -> bool {
    let Ok(timestamp) = timestamp.parse::<i64>() else {
        return false;
    };
    if (now_sec - timestamp).abs() > tolerance_sec {
        return false;
    }
    signature.split(' ').any(|candidate| {
        candidate
            .strip_prefix("v1,")
            .and_then(|b64| STANDARD.decode(b64).ok())
            .is_some_and(|given| {
                mac(secret, id, timestamp, body)
                    .verify_slice(&given)
                    .is_ok()
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The published test vector used by every standard-webhooks reference library (e.g. libraries/go/webhook_test.go).
    const SECRET: &str = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const ID: &str = "msg_p5jXN8AQM9LWM0D4loKWxJek";
    const TIMESTAMP: i64 = 1614265330;
    const BODY: &str = r#"{"test": 2432232314}"#;
    const EXPECTED: &str = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

    #[test]
    fn matches_the_specs_published_signature() {
        assert_eq!(sign(SECRET, ID, TIMESTAMP, BODY), EXPECTED);
        assert_eq!(
            sign(&SECRET["whsec_".len()..], ID, TIMESTAMP, BODY),
            EXPECTED
        );
    }

    #[test]
    fn verifies_any_of_several_and_rejects_a_changed_body_or_stale_timestamp() {
        let sigs = format!("v1,bm9wZQ== {EXPECTED}");
        let ts = TIMESTAMP.to_string();
        assert!(verify(SECRET, ID, &ts, &sigs, BODY, TIMESTAMP + 10, 300));
        assert!(!verify(
            SECRET,
            ID,
            &ts,
            &sigs,
            r#"{"test": 2432232315}"#,
            TIMESTAMP,
            300
        ));
        assert!(!verify(SECRET, ID, &ts, &sigs, BODY, TIMESTAMP + 301, 300));
    }

    #[test]
    fn makes_whsec_secrets_of_32_random_bytes() {
        let made = new_secret();
        assert!(made.starts_with("whsec_") && made.len() == 6 + 44 && made.ends_with('='));
        assert_eq!(STANDARD.decode(&made[6..]).unwrap().len(), 32);
    }
}
