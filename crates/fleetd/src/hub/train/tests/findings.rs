//! W373 (#976): a writer hears its PR's open blocking findings even when the train sends the PR back for a rebase in
//! the middle of its review, so it fixes them with the rebase instead of pushing the same code again.
use super::*;

/// Records `task`'s blocking verdict on `pr` at `head`, as `report` does.
fn blocking(kit: &Kit, task: &str, pr: &str, head: &str, summary: &str) {
    let verdict = json!({ "taskId": task, "prHeadSha": head, "blocking": 1, "nonBlocking": 0, "summary": summary });
    super::super::records::sql(&kit.db, |conn| {
        conn.execute(
            "INSERT INTO review_verdicts (task_id, pr_key, sha, blocking, at_ms, data) VALUES (?1, ?2, ?3, 1, 0, ?4)",
            rusqlite::params![task, crate::hub::reviews::verdicts::pr_key(pr), head, verdict.to_string()],
        )
        .unwrap()
    });
    kit.host.push_event("review.verdict", verdict);
}

/// The messages to `to` so far that say `what`.
fn sent(kit: &Kit, to: &str, what: &str) -> Vec<String> {
    let sends = kit.host.sends.lock().unwrap().clone();
    sends
        .into_iter()
        .filter(|(t, text)| t == to && text.contains(what))
        .map(|(_, text)| text)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pr_sent_back_mid_review_still_brings_its_blocking_findings_to_its_writer() {
    let kit = Kit::with_reviews();
    let writer = kit.running_task("T1", "write");
    let pr = kit.open_pr(7, "m", &[add("a1.txt", "a\n")]);
    let change = kit
        .train
        .enqueue(
            &project(),
            ChangeEnqueueCall {
                task_id: Some(writer.clone()),
                ..enqueue_call(pr.clone())
            },
        )
        .await
        .unwrap();
    assert_eq!(kit.spawned(), 1);
    let head = kit.head_of("m");

    // GitHub finds it conflicting while T50 reviews it: back to its writer, with nothing open yet.
    set_mergeable(&kit, 7, Some(false));
    kit.train.step(REPO).await;
    assert_eq!(state_of(&kit, &change), ChangeState::NeedsRebase);
    let first = sent(&kit, "T1", "could not rebase it");
    assert_eq!(first.len(), 1);
    assert!(!first[0].contains("still open"), "{}", first[0]);

    // T50's blocking verdict lands on the parked head: it still reaches the writer, at work on that very head.
    let finding = "blocking: crates/fleetd/src/hub/navi/checker.rs:333 trusts any answer";
    blocking(&kit, "T50", &pr, &head, finding);
    eventually("the findings reached the writer", || {
        !sent(&kit, "T1", finding).is_empty()
    })
    .await;
    let parked = kit.get(&change.change_id);
    assert!(
        parked
            .last_error
            .as_deref()
            .is_some_and(|e| e.starts_with("conflicts with main")),
        "it keeps why it was sent back: {:?}",
        parked.last_error
    );

    // The writer rebases without fixing it; sent back again, the notice names the finding, still open.
    kit.gh.push_empty("m");
    set_mergeable(&kit, 7, None);
    kit.train.step(REPO).await;
    assert_eq!(state_of(&kit, &change), ChangeState::Reviewing);
    set_mergeable(&kit, 7, Some(false));
    kit.train.step(REPO).await;
    assert_eq!(state_of(&kit, &change), ChangeState::NeedsRebase);
    let again = sent(&kit, "T1", "could not rebase it");
    assert_eq!(again.len(), 2);
    assert!(
        again[1].contains("blocking findings are still open") && again[1].contains(finding),
        "{}",
        again[1]
    );
}
