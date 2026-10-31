//! W118: a re-review is as big as what changed since the approved head. An unchanged patch keeps its approval and no
//! reviewer runs; a rebase that only resolved conflicts with main gets a short review of those files; anything else a full one; and a carried approval never clears a blocking finding.
use super::*;
use crate::hub::train::records::sql;

/// How the gate recorded the re-review of the Change's patch at `head`: (outcome, from_task, from_head, files).
fn rebase_row(kit: &Kit, head: &str) -> Option<(String, String, String, String)> {
    sql(&kit.db, |conn| {
        conn.query_row(
            "SELECT outcome, from_task, from_head, files FROM review_rebases WHERE head_sha = ?1",
            [head],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok()
    })
}

impl Kit {
    /// PR #7 on `m` edits line 6 of a.txt, approved by T50; then main edits line 6 too and the author rebases onto it,
    /// resolving the conflict as `resolved` (and adding `more`). Returns the Change, the approved head and the new one.
    async fn resolved(
        &self,
        resolved: &str,
        more: &[(&str, Option<&str>)],
    ) -> (Change, String, String) {
        let change = self
            .approved(
                7,
                "m",
                &[("a.txt", Some(&a_with(&[(6, "pr line 6")])))],
                "T50",
            )
            .await;
        let approved = change.head_sha.to_string();
        self.commit(
            "main",
            &[("a.txt", Some(&a_with(&[(6, "main line 6")])))],
            None,
        );
        let mut files = vec![("a.txt", Some(resolved))];
        files.extend_from_slice(more);
        let head = self.commit("m", &files, Some("origin/main"));
        (change, approved, head)
    }
}

/// A rebase onto a main that edited the PR hunk's context changes the patch id, but not the PR's own lines: the
/// approval carries over, no reviewer runs, and it merges. The carry is recorded with the head it came from.
#[tokio::test(flavor = "multi_thread")]
async fn an_unchanged_patch_keeps_its_approval_after_a_rebase_and_no_review_runs() {
    let kit = Kit::with_reviews();
    let change = kit
        .approved(
            7,
            "m",
            &[("a.txt", Some(&a_with(&[(6, "pr line 6")])))],
            "T50",
        )
        .await;
    let approved = change.head_sha.to_string();
    kit.commit(
        "main",
        &[("a.txt", Some(&a_with(&[(4, "main line 4")])))],
        None,
    );

    assert!(kit.train.step(REPO).await);
    let kept = kit.get(&change.change_id);
    assert_eq!(kept.state, ChangeState::Merged, "{:?}", kept.last_error);
    let rebased = kept.head_sha.to_string();
    assert_ne!(rebased, approved);
    assert_ne!(kept.patch_id, change.patch_id, "the patch id did change");
    assert_eq!(kit.spawned(), 1, "no second review");
    let carried = kept.reviews.last().unwrap();
    assert_eq!(
        (carried.task_id.as_str(), carried.pr_head_sha.as_str()),
        ("T50", rebased.as_str())
    );
    assert_eq!(
        rebase_row(&kit, &rebased),
        Some(("unchanged".into(), "T50".into(), approved, String::new()))
    );
}

/// The author's rebase resolved a conflict with main: its own lines differ from the approved ones only where main
/// changed them. One short review of the resolution runs, and its clean verdict lands it.
#[tokio::test(flavor = "multi_thread")]
async fn a_rebase_that_resolved_conflicts_gets_a_short_review_of_them() {
    let kit = Kit::with_reviews();
    let (change, approved, head) = kit
        .resolved(&a_with(&[(6, "pr and main line 6")]), &[])
        .await;

    kit.train.step(REPO).await;
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Reviewing);
    assert_eq!(kit.spawned(), 2);
    let spawn = kit.host.review_spawns.lock().unwrap()[1].clone();
    assert!(
        spawn.prompt.starts_with("Review the conflict resolution")
            && spawn.prompt.contains("in: `a.txt`.")
            && spawn.prompt.contains(&format!("approved at {approved}"))
            && spawn.prompt.contains(&format!("at head {head}")),
        "{}",
        spawn.prompt
    );
    let row = rebase_row(&kit, &head).unwrap();
    assert_eq!(
        (row.0.as_str(), row.2.as_str(), row.3.as_str()),
        ("conflicts", approved.as_str(), "a.txt")
    );
    assert!(merged_prs(&kit).is_empty());

    let cursor = kit.host.events_head();
    kit.verdict("T51", &head, 0);
    kit.host.next_event(cursor, "change.ready").await;
    assert!(kit.train.step(REPO).await);
    assert_eq!(state_of(&kit, &change), ChangeState::Merged);
    assert_eq!(*kit.gh.merges.lock().unwrap(), [(7, head)]);
}

