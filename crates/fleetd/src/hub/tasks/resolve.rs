//! The profile a task runs on.
use fleetd_contracts::effort::ProfileName;
use fleetd_contracts::tasks::TaskKind;

/// The spawn's profile, the hub's default when it names none: `allowed` is what the project allows, the default
/// first. A review task (the train's reviewers, QA and judges included) always runs on the default. A profile the
/// project doesn't allow is refused, naming the ones it does.
pub fn resolve_profile(
    spawn: Option<&ProfileName>,
    kind: TaskKind,
    allowed: &[ProfileName],
) -> Result<ProfileName, String> {
    let Some(default) = allowed.first() else {
        return Err("the hub's profiles were not read".into());
    };
    match spawn {
        _ if kind == TaskKind::Review => Ok(default.clone()),
        None => Ok(default.clone()),
        Some(name) if allowed.contains(name) => Ok(name.clone()),
        Some(name) => Err(format!(
            "this project doesn't allow profile {name}; it allows {}",
            allowed
                .iter()
                .map(ProfileName::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(n: &[&str]) -> Vec<ProfileName> {
        n.iter().map(|n| ProfileName::unchecked(*n)).collect()
    }

    #[test]
    fn the_spawn_s_profile_when_allowed_else_the_default() {
        let allowed = names(&["high", "medium"]);
        let medium = ProfileName::unchecked("medium");
        for kind in [TaskKind::Write, TaskKind::Read] {
            assert_eq!(resolve_profile(None, kind, &allowed).unwrap(), "high");
            assert_eq!(
                resolve_profile(Some(&medium), kind, &allowed).unwrap(),
                "medium"
            );
        }
    }

    #[test]
    fn a_profile_the_project_doesn_t_allow_is_refused_naming_the_allowed() {
        let fast = ProfileName::unchecked("fast");
        let why =
            resolve_profile(Some(&fast), TaskKind::Write, &names(&["high", "medium"])).unwrap_err();
        assert_eq!(
            why,
            "this project doesn't allow profile fast; it allows high, medium"
        );
        // Only the default allowed: medium is refused too.
        let medium = ProfileName::unchecked("medium");
        assert!(resolve_profile(Some(&medium), TaskKind::Write, &names(&["high"])).is_err());
    }

    #[test]
    fn reviewers_always_run_on_the_default() {
        let medium = ProfileName::unchecked("medium");
        for allowed in [names(&["high", "medium"]), names(&["high"])] {
            assert_eq!(
                resolve_profile(Some(&medium), TaskKind::Review, &allowed).unwrap(),
                "high"
            );
            assert_eq!(
                resolve_profile(None, TaskKind::Review, &allowed).unwrap(),
                "high"
            );
        }
    }
}
