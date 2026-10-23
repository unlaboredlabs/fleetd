//! The node's keys, as PKCS#8 PEM files Node's crypto reads and writes: the ed25519 identity that signs the hub's
//! challenge (`node-key.pem`) and the X25519 key secrets are sealed to (`node-box-key.pem`). Both are created mode
//! 0600 on first use, so a node that joined before M8 gets its box key on its next start.
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signer, SigningKey};
use rand::RngCore;
use zeroize::{Zeroize, Zeroizing};

use super::config::mkdir_private;

const KEY_FILE: &str = "node-key.pem";
const BOX_KEY_FILE: &str = "node-box-key.pem";

/// PKCS#8 v1 DER for a bare 32-byte key: SEQUENCE { INTEGER 0, SEQUENCE { OID }, OCTET STRING { OCTET STRING key } }.
const fn pkcs8_prefix(oid_last: u8) -> [u8; 16] {
    [
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, oid_last, 0x04, 0x22,
        0x04, 0x20,
    ]
}
const ED25519_OID: u8 = 0x70;
const X25519_OID: u8 = 0x6e;

fn to_pem(oid_last: u8, key: &[u8; 32]) -> Zeroizing<String> {
    let mut der = Zeroizing::new(Vec::with_capacity(48));
    der.extend_from_slice(&pkcs8_prefix(oid_last));
    der.extend_from_slice(key);
    let body = Zeroizing::new(B64.encode(der.as_slice()));
    let mut pem = String::from("-----BEGIN PRIVATE KEY-----\n");
    for line in body.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(line).unwrap_or_default());
        pem.push('\n');
    }
    pem.push_str("-----END PRIVATE KEY-----\n");
    Zeroizing::new(pem)
}

fn from_pem(oid_last: u8, pem: &str) -> Option<Zeroizing<[u8; 32]>> {
    let body: Zeroizing<String> = Zeroizing::new(
        pem.lines()
            .filter(|line| !line.starts_with("-----"))
            .map(str::trim)
            .collect(),
    );
    let der = Zeroizing::new(B64.decode(body.as_bytes()).ok()?);
    if der.len() != 48 || der[..16] != pkcs8_prefix(oid_last) {
        return None;
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&der[16..]);
    Some(key)
}

/// The key in `<home>/<file>`, or a fresh one written there with `create_new` and mode 0600.
fn load_or_create(home: &Path, file: &str, oid_last: u8) -> std::io::Result<Zeroizing<[u8; 32]>> {
    let path = home.join(file);
    if path.exists() {
        let pem = Zeroizing::new(std::fs::read_to_string(&path)?);
        return from_pem(oid_last, &pem)
            .ok_or_else(|| std::io::Error::other("not a PKCS#8 key of the expected type"));
    }
    mkdir_private(home)?;
    let mut key = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(key.as_mut());
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    out.write_all(to_pem(oid_last, &key).as_bytes())?;
    Ok(key)
}

pub struct NodeIdentity {
    key: SigningKey,
}

impl NodeIdentity {
    /// Raw 32-byte ed25519 public key, base64.
    pub fn pub_key(&self) -> String {
        B64.encode(self.key.verifying_key().as_bytes())
    }

    /// Signature over the nonce's UTF-8 bytes, base64.
    pub fn sign(&self, nonce: &str) -> String {
        B64.encode(self.key.sign(nonce.as_bytes()).to_bytes())
    }
}

pub fn load_or_create_identity(home: &Path) -> std::io::Result<NodeIdentity> {
    let seed = load_or_create(home, KEY_FILE, ED25519_OID)?;
    Ok(NodeIdentity {
        key: SigningKey::from_bytes(&seed),
    })
}

pub struct NodeBoxKey {
    secret: crypto_box::SecretKey,
}

impl NodeBoxKey {
    /// Raw 32-byte X25519 public key, standard base64: what browsers seal this machine's secrets to.
    pub fn public_key(&self) -> String {
        B64.encode(self.secret.public_key().as_bytes())
    }

    /// Opens a libsodium sealed box (`crypto_box_seal`); `None` when it was not sealed to this key or was tampered
    /// with.
    pub fn open(&self, sealed: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
        self.secret.unseal(sealed).ok().map(Zeroizing::new)
    }
}

