//! Model and effort for a spawn. TS spec: apps/hub/src/tasks/resolve.ts.
use fleetd_contracts::effort::Effort;

pub const DEFAULT_TASK_MODEL: &str = "claude-opus-5-5";
pub const DEFAULT_TASK_EFFORT: Effort = Effort::High;

#[derive(Clone, Debug, Default)]
pub struct ModelEffort {
    pub model: Option<String>,
    pub effort: Option<Effort>,
}

/// Each of model and effort independently: the spawn flag, then the policy file's defaults, then the project's
/// settings, then claude-opus-5-5 / high. Medium only ever comes from one of those saying so.
pub fn resolve_model_effort(
    flag: &ModelEffort,
    policy: Option<&ModelEffort>,
    project: Option<&ModelEffort>,
) -> (String, Effort) {
    let empty = ModelEffort::default();
    let order = [flag, policy.unwrap_or(&empty), project.unwrap_or(&empty)];
    let model = order
        .iter()
        .find_map(|l| l.model.clone())
        .unwrap_or_else(|| DEFAULT_TASK_MODEL.to_owned());
    let effort = order
        .iter()
        .find_map(|l| l.effort)
        .unwrap_or(DEFAULT_TASK_EFFORT);
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
    fn flag_then_policy_then_project_then_opus_high() {
        let none = me(None, None);
        assert_eq!(
            resolve_model_effort(&none, None, None),
            ("claude-opus-5-5".into(), Effort::High)
        );
        let policy = me(Some("claude-sonnet-5-5"), None);
        let project = me(Some("claude-haiku-5-5"), Some(Effort::Medium));
        // Each field on its own: the model from the policy, the effort from the project.
        assert_eq!(
            resolve_model_effort(&none, Some(&policy), Some(&project)),
            ("claude-sonnet-5-5".into(), Effort::Medium)
        );
        assert_eq!(
            resolve_model_effort(&none, None, Some(&project)),
            ("claude-haiku-5-5".into(), Effort::Medium)
        );
        let flag = me(Some("claude-haiku-5-5"), Some(Effort::Low));
        assert_eq!(
            resolve_model_effort(&flag, Some(&policy), Some(&project)),
            ("claude-haiku-5-5".into(), Effort::Low)
        );
        // Never medium by default.
        assert_eq!(
            resolve_model_effort(&none, Some(&policy), None).1,
            Effort::High
        );
    }
}
