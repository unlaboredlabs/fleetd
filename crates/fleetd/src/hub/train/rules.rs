//! Enqueue rules, pure: the tier and the freeze decision key.
use super::contract::{Tier, tier_str};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub message: String,
    pub fix: String,
}

impl Refusal {
    pub fn new(message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            fix: fix.into(),
        }
    }
}

fn rank(t: Tier) -> u8 {
    match t {
        Tier::S => 0,
        Tier::M => 1,
        Tier::L => 2,
    }
}

/// The brief's tier, raised by the task's or the caller's, never lowered by the caller.
pub fn check_tier(
    brief: Tier,
    requested: Option<Tier>,
    task: Option<Tier>,
) -> Result<Tier, Refusal> {
    if let Some(r) = requested
        && rank(r) < rank(brief)
    {
        return Err(Refusal::new(
            format!(
                "Tier {} is below the brief's tier {}; a tier can be raised, never lowered.",
                tier_str(r),
                tier_str(brief)
            ),
            format!("omit --tier, or pass --tier {} or higher", tier_str(brief)),
        ));
    }
    Ok([Some(brief), requested, task]
        .into_iter()
        .flatten()
        .fold(brief, |a, b| if rank(b) > rank(a) { b } else { a }))
}

/// `policy.freeze.<owner>.<name>`, lowercased; its value "true" holds the repo's train.
pub fn freeze_key(repo: &str) -> String {
    format!(
        "policy.freeze.{}",
        repo.to_lowercase().replacen('/', ".", 1)
    )
}

pub fn is_frozen_value(value: &str) -> bool {
    matches!(
        value.trim().to_lowercase().as_str(),
        "true" | "yes" | "on" | "1"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_highest_tier_and_refuses_a_caller_lowering_it() {
        assert_eq!(check_tier(Tier::M, None, None), Ok(Tier::M));
        assert_eq!(
            check_tier(Tier::S, Some(Tier::L), Some(Tier::M)),
            Ok(Tier::L)
        );
        assert_eq!(check_tier(Tier::M, None, Some(Tier::L)), Ok(Tier::L));
        assert_eq!(
            check_tier(Tier::M, Some(Tier::S), None).unwrap_err().fix,
            "omit --tier, or pass --tier M or higher"
        );
    }

    #[test]
    fn keys_the_freeze_on_the_lowercased_repo() {
        assert_eq!(
            freeze_key("Acme/Storefront"),
            "policy.freeze.acme.storefront"
        );
        assert!(is_frozen_value(" Yes ") && !is_frozen_value("false"));
    }
}
