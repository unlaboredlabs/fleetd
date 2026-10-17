//! The repo policy file `.fleetd/policy.yaml`, read from the project's workspace through T3's file RPC. Cached
//! per project for 60 s; `invalidate` drops an entry at once. No file means DEFAULT_POLICY. A broken file is an
//! error with a fix, never a silent fallback. TS spec: apps/hub/src/leases/Policy.ts.
use std::sync::Arc;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::tasks::PolicyFile;

use crate::hub::leads::LeadError;

pub const POLICY_TTL_MS: i64 = 60_000;

/// Parses and validates the file's text.
pub fn parse_policy(_text: &str) -> Result<PolicyFile, LeadError> { todo!() }

/// Where the policy text comes from: `None` when the project has no policy file. The hub's source reads it
/// through the machine's T3 (executor `WorkspaceFiles`); tests use a fake.
pub trait PolicySource: Send + Sync {
    fn read<'a>(&'a self, project_ref: &'a ProjectRef) -> crate::hub::tasks::hooks::BoxFut<'a, Result<Option<String>, LeadError>>;
}

pub struct Policies {/* source, cache, clock */}

impl Policies {
    pub fn new(_source: Arc<dyn PolicySource>, _clock: Arc<dyn crate::clock::Clock>) -> Arc<Self> { todo!() }
    /// The project's policy: from its file, cached up to 60 s, or DEFAULT_POLICY when it has none.
    pub async fn get(&self, _project_ref: &ProjectRef) -> Result<PolicyFile, LeadError> { todo!() }
    /// Forgets the cached policy, so the next `get` reads the file again.
    pub fn invalidate(&self, _project_ref: &ProjectRef) { todo!() }
}
