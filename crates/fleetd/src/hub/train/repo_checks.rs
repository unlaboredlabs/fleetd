//! A repo's own train checks. A repo that commits `.fleetd/train.json` on its base adds to its project's train settings
//! there: `fastChecks`, more checks the train waits for on each PR and batch, and `afterMerge`, checks that never stop
//! a merge. Beside the workflows, a renamed job and its name here change in one PR.
use fleetd_contracts::project_settings::{CheckName, TRAIN_CHECKS_MAX, TrainSettings};
use serde::Deserialize;

use super::service::{Train, lock};

pub const PATH: &str = ".fleetd/train.json";

/// How long a base's file is trusted before it is read again, as its CI config is.
const TTL_MS: i64 = 10 * 60_000;

/// A base's file and when it was read: empty settings when it has none, None when it can't be used.
pub(super) type Cached = (i64, Option<TrainSettings>);

type Checks = fleetd_contracts::prim::UniqueList<CheckName, 0, TRAIN_CHECKS_MAX>;

/// The file's shape: the two lists of the project's train settings, nothing else, so a misspelt key isn't a list that
/// silently does nothing.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct File {
    #[serde(default)]
    fast_checks: Checks,
    #[serde(default)]
    after_merge: Checks,
}

pub(super) fn parse(text: &str) -> Result<TrainSettings, String> {
    let file: File = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(TrainSettings {
        fast_checks: file.fast_checks,
        after_merge: file.after_merge,
    })
}

