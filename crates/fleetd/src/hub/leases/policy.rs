//! The repo policy file `.fleetd/policy.yaml`, read from the project's workspace through T3's file RPC. Cached
//! per project for 60 s; `invalidate` drops an entry at once (say, after a merge that touched the file). No file
//! means DEFAULT_POLICY, one area "all" = ["**"]. A broken file is an error with a fix, never a silent fallback, so
//! a typo can't widen what a writer may touch.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::tasks::{POLICY_FILE_PATH, PolicyFile, default_policy};
use serde_yaml_ng::Value;

use fleetd_contracts::mcp::ErrorCode;

use crate::clock::Clock;
use crate::hub::tasks::ports::{BoxFut, TaskError as LeadError, TaskPorts};

pub const POLICY_TTL_MS: u128 = 60_000;

const EXAMPLE: &str = "areas:\n  docs: [\"docs/**\"]\n  hub: [\"apps/hub/**\", \"packages/contracts/**\"]\ndefaults:          # optional\n  model: claude-opus-5-5\n  effort: high";

fn invalid(problem: &str) -> LeadError {
    let message: String = format!("{POLICY_FILE_PATH} is invalid: {problem}")
        .chars()
        .take(1000)
        .collect();
    LeadError::new(ErrorCode::Invalid, message).with_fix(format!(
            "Fix {POLICY_FILE_PATH} on the project's default branch. Area names are lowercase slugs ([a-z0-9][a-z0-9_-]*, at most 40 characters), each with a list of repo-relative globs. For example:\n{EXAMPLE}"
        ))
}

/// Effect Schema's path notation: `["areas"]["docs"][0]`.
fn at(path: &[String]) -> String {
    path.concat()
}

fn key(k: &str) -> String {
    format!("[{}]", serde_json::to_string(k).unwrap_or_default())
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Checks the decoded YAML against the PolicyFile schema in the order Effect Schema reports the first issue,
/// with its messages: structure first, then filters.
fn check_shape(value: &Value) -> Result<(), String> {
    let Value::Mapping(root) = value else {
        return Err("Expected object".into());
    };
    let Some(areas) = root.get("areas") else {
        return Err(format!("Missing key at {}", key("areas")));
    };
    let Value::Mapping(areas) = areas else {
        return Err(format!("Expected object at {}", key("areas")));
    };
    for (name, globs) in areas {
        let name = match name {
            Value::String(s) => s.clone(),
            other => serde_yaml_ng::to_string(other)
                .unwrap_or_default()
                .trim()
                .to_owned(),
        };
        let path = vec![key("areas"), key(&name)];
        let Value::Sequence(globs) = globs else {
            return Err(format!("Expected array at {}", at(&path)));
        };
        for (i, glob) in globs.iter().enumerate() {
            let p = format!("{}[{i}]", at(&path));
            let Value::String(glob) = glob else {
                return Err(format!("Expected string at {p}"));
            };
            if glob.is_empty() {
                return Err(format!(
                    "Expected a value with a length of at least 1 at {p}"
                ));
            }
            if js_len(glob) > 200 {
                return Err(format!(
                    "Expected a value with a length of at most 200 at {p}"
                ));
            }
            if glob.starts_with('/') {
                return Err(format!(
                    "Expected a repo-relative glob, not an absolute path at {p}"
                ));
            }
        }
        if globs.is_empty() {
            return Err(format!(
                "Expected a value with a length of at least 1 at {}",
                at(&path)
            ));
        }
        if globs.len() > 50 {
            return Err(format!(
                "Expected a value with a length of at most 50 at {}",
                at(&path)
            ));
        }
    }
    for name in areas.keys() {
        let name = name.as_str().unwrap_or_default();
        let path = at(&[key("areas"), key(name)]);
        if js_len(name) > 40 {
            return Err(format!(
                "Expected a value with a length of at most 40 at {path}"
            ));
        }
        let slug = name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
        if !slug {
            return Err(format!(
                "Expected a string matching the RegExp ^[a-z0-9][a-z0-9_-]*$ at {path}"
            ));
        }
    }
    if let Some(defaults) = root.get("defaults") {
        let Value::Mapping(defaults) = defaults else {
            return Err(format!("Expected object at {}", key("defaults")));
        };
        if let Some(model) = defaults.get("model") {
            let p = at(&[key("defaults"), key("model")]);
            match model {
                Value::String(s) if s.is_empty() => {
                    return Err(format!(
                        "Expected a value with a length of at least 1 at {p}"
                    ));
                }
                Value::String(_) => {}
                _ => return Err(format!("Expected string at {p}")),
            }
        }
        if let Some(effort) = defaults.get("effort") {
            let ok = matches!(effort.as_str(), Some("low" | "medium" | "high" | "max"));
            if !ok {
                let got = serde_json::to_string(&serde_json::to_value(effort).unwrap_or_default())
                    .unwrap_or_default();
                return Err(format!(
                    "Expected \"low\" | \"medium\" | \"high\" | \"max\", got {got} at {}",
                    at(&[key("defaults"), key("effort")])
                ));
            }
        }
    }
    if let Some(finish_all) = root.get("finishAll") {
        let Value::Mapping(finish_all) = finish_all else {
            return Err(format!("Expected object at {}", key("finishAll")));
        };
        let p = at(&[key("finishAll"), key("maxChildren")]);
        match finish_all.get("maxChildren") {
            None => return Err(format!("Missing key at {p}")),
            Some(v) => match v.as_f64() {
                Some(n) if n.fract() == 0.0 && (1.0..=50.0).contains(&n) => {}
                Some(n) if n.fract() == 0.0 => {
                    return Err(format!("Expected a value between 1 and 50, got {n} at {p}"));
                }
                _ => return Err(format!("Expected an integer at {p}")),
            },
        }
    }
    Ok(())
}

/// Parses and validates the file's text.
pub fn parse_policy(text: &str) -> Result<PolicyFile, LeadError> {
    let value: Value = match serde_yaml_ng::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            return Err(invalid(&format!(
                "YAML: {}",
                e.to_string().lines().next().unwrap_or_default()
            )));
        }
    };
    if value.is_null() {
        return Err(invalid("the file is empty; it needs an `areas:` map"));
    }
    check_shape(&value).map_err(|m| invalid(&m))?;
    let json = serde_json::to_value(&value).map_err(|e| invalid(&e.to_string()))?;
    serde_json::from_value(json).map_err(|e| invalid(&e.to_string()))
}

