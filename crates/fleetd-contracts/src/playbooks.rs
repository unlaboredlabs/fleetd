//! M9: playbook frontmatter.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ledger::PlaybookName;
use crate::prim::{Int, MAX_SAFE_INT};

/// The YAML frontmatter of `playbooks/<name>.md`, or of its override in `~/.fleetd/hub/playbooks/`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Playbook {
    pub name: PlaybookName,
    /// Bumped by hand on changes to gates; the pin itself is the file's SHA.
    pub version: Int<1, MAX_SAFE_INT>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn bugfix() -> Value {
        json!({
            "name": "bugfix",
            "version": 1,
        })
    }

    fn with(mut base: Value, key: &str, value: Value) -> Value {
        base[key] = value;
        base
    }

    #[test]
    fn playbook_frontmatter() {
        let accepts = |v: Value| serde_json::from_value::<Playbook>(v).is_ok();
        assert!(accepts(bugfix()));
        assert!(!accepts(with(bugfix(), "name", json!("chore"))));
    }
}
