//! Sealed secrets from the hub (`secret_deliver`): open the box with the node's X25519 key, write the sink under the
//! command roots (mode 0600, atomically), wipe the plaintext and answer with its fingerprint. Approved commands
//! (`gated_run`) read the values back from those sinks, so a value never crosses the hub in either direction. The
//! node remembers which sink holds which secret key in a small index in its home; the index holds no values.
use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::cmd::{ConfinedRun, confine, run_confined};
use super::identity::NodeBoxKey;
use super::util::{errno_name, scrubbed_env};
use super::wire::{
    GatedResult, GatedRun, SecretDeliver, SecretFingerprint, SecretResult, SecretSinkKind, Text,
    exit_code, head_text, parse_secret_sink, secret_env_name,
};

pub struct SecretsContext<'a> {
    pub machine_id: &'a str,
    /// Directories sinks and approved commands must be under.
    pub roots: &'a [String],
    /// The node home, where the sink index lives.
    pub home: &'a Path,
    /// Absent: this node takes no secrets.
    pub box_key: Option<&'a NodeBoxKey>,
}

/// The first 8 hex characters of sha256 over the plaintext.
pub fn fingerprint_of(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    digest[..4].iter().map(|b| format!("{b:02x}")).collect()
}

const INDEX_FILE: &str = "secret-sinks.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SinkRecord {
    kind: String,
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    env_name: Option<String>,
}

fn read_index(home: &Path) -> std::io::Result<BTreeMap<String, SinkRecord>> {
    let file = home.join(INDEX_FILE);
    if !file.exists() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_str(&std::fs::read_to_string(file)?).map_err(std::io::Error::other)
}

/// Write to a sibling temp file (0600), fsync, then rename over the target, so a reader sees the old or the new file.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut suffix = [0u8; 6];
    rand::rngs::OsRng.fill_bytes(&mut suffix);
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let hex: String = suffix.iter().map(|b| format!("{b:02x}")).collect();
    let tmp = target.with_file_name(format!(".{name}.fleetd-{hex}"));
    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, target).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// The real path a sink file may be written at: its directory is under one of `roots` after following symlinks, and
/// the file, if it exists, is a regular file rather than a symlink that could point anywhere.
pub fn confine_sink(file: &str, roots: &[String]) -> Result<PathBuf, String> {
    let path = Path::new(file);
    let parent = path
        .parent()
        .map_or_else(|| "/".to_owned(), |p| p.to_string_lossy().into_owned());
    let parent = if parent.is_empty() {
        "/".to_owned()
    } else {
        parent
    };
    let dir = confine(&parent, roots)
        .map_err(|why| why.replacen(" runs commands in ", " writes secrets in ", 1))?;
    let target = dir.join(path.file_name().unwrap_or_default());
    if let Ok(meta) = std::fs::symlink_metadata(&target)
        && !meta.file_type().is_file()
    {
        return Err(format!("{file} exists and is not a regular file"));
    }
    Ok(target)
}

/// `Some("")` or `Some("export ")` when `line` sets `name`.
fn line_prefix<'a>(line: &str, name: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(name).filter(|r| r.starts_with('='));
    if rest.is_some() {
        return Some("");
    }
    line.strip_prefix("export ")
        .and_then(|l| l.strip_prefix(name))
        .filter(|r| r.starts_with('='))
        .map(|_| "export ")
}

/// `existing` with `name`'s line set to `value`: the first line for `name` is replaced in place (keeping an `export `
/// prefix), later duplicates are dropped, and a missing one is appended. Returned as bytes the caller wipes.
pub fn env_file_with(existing: &str, name: &str, value: &[u8]) -> Zeroizing<Vec<u8>> {
    let trimmed = existing.strip_suffix('\n').unwrap_or(existing);
    let lines: Vec<&str> = if existing.is_empty() {
        Vec::new()
    } else {
        trimmed.split('\n').collect()
    };
    let at = lines
        .iter()
        .position(|line| line_prefix(line, name).is_some());
    let mut out = Zeroizing::new(Vec::with_capacity(
        existing.len() + value.len() + name.len() + 16,
    ));
    let push_line = |out: &mut Vec<u8>, line: &str| {
        out.extend_from_slice(line.as_bytes());
        out.push(b'\n');
    };
    let (before, after) = match at {
        None => (&lines[..], &lines[..0]),
        Some(at) => (&lines[..at], &lines[at + 1..]),
    };
    for line in before {
        push_line(&mut out, line);
    }
    out.extend_from_slice(
        at.and_then(|at| line_prefix(lines[at], name))
            .unwrap_or("")
            .as_bytes(),
    );
    out.extend_from_slice(name.as_bytes());
    out.push(b'=');
    out.extend_from_slice(value);
    out.push(b'\n');
    for line in after
        .iter()
        .filter(|line| line_prefix(line, name).is_none())
    {
        push_line(&mut out, line);
    }
    out
}

