//! A running lead keeps the exact texts it started with; an edit reaches the next session.
use fleetd_contracts::ids::ThreadId;
use fleetd_contracts::prompts::{PromptScope, PromptWarningCode};

use super::PromptSet;
use super::render::ref_of;
use super::store::entry;
use crate::hub::intake::auto_start_tests::hub;

#[tokio::test(flavor = "current_thread")]
async fn a_running_lead_keeps_its_texts_and_an_edit_reaches_the_next_session() {
    let hub = hub(true, true);
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
                && w.rule.as_deref() == Some("secrets-via-ask"))
    );
    prompts
        .set(
            entry("wake.intent").unwrap(),
            PromptScope::Global,
            None,
            "EDITED intent {{workstreamId}}",
            None,
        )
        .unwrap();

    // 3. A new order wakes the running lead in the words it started with, and what it was told is unchanged.
    let (w2, _, _) = hub.order("add a /ready endpoint").await;
    hub.after_debounce().await;
    let sends = hub.node.sends.lock().unwrap().clone();
    assert_eq!(sends.len(), 1);
    assert!(
        sends[0].contains(&format!(
            "- New intent {w2}: 'add a /ready endpoint'. Register it"
        )),
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
    assert_eq!(
        pinned("wake.intent"),
        ref_of("wake.intent", entry("wake.intent").unwrap().default)
    );

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
    let wrapped = e.default.replacen(
        " from the project's policy",
        "\nfrom the project's policy",
        1,
    );
    assert_ne!(wrapped, e.default);
    let older = e.default.replacen("one clear goal", "a clear goal", 1);
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
    let texts = super::registry::ENTRIES.iter().map(|e| (e.id, e.default));
    let playbooks = crate::hub::playbooks::load::BUNDLED
        .iter()
        .map(|(n, t)| (n.as_str(), *t));
    for (id, text) in texts.chain(playbooks) {
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