/// Where the policy text comes from: `None` when the project has no policy file. The hub's source reads it through
/// the machine's T3 (`Executors::read_file`); tests use a fake.
pub trait PolicySource: Send + Sync {
    fn read<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
    ) -> BoxFut<'a, Result<Option<String>, LeadError>>;
}

/// Reads the file from the project's workspace root through the machine's T3.
pub struct T3PolicySource {
    pub store: Arc<crate::hub::store::HubStore>,
    /// WorkspaceFiles.read, over the executor.
    pub ports: Arc<dyn TaskPorts>,
}

impl PolicySource for T3PolicySource {
    fn read<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
    ) -> BoxFut<'a, Result<Option<String>, LeadError>> {
        Box::pin(async move {
            let project = self.store.project_get(project_ref).map_err(|e| {
                tracing::error!(error = %e, "policy: project not read");
                LeadError::new(ErrorCode::T3Error, "The hub failed to answer that request.")
            })?;
            let Some(project) = project else {
                return Err(LeadError::new(
                    ErrorCode::NotFound,
                    format!(
                        "Project {} on {} is not known to the hub.",
                        project_ref.project_id.as_str(),
                        project_ref.machine_id.as_str()
                    ),
                )
                .with_fix(
                    "Check the project with project_get; its machine may not have reported it yet.",
                ));
            };
            self.ports
                .read_file(
                    &project_ref.machine_id,
                    &project.workspace_root,
                    POLICY_FILE_PATH,
                )
                .await
                .map_err(|e| e.to_task_error(&project_ref.machine_id))
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

    /// The project's policy: from its file, cached up to 60 s, or DEFAULT_POLICY when it has none.
    pub async fn get(&self, project_ref: &ProjectRef) -> Result<PolicyFile, LeadError> {
        let now = self.now_ms();
        if let Some((at, result)) = self.cache.lock().unwrap().get(project_ref)
            && now.saturating_sub(*at) < POLICY_TTL_MS
        {
            return result.clone();
        }
        // A read failure (machine offline) is not cached.
        let text = self.source.read(project_ref).await?;
        let result = match text {
            None => Ok(default_policy()),
            Some(text) => parse_policy(&text),
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
    fn reads_areas_and_defaults() {
        let text = "areas:\n  docs: [\"docs/**\"]\n  hub: [apps/hub/**, packages/contracts/**]\ndefaults:\n  model: claude-sonnet-5-5\n  effort: high\n";
        let policy = parse_policy(text).unwrap();
        assert_eq!(
            serde_json::to_value(policy).unwrap(),
            json!({ "areas": { "docs": ["docs/**"], "hub": ["apps/hub/**", "packages/contracts/**"] }, "defaults": { "model": "claude-sonnet-5-5", "effort": "high" } })
        );
    }

    #[test]
    fn refuses_broken_files_with_a_message_and_a_fix() {
        let cases = [
            ("areas: {docs: [docs/**]\n", "is invalid: YAML: "),
            (
                "",
                "is invalid: the file is empty; it needs an `areas:` map",
            ),
            ("owners: [wynn]\n", "is invalid: Missing key at [\"areas\"]"),
            (
                "areas:\n  Docs: [docs/**]\n",
                "is invalid: Expected a string matching the RegExp ^[a-z0-9][a-z0-9_-]*$ at [\"areas\"][\"Docs\"]",
            ),
            (
                "areas:\n  docs: docs/**\n",
                "is invalid: Expected array at [\"areas\"][\"docs\"]",
            ),
            (
                "areas:\n  docs: []\n",
                "is invalid: Expected a value with a length of at least 1 at [\"areas\"][\"docs\"]",
            ),
            (
                "areas:\n  docs: [/etc/**]\n",
                "is invalid: Expected a repo-relative glob, not an absolute path at [\"areas\"][\"docs\"][0]",
            ),
            (
                "areas:\n  docs: [docs/**]\ndefaults:\n  effort: medum\n",
                "at [\"defaults\"][\"effort\"]",
            ),
        ];
        for (text, message) in cases {
            let error = parse_policy(text).unwrap_err();
            assert_eq!(error.code, ErrorCode::Invalid, "{text:?}");
            assert!(
                error.message.contains(".fleetd/policy.yaml "),
                "{text:?}: {}",
                error.message
            );
            assert!(
                error.message.contains(message),
                "{text:?}: {}",
                error.message
            );
            let fix = error.fix.unwrap();
            assert!(fix.contains("Fix .fleetd/policy.yaml on the project's default branch."));
            assert!(fix.contains("  docs: [\"docs/**\"]"));
        }
    }

    #[derive(Default)]
    struct Fake {
        text: Mutex<Option<String>>,
        reads: AtomicUsize,
        offline: AtomicBool,
    }

    impl PolicySource for Fake {
        fn read<'a>(&'a self, _: &'a ProjectRef) -> BoxFut<'a, Result<Option<String>, LeadError>> {
            Box::pin(async move {
                self.reads.fetch_add(1, Ordering::SeqCst);
                if self.offline.load(Ordering::SeqCst) {
                    return Err(
                        LeadError::new(ErrorCode::MachineOffline, "offline").with_fix("wait")
                    );
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

    fn docs_only() -> serde_json::Value {
        json!({ "areas": { "docs": ["docs/**"] } })
    }

    #[tokio::test]
    async fn uses_the_default_policy_when_absent_and_caches_for_60_s() {
        let (fake, clock, policies, a) = setup();
        assert_eq!(policies.get(&a).await.unwrap(), default_policy());
        *fake.text.lock().unwrap() = Some("areas:\n  docs: [docs/**]\n".into());
        clock.advance(Duration::from_secs(59));
        assert_eq!(policies.get(&a).await.unwrap(), default_policy());
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
        clock.advance(Duration::from_secs(1));
        assert_eq!(
            serde_json::to_value(policies.get(&a).await.unwrap()).unwrap(),
            docs_only()
        );
        assert_eq!(fake.reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn rereads_after_invalidate_caches_a_broken_file_and_never_a_failed_read() {
        let (fake, _clock, policies, a) = setup();
        *fake.text.lock().unwrap() = Some("areas:\n  Docs: [docs/**]\n".into());
        assert_eq!(policies.get(&a).await.unwrap_err().code, ErrorCode::Invalid);
        assert_eq!(policies.get(&a).await.unwrap_err().code, ErrorCode::Invalid);
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
        *fake.text.lock().unwrap() = Some("areas:\n  docs: [docs/**]\n".into());
        policies.invalidate(&a);
        assert_eq!(
            serde_json::to_value(policies.get(&a).await.unwrap()).unwrap(),
            docs_only()
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
            docs_only()
        );
        assert_eq!(fake.reads.load(Ordering::SeqCst), 4);
    }
}
