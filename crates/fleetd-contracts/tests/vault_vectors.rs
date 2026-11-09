//! `tests/vault_vectors.json` (written by experimental/bun/scripts/vault-vectors.ts) agrees with vault.rs: each vector's
//! ids are valid, and its additional data is what `dek_aad`, `item_aad` and `check_aad` make. The Rust hub opens the
//! envelopes themselves (crates/fleetd/src/hub/vault).

use fleetd_contracts::vault::{VaultItemId, VaultKeyId, VaultKind, check_aad, dek_aad, item_aad};
use serde_json::Value;

#[test]
fn the_vectors_additional_data_is_vault_rs_own() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vault_vectors.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let key_id = v["keyId"].as_str().unwrap();
    assert!(VaultKeyId::new(key_id).is_ok());
    assert_eq!(v["checkAad"], check_aad(key_id));
    let vectors = v["vectors"].as_array().unwrap();
    assert!(vectors.len() >= 4);
    for vector in vectors {
        let item = vector["itemId"].as_str().unwrap();
        assert!(VaultItemId::new(item).is_ok(), "{item}");
        let kind: VaultKind = serde_json::from_value(vector["kind"].clone()).unwrap();
        let version = vector["version"].as_u64().unwrap();
        let scope = vector["scopeKey"].as_str().unwrap();
        assert_eq!(vector["dekAad"], dek_aad(item, version));
        assert_eq!(vector["itemAad"], item_aad(item, kind, scope, version));
    }
    assert!(v["negatives"].as_array().unwrap().len() >= 7);
}
