//! The repo policy file `.fleetd/policy.yaml`, read from the project's workspace through the node. Cached
//! per project for 60 s; `invalidate` drops an entry at once (say, after a merge that touched the file). No file is
//! the default policy, and a file without `areas` gets the areas inferred from the repo's layout (`areas.rs`), always
//! with "all" = ["**"]. A broken file is an error with a fix, never a silent fallback, so a typo can't widen what a
//! writer may touch.
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::prim::List;
use fleetd_contracts::tasks::{AreaGlob, POLICY_FILE_PATH, PolicyFile, default_policy};
use serde_yaml_ng::Value;

use fleetd_contracts::mcp::ErrorCode;

use super::areas;
use crate::clock::Clock;
use crate::hub::tasks::ports::{BoxFut, TaskError as LeadError, TaskPorts};

pub const POLICY_TTL_MS: u128 = 60_000;

const EXAMPLE: &str =
    "areas:\n  docs: [\"docs/**\"]\n  hub: [\"apps/hub/**\", \"packages/contracts/**\"]";

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
    let none = serde_yaml_ng::Mapping::new();
    let areas = match root.get("areas") {
        None => &none,
        Some(Value::Mapping(areas)) => areas,
        Some(_) => return Err(format!("Expected object at {}", key("areas"))),
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
    if let Some(lead) = root.get("lead") {
        let Value::Mapping(lead) = lead else {
            return Err(format!("Expected object at {}", key("lead")));
        };
        let p = at(&[key("lead"), key("autoStart")]);
        match lead.get("autoStart") {
            None => return Err(format!("Missing key at {p}")),
            Some(Value::Bool(_)) => {}
            Some(_) => return Err(format!("Expected boolean at {p}")),
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
    // An empty file sets nothing, like no file.
    let value = if value.is_null() {
        Value::Mapping(serde_yaml_ng::Mapping::new())
    } else {
        value
    };
    check_shape(&value).map_err(|m| invalid(&m))?;
    let mut json = serde_json::to_value(&value).map_err(|e| invalid(&e.to_string()))?;
    if json.get("areas").is_none() {
        json["areas"] = serde_json::to_value(default_policy().areas).unwrap_or_default();
    }
    serde_json::from_value(json).map_err(|e| invalid(&e.to_string()))
}

/// Whether the file's text sets `areas` itself; a file that doesn't gets the inferred ones.
fn sets_areas(text: &str) -> bool {
    serde_yaml_ng::from_str::<Value>(text).is_ok_and(|v| v.get("areas").is_some())
}

/// Whether the file still has the `defaults` (model, effort) of before task profiles, which fleetd ignores.
fn sets_defaults(text: &str) -> bool {
    serde_yaml_ng::from_str::<Value>(text).is_ok_and(|v| v.get("defaults").is_some())
}

/// Where a project's files come from. The hub's source asks the machine's node (`Executors::read_project_file`, and
/// one `git ls-tree` for the layout); tests use a fake.
pub trait PolicySource: Send + Sync {
    /// The project's workspace root.
    fn root(&self, project_ref: &ProjectRef) -> Result<String, LeadError>;
    /// A repo-relative file of the project: `None` when it does not exist.
    fn read<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
        path: &'a str,
    ) -> BoxFut<'a, Result<Option<String>, LeadError>>;
    /// The committed directories at the top of `root` and one level under each of `parents` (`parent/child`);
    /// `None` when the node can't say in full.
    fn dirs<'a>(
        &'a self,
        machine_id: &'a MachineId,
        root: &'a str,
        parents: Vec<String>,
    ) -> BoxFut<'a, Option<Vec<String>>>;
}

/// Reads the files from the project's workspace through the machine's node.
pub struct NodePolicySource {
    pub store: Arc<crate::hub::store::HubStore>,
    /// WorkspaceFiles.read, by project id, so a project just added reads before the hub's view of the node has it.
    pub executors: Arc<crate::hub::executor::Executors>,
    /// NodeCommands.run, over the executor.
    pub ports: Arc<dyn TaskPorts>,
}

