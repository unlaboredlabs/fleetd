//! The brief freeze hash: sha256 of canonical JSON, byte-identical to older hubs' `canonicalJson`, so a brief frozen
//! by an older hub hashes the same.
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// JSON with object keys sorted at every level and no whitespace, numbers and strings written as `JSON.stringify`
/// writes them.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number(n)),
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("a string serializes")),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            // JS compares UTF-16 code units; brief keys are ASCII, where that equals byte order.
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            out.push('{');
            for (i, (k, v)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).expect("a string serializes"));
                out.push(':');
                write_canonical(v, out);
            }
            out.push('}');
        }
    }
}

/// `String(n)` in JS: integers without a fraction, exponent form only from 1e21 up and below 1e-6.
pub fn js_number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    js_f64(n.as_f64().unwrap_or(0.0))
}

pub fn js_f64(f: f64) -> String {
    if !f.is_finite() {
        return "null".into();
    }
    if f == 0.0 {
        return "0".into();
    }
    let abs = f.abs();
    if (1e-6..1e21).contains(&abs) {
        // Rust's Display is the shortest round-trip form without an exponent, as JS prints in this range.
        return format!("{f}");
    }
    let s = format!("{f:e}");
    match s.split_once('e') {
        Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
        _ => s,
    }
}

/// sha256 of the brief's canonical JSON, lowercase hex.
pub fn brief_hash<B: Serialize>(brief: &B) -> String {
    let value = serde_json::to_value(brief).expect("a brief serializes");
    sha256_hex(canonical_json(&value).as_bytes())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn brief() -> Value {
        json!({
            "goal": "Add /health",
            "why": "the deploy checks it",
            "pointers": ["src/server.ts"],
            "constraints": [],
            "doneWhen": [{ "type": "http", "url": "http://localhost:3000/health", "status": 200 }],
            "tier": "S",
            "decisionRule": { "better": "higher", "goAtLeast": 0.1, "stopBelow": 0.02 },
            "budget": { "agentHours": 2 }
        })
    }

    #[test]
    fn equal_briefs_hash_the_same_whatever_their_key_order() {
        let reordered = json!({
            "tier": "S",
            "budget": { "agentHours": 2.0 },
            "decisionRule": { "stopBelow": 0.02, "goAtLeast": 0.1, "better": "higher" },
            "doneWhen": [{ "status": 200, "url": "http://localhost:3000/health", "type": "http" }],
            "constraints": [],
            "pointers": ["src/server.ts"],
            "why": "the deploy checks it",
            "goal": "Add /health"
        });
        assert_eq!(canonical_json(&reordered), canonical_json(&brief()));
        assert_eq!(brief_hash(&reordered), brief_hash(&brief()));
        let mut other = brief();
        other["tier"] = json!("M");
        assert_ne!(brief_hash(&other), brief_hash(&brief()));
    }

    #[test]
    fn matches_the_ts_hub_byte_for_byte() {
        // Printed by an older hub: canonicalJson(brief) and briefHash(brief) for this brief.
        assert_eq!(
            canonical_json(&brief()),
            r#"{"budget":{"agentHours":2},"constraints":[],"decisionRule":{"better":"higher","goAtLeast":0.1,"stopBelow":0.02},"doneWhen":[{"status":200,"type":"http","url":"http://localhost:3000/health"}],"goal":"Add /health","pointers":["src/server.ts"],"tier":"S","why":"the deploy checks it"}"#
        );
        assert_eq!(brief_hash(&brief()), TS_HASH);
    }

    const TS_HASH: &str = "6f157ae500a3f07ddb9e5acc74dbbbdddd64b757ad89a409995b18e225c5086c";

    #[test]
    fn numbers_print_like_js() {
        assert_eq!(js_f64(5.0), "5");
        assert_eq!(js_f64(0.1), "0.1");
        assert_eq!(js_f64(-0.0), "0");
        assert_eq!(js_f64(1e21), "1e+21");
        assert_eq!(js_f64(1.5e-7), "1.5e-7");
        assert_eq!(js_f64(0.000001), "0.000001");
        assert_eq!(js_f64(0.6 - 0.5), "0.09999999999999998");
    }
}