/// A resolution that also brings a hunk main never touched, here a new file, is reviewed in full, as any new patch is
/// (`rebase::compare`'s tests hold the other shapes).
#[tokio::test(flavor = "multi_thread")]
async fn a_rebase_that_changed_more_than_the_conflicts_gets_a_full_review() {
    let kit = Kit::with_reviews();
    let (change, approved, head) = kit
        .resolved(
            &a_with(&[(6, "pr and main line 6")]),
            &[add("b.txt", "more\n")],
        )
        .await;
    kit.train.step(REPO).await;
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Reviewing);
    assert_eq!(kit.spawned(), 2);
    let spawn = kit.host.review_spawns.lock().unwrap()[1].clone();
    assert!(
        spawn.prompt.starts_with("Review pull request")
            && spawn
                .prompt
                .contains(&format!("git range-diff {approved}...{head}")),
        "{}",
        spawn.prompt
    );
    assert_eq!(rebase_row(&kit, &head).unwrap().0, "changed");
}

/// Blocking findings on the last reviewed head are never carried past: a rebase of that head, its own lines unchanged,
/// is reviewed in full though an earlier head was approved.
#[tokio::test(flavor = "multi_thread")]
async fn a_rebase_of_a_blocked_head_is_reviewed_in_full() {
    let kit = Kit::with_reviews();
    let change = kit
        .approved(
            7,
            "m",
            &[("a.txt", Some(&a_with(&[(6, "pr line 6")])))],
            "T50",
        )
        .await;
    let blocked = kit.commit("m", &[add("b.txt", "more\n")], None);
    kit.train.step(REPO).await;
    assert_eq!(kit.spawned(), 2);
    kit.verdict("T51", &blocked, 1);
    eventually("held for a new head", || {
        kit.get(&change.change_id)
            .last_error
            .is_some_and(|e| e.contains("waiting for a new head"))
    })
    .await;

    kit.commit(
        "main",
        &[("a.txt", Some(&a_with(&[(4, "main line 4")])))],
        None,
    );
    git(&kit.author, &["fetch", "-q", "origin"]);
    git(&kit.author, &["checkout", "-q", "-B", "m", &blocked]);
    git(&kit.author, &["rebase", "-q", "origin/main"]);
    let rebased = kit.push_author("m");
    kit.train.step(REPO).await;
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Reviewing);
    assert_eq!(kit.spawned(), 3, "a full review, no carry");
    assert_eq!(rebase_row(&kit, &rebased), None);
    kit.train.step(REPO).await;
    assert!(merged_prs(&kit).is_empty());
}

