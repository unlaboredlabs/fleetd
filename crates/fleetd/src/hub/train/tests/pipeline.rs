//! Overlapping the queue: while a batch is in CI, the PRs that become ready go in a batch built on top of it, in CI at
//! the same time; both pass and land as one squash, on exactly the tree CI tested. A batch ahead that fails sends those
//! behind it back in line, and one behind that runs late doesn't hold the green batch ahead. A lone PR already tested on
//! the current base merges with no rebase, no label and no second CI run.
use super::*;

/// The scratch branch of the batch behind the one in front.
const BEHIND: &str = "fleetd/train/1/train/batch";

/// Four PRs: 7 and 8 ready, 9 and 10 in review until 7 and 8 are in CI, then ready.
async fn four(kit: &Kit) -> [Change; 4] {
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[add("a1.txt", "a\n")]))
        .await;
    let b = kit
        .enqueue(kit.open_pr(8, "b", &[add("b1.txt", "b\n")]))
        .await;
    let c = kit
        .enqueue_held(kit.open_pr(9, "c", &[add("c1.txt", "c\n")]))
        .await;
    let d = kit
        .enqueue_held(kit.open_pr(10, "d", &[add("d1.txt", "d\n")]))
        .await;
    let (train, ahead, later) = (
        Arc::downgrade(&kit.train),
        [a.change_id.clone(), b.change_id.clone()],
        [c.change_id.clone(), d.change_id.clone()],
    );
    *kit.gh.on_checks.lock().unwrap() = Some(Box::new(move || {
        let Some(train) = train.upgrade() else { return };
        let in_ci = |id: &ChangeId| train.get(id).is_some_and(|c| c.state == ChangeState::Ci);
        if !ahead.iter().all(in_ci) {
            return;
        }
        for id in &later {
            if let Some(c) = train.get(id).filter(|c| c.state == ChangeState::Reviewing) {
                let _ = train.mark_ready(id, vec![clean_review(&c)]);
            }
        }
    }));
    [a, b, c, d]
}

/// Puts `runs` on the batch behind once it exists, every read of its head after that.
fn behind_reads(kit: &Kit, runs: Value) {
    let gh = Arc::downgrade(&kit.gh);
    let earlier = kit.gh.on_checks.lock().unwrap().take();
    *kit.gh.on_checks.lock().unwrap() = Some(Box::new(move || {
        if let Some(earlier) = &earlier {
            earlier();
        }
        let Some(gh) = gh.upgrade() else { return };
        if let Some(head) = gh.head_of(BEHIND) {
            gh.head_runs.lock().unwrap().insert(head, runs.clone());
        }
    }));
}

