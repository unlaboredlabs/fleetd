//! Where the hub URL and human key live. Calls block on the OS, so run them off the UI thread.
//!
//! - Linux (and Windows): the OS keychain (the Secret Service, Credential Manager).
//! - macOS, app signed with a Team ID (Developer ID): the login keychain. The keychain trusts the app by its
//!   Team ID, so "Always Allow" survives updates.
//! - macOS, ad-hoc or unsigned (every build until the release is Developer ID signed): a 0600 file,
//!   `~/Library/Application Support/fleetd/hub.json`, as `gh` and `claude` keep theirs. The keychain can only trust
//!   such an app by its exact code hash, which changes with every build, so each update asked for the login
//!   password again and "Always Allow" never stuck.
//!
//! Older macOS builds kept the key in the keychain item `fleetd`/`hub`. It is read at most once, ever (a marker
//! file records the attempt before it), and moved to the current store; it is never written or deleted, since
//! either could prompt again.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

const SERVICE: &str = "fleetd";
#[cfg(not(test))]
const ACCOUNT: &str = "hub";
// Tests never touch the real entries.
#[cfg(test)]
const ACCOUNT: &str = "hub-test";
/// A new item for Developer ID builds, so it's created by (and trusts) the signed app rather than an ad-hoc one.
const SIGNED_ACCOUNT: &str = if cfg!(test) { "hub-developer-id-test" } else { "hub-developer-id" };
const FILE: &str = "hub.json";
const MIGRATED: &str = "keychain-migrated";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub url: String,
    pub key: String,
}

/// What launch found.
#[derive(Debug, PartialEq)]
pub struct Loaded {
    pub saved: Option<Saved>,
    /// A plain note for the connect screen, e.g. that the old keychain entry couldn't be read.
    pub note: Option<String>,
}

/// For scripted runs: both set means use them for this run and store nothing.
pub fn from_env() -> Option<Saved> {
    let url = std::env::var("FLEETD_HUB_URL").ok().filter(|v| !v.is_empty())?;
    let key = std::env::var("FLEETD_AGENT_KEY").ok().filter(|v| !v.is_empty())?;
    Some(Saved { url, key })
}

pub fn load() -> Result<Loaded, String> {
    let place = Place::here()?;
    eprintln!("fleetd-app: hub key store: {}", place.describe_store());
    place.load(&OsKeychain)
}

pub fn save(saved: &Saved) -> Result<(), String> {
    Place::here()?.save(&OsKeychain, saved)
}

pub fn clear() -> Result<(), String> {
    Place::here()?.clear(&OsKeychain)
}

/// For the UI: "in the OS keychain" or "in a file only you can read (…)". Known once [`load`] has run.
pub fn where_kept() -> String {
    Place::here().map_or_else(|_| "in the OS keychain".into(), |p| p.describe_store())
}

/// One keychain item per account under [`SERVICE`]; tests use a map.
trait Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, text: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct OsKeychain;

impl OsKeychain {
    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, account).map_err(|e| format!("No OS keychain available ({e})."))
    }
}

impl Keychain for OsKeychain {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match Self::entry(account)?.get_password() {
            Ok(text) => Ok(Some(text)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Couldn't read the OS keychain ({e}).")),
        }
    }

    fn set(&self, account: &str, text: &str) -> Result<(), String> {
        Self::entry(account)?.set_password(text).map_err(|e| format!("Couldn't save to the OS keychain ({e})."))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Couldn't remove the key from the OS keychain ({e}).")),
        }
    }
}

/// The store decision: the platform, how this app is signed, and the app's data directory.
#[derive(Clone, Debug)]
struct Place {
    mac: bool,
    team_signed: bool,
    /// `~/Library/Application Support/fleetd` on macOS.
    dir: PathBuf,
}

impl Place {
    fn here() -> Result<Self, String> {
        let dir = crate::pair::app_pair_file().and_then(|f| f.parent().map(Path::to_path_buf)).ok_or("No home directory.")?;
        Ok(Self { mac: cfg!(target_os = "macos"), team_signed: team_signed(), dir })
    }

