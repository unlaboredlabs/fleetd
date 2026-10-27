//! The profile a task runs on, and the model and effort its settings choose.
use fleetd_contracts::effort::{Effort, ModelName, ProfileSetting, TaskProfile};
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

/// The model and effort one profile's settings choose: the project's field, else the fleet's. None where neither
/// sets one, or where the model set was refused: the runner's own for the profile applies.
pub fn resolve_setting(
    project: &ProfileSetting,
    fleet: &ProfileSetting,
) -> (Option<ModelName>, Option<Effort>) {
    (
        project.usable_model().or(fleet.usable_model()).cloned(),
        project.effort.or(fleet.effort),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use TaskProfile::{High, Medium};

    fn setting(model: Option<&str>, effort: Option<Effort>) -> ProfileSetting {
        ProfileSetting {
            model: model.map(ModelName::unchecked),
            effort,
            refused: None,
        }
    }

    #[test]
    fn the_project_then_the_fleet_then_the_runner_s_own() {
        let none = ProfileSetting::default();
        // Nothing set: nothing chosen, so the runner's own runs.
        assert_eq!(resolve_setting(&none, &none), (None, None));
        let fleet = setting(Some("claude-sonnet-5-5"), Some(Effort::Max));
        assert_eq!(
            resolve_setting(&none, &fleet),
            (
                Some(ModelName::unchecked("claude-sonnet-5-5")),
                Some(Effort::Max)
            )
        );
        // The project's wins field by field: its effort, the fleet's model.
        let project = setting(None, Some(Effort::Low));
        assert_eq!(
            resolve_setting(&project, &fleet),
            (
                Some(ModelName::unchecked("claude-sonnet-5-5")),
                Some(Effort::Low)
            )
        );
        let project = setting(Some("claude-fable-5-1"), None);
        assert_eq!(
            resolve_setting(&project, &fleet).0,
            Some(ModelName::unchecked("claude-fable-5-1"))
        );
        // A refused model falls through, its effort still applies.
        let refused = ProfileSetting {
            refused: Some("claude refused it".into()),
            ..setting(Some("claude-nope"), Some(Effort::High))
        };
        assert_eq!(
            resolve_setting(&refused, &fleet),
            (
                Some(ModelName::unchecked("claude-sonnet-5-5")),
                Some(Effort::High)
            )
        );
        assert_eq!(resolve_setting(&refused, &none), (None, Some(Effort::High)));
    }

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