/// The value on `name`'s first line, as `env_file_with` writes it.
fn env_value(content: &str, name: &str) -> Option<String> {
    content.split('\n').find_map(|line| {
        line_prefix(line, name).map(|prefix| line[prefix.len() + name.len() + 1..].to_owned())
    })
}

fn io_code(error: &std::io::Error) -> String {
    errno_name(error).unwrap_or_else(|| "an unexpected error".to_owned())
}

/// Handles one `secret_deliver` and always answers it. Errors name the sink, never the value.
pub fn deliver_secret(frame: &SecretDeliver, ctx: &SecretsContext) -> SecretResult {
    let fail = |error: String| SecretResult {
        id: frame.id.clone(),
        fingerprint: None,
        error: Some(head_text(&error)),
    };
    let Some(box_key) = ctx.box_key else {
        return fail("this node takes no secrets: it has no box key".to_owned());
    };
    let Some(sink) = parse_secret_sink(&frame.sink) else {
        return fail("the sink does not parse".to_owned());
    };
    if sink.machine_id.as_str() != ctx.machine_id {
        return fail(format!(
            "the sink is on {}, not on {}",
            sink.machine_id, ctx.machine_id
        ));
    }
    if sink.kind == SecretSinkKind::Order {
        return deliver_order(frame, &sink.path, box_key, ctx);
    }
    let target = match confine_sink(&sink.path, ctx.roots) {
        Ok(target) => target,
        Err(why) => return fail(why),
    };
    let name = match sink.kind {
        SecretSinkKind::Env => match frame
            .env_name
            .as_ref()
            .map(|n| n.to_string())
            .or_else(|| secret_env_name(&frame.secret_key))
        {
            Some(name) => Some(name),
            None => {
                return fail(format!(
                    "{} names no valid variable: ask again with --env-name",
                    frame.secret_key.as_str()
                ));
            }
        },
        SecretSinkKind::File | SecretSinkKind::Order => None,
    };

    let sealed = Zeroizing::new(B64.decode(frame.sealed.as_str()).unwrap_or_default());
    let Some(plain) = box_key.open(&sealed) else {
        return fail(format!(
            "the value was not sealed to {}'s current box key: seal it to the machine's boxPubKey again",
            ctx.machine_id
        ));
    };
    if plain.is_empty() {
        return fail("the value is empty".to_owned());
    }
    if sink.kind == SecretSinkKind::Env && plain.iter().any(|&b| b == b'\n' || b == b'\r' || b == 0)
    {
        return fail(
            "an env: sink takes a one-line value; ask with a file: sink for a multi-line secret"
                .to_owned(),
        );
    }
    let written = (|| -> std::io::Result<()> {
        match &name {
            Some(name) => {
                let existing = Zeroizing::new(if target.exists() {
                    String::from_utf8_lossy(&std::fs::read(&target)?).into_owned()
                } else {
                    String::new()
                });
                write_atomic(&target, &env_file_with(&existing, name, &plain))?;
            }
            None => write_atomic(&target, &plain)?,
        }
        let mut index = read_index(ctx.home)?;
        let kind = if sink.kind == SecretSinkKind::Env {
            "env"
        } else {
            "file"
        };
        index.insert(
            frame.secret_key.to_string(),
            SinkRecord {
                kind: kind.to_owned(),
                path: sink.path.clone(),
                env_name: name.clone(),
            },
        );
        let json = serde_json::to_string_pretty(&index).map_err(std::io::Error::other)?;
        write_atomic(&ctx.home.join(INDEX_FILE), format!("{json}\n").as_bytes())
    })();
    match written {
        Ok(()) => SecretResult {
            id: frame.id.clone(),
            fingerprint: Some(SecretFingerprint::unchecked(fingerprint_of(&plain))),
            error: None,
        },
        Err(error) => fail(format!(
            "could not write {}: {}",
            sink.path,
            io_code(&error)
        )),
    }
}

