//! Secret asks: the value is sealed here to the target machine's X25519 `boxPubKey` with libsodium's
//! `crypto_box_seal` construction, so the hub only ever relays ciphertext; the node opens it with
//! libsodium's `crypto_box_seal_open`. The plaintext lives only in a masked [`crate::input::TextInput`], which
//! wipes it when cleared or dropped, and is never logged.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use crypto_box::PublicKey;
use crypto_box::aead::OsRng;

pub use fleetd_contracts::secrets::SECRET_MAX_BYTES;

/// Seals `plaintext` to `box_pub_key` (standard base64 of 32 bytes) and returns standard base64, as
/// `secret_submit` takes it.
pub fn seal(box_pub_key: &str, plaintext: &[u8]) -> Result<String, String> {
    if plaintext.is_empty() {
        return Err("The secret is empty.".into());
    }
    if plaintext.len() > SECRET_MAX_BYTES {
        return Err(format!("The secret is over {SECRET_MAX_BYTES} bytes."));
    }
    let key = STANDARD.decode(box_pub_key.trim()).ok().and_then(|k| <[u8; 32]>::try_from(k).ok());
    let Some(key) = key else { return Err("The machine's box key is not a 32-byte key.".into()) };
    let sealed = PublicKey::from(key).seal(&mut OsRng, plaintext).map_err(|_| "Sealing failed.".to_string())?;
    Ok(STANDARD.encode(sealed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crypto_box::SecretKey;
    use std::process::Command;

    fn keypair() -> (SecretKey, String) {
        let secret = SecretKey::generate(&mut OsRng);
        let public = STANDARD.encode(secret.public_key().as_bytes());
        (secret, public)
    }

    #[test]
    fn seals_to_the_key_and_only_that_key_opens_it() {
        let (secret, public) = keypair();
        let sealed = STANDARD.decode(seal(&public, b"hunter2").unwrap()).unwrap();
        // Ephemeral public key (32) + MAC (16) + the message, as libsodium lays it out.
        assert_eq!(sealed.len(), 48 + 7);
        assert_eq!(secret.unseal(&sealed).unwrap(), b"hunter2");
        assert!(keypair().0.unseal(&sealed).is_err());
    }

    #[test]
    fn refuses_empty_oversized_and_bad_keys() {
        let (_, public) = keypair();
        assert!(seal(&public, b"").is_err());
        assert!(seal(&public, &vec![b'x'; SECRET_MAX_BYTES + 1]).is_err());
        assert!(seal(&public, &vec![b'x'; SECRET_MAX_BYTES]).is_ok());
        assert!(seal("AAAA", b"x").is_err());
        assert!(seal("not base64!", b"x").is_err());
    }

    /// Rust seals, libsodium (`libsodium-wrappers`, from the lab suite's packages) opens. Needs node and
    /// `npm ci --prefix tests/lab`; CI's Rust job sets FLEETD_REQUIRE_NODE_SEAL=1 so a missing node fails instead of
    /// skipping.
    #[test]
    fn node_libsodium_opens_what_rust_seals() {
        let node_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/lab");
        let has_sodium = std::path::Path::new(node_dir).join("node_modules/libsodium-wrappers").exists();
        if !has_sodium || Command::new("node").arg("--version").output().is_err() {
            assert!(std::env::var_os("FLEETD_REQUIRE_NODE_SEAL").is_none(), "node or tests/lab/node_modules missing");
            eprintln!("skipped: node or tests/lab/node_modules/libsodium-wrappers missing");
            return;
        }
        let (secret, public) = keypair();
        let secret_b64 = STANDARD.encode(secret.to_bytes());
        let message = "sk-test 🔑 value";
        let sealed = seal(&public, message.as_bytes()).unwrap();
        let script = r#"
            const sodium = require("libsodium-wrappers");
            sodium.ready.then(() => {
              const [pk, sk, sealed] = process.argv.slice(1).map((v) => sodium.from_base64(v, sodium.base64_variants.ORIGINAL));
              process.stdout.write(sodium.to_string(sodium.crypto_box_seal_open(sealed, pk, sk)));
            });
        "#;
        let out = Command::new("node").current_dir(node_dir).args(["-e", script, &public, &secret_b64, &sealed]).output().unwrap();
        assert!(out.status.success(), "node failed: {}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8(out.stdout).unwrap(), message);
    }
}
