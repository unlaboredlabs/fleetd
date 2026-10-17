//! Webhook secrets at rest: AES-256-GCM under a key that lives in its own 0600 file in the hub home, so a copy of
//! hub.sqlite alone does not reveal them. Sealed form: base64(iv 12 || tag 16 || ciphertext), as the TS hub writes,
//! so its subscriptions keep working. TS spec: apps/hub/src/webhooks/SecretBox.ts.
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rand::RngCore;

const KEY_BYTES: usize = 32;
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

pub struct SecretBox {
    cipher: Aes256Gcm,
}

#[derive(Debug, thiserror::Error)]
pub enum SecretBoxError {
    #[error("webhook key must be {KEY_BYTES} bytes, got {0}")]
    KeyLength(usize),
    #[error("webhook key file: {0}")]
    Io(#[from] std::io::Error),
    #[error("sealed secret does not open under this key")]
    Open,
}

impl SecretBox {
    pub fn from_key(key: &[u8]) -> Result<Self, SecretBoxError> {
        if key.len() != KEY_BYTES {
            return Err(SecretBoxError::KeyLength(key.len()));
        }
        Ok(Self {
            cipher: Aes256Gcm::new_from_slice(key)
                .map_err(|_| SecretBoxError::KeyLength(key.len()))?,
        })
    }

    /// Reads the key in `file`, creating it (0600, exclusive, so two processes can't each write one) if missing.
    pub fn from_key_file(file: &Path) -> Result<Self, SecretBoxError> {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(file)
        {
            Ok(mut f) => {
                let mut key = [0u8; KEY_BYTES];
                rand::thread_rng().fill_bytes(&mut key);
                f.write_all(&key)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))?;
        Self::from_key(&std::fs::read(file)?)
    }

    pub fn seal(&self, plain: &str) -> String {
        let mut iv = [0u8; IV_BYTES];
        rand::thread_rng().fill_bytes(&mut iv);
        // aes-gcm appends the tag; the stored form puts it before the ciphertext.
        let out = self
            .cipher
            .encrypt(Nonce::from_slice(&iv), plain.as_bytes())
            .expect("aes-gcm seals");
        let (ciphertext, tag) = out.split_at(out.len() - TAG_BYTES);
        STANDARD.encode([&iv[..], tag, ciphertext].concat())
    }

    /// Fails when `sealed` was not sealed under this key.
    pub fn open(&self, sealed: &str) -> Result<String, SecretBoxError> {
        let bytes = STANDARD.decode(sealed).map_err(|_| SecretBoxError::Open)?;
        if bytes.len() < IV_BYTES + TAG_BYTES {
            return Err(SecretBoxError::Open);
        }
        let (iv, rest) = bytes.split_at(IV_BYTES);
        let (tag, ciphertext) = rest.split_at(TAG_BYTES);
        let plain = self
            .cipher
            .decrypt(Nonce::from_slice(iv), [ciphertext, tag].concat().as_slice())
            .map_err(|_| SecretBoxError::Open)?;
        String::from_utf8(plain).map_err(|_| SecretBoxError::Open)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_a_0600_key_file_once_and_opens_only_what_it_sealed() {
        let dir = std::env::temp_dir().join(format!("fleetd-webhooks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("webhook.key");
        let _ = std::fs::remove_file(&file);
        let sealed = SecretBox::from_key_file(&file).unwrap().seal("whsec_abc");
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!sealed.contains("whsec_abc"));
        assert_eq!(
            SecretBox::from_key_file(&file)
                .unwrap()
                .open(&sealed)
                .unwrap(),
            "whsec_abc"
        );
        assert!(
            SecretBox::from_key(&[7u8; 32])
                .unwrap()
                .open(&sealed)
                .is_err()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Sealed by the TS hub's SecretBox (node:crypto aes-256-gcm) under the all-0x01 key.
    #[test]
    fn opens_a_secret_the_ts_hub_sealed() {
        let sealed = "fGGbV1rLl/0XkEex8MCs/D9kx2cBl70tsZDOecEvZI6ZeGuFsTBNObo=";
        assert_eq!(
            SecretBox::from_key(&[1u8; 32])
                .unwrap()
                .open(sealed)
                .unwrap(),
            "whsec_interop"
        );
    }
}
