//! An order's variables: secrets a person entered for one order's agents (`order:<machine>:<order id>` sinks), kept
//! by the node in `<node home>/order-env/<project>/<order>.json` and added, on top of the project's own
//! (project_env.rs), to every claude the node starts for a session of that order. A session already running gets
//! them at its next turn, when the node starts its claude again (sessions `ensure_live`). They go when the order
//! closes (`order_env_drop`). Kept as project variables are: the file is written atomically at mode 0600 in 0700
//! directories, plaintext buffers are wiped, and errors name a variable, never a value.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use fleetd_contracts::project_settings::{
    ENV_TOTAL_MAX_BYTES, ENV_VALUE_MAX_BYTES, PROJECT_ENV_MAX, env_name_reserved,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use super::project_env::Vars;
use super::secrets::write_atomic;

const DIR: &str = "order-env";

/// One `deliver` at a time: each reads the file, changes it and writes it back.
static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
struct OrderFile {
    vars: BTreeMap<String, Value>,
}

#[derive(Serialize, Deserialize)]
struct Value(String);

impl Drop for Value {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Project and order ids name files: anything else than a plain name is refused.
fn plain(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn file(home: &Path, project_id: &str, order_id: &str) -> Option<PathBuf> {
    (plain(project_id) && plain(order_id)).then(|| {
        home.join(DIR)
            .join(project_id)
            .join(format!("{order_id}.json"))
    })
}

fn read_file(path: &Path) -> std::io::Result<(OrderFile, Zeroizing<Vec<u8>>)> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((OrderFile::default(), Zeroizing::new(Vec::new())));
        }
        Err(e) => return Err(e),
    };
    let parsed = serde_json::from_slice(&bytes)
        .map_err(|_| std::io::Error::other("the file does not parse"))?;
    Ok((parsed, bytes))
}

fn io_why(error: &std::io::Error) -> String {
    super::util::errno_name(error).unwrap_or_else(|| error.to_string())
}

/// Saves `name` for the order's agents. The value, like a project variable's, is up to 64 KiB with any number of
/// lines and no NUL; the order's values and the project's together stay under 512 KiB, as they all go into each of the
/// order's sessions.
pub fn deliver(
    home: &Path,
    project_id: &str,
    order_id: &str,
    name: &str,
    value: &[u8],
) -> Result<(), String> {
    let Some(path) = file(home, project_id, order_id) else {
        return Err(format!("{project_id}/{order_id} names no order"));
    };
    if env_name_reserved(name) {
        return Err(format!(
            "{name} is fleetd's or claude's own: an order can't set it"
        ));
    }
    if value.is_empty() {
        return Err(format!("{name}'s value is empty"));
    }
    if value.len() > ENV_VALUE_MAX_BYTES {
        return Err(format!("{name}'s value is over 64 KiB"));
    }
    if value.contains(&0) {
        return Err(format!("{name}'s value holds a NUL character"));
    }
    let Ok(text) = std::str::from_utf8(value) else {
        return Err(format!("{name}'s value is not UTF-8 text"));
    };
    let shown = format!("{DIR}/{project_id}/{order_id}.json");
    let _writing = WRITING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (mut order, _) =
        read_file(&path).map_err(|e| format!("cannot read {shown}: {}", io_why(&e)))?;
    order.vars.insert(name.to_owned(), Value(text.to_owned()));
    let project = super::project_env::vars(home, project_id);
    let names = project
        .iter()
        .map(|(n, _)| n.as_str())
        .chain(order.vars.keys().map(String::as_str))
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    if names > PROJECT_ENV_MAX {
        return Err(format!(
            "an order's agents take at most {PROJECT_ENV_MAX} variables with the project's; this would make {names}"
        ));
    }
    let total = together(&project, &order);
    if total > ENV_TOTAL_MAX_BYTES {
        return Err(total_over(total));
    }
    let dir = path.parent().unwrap_or(home);
    super::config::mkdir_private(&home.join(DIR))
        .and_then(|()| super::config::mkdir_private(dir))
        .map_err(|e| format!("cannot make {DIR}: {}", io_why(&e)))?;
    let bytes = Zeroizing::new(serde_json::to_vec(&order).map_err(|e| e.to_string())?);
    write_atomic(&path, &bytes).map_err(|e| format!("cannot write {shown}: {}", io_why(&e)))
}

