//! The hub store, the node and the hub server as the CLI calls them, until their slices land on main
//! (feat/rust-hub-store, feat/rust-node, feat/rust-hub-framework). Each item has exactly the agreed API; when a slice
//! lands, its items here become `pub use` of the real ones, and this file goes once all three have.

pub mod store {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use fleetd_contracts::ids::MachineId;
    use fleetd_contracts::model::Machine;

    #[derive(Debug, thiserror::Error)]
    pub enum StoreError {
        #[error("this fleetd build has no hub store yet")]
        Pending,
    }

    pub struct HubDb;

    impl HubDb {
        pub fn open(_home: &Path) -> Result<Arc<Self>, StoreError> {
            Err(StoreError::Pending)
        }
    }

    pub fn resolve_hub_home(_home: Option<&str>, _user_home: &Path) -> Result<PathBuf, StoreError> {
        Err(StoreError::Pending)
    }

    pub struct HubStore;

    impl HubStore {
        pub fn new(_db: Arc<HubDb>) -> Self {
            HubStore
        }
        pub fn machine_get(&self, _machine_id: &MachineId) -> Result<Option<Machine>, StoreError> {
            Err(StoreError::Pending)
        }
        pub fn machine_remove(&self, _machine_id: &MachineId) -> Result<(), StoreError> {
            Err(StoreError::Pending)
        }
    }
}

pub mod auth {
    use std::sync::Arc;

    use fleetd_contracts::auth::{AgentKeyInfo, Grant, KeyKind};
    use fleetd_contracts::ids::MachineId;

    use super::store::{HubDb, StoreError};

    #[derive(Debug, thiserror::Error)]
    pub enum AuthError {
        #[error("no agent key {key_id}; run `fleetd hub key list` to see key ids")]
        KeyNotFound { key_id: String },
        #[error(transparent)]
        Store(#[from] StoreError),
    }

    pub struct CreatedKey {
        pub key: String,
        pub info: AgentKeyInfo,
    }

    pub struct EnrollToken {
        pub token: String,
        pub expires_at: String,
    }

    pub struct Auth;

    impl Auth {
        pub fn new(_db: Arc<HubDb>, _clock: Arc<dyn crate::clock::Clock>) -> Self {
            Auth
        }
        pub fn create_key(
            &self,
            _name: &str,
            _grants: &[Grant],
            _kind: KeyKind,
        ) -> Result<CreatedKey, StoreError> {
            Err(StoreError::Pending)
        }
        pub fn list(&self) -> Result<Vec<AgentKeyInfo>, StoreError> {
            Err(StoreError::Pending)
        }
        pub fn revoke(&self, _key_id: &str) -> Result<(), AuthError> {
            Err(StoreError::Pending.into())
        }
        pub fn create_enroll_token(
            &self,
            _machine_id: &MachineId,
        ) -> Result<EnrollToken, StoreError> {
            Err(StoreError::Pending)
        }
        pub fn node_pub_key(&self, _machine_id: &MachineId) -> Result<Option<String>, StoreError> {
            Err(StoreError::Pending)
        }
        pub fn revoke_node(&self, _machine_id: &MachineId) -> Result<bool, StoreError> {
            Err(StoreError::Pending)
        }
    }
}

pub mod node {
    use std::path::PathBuf;

    #[derive(Clone, Debug, Default)]
    pub struct JoinArgs {
        pub hub: String,
        pub token: String,
        pub machine: String,
        pub t3_home: String,
        pub t3_url: String,
        pub t3_cmd: Option<String>,
        pub t3_restart_cmd: Option<String>,
        pub tags: Option<Vec<String>>,
        pub name: Option<String>,
        pub home: Option<PathBuf>,
        pub enroll_only: bool,
    }

    #[derive(Clone, Debug, Default)]
    pub struct RunArgs {
        pub home: Option<PathBuf>,
    }

    pub fn read_token_file(path: &str) -> std::io::Result<String> {
        let text = if path == "-" {
            std::io::read_to_string(std::io::stdin())?
        } else {
            std::fs::read_to_string(path)?
        };
        Ok(text.trim().to_owned())
    }

    pub fn parse_tags(tags: &str) -> Vec<String> {
        tags.split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .collect()
    }

    pub async fn join(_args: JoinArgs) -> Result<(), String> {
        Err("this fleetd build has no node yet".into())
    }

    pub async fn run(_args: RunArgs) -> Result<(), String> {
        Err("this fleetd build has no node yet".into())
    }
}

pub mod serve {
    /// `fleetd hub start|serve`: the hub parses its own flags; the exit code once it stops.
    pub async fn run(_argv: &[String]) -> u8 {
        eprintln!("fleetd: this fleetd build has no hub yet");
        1
    }
}
