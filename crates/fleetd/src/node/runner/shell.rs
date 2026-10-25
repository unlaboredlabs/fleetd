//! Shell commands as every runner's spans and the hub's time views read them.

/// The program a shell command runs: after any `cd x &&` and `VAR=value` prefixes.
pub fn program(command: &str) -> Option<&str> {
    let mut rest = command.trim();
    loop {
        if let Some(after) = rest.strip_prefix("cd ")
            && let Some(i) = after.find("&&")
        {
            rest = after[i + 2..].trim_start();
            continue;
        }
        let first = rest.split_whitespace().next()?;
        if first.contains('=') && !first.starts_with('=') {
            rest = rest[first.len()..].trim_start();
            continue;
        }
        return Some(first);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_program_skips_cd_and_env_prefixes() {
        assert_eq!(program("cd /x && RUST_LOG=1 cargo test"), Some("cargo"));
        assert_eq!(program("git push origin HEAD"), Some("git"));
        assert_eq!(program("  "), None);
    }
}