pub fn load_or_create_box_key(home: &Path) -> std::io::Result<NodeBoxKey> {
    let mut bytes = load_or_create(home, BOX_KEY_FILE, X25519_OID)?;
    let secret = crypto_box::SecretKey::from(*bytes);
    bytes.zeroize();
    Ok(NodeBoxKey { secret })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    #[test]
    fn hello_signature_verifies_over_the_nonce_and_nothing_else() {
        let home = tempfile::tempdir().unwrap();
        let identity = load_or_create_identity(home.path()).unwrap();
        let again = load_or_create_identity(home.path()).unwrap();
        assert_eq!(identity.pub_key(), again.pub_key());
        let mode = std::os::unix::fs::PermissionsExt::mode(
            &std::fs::metadata(home.path().join(KEY_FILE))
                .unwrap()
                .permissions(),
        );
        assert_eq!(mode & 0o777, 0o600);

        let public: [u8; 32] = B64.decode(identity.pub_key()).unwrap().try_into().unwrap();
        let verifier = VerifyingKey::from_bytes(&public).unwrap();
        let sig: [u8; 64] = B64
            .decode(identity.sign("nonce-1"))
            .unwrap()
            .try_into()
            .unwrap();
        let sig = Signature::from_bytes(&sig);
        assert!(verifier.verify(b"nonce-1", &sig).is_ok());
        assert!(verifier.verify(b"nonce-2", &sig).is_err());
    }

    /// Vectors from `testdata/interop.mjs gen`: keys written by node:crypto, a value sealed by libsodium-wrappers.
    fn vectors() -> serde_json::Value {
        serde_json::from_str(include_str!("testdata/interop.json")).unwrap()
    }

    #[test]
    fn sealed_boxes_interoperate_with_libsodium() {
        let v = vectors();
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join(BOX_KEY_FILE),
            v["boxKeyPem"].as_str().unwrap(),
        )
        .unwrap();
        let node_key = load_or_create_box_key(home.path()).unwrap();
        assert_eq!(node_key.public_key(), v["boxPubKey"].as_str().unwrap());
        let opened = node_key
            .open(&B64.decode(v["sealed"].as_str().unwrap()).unwrap())
            .unwrap();
        assert_eq!(opened.as_slice(), v["value"].as_str().unwrap().as_bytes());

        // Another key cannot open it, and neither can a tampered box.
        let other = load_or_create_box_key(tempfile::tempdir().unwrap().path()).unwrap();
        let mut sealed = B64.decode(v["sealed"].as_str().unwrap()).unwrap();
        assert!(other.open(&sealed).is_none());
        sealed[40] ^= 1;
        assert!(node_key.open(&sealed).is_none());

        // The other way: a key this node created, a value sealed here, opened by libsodium with Node reading our PEM.
        let rust_home = tempfile::tempdir().unwrap();
        let rust_key = load_or_create_box_key(rust_home.path()).unwrap();
        let public: [u8; 32] = B64
            .decode(rust_key.public_key())
            .unwrap()
            .try_into()
            .unwrap();
        let sealed = crypto_box::PublicKey::from(public)
            .seal(&mut crypto_box::aead::OsRng, b"sealed-by-rust")
            .unwrap();
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let sodium = std::env::var_os("LIBSODIUM_WRAPPERS")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| manifest.join("../../tests/lab/node_modules/libsodium-wrappers"));
        if !sodium.exists() {
            // CI's `rust` job installs tests/lab, so a missing package there is a broken setup, not a skip.
            assert!(
                std::env::var_os("FLEETD_REQUIRE_NODE_SEAL").is_none(),
                "no libsodium-wrappers at {}",
                sodium.display()
            );
            eprintln!(
                "skipped libsodium opening a Rust-sealed box: no libsodium-wrappers at {} (set LIBSODIUM_WRAPPERS)",
                sodium.display()
            );
            return;
        }
        let out = std::process::Command::new("node")
            .arg(manifest.join("src/node/testdata/interop.mjs"))
            .args([
                "open",
                rust_home.path().join(BOX_KEY_FILE).to_str().unwrap(),
                &B64.encode(&sealed),
            ])
            .env("LIBSODIUM_WRAPPERS", &sodium)
            .output()
            .expect("node runs");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(B64.decode(out.stdout).unwrap(), b"sealed-by-rust");
    }
}