impl Train {
    /// The base's `.fleetd/train.json`, read at most every `TTL_MS`: empty settings without one. None when it can't be
    /// read, or used until it is read again (logged): then, as with unreadable project settings, every check counts.
    pub(super) async fn repo_checks(&self, repo: &str, base: &str) -> Option<TrainSettings> {
        let key = (repo.to_string(), base.to_string());
        let now = self.now_ms();
        if let Some((at, settings)) = lock(&self.repo_checks).get(&key)
            && now - at < TTL_MS
        {
            return settings.clone();
        }
        let settings = match self.github.file(repo, PATH, base).await {
            Ok(None) => Some(TrainSettings::default()),
            Ok(Some(text)) => match parse(&text) {
                Ok(settings) => Some(settings),
                Err(why) => {
                    tracing::warn!(
                        repo,
                        base,
                        why,
                        "train: {PATH} is not used; every check counts"
                    );
                    None
                }
            },
            Err(e) => {
                tracing::warn!(repo, base, error = %e.message, "train: {PATH} not read");
                return None;
            }
        };
        lock(&self.repo_checks).insert(key, (now, settings.clone()));
        settings
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_holds_the_two_lists_and_nothing_else() {
        let settings = parse(r#"{ "fastChecks": ["site"], "afterMerge": ["e2e"] }"#).unwrap();
        assert_eq!(settings.fast_set(&["build".into()]), ["build", "site"]);
        assert!(settings.after_merge_only("e2e"));
        assert_eq!(parse("{}").unwrap(), TrainSettings::default());
        for bad in [
            r#"{ "fastCheck": ["site"] }"#,
            r#"{ "fastChecks": ["site", "site"] }"#,
            r#"{ "fastChecks": "site" }"#,
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    /// The repo's lists add to the project's, each name once; one in both lists is left for after the merge.
    #[test]
    fn the_repos_checks_add_to_the_projects() {
        let project =
            parse(r#"{ "fastChecks": ["integration", "site"], "afterMerge": ["bench"] }"#).unwrap();
        let repo =
            parse(r#"{ "fastChecks": ["site", "lint"], "afterMerge": ["integration"] }"#).unwrap();
        let both = project.with(&repo);
        assert_eq!(both.fast_set(&["build".into()]), ["build", "site", "lint"]);
        assert!(both.after_merge_only("bench") && both.after_merge_only("integration"));
    }

    /// fleetd's own `.fleetd/train.json`: its fast checks are jobs of its CI that run on each PR's push on Linux; its
    /// after-merge checks, besides mac.yml's, are Linux jobs of ci.yml too; none is a name no job has, which no run
    /// would ever report. Linux QA blocks merges (D158): every Linux shard of
    /// desktop-qa.yml's `qa` is in it, so a shard renamed or added fails here rather than drop out of the gate. No PR
    /// runs a macOS job (ci.no-macos-on-prs): each check mac.yml reports, and the iOS build of a manual Mobile run, is
    /// after merge only, so a red one on a branch someone ran it on never holds a merge.
    #[test]
    fn fleetds_own_file_names_linux_jobs_of_its_ci() {
        use serde_yaml_ng::Value;
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let file = parse(&std::fs::read_to_string(format!("{root}/{PATH}")).unwrap()).unwrap();
        let workflow = |name: &str| -> Value {
            let path = format!("{root}/.github/workflows/{name}");
            serde_yaml_ng::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
        };
        let ci = workflow("ci.yml");
        let jobs = ci["jobs"].as_mapping().unwrap();
        // The Linux shards' check names: `qa`'s name with each Linux entry of its matrix (a `fromJSON` of literal
        // entries) put in.
        let qa = &workflow("desktop-qa.yml")["jobs"]["qa"];
        let template = qa["name"].as_str().unwrap();
        let include = qa["strategy"]["matrix"]["include"].as_str().unwrap();
        let shards_on = |os: &str| -> Vec<String> {
            include
                .split('{')
                .filter_map(|piece| piece.split_once('}'))
                .filter_map(|(entry, _)| {
                    serde_json::from_str::<serde_json::Value>(&format!("{{{entry}}}")).ok()
                })
                .filter(|entry| entry["os"] == os)
                .map(|entry| {
                    let mut name = template.to_string();
                    for (key, value) in entry.as_object().unwrap() {
                        let value = value
                            .as_str()
                            .map_or_else(|| value.to_string(), str::to_string);
                        name = name.replace(&format!("${{{{ matrix.{key} }}}}"), &value);
                    }
                    name
                })
                .collect()
        };
        let shards = shards_on("ubuntu-latest");
        assert_eq!(shards.len(), 4, "{shards:?}");
        assert_eq!(qa["runs-on"].as_str(), Some("${{ matrix.os }}"));
        for shard in &shards {
            assert!(
                file.fast_checks.iter().any(|c| c.as_str() == shard),
                "{PATH} leaves out {shard}"
            );
        }
        assert!(!file.fast_checks.is_empty());
        for check in file.fast_checks.iter() {
            let check = check.as_str();
            if shards.iter().any(|s| s == check) {
                continue;
            }
            let job = jobs
                .iter()
                .find(|(id, job)| job["name"].as_str().or(id.as_str()) == Some(check))
                .map(|(_, job)| job);
            let Some(job) = job else {
                panic!(
                    "{PATH} names {check}, which no job of ci.yml or Linux shard of desktop-qa.yml is"
                );
            };
            assert_eq!(job["runs-on"].as_str(), Some("ubuntu-latest"), "{check}");
        }

        // What mac.yml reports: its own jobs, and `<job> / <check>` for the workflows it calls, each on macOS.
        let mut mac = vec!["mobile (ios)".to_string()];
        for (id, job) in workflow("mac.yml")["jobs"].as_mapping().unwrap() {
            let id = id.as_str().unwrap();
            match job["uses"].as_str() {
                Some("./.github/workflows/desktop-qa.yml") => {
                    let macos = shards_on("macos-latest");
                    assert_eq!(macos.len(), 3, "{macos:?}");
                    mac.extend(macos.iter().map(|s| format!("{id} / {s}")));
                }
                Some(called) => {
                    let called = workflow(called.trim_start_matches("./.github/workflows/"));
                    for (cid, cjob) in called["jobs"].as_mapping().unwrap() {
                        if cjob["runs-on"].as_str() == Some("macos-latest") {
                            let name = cjob["name"].as_str().or(cid.as_str()).unwrap();
                            mac.push(format!("{id} / {name}"));
                        }
                    }
                }
                None if job["runs-on"].as_str() == Some("macos-latest") => {
                    mac.push(job["name"].as_str().unwrap_or(id).to_string());
                }
                None => {}
            }
        }
        let ci_job = |check: &str| {
            jobs.iter().any(|(id, job)| {
                job["name"].as_str().or(id.as_str()) == Some(check)
                    && job["runs-on"].as_str() == Some("ubuntu-latest")
            })
        };
        let mut after: Vec<String> = file
            .after_merge
            .iter()
            .map(|c| c.as_str().to_string())
            .filter(|c| !ci_job(c))
            .collect();
        after.sort();
        mac.sort();
        assert_eq!(
            after, mac,
            "{PATH}'s afterMerge must list every check mac.yml reports, and besides those only Linux jobs of ci.yml"
        );
    }
}