// The listings name positional arguments only, never interpolated, and read committed directories, so build output
// and node_modules never count. Each is cut short to fit the node's 2000-character output: a folder's children stop at
// one more than areas.rs takes before it falls back to one area per folder, which is all inference needs to know.
const TOP_SCRIPT: &str = "git -c core.quotePath=false ls-tree -d --name-only HEAD";
const EXISTS_SCRIPT: &str =
    "for d in \"$@\"; do if git cat-file -e \"HEAD:$d\" 2>/dev/null; then echo \"$d\"; fi; done";
const CHILDREN_SCRIPT: &str =
    "git -c core.quotePath=false ls-tree -d --name-only \"HEAD:$1\" 2>/dev/null | head -n 41";
/// What the node keeps of a command's output; a listing that fills it may have lost its first lines.
const OUTPUT_MAX: usize = 2000;

/// The listing's lines, when the command ran and its output is whole.
fn listed(out: Option<crate::hub::tasks::ports::CmdOutput>) -> Option<Vec<String>> {
    let out = out?;
    (out.exit_code == Some(0) && js_len(&out.output_tail) < OUTPUT_MAX).then(|| {
        out.output_tail
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect()
    })
}

impl NodePolicySource {
    async fn sh(
        &self,
        m: &MachineId,
        root: &str,
        script: &str,
        args: &[String],
    ) -> Option<Vec<String>> {
        let argv = ["sh", "-c", script, "fleetd-dirs"]
            .into_iter()
            .map(str::to_owned)
            .chain(args.iter().cloned())
            .collect();
        listed(self.ports.run_command(m, root, argv, 30).await)
    }
}

impl PolicySource for NodePolicySource {
    fn root(&self, project_ref: &ProjectRef) -> Result<String, LeadError> {
        let project = self.store.project_get(project_ref).map_err(|e| {
            tracing::error!(error = %e, "policy: project not read");
            LeadError::new(ErrorCode::Failed, "The hub failed to answer that request.")
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
        Ok(project.workspace_root)
    }

    fn read<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
        path: &'a str,
    ) -> BoxFut<'a, Result<Option<String>, LeadError>> {
        Box::pin(async move {
            self.executors
                .read_project_file(&project_ref.machine_id, &project_ref.project_id, path)
                .await
                .map_err(|e| {
                    crate::hub::tasks::wire::port_error(e).to_task_error(&project_ref.machine_id)
                })
        })
    }

    fn dirs<'a>(
        &'a self,
        machine_id: &'a MachineId,
        root: &'a str,
        parents: Vec<String>,
    ) -> BoxFut<'a, Option<Vec<String>>> {
        Box::pin(async move {
            // The whole top level when it fits, else just the folders inference looks for.
            let top = match self.sh(machine_id, root, TOP_SCRIPT, &[]).await {
                Some(top) => top,
                None => {
                    let wanted: Vec<String> = std::iter::once("docs".to_owned())
                        .chain(parents.iter().cloned())
                        .collect();
                    self.sh(machine_id, root, EXISTS_SCRIPT, &wanted).await?
                }
            };
            let present: Vec<String> = parents.into_iter().filter(|p| top.contains(p)).collect();
            let children = futures_util::future::join_all(
                present
                    .iter()
                    .map(|p| self.sh(machine_id, root, CHILDREN_SCRIPT, std::slice::from_ref(p))),
            )
            .await;
            let mut dirs = top;
            for (parent, kids) in present.iter().zip(children) {
                dirs.extend(kids?.into_iter().map(|k| format!("{parent}/{k}")));
            }
            Some(dirs)
        })
    }
}

/// A project's policy, whether its areas were inferred from the repo rather than set in the file, and whether the
/// file has `defaults` that fleetd ignores.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub policy: PolicyFile,
    pub inferred: bool,
    pub ignored_defaults: bool,
}

