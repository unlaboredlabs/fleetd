//! Repo tasks. `cargo xtask t3-conformance [--t3 <pinned T3 checkout>]`: checks t3-wire against T3's own contracts
//! at the pin (vendor/t3/pin.json) and replays the recorded executor fixtures through its decoders.
mod diff;
mod replay;

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use anyhow::{Context, bail};
use serde_json::Value;
use t3_wire::methods::USED;

use crate::diff::{Differ, Dir};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

fn pin() -> anyhow::Result<String> {
    let text = std::fs::read_to_string(repo_root().join("vendor/t3/pin.json"))
        .context("reading vendor/t3/pin.json")?;
    let pin: Value = serde_json::from_str(&text)?;
    Ok(pin["commit"]
        .as_str()
        .context("pin.json has no commit")?
        .to_string())
}

fn default_checkout(pin: &str) -> PathBuf {
    let lab = std::env::var_os("FLEETD_LAB")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("src/fleetd-lab")
        });
    lab.join(format!("t3-src-{}", &pin[..10]))
}

/// Runs the export script in the checkout, with its own effect, and returns `{tag: {stream, payload, success,
/// error} | null}`.
fn upstream_schemas(checkout: &Path) -> anyhow::Result<Value> {
    let script = repo_root().join("crates/t3-wire/conformance/export-t3-schemas.mjs");
    let out = Command::new("node")
        .arg(&script)
        .arg(checkout)
        .args(USED.iter().map(|m| m.tag))
        .output()
        .context("running node (needs Node 24 for TypeScript type stripping)")?;
    if !out.status.success() {
        bail!(
            "exporting T3's schemas failed:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(serde_json::from_slice(&out.stdout)?)
}

fn conformance(checkout: &Path) -> anyhow::Result<Vec<String>> {
    let pin = pin()?;
    let head = Command::new("git")
        .arg("-C")
        .arg(checkout)
        .args(["rev-parse", "HEAD"])
        .output()
        .context("git rev-parse")?;
    let head = String::from_utf8_lossy(&head.stdout).trim().to_string();
    if head != pin {
        bail!("{} is at {head:?}, not the pin {pin}", checkout.display());
    }
    if !checkout
        .join("packages/contracts/node_modules/effect")
        .exists()
    {
        bail!(
            "{} has no packages/contracts/node_modules/effect; install the checkout's dependencies",
            checkout.display()
        );
    }
    let upstream = upstream_schemas(checkout)?;
    let mut problems = Vec::new();
    for spec in USED {
        let Some(up) = upstream.get(spec.tag).filter(|u| !u.is_null()) else {
            problems.push(format!("{}: T3 no longer serves this method", spec.tag));
            continue;
        };
        if up["stream"].as_bool() != Some(spec.stream) {
            problems.push(format!(
                "{}: T3 changed it to {}a stream",
                spec.tag,
                if spec.stream { "not " } else { "" }
            ));
        }
        let parts = [
            ("payload", spec.payload, Dir::Send),
            ("success", Some(spec.success), Dir::Read),
            ("error", spec.error, Dir::Read),
        ];
        for (part, schema, dir) in parts {
            let Some(schema) = schema else { continue };
            let rust = serde_json::to_value(schema())?;
            problems
                .extend(Differ::new(&rust, &up[part], dir).run(&format!("{}.{part}", spec.tag)));
        }
    }
    Ok(problems)
}

/// Ok(false) when T3 drifted from what fleetd uses.
fn t3_conformance(args: &[String]) -> anyhow::Result<bool> {
    let pin = pin()?;
    let checkout = match args.iter().position(|a| a == "--t3") {
        Some(i) => PathBuf::from(args.get(i + 1).context("--t3 needs a path")?),
        None => default_checkout(&pin),
    };
    let mut problems = conformance(&checkout)?;
    let replayed = replay::replay(&repo_root().join("crates/t3-wire/fixtures"))?;
    problems.extend(replayed.problems);
    if problems.is_empty() {
        println!(
            "t3-conformance: {} methods match T3 at {}; {} fixture items decode",
            USED.len(),
            &pin[..10],
            replayed.items
        );
        return Ok(true);
    }
    eprintln!(
        "t3-conformance: {} problem(s) against T3 at {}:",
        problems.len(),
        &pin[..10]
    );
    for p in &problems {
        eprintln!("  {p}");
    }
    Ok(false)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("t3-conformance") {
        eprintln!("usage: cargo xtask t3-conformance [--t3 <pinned T3 checkout>]");
        return ExitCode::from(2);
    }
    match t3_conformance(&args[1..]) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("t3-conformance: {e:#}");
            ExitCode::FAILURE
        }
    }
}
