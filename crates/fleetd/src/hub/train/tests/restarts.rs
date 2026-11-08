//! The train's waits on a Change are kept in the hub database: a hub restart (an update) never starts one over, so
//! each still ends at the moment it would have without the restart.
use super::*;
use crate::hub::train::records::{WAIT_BLOCKED, WAIT_UNSTARTED};
use crate::hub::train::service::{BLOCKED_WAKE, CHECKS_START_WAIT};

const MINUTE: Duration = Duration::from_secs(60);

fn wakes_saying(kit: &Kit, text: &str) -> usize {
    kit.host
        .wakes
        .lock()
        .unwrap()
        .iter()
        .filter(|w| w.contains(text))
        .count()
}

fn since(train: &Train, change: &Change, kind: &str) -> i64 {
    train
        .records
        .wait(&change.change_id, kind)
        .expect("a wait")
        .since_ms
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wait_for_checks_to_start_keeps_its_start_across_a_restart() {
    let clock = Arc::new(Sleeps::default());
    // main requires `build`; the PR's head has only `lint`.
    let kit = Kit::on_clock(FakeCi::Required, clock.clone());
    let change = kit
        .enqueue_held(kit.open_pr(7, "silent", &[add("q.txt", "q\n")]))
        .await;
    kit.gh.head_runs.lock().unwrap().insert(
        kit.head_of("silent"),
        json!([check("lint", "completed", Some("success"), None)]),
    );
    let flagged = |kit: &Kit| wakes_saying(kit, "no check started on its head");

    kit.train.step(REPO).await;
    let began = since(&kit.train, &change, WAIT_UNSTARTED);
    clock.sleep(CHECKS_START_WAIT - MINUTE).await;
    let train = kit.restarted_on(clock.clone());
    train.step(REPO).await;
    assert_eq!(flagged(&kit), 0, "not before the wait");
    assert_eq!(since(&train, &change, WAIT_UNSTARTED), began);

    clock.sleep(MINUTE).await;
    train.step(REPO).await;
    assert_eq!(flagged(&kit), 1, "when the wait began before the restart");

    let train = kit.restarted_on(clock.clone());
    clock.sleep(CHECKS_START_WAIT).await;
    train.step(REPO).await;
    assert_eq!(flagged(&kit), 1, "once per head, across restarts too");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_blocked_wait_keeps_its_start_across_a_restart() {
    let clock = Arc::new(Sleeps::default());
    let kit = Kit::on_clock(FakeCi::Actions, clock.clone());
    let change = kit
        .enqueue_held(kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")]))
        .await;
    kit.gate.blocked.lock().unwrap().insert(7);
    let told = |kit: &Kit| wakes_saying(kit, "call `change_enqueue` for it again");

    kit.train.step(REPO).await;
    let began = since(&kit.train, &change, WAIT_BLOCKED);
    clock.sleep(BLOCKED_WAKE - MINUTE).await;
    let train = kit.restarted_on(clock.clone());
    train.step(REPO).await;
    assert_eq!(told(&kit), 0, "not before the wait");
    assert_eq!(since(&train, &change, WAIT_BLOCKED), began);

    clock.sleep(MINUTE).await;
    train.step(REPO).await;
    assert_eq!(told(&kit), 1, "when the wait began before the restart");

    let train = kit.restarted_on(clock.clone());
    clock.sleep(BLOCKED_WAKE).await;
    train.step(REPO).await;
    assert_eq!(told(&kit), 1, "once per head, across restarts too");
}