    /// The keychain item this app reads and writes, or `None` for the file.
    fn keychain_account(&self) -> Option<&'static str> {
        match (self.mac, self.team_signed) {
            (false, _) => Some(ACCOUNT),
            (true, true) => Some(SIGNED_ACCOUNT),
            (true, false) => None,
        }
    }

    fn file(&self) -> PathBuf {
        self.dir.join(FILE)
    }

    fn describe_store(&self) -> String {
        match self.keychain_account() {
            Some(_) => "in the OS keychain".into(),
            None => format!("in a file only you can read ({})", self.file().display()),
        }
    }

    fn load(&self, keychain: &impl Keychain) -> Result<Loaded, String> {
        let found = |saved| Ok(Loaded { saved: Some(saved), note: None });
        match self.keychain_account() {
            Some(account) => {
                if let Some(text) = keychain.get(account)? {
                    return found(parse(&text).ok_or("The saved hub entry in the keychain is unreadable.")?);
                }
                if self.mac
                    && let Some(saved) = read_file(&self.file())
                {
                    // Left by an ad-hoc build: into the keychain, then the file goes.
                    if keychain.set(account, &serde_json::to_string(&saved).unwrap()).is_ok() {
                        std::fs::remove_file(self.file()).ok();
                    }
                    return found(saved);
                }
            }
            None => {
                if let Some(saved) = read_file(&self.file()) {
                    return found(saved);
                }
            }
        }
        if self.mac { Ok(self.migrate_once(keychain)) } else { Ok(Loaded { saved: None, note: None }) }
    }

    /// Reads the old `fleetd`/`hub` item at most once, ever. The marker is written first, so a denied, cancelled
    /// or crashed read is never retried; if it can't be written, the item isn't read at all.
    fn migrate_once(&self, keychain: &impl Keychain) -> Loaded {
        let nothing = Loaded { saved: None, note: None };
        let marker = self.dir.join(MIGRATED);
        if marker.exists() || make_dir(&self.dir).and_then(|()| std::fs::write(&marker, b"")).is_err() {
            return nothing;
        }
        eprintln!("fleetd-app: reading the hub key an earlier version kept in the keychain (once)");
        match keychain.get(ACCOUNT) {
            Ok(None) => nothing,
            Ok(Some(text)) => match parse(&text) {
                Some(saved) => {
                    let note = self.save(keychain, &saved).err().map(|e| format!("{e} Connected for this session only."));
                    Loaded { saved: Some(saved), note }
                }
                None => Loaded { saved: None, note: Some(PAIR_AGAIN.into()) },
            },
            Err(_) => Loaded { saved: None, note: Some(PAIR_AGAIN.into()) },
        }
    }

    /// Writes only when the value changed, so an unchanged key never rewrites the store.
    fn save(&self, keychain: &impl Keychain, saved: &Saved) -> Result<(), String> {
        let text = serde_json::to_string(saved).unwrap();
        if self.mac {
            // A fresh pairing settles the old item too: it's never read after this.
            make_dir(&self.dir).and_then(|()| std::fs::write(self.dir.join(MIGRATED), b"")).ok();
        }
        match self.keychain_account() {
            Some(account) => {
                if keychain.get(account).ok().flatten().as_deref() == Some(text.as_str()) {
                    return Ok(());
                }
                keychain.set(account, &text)
            }
            None => {
                if read_file(&self.file()).as_ref() == Some(saved) {
                    return Ok(());
                }
                write_private(&self.dir, &self.file(), text.as_bytes())
            }
        }
    }

    fn clear(&self, keychain: &impl Keychain) -> Result<(), String> {
        if self.mac {
            match std::fs::remove_file(self.file()) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Couldn't remove {} ({e}).", self.file().display())),
            }
        }
        match self.keychain_account() {
            Some(account) => keychain.delete(account),
            None => Ok(()),
        }
    }
}

const PAIR_AGAIN: &str = "This version keeps its key outside the keychain and couldn't move the old one. Pair once more to continue.";

fn parse(text: &str) -> Option<Saved> {
    serde_json::from_str(text).ok()
}

fn read_file(path: &Path) -> Option<Saved> {
    std::fs::read_to_string(path).ok().as_deref().and_then(parse)
}