type Cached = (u128, Result<Resolved, LeadError>);

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

    /// The project's policy: from its file, cached up to 60 s, with the inferred areas when the file sets none.
    pub async fn get(&self, project_ref: &ProjectRef) -> Result<PolicyFile, LeadError> {
        self.resolve(project_ref).await.map(|r| r.policy)
    }

    pub async fn resolve(&self, project_ref: &ProjectRef) -> Result<Resolved, LeadError> {
        let now = self.now_ms();
        if let Some((at, result)) = self.cache.lock().unwrap().get(project_ref)
            && now.saturating_sub(*at) < POLICY_TTL_MS
        {
            return result.clone();
        }
        let root = self.source.root(project_ref)?;
        self.load_and_cache(project_ref, &root, now).await
    }

    /// Reads the project's policy afresh, for a project just registered at `root`: the hub may not list it yet.
    pub async fn resolve_new(
        &self,
        project_ref: &ProjectRef,
        root: &str,
    ) -> Result<Resolved, LeadError> {
        let now = self.now_ms();
        self.load_and_cache(project_ref, root, now).await
    }

    async fn load_and_cache(
        &self,
        project_ref: &ProjectRef,
        root: &str,
        now: u128,
    ) -> Result<Resolved, LeadError> {
        // A read failure (machine offline) is not cached, nor a layout the node couldn't list.
        let (result, settled) = self.load(project_ref, root).await?;
        if settled {
            self.cache
                .lock()
                .unwrap()
                .insert(project_ref.clone(), (now, result.clone()));
        }
        result
    }

    /// Outer error: the file could not be read. Inner: what the file says, a broken file included, and whether the
    /// answer is settled (false when inference couldn't list the layout and fell back to "all").
    async fn load(
        &self,
        project_ref: &ProjectRef,
        root: &str,
    ) -> Result<(Result<Resolved, LeadError>, bool), LeadError> {
        let text = self.source.read(project_ref, POLICY_FILE_PATH).await?;
        let ignored_defaults = text.as_deref().is_some_and(sets_defaults);
        let policy = match text.as_deref() {
            None => default_policy(),
            Some(text) => match parse_policy(text) {
                Ok(policy) if sets_areas(text) => {
                    let resolved = Resolved {
                        policy,
                        inferred: false,
                        ignored_defaults,
                    };
                    return Ok((Ok(resolved), true));
                }
                Ok(policy) => policy,
                Err(e) => return Ok((Err(e), true)),
            },
        };
        let mut policy = policy;
        let inferred = self.infer(project_ref, root).await;
        let settled = inferred.is_some();
        if let Some(areas) = inferred {
            policy.areas = areas;
        }
        let resolved = Resolved {
            policy,
            inferred: true,
            ignored_defaults,
        };
        Ok((Ok(resolved), settled))
    }

    /// The areas the repo's layout suggests; `None` when the node can't list it, which leaves "all".
    async fn infer(
        &self,
        project_ref: &ProjectRef,
        root: &str,
    ) -> Option<BTreeMap<String, List<AreaGlob, 1, 50>>> {
        let read = |path: &'static str| async move {
            self.source.read(project_ref, path).await.ok().flatten()
        };
        let manifests = areas::Manifests {
            cargo_toml: read("Cargo.toml").await,
            package_json: read("package.json").await,
            pnpm_workspace: read("pnpm-workspace.yaml").await,
        };
        let dirs = self
            .source
            .dirs(
                &project_ref.machine_id,
                root,
                areas::dirs_to_list(&manifests),
            )
            .await?;
        Some(
            areas::infer(&manifests, &dirs)
                .into_iter()
                .map(|(name, globs)| {
                    (
                        name,
                        List::unchecked(globs.into_iter().map(AreaGlob::unchecked).collect()),
                    )
                })
                .collect(),
        )
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
    fn reads_areas_and_ignores_the_old_defaults() {
        // `claude.autoMemory` is gone: a file that still sets it reads, without it.
        let text = "areas:\n  docs: [\"docs/**\"]\n  hub: [apps/hub/**, packages/contracts/**]\ndefaults:\n  model: claude-sonnet-5-5\n  effort: high\nlead:\n  autoStart: false\nclaude:\n  autoMemory: true\n";
        let policy = parse_policy(text).unwrap();
        assert_eq!(
            serde_json::to_value(policy).unwrap(),
            json!({ "areas": { "docs": ["docs/**"], "hub": ["apps/hub/**", "packages/contracts/**"] }, "lead": { "autoStart": false } })
        );
        // Ignored whatever they say: a broken one doesn't break the file.
        assert!(parse_policy("areas:\n  docs: [docs/**]\ndefaults:\n  effort: medum\n").is_ok());
    }

    #[test]
    fn refuses_broken_files_with_a_message_and_a_fix() {
        let cases = [
            ("areas: {docs: [docs/**]\n", "is invalid: YAML: "),
            (
                "areas: [docs/**]\n",
                "is invalid: Expected object at [\"areas\"]",
            ),
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
                "areas:\n  docs: [docs/**]\nlead:\n  autoStart: no thanks\n",
                "is invalid: Expected boolean at [\"lead\"][\"autoStart\"]",
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
        files: Mutex<HashMap<String, String>>,
        dirs: Mutex<Option<Vec<String>>>,
        /// Reads of the policy file.
        reads: AtomicUsize,
        offline: AtomicBool,
    }

    impl PolicySource for Fake {
        fn root(&self, _: &ProjectRef) -> Result<String, LeadError> {
            Ok("/repo".into())
        }

        fn read<'a>(
            &'a self,
            _: &'a ProjectRef,
            path: &'a str,
        ) -> BoxFut<'a, Result<Option<String>, LeadError>> {
            Box::pin(async move {
                if path == POLICY_FILE_PATH {
                    self.reads.fetch_add(1, Ordering::SeqCst);
                }
                if self.offline.load(Ordering::SeqCst) {
                    return Err(
                        LeadError::new(ErrorCode::MachineOffline, "offline").with_fix("wait")
                    );
                }
                if path != POLICY_FILE_PATH {
                    return Ok(self.files.lock().unwrap().get(path).cloned());
                }
                Ok(self.text.lock().unwrap().clone())
            })
        }

        fn dirs<'a>(
            &'a self,
            _: &'a MachineId,
            _: &'a str,
            _: Vec<String>,
        ) -> BoxFut<'a, Option<Vec<String>>> {
            Box::pin(async move { self.dirs.lock().unwrap().clone() })
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
        // A layout with no members: inference settles on the one area.
        *fake.dirs.lock().unwrap() = Some(Vec::new());
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

    /// A cargo workspace with two crates and docs, no policy file.
    fn workspace(fake: &Fake) {
        fake.files.lock().unwrap().insert(
            "Cargo.toml".into(),
            "[workspace]\nmembers = [\"crates/*\"]\n".into(),
        );
        *fake.dirs.lock().unwrap() = Some(
            ["crates", "docs", "crates/hub", "crates/cli"]
                .map(String::from)
                .to_vec(),
        );
    }

    #[tokio::test]
    async fn infers_areas_without_a_file_or_without_areas_in_it_and_a_file_with_areas_wins() {
        let (fake, _clock, policies, a) = setup();
        workspace(&fake);
        let resolved = policies.resolve(&a).await.unwrap();
        assert!(resolved.inferred);
        assert_eq!(
            resolved.policy.areas.keys().collect::<Vec<_>>(),
            ["all", "cli", "docs", "hub"]
        );
        // A file that sets other things but not areas keeps the inferred ones.
        *fake.text.lock().unwrap() =
            Some("defaults:\n  effort: high\nbranchPrefix: team/\n".into());
        policies.invalidate(&a);
        let resolved = policies.resolve(&a).await.unwrap();
        assert!(resolved.inferred && resolved.ignored_defaults);
        assert_eq!(resolved.policy.areas.len(), 4);
        assert_eq!(resolved.policy.branch_prefix.unwrap().as_str(), "team/");
        // Explicit areas win.
        *fake.text.lock().unwrap() = Some("areas:\n  docs: [docs/**]\n".into());
        policies.invalidate(&a);
        let resolved = policies.resolve(&a).await.unwrap();
        assert!(!resolved.inferred && !resolved.ignored_defaults);
        assert_eq!(serde_json::to_value(resolved.policy).unwrap(), docs_only());
        // A layout the node can't list leaves the one area, and is asked again on the next read, not in 60 s.
        *fake.text.lock().unwrap() = None;
        *fake.dirs.lock().unwrap() = None;
        policies.invalidate(&a);
        assert_eq!(policies.get(&a).await.unwrap(), default_policy());
        workspace(&fake);
        assert_eq!(policies.get(&a).await.unwrap().areas.len(), 4);
    }
}