fn branch_of(kit: &Kit, pr: i64) -> String {
    kit.gh.pulls.lock().unwrap()[&pr].branch.clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_batch_built_on_the_one_in_ci_lands_both_as_one_squash_on_the_tree_it_tested() {
    let kit = Kit::on_clock(FakeCi::Queued { polls: 3 }, Arc::new(Sleeps::default()));
    let changes = four(&kit).await;

    assert!(kit.train.step(REPO).await);

    let merges = kit.gh.merges.lock().unwrap().clone();
    assert_eq!(merges.len(), 1, "one squash for both batches: {merges:?}");
    let (pr, head) = merges[0].clone();
    assert_eq!(branch_of(&kit, pr), BEHIND);
    // What landed is the tree CI passed on the batch behind: main's tree is its head's.
    let tree = |rev: &str| git(&kit.gh.origin, &["rev-parse", &format!("{rev}^{{tree}}")]);
    assert_eq!(tree("main"), tree(&head));
    let body = kit.gh.pulls.lock().unwrap()[&pr].body.clone();
    let numbers: Vec<i64> = batch_heads(&body).into_iter().map(|(n, _)| n).collect();
    assert_eq!(numbers, [7, 8, 9, 10]);
    for (change, file) in changes.iter().zip(["a1.txt", "b1.txt", "c1.txt", "d1.txt"]) {
        assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
        assert!(kit.main_file(file).is_some(), "{file}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_batch_ahead_that_fails_drops_the_one_behind_which_forms_again_on_main() {
    let kit = Kit::on_clock(FakeCi::Queued { polls: 3 }, Arc::new(Sleeps::default()));
    let [a, b, c, d] = four(&kit).await;
    // Once the batch behind exists, the batch ahead goes red.
    let gh = Arc::downgrade(&kit.gh);
    let earlier = kit.gh.on_checks.lock().unwrap().take();
    *kit.gh.on_checks.lock().unwrap() = Some(Box::new(move || {
        if let Some(earlier) = &earlier {
            earlier();
        }
        let Some(gh) = gh.upgrade() else { return };
        if gh.head_of(BEHIND).is_some()
            && let Some(ahead) = gh.head_of("fleetd/train/batch")
        {
            gh.head_runs.lock().unwrap().insert(
                ahead,
                json!([{ "id": 1, "name": "ci", "status": "completed", "conclusion": "failure" }]),
            );
        }
    }));

    assert!(kit.train.step(REPO).await);

    // The batch behind never merged; the batch ahead's PRs went alone, each on its own CI.
    let merged: Vec<String> = merged_prs(&kit)
        .iter()
        .map(|n| branch_of(&kit, *n))
        .collect();
    assert!(!merged.iter().any(|b| b == BEHIND), "{merged:?}");
    for change in [&a, &b] {
        assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
    }
    for change in [&c, &d] {
        let back = kit.get(&change.change_id);
        assert_eq!(back.state, ChangeState::Ready);
        let why = back.last_error.unwrap_or_default();
        assert!(why.contains("ahead of it didn't pass: its CI red"), "{why}");
    }

    // The next pass builds them on main, and they land.
    *kit.gh.on_checks.lock().unwrap() = None;
    kit.gh.head_runs.lock().unwrap().clear();
    assert!(kit.train.step(REPO).await);
    for change in [&c, &d] {
        assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
    }
}

/// The batch behind still in CI when the one ahead passed gets as long as the one ahead's CI took, then the one ahead
/// lands alone and the PRs behind it go back in line for a batch on main.
#[tokio::test(flavor = "multi_thread")]
async fn a_batch_behind_still_in_ci_never_holds_the_green_batch_ahead() {
    let clock = Arc::new(Sleeps::default());
    let kit = Kit::on_clock(FakeCi::Queued { polls: 3 }, clock.clone());
    let [a, b, c, d] = four(&kit).await;
    behind_reads(
        &kit,
        json!([{ "id": 1, "name": "ci", "status": "in_progress", "conclusion": null, "started_at": AFTER }]),
    );

    assert!(kit.train.step(REPO).await);

    let merges = kit.gh.merges.lock().unwrap().clone();
    assert_eq!(merges.len(), 1, "{merges:?}");
    assert_eq!(branch_of(&kit, merges[0].0), "fleetd/train/batch");
    for change in [&a, &b] {
        assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
    }
    for change in [&c, &d] {
        let back = kit.get(&change.change_id);
        assert_eq!(back.state, ChangeState::Ready);
        let why = back.last_error.unwrap_or_default();
        assert!(
            why.contains("was still in CI") && why.contains("which landed without it"),
            "{why}"
        );
    }
    // It waited about as long as the batch ahead's CI took, far short of the CI timeout.
    let waited: Duration = clock.taken().iter().sum();
    assert!(waited < Duration::from_secs(10 * 60), "{waited:?}");

    *kit.gh.on_checks.lock().unwrap() = None;
    kit.gh.head_runs.lock().unwrap().clear();
    assert!(kit.train.step(REPO).await);
    for change in [&c, &d] {
        assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_set_wait_bounds_how_long_the_batch_ahead_waits() {
    let clock = Arc::new(Sleeps::default());
    let kit = Kit::build(
        FakeCi::Queued { polls: 3 },
        |o| o.follower_wait = Some(Duration::from_secs(90)),
        false,
        clock.clone(),
    );
    let [_, _, c, _] = four(&kit).await;
    behind_reads(
        &kit,
        json!([{ "id": 1, "name": "ci", "status": "in_progress", "conclusion": null, "started_at": AFTER }]),
    );

    assert!(kit.train.step(REPO).await);

    let why = kit.get(&c.change_id).last_error.unwrap_or_default();
    assert!(why.contains("still in CI 90 s after"), "{why}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pipeline_depth_of_one_never_builds_a_batch_behind() {
    let kit = Kit::build(
        FakeCi::Queued { polls: 3 },
        |o| o.pipeline_depth = 1,
        false,
        Arc::new(Sleeps::default()),
    );
    four(&kit).await;

    assert!(kit.train.step(REPO).await);

    assert!(kit.gh.head_of(BEHIND).is_none());
    assert_eq!(merged_prs(&kit).len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lone_pr_already_green_on_the_current_main_merges_with_no_rebase_label_or_second_run() {
    let kit = Kit::new();
    let change = kit
        .enqueue(kit.open_pr(7, "a", &[add("a1.txt", "a\n")]))
        .await;
    let head = kit.head_of("a");

    assert!(kit.train.step(REPO).await);

    assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
    assert_eq!(*kit.gh.merges.lock().unwrap(), [(7, head)]);
    let log = gh_log(&kit);
    assert!(
        !log.iter().any(|l| l == "rebase #7" || l == "label #7"),
        "{log:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lone_pr_behind_main_is_still_rebased_and_tested_again() {
    let kit = Kit::new();
    let change = kit
        .enqueue(kit.open_pr(7, "a", &[add("a1.txt", "a\n")]))
        .await;
    kit.commit("main", &[add("other.txt", "other\n")], None);
    let head = kit.head_of("a");

    assert!(kit.train.step(REPO).await);

    assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
    assert!(gh_log(&kit).iter().any(|l| l == "rebase #7"));
    assert_ne!(kit.gh.merges.lock().unwrap()[0].1, head);
}

/// Both batches pass, but a PR of the one behind was pushed to during its CI: the one behind can't land, and the green
/// batch ahead lands instead of being thrown out with it.
#[tokio::test(flavor = "multi_thread")]
async fn a_batch_behind_that_cant_land_gives_way_to_the_green_batch_ahead() {
    let kit = Kit::on_clock(FakeCi::Queued { polls: 3 }, Arc::new(Sleeps::default()));
    let [a, b, c, d] = four(&kit).await;
    let gh = Arc::downgrade(&kit.gh);
    let pushed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let earlier = kit.gh.on_checks.lock().unwrap().take();
    *kit.gh.on_checks.lock().unwrap() = Some(Box::new(move || {
        if let Some(earlier) = &earlier {
            earlier();
        }
        let Some(gh) = gh.upgrade() else { return };
        if gh.head_of(BEHIND).is_some() && !pushed.swap(true, std::sync::atomic::Ordering::SeqCst) {
            gh.push_empty("c");
        }
    }));

    assert!(kit.train.step(REPO).await);

    let merges = kit.gh.merges.lock().unwrap().clone();
    assert_eq!(merges.len(), 1, "{merges:?}");
    assert_eq!(branch_of(&kit, merges[0].0), "fleetd/train/batch");
    for change in [&a, &b] {
        assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
    }
    for change in [&c, &d] {
        let back = kit.get(&change.change_id);
        assert_eq!(back.state, ChangeState::Ready);
        let why = back.last_error.unwrap_or_default();
        assert!(
            why.contains("couldn't land") && why.contains("landed without it"),
            "{why}"
        );
    }
}

/// The batch ahead passes and the one behind fails: the one ahead lands, then each PR of the one behind goes alone.
#[tokio::test(flavor = "multi_thread")]
async fn a_red_batch_behind_lets_the_one_ahead_land_and_its_own_prs_go_alone() {
    let kit = Kit::on_clock(FakeCi::Queued { polls: 3 }, Arc::new(Sleeps::default()));
    let changes = four(&kit).await;
    behind_reads(
        &kit,
        json!([{ "id": 1, "name": "ci", "status": "completed", "conclusion": "failure" }]),
    );

    assert!(kit.train.step(REPO).await);

    let merged: Vec<(String, i64)> = kit
        .gh
        .merges
        .lock()
        .unwrap()
        .iter()
        .map(|(n, _)| (branch_of(&kit, *n), *n))
        .collect();
    assert_eq!(merged[0].0, "fleetd/train/batch", "{merged:?}");
    assert_eq!(
        &merged[1..].iter().map(|(_, n)| *n).collect::<Vec<_>>(),
        &[9, 10]
    );
    for change in &changes {
        assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
    }
}

/// PR 7 ready alone; PR 8 in review until 7 is in CI, then ready. 7's CI runs until a batch is stacked on it.
async fn lone_then_one(kit: &Kit) -> [Change; 2] {
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[add("a1.txt", "a\n")]))
        .await;
    let b = kit
        .enqueue_held(kit.open_pr(8, "b", &[add("b1.txt", "b\n")]))
        .await;
    let (train, gh, ahead, later) = (
        Arc::downgrade(&kit.train),
        Arc::downgrade(&kit.gh),
        a.change_id.clone(),
        b.change_id.clone(),
    );
    *kit.gh.on_checks.lock().unwrap() = Some(Box::new(move || {
        let (Some(train), Some(gh)) = (train.upgrade(), gh.upgrade()) else {
            return;
        };
        let Some(lone) = train.get(&ahead).filter(|c| c.state == ChangeState::Ci) else {
            return;
        };
        let mut runs = gh.head_runs.lock().unwrap();
        if gh.head_of(BEHIND).is_none() {
            runs.insert(
                lone.head_sha.to_string(),
                json!([check("ci", "in_progress", None, Some(AFTER))]),
            );
        } else {
            runs.remove(lone.head_sha.as_str());
        }
        drop(runs);
        if let Some(c) = train
            .get(&later)
            .filter(|c| c.state == ChangeState::Reviewing)
        {
            let _ = train.mark_ready(&later, vec![clean_review(&c)]);
        }
    }));
    [a, b]
}

/// The lane isn't held by a PR merging alone: the PR that becomes ready during its CI goes in a batch stacked on its
/// rebased head, in CI on the combined tree, and both land as one squash once both passed, on exactly that tree.
#[tokio::test(flavor = "multi_thread")]
async fn a_ready_pr_stacks_on_a_pr_merging_alone_and_lands_with_it() {
    let kit = Kit::on_clock(FakeCi::Queued { polls: 3 }, Arc::new(Sleeps::default()));
    let changes = lone_then_one(&kit).await;
    // Behind main: 7 is rebased, and its CI runs on the new head.
    kit.commit("main", &[add("other.txt", "other\n")], None);

    assert!(kit.train.step(REPO).await);

    assert!(gh_log(&kit).iter().any(|l| l == "rebase #7"));
    let merges = kit.gh.merges.lock().unwrap().clone();
    assert_eq!(merges.len(), 1, "one squash for both: {merges:?}");
    let (pr, head) = merges[0].clone();
    assert_eq!(branch_of(&kit, pr), BEHIND);
    let tree = |rev: &str| git(&kit.gh.origin, &["rev-parse", &format!("{rev}^{{tree}}")]);
    assert_eq!(tree("main"), tree(&head));
    let body = kit.gh.pulls.lock().unwrap()[&pr].body.clone();
    let heads = batch_heads(&body);
    assert_eq!(heads.iter().map(|(n, _)| *n).collect::<Vec<_>>(), [7, 8]);
    // Built on 7's rebased head, the one its own CI passed on.
    assert_eq!(heads[0].1.as_deref(), Some(kit.head_of("a").as_str()));
    for (change, file) in changes.iter().zip(["a1.txt", "b1.txt"]) {
        assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
        assert!(kit.main_file(file).is_some(), "{file}");
    }
}

/// The PR alone fails its CI: the batch stacked on it never lands, and its PR goes back in line, to go on main.
#[tokio::test(flavor = "multi_thread")]
async fn a_pr_stacked_on_a_lone_pr_that_fails_starts_again_on_main() {
    let kit = Kit::on_clock(FakeCi::Queued { polls: 3 }, Arc::new(Sleeps::default()));
    let [a, b] = lone_then_one(&kit).await;
    let gh = Arc::downgrade(&kit.gh);
    let earlier = kit.gh.on_checks.lock().unwrap().take();
    *kit.gh.on_checks.lock().unwrap() = Some(Box::new(move || {
        if let Some(earlier) = &earlier {
            earlier();
        }
        let Some(gh) = gh.upgrade() else { return };
        if gh.head_of(BEHIND).is_some()
            && let Some(lone) = gh.head_of("a")
        {
            gh.head_runs.lock().unwrap().insert(
                lone,
                json!([check("ci", "completed", Some("failure"), None)]),
            );
        }
    }));

    assert!(kit.train.step(REPO).await);

    assert!(kit.gh.head_of(BEHIND).is_some(), "8 was stacked on 7");
    assert!(merged_prs(&kit).is_empty());
    assert_eq!(kit.get(&a.change_id).state, ChangeState::CiFailed);
    let back = kit.get(&b.change_id);
    assert_eq!(back.state, ChangeState::Ready);
    let why = back.last_error.unwrap_or_default();
    assert!(
        why.contains("#7 ahead of it didn't pass: its CI red; it forms again on main"),
        "{why}"
    );

    *kit.gh.on_checks.lock().unwrap() = None;
    kit.gh.head_runs.lock().unwrap().clear();
    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&b.change_id).state, ChangeState::Merged);
    assert_eq!(merged_prs(&kit), [8]);
}

/// The batch stacked on a lone PR goes red: the lone PR merges by itself, as it would with nothing behind it, and the
/// stacked PR goes alone after it.
#[tokio::test(flavor = "multi_thread")]
async fn a_red_batch_stacked_on_a_lone_pr_lets_it_merge_alone() {
    let kit = Kit::on_clock(FakeCi::Queued { polls: 3 }, Arc::new(Sleeps::default()));
    let [a, b] = lone_then_one(&kit).await;
    behind_reads(
        &kit,
        json!([{ "id": 1, "name": "ci", "status": "completed", "conclusion": "failure" }]),
    );

    assert!(kit.train.step(REPO).await);

    assert_eq!(merged_prs(&kit), [7, 8]);
    for change in [&a, &b] {
        assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
    }
}
