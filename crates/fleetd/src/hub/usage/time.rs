//! Small text helpers shared by the usage, approvals and doctor areas.
/// Text cut to `max` characters with an ellipsis (chars, not UTF-16 units).
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    } else {
        text.to_string()
    }
}

pub fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}
