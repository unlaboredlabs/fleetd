//! The optional repo policy file `.fleetd/policy.yaml`, read from the working tree of the project's checkout through
//! the node (not from the default branch, so an uncommitted file counts). Cached per project for 60 s; `invalidate`
//! drops an entry at once (say, after a merge that touched the file). No file is the default policy. A broken file
//! is an error with a fix, never a silent fallback, so a typo can't drop a deny rule.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::UNIX_EPOCH;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::tasks::{POLICY_FILE_PATH, PolicyFile};

use crate::clock::Clock;
use crate::hub::executor::ExecutorError;
use crate::hub::tasks::ports::{BoxFut, TaskError as LeadError};

pub const POLICY_TTL_MS: u128 = 60_000;

const EXAMPLE: &str = "tools:\n  deny: [\"Bash(git push:*)\"]";

fn invalid(problem: &str) -> LeadError {
    let message: String = format!("{POLICY_FILE_PATH} is invalid: {problem}")
        .chars()
        .take(1000)
        .collect();
    LeadError::new(ErrorCode::Invalid, message).with_fix(format!(
        "Fix {POLICY_FILE_PATH} in the project's checkout on its machine. For example:\n{EXAMPLE}"
    ))
}

/// Parses and validates the file's text. An empty file sets nothing, like no file.
pub fn parse_policy(text: &str) -> Result<PolicyFile, LeadError> {
    if text.trim().is_empty() {
        return Ok(PolicyFile::default());
    }
    serde_yaml_ng::from_str(text)
        .map_err(|e| invalid(e.to_string().lines().next().unwrap_or_default()))
}

/// Why a policy file wasn't read.
#[derive(Debug)]
pub enum ReadFailure {
    /// The machine answered that it has no such project: removed from it, or not added yet.
    NoProject(LeadError),
    /// Anything else, an offline machine among them.
    Other(LeadError),
}

/// Where a project's policy file comes from. The hub's source asks the machine's node
/// (`Executors::read_project_file`); tests use a fake.
pub trait PolicySource: Send + Sync {
    /// The file's text: `None` when the project has none.
    fn read<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
    ) -> BoxFut<'a, Result<Option<String>, ReadFailure>>;
}

/// Reads the file from the project's workspace through the machine's node.
pub struct NodePolicySource {
    /// WorkspaceFiles.read, by project id, so a project just added reads before the hub's view of the node has it.
    /// Weak: the executors hold the policies, so a strong link back would keep a stopped hub alive.
    pub executors: Weak<crate::hub::executor::Executors>,
}

impl PolicySource for NodePolicySource {
    fn read<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
    ) -> BoxFut<'a, Result<Option<String>, ReadFailure>> {
        Box::pin(async move {
            let Some(executors) = self.executors.upgrade() else {
                return Err(ReadFailure::Other(LeadError::new(
                    ErrorCode::Failed,
                    "The hub is shutting down.",
                )));
            };
            executors
                .read_project_file(
                    &project_ref.machine_id,
                    &project_ref.project_id,
                    POLICY_FILE_PATH,
                )
                .await
                .map_err(|e| {
                    let no_project = matches!(&e, ExecutorError::NodeRequestFailed { message, .. }
                        if *message == crate::node::sessions::no_project(project_ref.project_id.as_str()));
                    let error = crate::hub::tasks::wire::port_error(e)
                        .to_task_error(&project_ref.machine_id);
                    if no_project {
                        ReadFailure::NoProject(error)
                    } else {
                        ReadFailure::Other(error)
                    }
                })
        })
    }
}

type Cached = (u128, Result<PolicyFile, LeadError>);

pub struct Policies {
    source: Arc<dyn PolicySource>,
    clock: Arc<dyn Clock>,
    // An invalid file is cached like a valid one, so a broken file isn't re-read on every spawn.
    cache: Mutex<HashMap<ProjectRef, Cached>>,
}