#[cfg(unix)]
fn make_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn make_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// 0600 from creation, in a 0700 directory, renamed into place so a crash never leaves half a file.
fn write_private(dir: &Path, path: &Path, body: &[u8]) -> Result<(), String> {
    let failed = |e: std::io::Error| format!("Couldn't save {} ({e}).", path.display());
    make_dir(dir).map_err(failed)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::remove_file(&tmp).ok();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&tmp).map_err(failed)?;
    file.write_all(body).and_then(|()| file.sync_all()).map_err(failed)?;
    std::fs::rename(&tmp, path).map_err(failed)
}

/// Whether this running app is signed by an Apple-issued certificate with a Team ID (Developer ID or Apple
/// Development). Ad-hoc and unsigned builds aren't. Checked once, against the app's own signature.
fn team_signed() -> bool {
    static SIGNED: OnceLock<bool> = OnceLock::new();
    *SIGNED.get_or_init(check_team_signed)
}

#[cfg(target_os = "macos")]
const TEAM_REQUIREMENT: &str = "anchor apple generic and certificate leaf[subject.OU] exists";

#[cfg(target_os = "macos")]
fn check_team_signed() -> bool {
    use security_framework::os::macos::code_signing::{Flags, SecCode, SecRequirement};
    let Ok(requirement) = TEAM_REQUIREMENT.parse::<SecRequirement>() else { return false };
    SecCode::for_self(Flags::NONE).and_then(|code| code.check_validity(Flags::NONE, &requirement)).is_ok()
}