/// The size of what one of the order's sessions is given: the project's values, each replaced by the order's of the
/// same name, and the order's.
fn together(project: &Vars, order: &OrderFile) -> usize {
    project
        .iter()
        .filter(|(n, _)| !order.vars.contains_key(n))
        .map(|(_, v)| v.len())
        .sum::<usize>()
        + order.vars.values().map(|v| v.0.len()).sum::<usize>()
}

fn total_over(total: usize) -> String {
    format!(
        "An order's agents take at most 512 KiB of variables together with the project's; these would take {} KiB.",
        total.div_ceil(1024)
    )
}

/// The largest the project's sessions' variables would get if the project's own became `project`: its biggest
/// order's on top. Checked before the project's change is saved.
pub fn largest_with(home: &Path, project_id: &str, project: &Vars) -> Result<(), String> {
    let Some(dir) = plain(project_id).then(|| home.join(DIR).join(project_id)) else {
        return Ok(());
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let Ok((order, _)) = read_file(&entry.path()) else {
            continue;
        };
        let total = together(project, &order);
        if total > ENV_TOTAL_MAX_BYTES {
            let order_id = entry
                .path()
                .file_stem()
                .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
            return Err(format!(
                "with order {order_id}'s variables its agents would take {} KiB, over the 512 KiB they may have",
                total.div_ceil(1024)
            ));
        }
    }
    Ok(())
}

/// The order's variables, `(name, value)`, for a claude the node starts now (every one is a secret), and a digest of
/// them: when the digest changes, a running session of the order is started again at its next turn. `None` when the
/// order has none; a file that can't be read gives none, logged without its contents.
pub fn for_spawn(home: &Path, project_id: &str, order_id: &str) -> (Vars, Option<String>) {
    let Some(path) = file(home, project_id, order_id) else {
        return (Vec::new(), None);
    };
    match read_file(&path) {
        Ok((order, bytes)) if !order.vars.is_empty() => {
            let vars = order
                .vars
                .iter()
                .filter(|(name, _)| !env_name_reserved(name))
                .map(|(name, value)| (name.clone(), value.0.clone()))
                .collect();
            (vars, Some(digest(&bytes)))
        }
        Ok(_) => (Vec::new(), None),
        Err(e) => {
            tracing::warn!(project_id, order_id, "order env not read: {}", io_why(&e));
            (Vec::new(), None)
        }
    }
}

/// The digest [`for_spawn`] gives, without the values.
pub fn digest_of(home: &Path, project_id: &str, order_id: &str) -> Option<String> {
    let path = file(home, project_id, order_id)?;
    match read_file(&path) {
        Ok((order, bytes)) if !order.vars.is_empty() => Some(digest(&bytes)),
        _ => None,
    }
}

fn digest(bytes: &[u8]) -> String {
    let sum = Sha256::digest(bytes);
    sum[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Forgets the order's variables, when it closes.
pub fn forget(home: &Path, project_id: &str, order_id: &str) -> Result<(), String> {
    let Some(path) = file(home, project_id, order_id) else {
        return Ok(());
    };
    let _writing = WRITING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!(
            "cannot remove {DIR}/{project_id}/{order_id}.json: {}",
            io_why(&e)
        )),
        _ => Ok(()),
    }
}

