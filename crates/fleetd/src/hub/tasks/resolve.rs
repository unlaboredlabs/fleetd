//! The model and effort a claude fleetd starts runs on: the lead and every agent of a project.
use fleetd_contracts::effort::Effort;

pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
pub const DEFAULT_EFFORT: Effort = Effort::High;

/// A model and effort, each optional: a project's saved setting, or one spawn's override.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelEffort {
    pub model: Option<String>,
    pub effort: Option<Effort>,
}

/// Each of model and effort on its own: the spawn's override, then the project's setting, then the default.
pub fn resolve_model_effort(spawn: &ModelEffort, project: &ModelEffort) -> (String, Effort) {
    let model = spawn
        .model
        .clone()
        .or_else(|| project.model.clone())
        .unwrap_or_else(|| DEFAULT_MODEL.to_owned());
    let effort = spawn.effort.or(project.effort).unwrap_or(DEFAULT_EFFORT);
    (model, effort)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me(model: Option<&str>, effort: Option<Effort>) -> ModelEffort {
        ModelEffort {
            model: model.map(str::to_owned),
            effort,
        }
    }

    #[test]
    fn the_spawn_override_then_the_project_setting_then_opus_high() {
        let none = me(None, None);
        assert_eq!(
            resolve_model_effort(&none, &none),
            ("claude-opus-5-5".into(), Effort::High)
        );
        let project = me(Some("claude-sonnet-5-5"), Some(Effort::Medium));
        assert_eq!(
            resolve_model_effort(&none, &project),
            ("claude-sonnet-5-5".into(), Effort::Medium)
        );
        // Each field on its own: the spawn names the model only, the effort stays the project's.
        let spawn = me(Some("claude-haiku-5-5"), None);
        assert_eq!(
            resolve_model_effort(&spawn, &project),
            ("claude-haiku-5-5".into(), Effort::Medium)
        );
        // A project that saved only its effort keeps the default model.
        assert_eq!(
            resolve_model_effort(&none, &me(None, Some(Effort::Low))),
            ("claude-opus-5-5".into(), Effort::Low)
        );
    }
}
