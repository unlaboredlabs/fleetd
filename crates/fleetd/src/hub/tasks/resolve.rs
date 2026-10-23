//! The profile a task runs on.
use fleetd_contracts::effort::TaskProfile;
use fleetd_contracts::tasks::TaskKind;

/// The spawn's profile, high when it names none. A review task (the train's reviewers, QA and judges
/// included) always runs high, and so does every task of a project with medium off.
pub fn resolve_profile(
    spawn: Option<TaskProfile>,
    kind: TaskKind,
    medium_allowed: bool,
) -> TaskProfile {
    if kind == TaskKind::Review || !medium_allowed {
        return TaskProfile::High;
    }
    spawn.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use TaskProfile::{High, Medium};

    #[test]
    fn the_spawn_then_the_project_switch_then_high() {
        for kind in [TaskKind::Write, TaskKind::Read] {
            assert_eq!(resolve_profile(None, kind, true), High);
            assert_eq!(resolve_profile(Some(Medium), kind, true), Medium);
            assert_eq!(resolve_profile(Some(High), kind, true), High);
            // Medium off: the spawn's medium runs high.
            assert_eq!(resolve_profile(Some(Medium), kind, false), High);
        }
    }

    #[test]
    fn reviewers_always_run_high() {
        for allowed in [true, false] {
            assert_eq!(
                resolve_profile(Some(Medium), TaskKind::Review, allowed),
                High
            );
            assert_eq!(resolve_profile(None, TaskKind::Review, allowed), High);
        }
    }
}