impl Policies {
    pub fn new(source: Arc<dyn PolicySource>, clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self {
            source,
            clock,
            cache: Mutex::new(HashMap::new()),
        })
    }

    fn now_ms(&self) -> u128 {
        self.clock
            .now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    }

    /// The project's policy from its file, cached up to 60 s. A read failure (machine offline) is not cached, except
    /// the machine's answer that it has no such project.
    pub async fn get(&self, project_ref: &ProjectRef) -> Result<PolicyFile, LeadError> {
        let now = self.now_ms();
        if let Some((at, result)) = self.cache.lock().unwrap().get(project_ref)
            && now.saturating_sub(*at) < POLICY_TTL_MS
        {
            return result.clone();
        }
        let result = match self.source.read(project_ref).await {
            Ok(None) => Ok(PolicyFile::default()),
            Ok(Some(text)) => parse_policy(&text),
            // The one failure cached (decision perf.timing-calls): the machine answered, and a project it doesn't have
            // is still gone a moment later, so a caller asking every few seconds (the merge train) doesn't send the
            // node a request each time. A project added back is read once the 60 s are up. An offline machine, or
            // any other failure, is read again on the next call.
            Err(ReadFailure::NoProject(error)) => Err(error),
            Err(ReadFailure::Other(error)) => return Err(error),
        };
        self.cache
            .lock()
            .unwrap()
            .insert(project_ref.clone(), (now, result.clone()));
        result
    }

    /// Forgets the cached policy, so the next `get` reads the file again.
    pub fn invalidate(&self, project_ref: &ProjectRef) {
        self.cache.lock().unwrap().remove(project_ref);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    use fleetd_contracts::ids::{MachineId, ProjectId};
    use serde_json::json;

    use super::*;
    use crate::hub::store::test_clock::ManualClock;

    #[test]
    fn reads_tools_and_the_branch_prefix_and_ignores_other_keys() {
        let text = "areas:\n  docs: [\"docs/**\"]\ndefaults:\n  model: claude-sonnet-5-5\n  effort: high\ntools:\n  deny: [\"Bash(git push:*)\"]\nbranchPrefix: team/\n";
        assert_eq!(
            serde_json::to_value(parse_policy(text).unwrap()).unwrap(),
            json!({ "tools": { "allow": [], "deny": ["Bash(git push:*)"] }, "branchPrefix": "team/" })
        );
        // An older file's defaults are ignored whatever they say (a profile's model and effort are the hub's profiles): a
        // broken one doesn't break the file.
        assert!(parse_policy("defaults:\n  effort: medum\n").is_ok());
        assert_eq!(parse_policy("\n").unwrap(), PolicyFile::default());
    }

    #[test]
    fn refuses_broken_files_with_a_message_and_a_fix() {
        for text in [
            "tools: {deny: [x\n",
            "tools:\n  deny: Bash\n",
            "branchPrefix: no slash\n",
        ] {
            let error = parse_policy(text).unwrap_err();
            assert_eq!(error.code, ErrorCode::Invalid, "{text:?}");
            assert!(
                error
                    .message
                    .starts_with(".fleetd/policy.yaml is invalid: "),
                "{text:?}: {}",
                error.message
            );
            assert!(
                error
                    .fix
                    .unwrap()
                    .contains("Fix .fleetd/policy.yaml in the project's checkout on its machine.")
            );
        }
    }

    #[derive(Default)]
    struct Fake {
        text: Mutex<Option<String>>,
        reads: AtomicUsize,
        offline: AtomicBool,
        /// The machine doesn't have the project.
        gone: AtomicBool,
    }

    impl PolicySource for Fake {
        fn read<'a>(
            &'a self,
            _: &'a ProjectRef,
        ) -> BoxFut<'a, Result<Option<String>, ReadFailure>> {
            Box::pin(async move {
                self.reads.fetch_add(1, Ordering::SeqCst);
                if self.offline.load(Ordering::SeqCst) {
                    return Err(ReadFailure::Other(
                        LeadError::new(ErrorCode::MachineOffline, "offline").with_fix("wait"),
                    ));
                }
                if self.gone.load(Ordering::SeqCst) {
                    return Err(ReadFailure::NoProject(LeadError::new(
                        ErrorCode::Failed,
                        "no project pa on this machine",
                    )));
                }
                Ok(self.text.lock().unwrap().clone())
            })
        }
    }

    fn setup() -> (Arc<Fake>, Arc<ManualClock>, Arc<Policies>, ProjectRef) {
        let fake = Arc::new(Fake::default());
        let clock = ManualClock::at(1_792_231_200_000);
        let policies = Policies::new(fake.clone(), clock.clone());
        (
            fake,
            clock,
            policies,
            ProjectRef {
                machine_id: MachineId::unchecked("lab-a"),
                project_id: ProjectId::unchecked("pa"),
            },
        )
    }

    fn team() -> serde_json::Value {
        json!({ "branchPrefix": "team/" })
    }

    #[tokio::test]
    async fn uses_the_default_policy_when_absent_and_caches_for_60_s() {
        let (fake, clock, policies, a) = setup();
        assert_eq!(policies.get(&a).await.unwrap(), PolicyFile::default());
        *fake.text.lock().unwrap() = Some("branchPrefix: team/\n".into());
        clock.advance(Duration::from_secs(59));
        assert_eq!(policies.get(&a).await.unwrap(), PolicyFile::default());
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
        clock.advance(Duration::from_secs(1));
        assert_eq!(
            serde_json::to_value(policies.get(&a).await.unwrap()).unwrap(),
            team()
        );
        assert_eq!(fake.reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn rereads_after_invalidate_caches_a_broken_file_and_never_an_offline_read() {
        let (fake, _clock, policies, a) = setup();
        *fake.text.lock().unwrap() = Some("branchPrefix: no slash\n".into());
        assert_eq!(policies.get(&a).await.unwrap_err().code, ErrorCode::Invalid);
        assert_eq!(policies.get(&a).await.unwrap_err().code, ErrorCode::Invalid);
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
        *fake.text.lock().unwrap() = Some("branchPrefix: team/\n".into());
        policies.invalidate(&a);
        assert_eq!(
            serde_json::to_value(policies.get(&a).await.unwrap()).unwrap(),
            team()
        );
        policies.invalidate(&a);
        fake.offline.store(true, Ordering::SeqCst);
        assert_eq!(
            policies.get(&a).await.unwrap_err().code,
            ErrorCode::MachineOffline
        );
        fake.offline.store(false, Ordering::SeqCst);
        assert_eq!(
            serde_json::to_value(policies.get(&a).await.unwrap()).unwrap(),
            team()
        );
        assert_eq!(fake.reads.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn caches_a_project_the_machine_does_not_have_for_60_s_and_reads_it_once_it_is_back() {
        let (fake, clock, policies, a) = setup();
        fake.gone.store(true, Ordering::SeqCst);
        assert_eq!(policies.get(&a).await.unwrap_err().code, ErrorCode::Failed);
        clock.advance(Duration::from_secs(30));
        assert_eq!(policies.get(&a).await.unwrap_err().code, ErrorCode::Failed);
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
        // The project is back: read again, and found, within the 60 s.
        fake.gone.store(false, Ordering::SeqCst);
        *fake.text.lock().unwrap() = Some("branchPrefix: team/\n".into());
        clock.advance(Duration::from_secs(30));
        assert_eq!(
            serde_json::to_value(policies.get(&a).await.unwrap()).unwrap(),
            team()
        );
        assert_eq!(fake.reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn never_caches_an_offline_machine() {
        let (fake, clock, policies, a) = setup();
        fake.offline.store(true, Ordering::SeqCst);
        for _ in 0..3 {
            assert_eq!(
                policies.get(&a).await.unwrap_err().code,
                ErrorCode::MachineOffline
            );
            clock.advance(Duration::from_secs(1));
        }
        assert_eq!(fake.reads.load(Ordering::SeqCst), 3);
        fake.offline.store(false, Ordering::SeqCst);
        assert_eq!(policies.get(&a).await.unwrap(), PolicyFile::default());
        assert_eq!(fake.reads.load(Ordering::SeqCst), 4);
    }
}
