//! The hub store and the hub server as the CLI calls them, until their slices land on main (feat/rust-hub-store,
//! feat/rust-hub-framework). Each item has exactly the agreed API; when a slice lands, its items here become `pub use`
//! of the real ones, and this file goes once both have.

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

pub mod serve {
    use std::process::ExitCode;

    /// `fleetd hub start|serve`: parses its own flags and runs its own runtime until a signal.
    pub fn hub_start(_argv: &[String]) -> ExitCode {
        eprintln!("fleetd: this fleetd build has no hub yet");
        ExitCode::from(1)
    }
}
