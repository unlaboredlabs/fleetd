//! Enqueue rules, pure: the refusal shape.

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