#[cfg(not(target_os = "macos"))]
fn check_team_signed() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use super::*;

    #[derive(Default)]
    struct FakeKeychain {
        items: RefCell<HashMap<String, String>>,
        /// Every call, in order, e.g. "get hub-test".
        calls: RefCell<Vec<String>>,
        deny: bool,
    }

    impl FakeKeychain {
        fn with(account: &str, saved: &Saved) -> Self {
            let k = Self::default();
            k.items.borrow_mut().insert(account.into(), serde_json::to_string(saved).unwrap());
            k
        }
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl Keychain for FakeKeychain {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.calls.borrow_mut().push(format!("get {account}"));
            if self.deny {
                return Err("User canceled the operation.".into());
            }
            Ok(self.items.borrow().get(account).cloned())
        }
        fn set(&self, account: &str, text: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("set {account}"));
            self.items.borrow_mut().insert(account.into(), text.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("delete {account}"));
            self.items.borrow_mut().remove(account);
            Ok(())
        }
    }

    fn saved() -> Saved {
        Saved { url: "http://127.0.0.1:4790".into(), key: "fld_test".into() }
    }

    fn mac(team_signed: bool) -> (Place, PathBuf) {
        let dir = std::env::temp_dir().join(format!("fleetd-keychain-{}-{}", std::process::id(), rand_suffix()));
        std::fs::remove_dir_all(&dir).ok();
        (Place { mac: true, team_signed, dir: dir.clone() }, dir)
    }

    fn rand_suffix() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        N.fetch_add(1, Ordering::Relaxed)
    }

    #[test]
    fn the_keychain_only_for_a_team_signed_mac_app_or_off_macos() {
        let dir = PathBuf::from("/x");
        let place = |mac, team_signed| Place { mac, team_signed, dir: dir.clone() };
        assert_eq!(place(true, false).keychain_account(), None, "ad-hoc macOS uses the file");
        assert_eq!(place(true, true).keychain_account(), Some(SIGNED_ACCOUNT));
        assert_eq!(place(false, false).keychain_account(), Some(ACCOUNT), "Linux keeps its Secret Service entry");
    }

    #[test]
    fn ad_hoc_moves_the_old_item_once_then_never_touches_the_keychain() {
        let (place, dir) = mac(false);
        let keychain = FakeKeychain::with(ACCOUNT, &saved());
        assert_eq!(place.load(&keychain).unwrap(), Loaded { saved: Some(saved()), note: None });
        assert_eq!(keychain.calls(), ["get hub-test"], "one read, no write or delete of the old item");
        for _ in 0..2 {
            assert_eq!(place.load(&keychain).unwrap().saved, Some(saved()));
        }
        assert_eq!(keychain.calls().len(), 1, "relaunches read only the file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&dir.join(FILE)), 0o600);
            assert_eq!(mode(&dir), 0o700);
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_denied_read_is_never_retried_and_asks_to_pair() {
        let (place, dir) = mac(false);
        let keychain = FakeKeychain { deny: true, ..FakeKeychain::with(ACCOUNT, &saved()) };
        let first = place.load(&keychain).unwrap();
        assert_eq!(first.saved, None);
        assert!(first.note.unwrap().contains("Pair once more"));
        assert_eq!(place.load(&keychain).unwrap(), Loaded { saved: None, note: None });
        assert_eq!(keychain.calls(), ["get hub-test"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn after_disconnect_the_old_item_stays_unread() {
        let (place, dir) = mac(false);
        let keychain = FakeKeychain::with(ACCOUNT, &saved());
        place.load(&keychain).unwrap();
        place.clear(&keychain).unwrap();
        assert_eq!(place.load(&keychain).unwrap().saved, None);
        assert_eq!(keychain.calls(), ["get hub-test"], "clear touches no keychain item on an ad-hoc build");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_fresh_pairing_settles_the_old_item_and_rewrites_nothing_unchanged() {
        let (place, dir) = mac(false);
        let keychain = FakeKeychain::with(ACCOUNT, &saved());
        place.save(&keychain, &saved()).unwrap();
        let written = std::fs::metadata(dir.join(FILE)).unwrap().modified().unwrap();
        place.save(&keychain, &saved()).unwrap();
        assert_eq!(std::fs::metadata(dir.join(FILE)).unwrap().modified().unwrap(), written);
        place.clear(&keychain).unwrap();
        assert_eq!(place.load(&keychain).unwrap().saved, None);
        assert!(keychain.calls().is_empty(), "the old item is never read after a pairing: {:?}", keychain.calls());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_signed_build_takes_over_the_file_into_its_own_item() {
        let (ad_hoc, dir) = mac(false);
        let keychain = FakeKeychain::default();
        ad_hoc.save(&keychain, &saved()).unwrap();
        let signed = Place { team_signed: true, ..ad_hoc };
        assert_eq!(signed.load(&keychain).unwrap().saved, Some(saved()));
        assert!(!dir.join(FILE).exists(), "the file goes once the keychain has it");
        assert_eq!(signed.load(&keychain).unwrap().saved, Some(saved()));
        assert_eq!(keychain.calls(), ["get hub-developer-id-test", "set hub-developer-id-test", "get hub-developer-id-test"]);
        signed.save(&keychain, &saved()).unwrap();
        assert!(!keychain.calls().iter().skip(3).any(|c| c.starts_with("set")), "unchanged: no rewrite");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn linux_reads_and_writes_its_one_keychain_entry_and_no_file() {
        let dir = std::env::temp_dir().join(format!("fleetd-keychain-linux-{}", std::process::id()));
        let place = Place { mac: false, team_signed: false, dir: dir.clone() };
        let keychain = FakeKeychain::default();
        assert_eq!(place.load(&keychain).unwrap().saved, None);
        place.save(&keychain, &saved()).unwrap();
        assert_eq!(place.load(&keychain).unwrap().saved, Some(saved()));
        assert!(!dir.exists(), "no file and no marker off macOS");
        assert_eq!(keychain.calls(), ["get hub-test", "get hub-test", "set hub-test", "get hub-test"]);
    }

    /// The test binary is ad-hoc signed by the linker, so this also proves an ad-hoc build reads as unsigned.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_team_requirement_parses_and_an_ad_hoc_build_fails_it() {
        use security_framework::os::macos::code_signing::SecRequirement;
        assert!(TEAM_REQUIREMENT.parse::<SecRequirement>().is_ok());
        assert!(!check_team_signed());
    }

    /// Needs an OS keychain (CI has none): `cargo test -p fleetd-app -- --ignored keychain`.
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        let keychain = OsKeychain;
        let text = serde_json::to_string(&saved()).unwrap();
        keychain.set(ACCOUNT, &text).unwrap();
        assert_eq!(keychain.get(ACCOUNT).unwrap(), Some(text));
        keychain.delete(ACCOUNT).unwrap();
        assert_eq!(keychain.get(ACCOUNT).unwrap(), None);
        keychain.delete(ACCOUNT).unwrap();
    }
}