/// A carried approval is its reviewer's: when that reviewer records blocking findings on the head it approved after
/// all, the heads its approval carried to are blocked too.
#[tokio::test(flavor = "multi_thread")]
async fn a_late_blocking_verdict_blocks_the_heads_its_approval_carried_to() {
    let kit = Kit::with_reviews();
    let change = kit
        .approved(
            7,
            "m",
            &[("a.txt", Some(&a_with(&[(6, "pr line 6")])))],
            "T50",
        )
        .await;
    let approved = change.head_sha.to_string();
    kit.commit(
        "main",
        &[("a.txt", Some(&a_with(&[(4, "main line 4")])))],
        None,
    );
    git(&kit.author, &["fetch", "-q", "origin"]);
    git(&kit.author, &["checkout", "-q", "-B", "m", &approved]);
    git(&kit.author, &["rebase", "-q", "origin/main"]);
    let rebased = kit.push_author("m");
    let patch = kit
        .train
        .github()
        .patch_id(REPO, "main", &rebased)
        .await
        .unwrap();
    let mut moved = kit.get(&change.change_id);
    moved.head_sha = CommitSha::unchecked(&rebased);
    moved.patch_id = Some(PatchId::unchecked(&patch));
    let reviews = kit._reviews.clone().unwrap();
    assert!(matches!(
        reviews.review(moved.clone()).await,
        Verdict::Ready(_)
    ));
    assert_eq!(kit.spawned(), 1);

    kit.verdict("T50", &approved, 1);
    tokio::time::timeout(Duration::from_secs(20), async {
        while reviews.again(moved.clone()).await != Verdict::Blocked {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the carried approval blocked");
}

/// #884: a review's blocking finding held the PR, and the lead resolved it by narrowing the brief, with no new patch;
/// it then waited 2 h for a push. Enqueued again, the findings on its patch count no more and a fresh full review of it
/// runs: only that review's clean verdict lands it. Enqueued again with nothing blocking it, nothing starts.
#[tokio::test(flavor = "multi_thread")]
async fn a_blocked_pr_enqueued_again_gets_a_fresh_full_review_of_the_same_patch() {
    let kit = Kit::with_reviews();
    let pr = kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")]);
    let head = kit.head_of("slice-1");
    let change = kit.enqueue(pr.clone()).await;
    assert_eq!(kit.spawned(), 1);
    kit.verdict("T50", &head, 1);
    eventually("blocked", || {
        kit.get(&change.change_id)
            .last_error
            .is_some_and(|e| e.starts_with(crate::hub::reviews::service::BLOCKED))
    })
    .await;
    kit.train.step(REPO).await;
    assert_eq!(state_of(&kit, &change), ChangeState::Reviewing);
    assert_eq!(kit.spawned(), 1, "no new head, no new review");

    let again = kit.enqueue(pr.clone()).await;
    assert_eq!(again.change_id, change.change_id);
    assert_eq!(kit.spawned(), 2, "a fresh review of the same patch");
    assert_eq!(
        again.last_error.as_deref(),
        Some(super::super::service::RESOLVED)
    );
    // The fresh review is still at work: no merge, and enqueuing again starts no other.
    kit.train.step(REPO).await;
    assert_eq!(state_of(&kit, &change), ChangeState::Reviewing);
    kit.enqueue(pr).await;
    assert_eq!(kit.spawned(), 2);
    assert!(merged_prs(&kit).is_empty());

    let cursor = kit.host.events_head();
    kit.verdict("T51", &head, 0);
    kit.host.next_event(cursor, "change.ready").await;
    assert!(kit.train.step(REPO).await);
    assert_eq!(state_of(&kit, &change), ChangeState::Merged);
    assert_eq!(*kit.gh.merges.lock().unwrap(), [(7, head)]);
}

/// A fresh review that finds blocking findings again holds the PR as any review does.
#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_review_with_blocking_findings_still_holds_the_pr() {
    let kit = Kit::with_reviews();
    let pr = kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")]);
    let head = kit.head_of("slice-1");
    let change = kit.enqueue(pr.clone()).await;
    kit.verdict("T50", &head, 1);
    eventually("blocked", || {
        kit.get(&change.change_id)
            .last_error
            .is_some_and(|e| e.starts_with(crate::hub::reviews::service::BLOCKED))
    })
    .await;
    kit.enqueue(pr).await;
    assert_eq!(kit.spawned(), 2);

    kit.verdict("T51", &head, 2);
    eventually("blocked by T51", || {
        kit.get(&change.change_id)
            .last_error
            .is_some_and(|e| e.contains("T51 found 2 blocking"))
    })
    .await;
    kit.train.step(REPO).await;
    assert_eq!(state_of(&kit, &change), ChangeState::Reviewing);
    assert!(merged_prs(&kit).is_empty());
}

/// A PR its review's findings hold at one head, with no push for `BLOCKED_WAKE`: the lead hears once, with how to
/// start a fresh review if they resolved the findings without a patch.
#[tokio::test(flavor = "multi_thread")]
async fn the_lead_hears_once_when_a_blocked_pr_sits_with_nothing_moving() {
    let clock = Arc::new(Sleeps::default());
    let kit = Kit::build(FakeCi::Actions, |_| {}, true, clock.clone());
    let pr = kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")]);
    let head = kit.head_of("slice-1");
    let change = kit.enqueue(pr).await;
    kit.verdict("T50", &head, 1);
    eventually("blocked", || {
        kit.get(&change.change_id)
            .last_error
            .is_some_and(|e| e.starts_with(crate::hub::reviews::service::BLOCKED))
    })
    .await;
    let told = || {
        kit.host
            .wakes
            .lock()
            .unwrap()
            .iter()
            .filter(|w| w.contains("call `change_enqueue` for it again"))
            .count()
    };

    kit.train.step(REPO).await;
    assert_eq!(told(), 0);
    clock.sleep(super::super::service::BLOCKED_WAKE).await;
    kit.train.step(REPO).await;
    assert_eq!(told(), 1);
    kit.train.step(REPO).await;
    assert_eq!(told(), 1, "once per head");
}
