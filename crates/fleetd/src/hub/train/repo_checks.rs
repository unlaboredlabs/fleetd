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

    /// fleetd's own `.fleetd/train.json` names jobs of its CI that run on each PR's push on Linux: never a macOS job,
    /// which the batch skips (D204), and never a name no job has, which no run would ever report.
    #[test]
    fn fleetds_own_file_names_linux_jobs_of_its_ci() {
        use serde_yaml_ng::Value;
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let file = parse(&std::fs::read_to_string(format!("{root}/{PATH}")).unwrap()).unwrap();
        let ci: Value = serde_yaml_ng::from_str(
            &std::fs::read_to_string(format!("{root}/.github/workflows/ci.yml")).unwrap(),
        )
        .unwrap();
        let jobs = ci["jobs"].as_mapping().unwrap();
        assert!(!file.fast_checks.is_empty());
        for check in file.fast_checks.iter().chain(file.after_merge.iter()) {
            let check = check.as_str();
            let job = jobs
                .iter()
                .find(|(id, job)| job["name"].as_str().or(id.as_str()) == Some(check))
                .map(|(_, job)| job);
            let Some(job) = job else {
                panic!("{PATH} names {check}, which no job of ci.yml is");
            };
            assert_eq!(job["runs-on"].as_str(), Some("ubuntu-latest"), "{check}");
        }
    }
}