/// An `order:` sink: the value becomes one variable of the order's agents on this machine (order_env.rs). No sink
/// index entry: an approved command reads no order variable.
fn deliver_order(
    frame: &SecretDeliver,
    order_id: &str,
    box_key: &NodeBoxKey,
    ctx: &SecretsContext,
) -> SecretResult {
    let fail = |error: String| SecretResult {
        id: frame.id.clone(),
        fingerprint: None,
        error: Some(head_text(&error)),
    };
    let Some(project_id) = &frame.project_id else {
        return fail(format!("the hub named no project for order {order_id}"));
    };
    let Some(name) = frame
        .env_name
        .as_ref()
        .map(|n| n.to_string())
        .or_else(|| secret_env_name(&frame.secret_key))
    else {
        return fail(format!(
            "{} names no valid variable: ask again with --env-name",
            frame.secret_key.as_str()
        ));
    };
    let sealed = Zeroizing::new(B64.decode(frame.sealed.as_str()).unwrap_or_default());
    let Some(plain) = box_key.open(&sealed) else {
        return fail(format!(
            "the value was not sealed to {}'s current box key: seal it to the machine's boxPubKey again",
            ctx.machine_id
        ));
    };
    match super::order_env::deliver(ctx.home, project_id.as_str(), order_id, &name, &plain) {
        Ok(()) => SecretResult {
            id: frame.id.clone(),
            fingerprint: Some(SecretFingerprint::unchecked(fingerprint_of(&plain))),
            error: None,
        },
        Err(why) => fail(why),
    }
}

/// A delivered secret's value, read back from its sink; `Err` is why it cannot be read.
pub fn read_secret(secret_key: &str, ctx: &SecretsContext) -> Result<Zeroizing<String>, String> {
    let index = read_index(ctx.home)
        .map_err(|error| format!("cannot read the node's secret index: {}", io_code(&error)))?;
    let Some(record) = index.get(secret_key) else {
        return Err(format!(
            "secret {secret_key} was never delivered to {}: ask for it with fleetd ask --kind secret",
            ctx.machine_id
        ));
    };
    let target = confine_sink(&record.path, ctx.roots)?;
    let content = Zeroizing::new(
        std::fs::read(&target)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .map_err(|error| {
                format!(
                    "cannot read {}: {}",
                    record.path,
                    errno_name(&error).unwrap_or_else(|| "unexpected error".to_owned())
                )
            })?,
    );
    let value = if record.kind == "env" {
        env_value(&content, record.env_name.as_deref().unwrap_or(""))
    } else {
        Some(content.to_string())
    };
    match value {
        Some(value) if !value.is_empty() => Ok(Zeroizing::new(value)),
        _ => Err(format!("{} no longer holds {secret_key}", record.path)),
    }
}

