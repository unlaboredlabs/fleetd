//! A running lead keeps the exact texts it started with; an edit reaches the next session.
use fleetd_contracts::ids::ThreadId;
use fleetd_contracts::prompts::{PromptScope, PromptWarningCode};

use super::PromptSet;
use super::render::ref_of;
use super::store::entry;
use crate::hub::leads::auto_start_tests::hub;

#[tokio::test(flavor = "current_thread")]
async fn a_running_lead_keeps_its_texts_and_an_edit_reaches_the_next_session() {
    let hub = hub(true);
    let db = hub.area.ctx.db.clone();
    let prompts = db.prompts();
    let defaults = PromptSet::defaults();

    // 1. The lead of P starts with the shipped lead.start, rendered for P.
    hub.order("add a /health endpoint").await;
    let first = hub.launched_prompts().remove(0);
    let shipped = defaults.render(
        "lead.start",
        &[("project", &"repo-a"), ("projectRef", &"lab-a/p-a")],
    );
    assert!(first.starts_with(shipped.trim_end()), "{first}");
    let lead = hub.area.leads.get(&hub.project).unwrap().unwrap();

    // 2. Both edits are saved hub-wide; the lead prompt loses a safety rule, which warns and does not block.
    let lead_start = entry("lead.start").unwrap();
    let (edited_ref, warnings) = prompts
        .set(
            lead_start,
            PromptScope::Global,
            None,
            "EDITED {{project}}",
            None,
        )
        .unwrap();
    assert!(
        warnings
            .iter()
            .any(|w| w.code == PromptWarningCode::SafetyRuleMissing
                && w.rule.as_deref() == Some("secrets-via-request"))
    );
    for (id, text) in [
        ("steer.message", "EDITED steer {{id}}"),
        ("lead.wake", "EDITED wake {{state}} {{events}}"),
    ] {
        prompts
            .set(entry(id).unwrap(), PromptScope::Global, None, text, None)
            .unwrap();
    }

    // 3. A new order wakes the running lead (an event line in its pinned wake text), and what it was told is unchanged.
    let (w2, _) = hub.order("add a /ready endpoint").await;
    hub.after_debounce().await;
    let sends = hub.node.sends.lock().unwrap().clone();
    assert_eq!(sends.len(), 1);
    assert!(
        sends[0].contains(&format!("- new order {w2}: \"add a /ready endpoint\"")),
        "{}",
        sends[0]
    );
    assert!(!sends[0].contains("EDITED"), "{}", sends[0]);
    let session = prompts
        .session(&hub.project.machine_id, &lead.thread_id)
        .unwrap()
        .unwrap();
    assert_eq!(session.text, first);
    let pinned = |id: &str| {
        session
            .refs
            .iter()
            .find(|r| r.id.as_str() == id)
            .unwrap()
            .r#ref
            .to_string()
    };
    assert_eq!(
        pinned("lead.start"),
        ref_of("lead.start", lead_start.default)
    );
    for id in ["steer.message", "lead.wake"] {
        assert_eq!(pinned(id), ref_of(id, entry(id).unwrap().default));
    }

    // 4. A restarted lead is a new session: it starts with the edit, and its pins name the override.
    let restarted = hub.area.leads.restart(&hub.project).await.unwrap();
    let second = hub.launched_prompts().remove(1);
    assert!(second.starts_with("EDITED repo-a"), "{second}");
    let session = prompts
        .session(
            &hub.project.machine_id,
            &ThreadId::unchecked(restarted.thread_id.as_str()),
        )
        .unwrap()
        .unwrap();
    let lead_ref = session
        .refs
        .iter()
        .find(|r| r.id.as_str() == "lead.start")
        .unwrap();
    assert_eq!(
        (lead_ref.r#ref.as_str(), lead_ref.scope),
        (edited_ref.as_str(), PromptScope::Global)
    );
}

/// Every shipped text fills only the placeholders its entry declares, and uses each required one: an edit is warned
/// against the same list, so a text moved into the registry can't silently lose or invent a value.
#[test]
fn every_shipped_text_uses_what_its_entry_declares() {
    for e in super::registry::ENTRIES {
        let declared = e.placeholders();
        let used = super::render::placeholders_in(e.default);
        for p in &declared {
            assert!(
                !p.required || used.contains(&p.name),
                "{} declares {{{{{}}}}} required and doesn't use it",
                e.id,
                p.name
            );
        }
        for name in &used {
            assert!(
                declared.iter().any(|p| &p.name == name),
                "{} uses {{{{{name}}}}}, which it doesn't declare",
                e.id
            );
        }
    }
}

/// A project id is whatever a node reports; as a path it must not reach the hub-wide overrides or leave the home.
#[test]
fn a_project_id_never_steers_where_an_override_is_written() {
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let db = crate::hub::store::HubDb::open(home.path()).unwrap();
    let prompts = db.prompts();
    let e = entry("lead.start").unwrap();
    prompts
        .save(e, PromptScope::Global, None, "hub-wide", None)
        .unwrap();
    let project = |id: &str| fleetd_contracts::ids::ProjectRef {
        machine_id: fleetd_contracts::ids::MachineId::new("lab-a").unwrap(),
        project_id: fleetd_contracts::ids::ProjectId::unchecked(id),
    };
    let absolute = outside.path().join("lead.start").display().to_string();
    for id in ["../..", "..", absolute.as_str()] {
        let p = project(id);
        prompts
            .save(e, PromptScope::Project, Some(&p), "project", None)
            .unwrap();
        assert_eq!(prompts.override_of(e, Some(&p)).unwrap().text, "project");
        prompts.reset(e, PromptScope::Project, Some(&p)).unwrap();
    }
    assert_eq!(prompts.override_of(e, None).unwrap().text, "hub-wide");
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    assert!(!home.path().join("lead.start.md").exists());
}

/// The shipped texts were reflowed from hard-wrapped lines into paragraphs. An override edited from the wrapped text
/// is not "behind the default": same words, so no update notice. A real change of words still is.
#[test]
fn a_reflowed_default_is_not_a_changed_default() {
    let home = tempfile::tempdir().unwrap();
    let db = crate::hub::store::HubDb::open(home.path()).unwrap();
    let prompts = db.prompts();
    let e = entry("lead.start").unwrap();
    let wrapped = e
        .default
        .replacen(" and keep them posted", "\nand keep them posted", 1);
    assert_ne!(wrapped, e.default);
    let older = e.default.replacen(
        "Trust it over your memory",
        "Trust it over what you recall",
        1,
    );
    for (base_text, stale) in [
        (e.default.to_owned(), false),
        (wrapped, false),
        (older, true),
    ] {
        // Saving a text keeps it, as a release's `keep_defaults` keeps its shipped texts.
        let base = prompts
            .save(e, PromptScope::Global, None, &base_text, None)
            .unwrap();
        prompts
            .save(
                e,
                PromptScope::Global,
                None,
                "mine {{project}} {{projectRef}}",
                Some(&base),
            )
            .unwrap();
        assert_eq!(prompts.stale().len(), usize::from(stale));
        assert_eq!(prompts.detail(e, None).stale.is_some(), stale);
        assert_eq!(
            prompts
                .list(None)
                .iter()
                .find(|s| s.id.as_str() == e.id)
                .unwrap()
                .stale,
            stale
        );
    }
}

/// Every shipped text is paragraphs, one line each: the editor soft-wraps, so a hard wrap breaks lines mid-sentence.
/// A long line that stops mid-sentence and goes on in the next line is a hard wrap.
#[test]
fn shipped_texts_are_not_hard_wrapped() {
    for (id, text) in super::registry::ENTRIES.iter().map(|e| (e.id, e.default)) {
        for pair in text.lines().collect::<Vec<_>>().windows(2) {
            let (line, next) = (pair[0], pair[1].trim_start());
            let block = ["- ", "* ", "#", "```", "|", ">", "{{"]
                .iter()
                .any(|p| next.starts_with(p))
                || next
                    .split_once(". ")
                    .is_some_and(|(n, _)| n.chars().all(|c| c.is_ascii_digit()) && !n.is_empty());
            let ends = line.trim_end().ends_with(['.', ':', '!', '?', '`']);
            assert!(
                line.len() < 90 || ends || next.is_empty() || block,
                "{id} is hard-wrapped after: {line}"
            );
        }
    }
}

/// What agents read never sends them back to the shell: prompts, and every hint, refusal and digest line the hub
/// writes (string literals in its source), name fleetd's tools, not lead-side `fleetd` commands or their flags.
#[test]
fn agent_facing_texts_name_tools_not_fleetd_commands() {
    let command = regex::Regex::new(
        r"fleetd (task (spawn|list|message|cancel)|request (secret|withdraw)|decide\b|brief create|close --workstream|plan (add|edit|drop|show|milestone)|gated run|change enqueue|review verdict|decisions search)",
    )
    .unwrap();
    let flag = regex::Regex::new(r#""[^"]*--(workstream|proceeded|item|steer|milestone|rec|why|context|option|sink|env-name|class|scope|task)\b"#).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut found = Vec::new();
    for (id, text) in super::registry::ENTRIES.iter().map(|e| (e.id, e.default)) {
        if let Some(m) = command.find(text) {
            found.push(format!("prompt {id}: {}", m.as_str()));
        }
    }
    let mut dirs = vec![root.join("src/hub")];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if path.is_dir() {
                dirs.push(path);
                continue;
            }
            if !name.ends_with(".rs") || name == "tests.rs" || name.ends_with("_tests.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            // Unit tests at the end of a file may quote the old texts.
            let code = text.split("#[cfg(test)]").next().unwrap();
            for (n, line) in code.lines().enumerate() {
                if line.trim_start().starts_with("//") {
                    continue;
                }
                if command.is_match(line) || flag.is_match(line) {
                    found.push(format!(
                        "{}:{}: {}",
                        path.strip_prefix(root).unwrap().display(),
                        n + 1,
                        line.trim()
                    ));
                }
            }
        }
    }
    assert!(
        found.is_empty(),
        "agent-facing texts name lead-side commands:\n{}",
        found.join("\n")
    );
}

/// An edit to a prompt a release retired is never applied and never lost: it is listed until the human deletes it.
#[test]
fn edits_to_retired_prompts_are_listed_until_reset() {
    let home = tempfile::tempdir().unwrap();
    let db = crate::hub::store::HubDb::open(home.path()).unwrap();
    db.with(|c| {
        c.execute(
            "INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES ('lab-a', 'p-a', '', '', '{}')",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let prompts = db.prompts();
    let dir = db.prompts_dir().unwrap().to_owned();
    let p = fleetd_contracts::ids::ProjectRef {
        machine_id: fleetd_contracts::ids::MachineId::new("lab-a").unwrap(),
        project_id: fleetd_contracts::ids::ProjectId::unchecked("p-a"),
    };
    // Written by an older release.
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("wake.intent.md"),
        "---\nbase: wake.intent@0123456789\n---\nNew order {{workstreamId}}, mine",
    )
    .unwrap();
    prompts
        .save(
            entry("lead.start").unwrap(),
            PromptScope::Project,
            Some(&p),
            "live",
            None,
        )
        .unwrap();
    let project_dir = dir
        .join("projects")
        .read_dir()
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let project_file = project_dir.join("permission.denied.human.md");
    std::fs::write(&project_file, "---\nbase: x@0123456789\n---\nNo: {{said}}").unwrap();

    let hub_wide = prompts.orphans(None);
    let ids: Vec<(&str, Option<&str>)> = hub_wide
        .iter()
        .map(|o| {
            (
                o.id.as_str(),
                o.suggested_target.as_ref().map(|t| t.as_str()),
            )
        })
        .collect();
    assert_eq!(ids, vec![("wake.intent", Some("lead.start"))]);
    assert!(hub_wide.iter().all(|o| o.scope == PromptScope::Global));

    let with_project = prompts.orphans(Some(&p));
    let mine = &with_project[1];
    assert_eq!(
        (with_project.len(), mine.id.as_str(), mine.scope),
        (2, "permission.denied.human", PromptScope::Project)
    );
    assert_eq!(mine.suggested_target, None);
    assert_eq!(prompts.all_orphans().len(), 2);
    // Nothing retired reaches a session: the live prompts are untouched.
    assert_eq!(
        prompts.current(Some(&p)).get("lead.start").text.as_ref(),
        "live"
    );

    let retired = super::retired::get("permission.denied.human").unwrap();
    prompts
        .reset_retired(retired, PromptScope::Project, Some(&p))
        .unwrap();
    assert!(!project_file.exists());
    let left: Vec<String> = prompts
        .all_orphans()
        .into_iter()
        .map(|o| o.id.to_string())
        .collect();
    assert_eq!(left, vec!["wake.intent"]);
}

/// The lead asks once and lets the chat's waiting state carry the question: its own examples never nag.
#[test]
fn the_leads_examples_never_nag() {
    let lead = super::store::entry("lead.start").unwrap().default;
    let nag =
        regex::Regex::new(r"(?i)still waiting|waiting on you|reminder:|as I asked|haven't heard")
            .unwrap();
    let examples = lead.split("## Examples").nth(1).unwrap();
    let examples = examples.split("\n## ").next().unwrap();
    let said: Vec<&str> = examples.lines().filter(|l| l.starts_with("You:")).collect();
    assert!(!said.is_empty(), "{lead}");
    for line in said {
        assert!(
            !nag.is_match(line),
            "the lead nags in its own example: {line}"
        );
    }
}
