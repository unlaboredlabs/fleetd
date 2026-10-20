//! The headline: one line the code writes from the facts. No model phrases it.
use fleetd_contracts::status::HeadlineFacts;

/// `{doing joined | "nothing running"}{; waiting on …}. {needs you}.` The stale clause is prepended by the caller.
pub fn template(f: &HeadlineFacts) -> String {
    let doing = if f.doing.is_empty() {
        "Nothing running".to_owned()
    } else {
        let mut d = f
            .doing
            .iter()
            .take(2)
            .cloned()
            .collect::<Vec<_>>()
            .join(" and ");
        if let Some(first) = d.get(..1) {
            d = first.to_uppercase() + &d[1..];
        }
        d
    };
    let waiting = f
        .waiting_on
        .first()
        .map(|w| format!("; waiting on {w}"))
        .unwrap_or_default();
    let needs = match (f.needs_you, &f.first_ask) {
        (0, _) => "Nothing needs you".to_owned(),
        (1, Some(key)) => format!("1 needs you: {key}"),
        (n, _) => format!("{n} need you"),
    };
    format!("{doing}{waiting}. {needs}.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> HeadlineFacts {
        HeadlineFacts {
            scope: "project fleetd".into(),
            pct: 72,
            was: Some(80),
            doing: vec!["switching to the new runner".into()],
            waiting_on: vec!["the full lab run".into()],
            ..Default::default()
        }
    }

    #[test]
    fn the_template_says_what_runs_what_waits_and_who_is_needed() {
        assert_eq!(
            template(&facts()),
            "Switching to the new runner; waiting on the full lab run. Nothing needs you."
        );
        let f = HeadlineFacts {
            needs_you: 1,
            first_ask: Some("api.path".into()),
            ..Default::default()
        };
        assert_eq!(template(&f), "Nothing running. 1 needs you: api.path.");
        let f = HeadlineFacts {
            needs_you: 3,
            ..Default::default()
        };
        assert_eq!(template(&f), "Nothing running. 3 need you.");
    }
}