/// Runs one approved command like a `cmd_check`, with each `secretEnv` value read from this node's sinks and
/// injected into its environment, then scrubbed from the output. Always answers.
pub async fn run_gated(frame: GatedRun, ctx: &SecretsContext<'_>) -> GatedResult {
    let not_run = |error: String| GatedResult {
        id: frame.id.clone(),
        exit_code: None,
        output_tail: Text::unchecked(""),
        timed_out: false,
        error: Some(head_text(&error)),
    };
    let mut env = scrubbed_env();
    let mut values: Vec<String> = Vec::new();
    for entry in frame.secret_env.iter().flat_map(|entries| entries.iter()) {
        match read_secret(&entry.secret_key, ctx) {
            Ok(value) => {
                env.retain(|(key, _)| key != entry.name.as_str());
                env.push((entry.name.to_string(), value.to_string()));
                values.push(value.to_string());
            }
            Err(why) => return not_run(why),
        }
    }
    let outcome = run_confined(
        ConfinedRun {
            cwd: &frame.cwd,
            argv: &frame.argv,
            timeout_sec: frame.timeout_sec.get() as u64,
            env: Some(env),
            scrub: &values,
        },
        ctx.roots,
    )
    .await;
    for value in &mut values {
        zeroize::Zeroize::zeroize(value);
    }
    if let Some(why) = outcome.not_run {
        return not_run(why);
    }
    GatedResult {
        id: frame.id.clone(),
        exit_code: exit_code(outcome.exit_code),
        output_tail: Text::unchecked(outcome.output_tail),
        timed_out: outcome.timed_out,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The largest secret goes end to end: sealed to the node's key, opened, written to an env sink, and read back
    /// into an approved command's environment whole. One byte more is no sealed secret at all.
    #[tokio::test]
    async fn a_64_kib_secret_reaches_its_sink_and_a_gated_run() {
        use fleetd_contracts::secrets::{SEAL_OVERHEAD, SECRET_MAX_BYTES, SealedSecret};
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let root_path = root.path().canonicalize().unwrap();
        let roots = [root_path.to_string_lossy().into_owned()];
        let key = super::super::identity::load_or_create_box_key(home.path()).unwrap();
        let ctx = SecretsContext {
            machine_id: "devbox",
            roots: &roots,
            home: home.path(),
            box_key: Some(&key),
        };
        let public: [u8; 32] = B64.decode(key.public_key()).unwrap().try_into().unwrap();
        let seal = |value: &[u8]| {
            B64.encode(
                crypto_box::PublicKey::from(public)
                    .seal(&mut crypto_box::aead::OsRng, value)
                    .unwrap(),
            )
        };
        let value = "k".repeat(SECRET_MAX_BYTES);
        let frame: SecretDeliver = serde_json::from_value(serde_json::json!({
            "id": "1",
            "sink": format!("env:devbox:{}/.env", roots[0]),
            "sealed": seal(value.as_bytes()),
            "secretKey": "big.key",
        }))
        .unwrap();
        let result = deliver_secret(&frame, &ctx);
        assert_eq!(result.error, None);
        assert_eq!(read_secret("big.key", &ctx).unwrap().as_str(), value);

        let run: GatedRun = serde_json::from_value(serde_json::json!({
            "id": "2",
            "argv": ["sh", "-c", "printf %s \"$BIG_KEY\" | wc -c"],
            "cwd": roots[0],
            "timeoutSec": 60,
            "secretEnv": [{ "name": "BIG_KEY", "secretKey": "big.key" }],
        }))
        .unwrap();
        let ran = run_gated(run, &ctx).await;
        assert_eq!(ran.error, None);
        assert_eq!(
            ran.output_tail.as_str().trim(),
            SECRET_MAX_BYTES.to_string()
        );

        let over = seal("k".repeat(SECRET_MAX_BYTES + 1).as_bytes());
        assert_eq!(
            B64.decode(&over).unwrap().len(),
            SEAL_OVERHEAD + SECRET_MAX_BYTES + 1
        );
        assert!(SealedSecret::new(over).is_err());
    }

    #[test]
    fn env_sink_replaces_the_first_line_in_place_and_drops_duplicates() {
        let existing = "# app\nA=1\nexport STRIPE_TEST_KEY=old\nB=2\nSTRIPE_TEST_KEY=older\n";
        let out = env_file_with(existing, "STRIPE_TEST_KEY", b"new");
        assert_eq!(
            std::str::from_utf8(&out).unwrap(),
            "# app\nA=1\nexport STRIPE_TEST_KEY=new\nB=2\n"
        );
        let appended = env_file_with(std::str::from_utf8(&out).unwrap(), "STRIPE_KEY", b"v2");
        assert_eq!(
            std::str::from_utf8(&appended).unwrap(),
            "# app\nA=1\nexport STRIPE_TEST_KEY=new\nB=2\nSTRIPE_KEY=v2\n"
        );
        assert_eq!(
            std::str::from_utf8(&env_file_with("", "K", b"v")).unwrap(),
            "K=v\n"
        );
        assert_eq!(
            std::str::from_utf8(&env_file_with("A=1", "K", b"v")).unwrap(),
            "A=1\nK=v\n"
        );
        // A longer name sharing the prefix is another variable.
        assert_eq!(
            std::str::from_utf8(&env_file_with("KEY2=x\n", "KEY", b"v")).unwrap(),
            "KEY2=x\nKEY=v\n"
        );
        assert_eq!(
            env_value("A=1\nexport K=v\nK=w\n", "K").as_deref(),
            Some("v")
        );
    }
}
