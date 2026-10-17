//! Bakes the pinned T3 release (vendor/t3/pin.json, written by `pnpm sync:t3`) into the binary as
//! `FLEETD_T3_NPM_VERSION` and `FLEETD_T3_PIN`, so a built fleetd needs no repo checkout to know it.

use std::path::Path;

/// The string value of `"key": "…"` in a flat JSON object, without a JSON dependency at build time.
fn field(json: &str, key: &str) -> String {
    let after = json
        .split_once(&format!("\"{key}\""))
        .unwrap_or_else(|| panic!("vendor/t3/pin.json has no \"{key}\""))
        .1;
    let value = after
        .split_once(':')
        .expect("a colon after the key")
        .1
        .trim_start();
    let value = value.strip_prefix('"').expect("a string value");
    value.split_once('"').expect("a closing quote").0.to_owned()
}

fn main() {
    let pin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/t3/pin.json");
    println!("cargo:rerun-if-changed={}", pin.display());
    let json = std::fs::read_to_string(&pin)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", pin.display()));
    println!(
        "cargo:rustc-env=FLEETD_T3_NPM_VERSION={}",
        field(&json, "npm")
    );
    println!("cargo:rustc-env=FLEETD_T3_PIN={}", field(&json, "commit"));
}