/// Forgets one of the order's variables: one the hub could not record.
pub fn forget_one(home: &Path, project_id: &str, order_id: &str, name: &str) -> Result<(), String> {
    let Some(path) = file(home, project_id, order_id) else {
        return Ok(());
    };
    let shown = format!("{DIR}/{project_id}/{order_id}.json");
    let _writing = WRITING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (mut order, _) =
        read_file(&path).map_err(|e| format!("cannot read {shown}: {}", io_why(&e)))?;
    if order.vars.remove(name).is_none() {
        return Ok(());
    }
    if order.vars.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("cannot remove {shown}: {}", io_why(&e)))
            }
            _ => Ok(()),
        };
    }
    let bytes = Zeroizing::new(serde_json::to_vec(&order).map_err(|e| e.to_string())?);
    write_atomic(&path, &bytes).map_err(|e| format!("cannot write {shown}: {}", io_why(&e)))
}

/// Forgets every order's variables of the project, when the project goes.
pub fn forget_project(home: &Path, project_id: &str) {
    if !plain(project_id) {
        return;
    }
    if let Err(e) = std::fs::remove_dir_all(home.join(DIR).join(project_id))
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(project_id, "order env not removed: {}", io_why(&e));
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn a_value_reaches_its_order_only_and_goes_with_it() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        assert_eq!(for_spawn(home, "p", "W1"), (Vec::new(), None));
        deliver(home, "p", "W1", "DB_URL", b"postgres://u:pw@db/x").unwrap();
        let (vars, digest) = for_spawn(home, "p", "W1");
        assert_eq!(
            vars,
            [("DB_URL".to_owned(), "postgres://u:pw@db/x".to_owned())]
        );
        assert_eq!(digest, digest_of(home, "p", "W1"));
        // Another order, or the same order id in another project, has none of it.
        assert!(for_spawn(home, "p", "W2").0.is_empty());
        assert!(for_spawn(home, "q", "W1").0.is_empty());
        let path = file(home, "p", "W1").unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        // A second variable changes the digest: a running session starts again at its next turn.
        deliver(home, "p", "W1", "API_KEY", b"k-123456").unwrap();
        assert_ne!(digest_of(home, "p", "W1"), digest);
        assert_eq!(for_spawn(home, "p", "W1").0.len(), 2);
        forget_one(home, "p", "W1", "API_KEY").unwrap();
        assert_eq!(for_spawn(home, "p", "W1").0.len(), 1);
        forget(home, "p", "W1").unwrap();
        assert_eq!(for_spawn(home, "p", "W1"), (Vec::new(), None));
        forget(home, "p", "W1").unwrap();
    }

    #[test]
    fn the_project_limits_hold_and_errors_never_name_the_value() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        for (name, value) in [
            ("FLEETD_THREAD_ID", &b"hunter22"[..]),
            ("A", b"hunter2\0x"),
            ("A", b""),
        ] {
            let error = deliver(home, "p", "W1", name, value).unwrap_err();
            assert!(!error.contains("hunter2"), "{error}");
        }
        let big = vec![b'x'; ENV_VALUE_MAX_BYTES + 1];
        assert!(deliver(home, "p", "W1", "BIG", &big).is_err());
        assert!(deliver(home, "../p", "W1", "A", b"1234").is_err());
        // A multi-line value, as a project's may be.
        let pem = crate::node::project_env::tests::PEM;
        deliver(home, "p", "W1", "TLS", pem.as_bytes()).unwrap();
        // Seven 64 KiB values fit beside the chain; an eighth would pass 512 KiB.
        let value = vec![b'y'; ENV_VALUE_MAX_BYTES];
        for i in 0..7 {
            deliver(home, "p", "W1", &format!("V{i}"), &value).unwrap();
        }
        let error = deliver(home, "p", "W1", "V7", &value).unwrap_err();
        assert!(error.contains("512 KiB"), "{error}");
        assert_eq!(for_spawn(home, "p", "W1").0.len(), 8);
        // The project's own then can't grow past it either.
        let project = vec![("P".to_owned(), "z".repeat(ENV_VALUE_MAX_BYTES))];
        let error = largest_with(home, "p", &project).unwrap_err();
        assert!(error.contains("order W1"), "{error}");
        assert!(largest_with(home, "p", &Vec::new()).is_ok());
        forget_project(home, "p");
        assert!(for_spawn(home, "p", "W1").0.is_empty());
    }
}
