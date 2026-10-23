//! Reading playbook files: YAML frontmatter checked against the Playbook schema, pinned by git blob SHA. fleetd's own
//! playbooks are compiled in; the user's overrides are read from `<hub home>/playbooks`.
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

use fleetd_contracts::ledger::{PlaybookName, PlaybookRef};
use regex::Regex;
use sha1::{Digest, Sha1};

use super::Playbook;

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct PlaybookError {
    pub message: String,
}

impl PlaybookError {
    fn new(message: impl Into<String>) -> Self {
        let message: String = message.into();
        Self {
            message: message.chars().take(1000).collect(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct LoadedPlaybook {
    pub r#ref: PlaybookRef,
    pub playbook: Playbook,
    /// The whole file, as hashed.
    pub text: String,
}

/// fleetd's own playbooks, by name.
pub const BUNDLED: [(PlaybookName, &str); 3] = [
    (
        PlaybookName::Bugfix,
        include_str!("../../../../../playbooks/bugfix.md"),
    ),
    (
        PlaybookName::Feature,
        include_str!("../../../../../playbooks/feature.md"),
    ),
    (
        PlaybookName::Research,
        include_str!("../../../../../playbooks/research.md"),
    ),
];

/// What `git hash-object <file>` prints for these bytes.
pub fn git_blob_sha(content: &[u8]) -> String {
    let mut sha = Sha1::new();
    sha.update(format!("blob {}\0", content.len()).as_bytes());
    sha.update(content);
    hex(&sha.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

static FRONTMATTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)").unwrap());

/// Parses one playbook file. `expected` is the file's base name, which must match its `name`.
pub fn parse_playbook(
    text: &str,
    place: &str,
    expected: Option<PlaybookName>,
) -> Result<LoadedPlaybook, PlaybookError> {
    let invalid =
        |problem: String| PlaybookError::new(format!("playbook {place} is invalid: {problem}"));
    let Some(m) = FRONTMATTER.captures(text) else {
        return Err(invalid(
            "it must start with YAML frontmatter between two `---` lines".into(),
        ));
    };
    let yaml: serde_json::Value = serde_yaml_ng::from_str(&m[1]).map_err(|e| {
        invalid(format!(
            "YAML: {}",
            e.to_string().lines().next().unwrap_or_default()
        ))
    })?;
    let playbook: Playbook = serde_path_to_error::deserialize(yaml).map_err(|e| {
        let at = e.path().to_string();
        let inner = e.into_inner().to_string().replace('\n', " ");
        invalid(if at == "." {
            inner
        } else {
            format!("{inner} at {at}")
        })
    })?;
    if let Some(name) = expected
        && playbook.name != name
    {
        return Err(invalid(format!(
            "its name is {} but the file is {}.md",
            playbook.name.as_str(),
            name.as_str()
        )));
    }
    let r#ref = PlaybookRef::new(format!(
        "{}@{}",
        playbook.name.as_str(),
        git_blob_sha(text.as_bytes())
    ))
    .map_err(invalid)?;
    Ok(LoadedPlaybook {
        r#ref,
        playbook,
        text: text.to_string(),
    })
}

fn name_of(stem: &str) -> Option<PlaybookName> {
    PlaybookName::ALL.into_iter().find(|n| n.as_str() == stem)
}

/// Every `<name>.md` in `dir`, by name. A missing directory has none; any other `.md` file there is an error.
pub fn load_dir(dir: &Path) -> Result<BTreeMap<&'static str, LoadedPlaybook>, PlaybookError> {
    let mut loaded = BTreeMap::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(loaded),
        Err(e) => {
            return Err(PlaybookError::new(format!(
                "cannot read playbooks in {}: {e}",
                dir.display()
            )));
        }
    };
    let mut files: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|f| f.ends_with(".md"))
        .collect();
    files.sort();
    for file in files {
        let place = dir.join(&file).display().to_string();
        let stem = &file[..file.len() - 3];
        // finish-all went; an override of it stays a retired prompt's orphan, not a reason to refuse to start.
        if stem == "finish-all" {
            continue;
        }
        let Some(name) = name_of(stem) else {
            return Err(PlaybookError::new(format!(
                "playbook {place} is invalid: playbooks are named bugfix, feature, research"
            )));
        };
        let text = std::fs::read_to_string(dir.join(&file))
            .map_err(|e| PlaybookError::new(format!("cannot read {place}: {e}")))?;
        loaded.insert(name.as_str(), parse_playbook(&text, &place, Some(name))?);
    }
    Ok(loaded)
}

/// The bundled playbooks with the user's overrides on top; every name ends up with one.
pub fn load_all(
    overrides: Option<&Path>,
) -> Result<BTreeMap<&'static str, LoadedPlaybook>, PlaybookError> {
    let mut all = BTreeMap::new();
    for (name, text) in BUNDLED {
        all.insert(
            name.as_str(),
            parse_playbook(text, &format!("(bundled) {}.md", name.as_str()), Some(name))?,
        );
    }
    if let Some(dir) = overrides {
        all.extend(load_dir(dir)?);
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_playbooks_load_and_pin_like_git() {
        let all = load_all(None).unwrap();
        assert_eq!(all.len(), 3);
        // `git hash-object playbooks/bugfix.md` at this commit; a playbook edit changes it on purpose.
        assert_eq!(
            git_blob_sha(BUNDLED[0].1.as_bytes()),
            all["bugfix"].r#ref.as_str()["bugfix@".len()..]
        );
        // `printf 'STOP − is a success ✓\n' | git hash-object --stdin`
        assert_eq!(
            git_blob_sha("STOP − is a success ✓\n".as_bytes()),
            "d675a79f6f1c9c0df8825f730e4bedc7231db428"
        );
    }
}
