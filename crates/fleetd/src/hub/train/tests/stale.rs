//! A check GitHub still shows pending after its workflow run finished (#1362): the train re-runs that run once per head
//! and waits for the fresh result, never counting the stale check as passed. A run still going is never re-run. The
//! shapes are GitHub's own answers (`testdata/stale_checks.json`): `stale` the Desktop QA run 42538020541 at attempt 1,
//! completed green while job `qa (ubuntu-latest, 1/4)` read in_progress (conclusion success); `rerun` its checks after
//! the lead re-ran it; `pending` a CI run with its `site` job still going.
use super::*;

const STALE_RUN: u64 = 42538020541;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../testdata/stale_checks.json")).unwrap()
}

fn check_runs(shape: &str) -> Vec<Value> {
    fixture()[shape]["check_runs"].as_array().unwrap().clone()
}

/// The four QA shards and `site`, required on main, on a clock that stands still but for the train's sleeps: 2027,
/// long after the recorded runs finished. Each head shows `checks`, with the required checks it lacks green; both
/// recorded workflow runs answer. Returns the checks shown, to change.
fn kit(clock: Arc<Sleeps>, checks: Vec<Value>) -> (Kit, Shown) {
    let kit = Kit::on_clock(FakeCi::Actions, clock);
    let required: Vec<String> = check_runs("stale")
        .iter()
        .map(|r| r["name"].as_str().unwrap().to_string())
        .chain(["site".to_string()])
        .collect();
    *kit.gh.required.lock().unwrap() = Some(required.clone());
    train_file(&kit, &[], &[]);
    let mut runs = checks;
    for (i, name) in required.iter().enumerate() {
        if !runs.iter().any(|r| r["name"] == json!(name)) {
            runs.push(job(i as u64 + 1, 1, name, "success"));
        }
    }
    let shown = Arc::new(Mutex::new(runs));
    let read = shown.clone();
    answer_checks(&kit, move || read.lock().unwrap().clone());
    let mut workflow_runs = kit.gh.workflow_runs.lock().unwrap();
    for shape in ["stale", "pending"] {
        let run = fixture()[shape]["workflow_run"].clone();
        workflow_runs.insert(run["id"].as_u64().unwrap(), run);
    }
    drop(workflow_runs);
    (kit, shown)
}

type Shown = Arc<Mutex<Vec<Value>>>;

/// What the train's next read of the head shows from now on: `runs` in place of the checks of their names.
fn show(shown: &Shown, runs: Vec<Value>) {
    let mut shown = shown.lock().unwrap();
    for r in runs {
        shown.retain(|s| s["name"] != r["name"]);
        shown.push(r);
    }
}

/// #1362: a ready PR whose required QA shard GitHub left in_progress under a run that finished green is re-run once,
/// and stays out of the batch until the re-run's fresh green result shows; it is never counted green before that.
#[tokio::test(flavor = "multi_thread")]
async fn a_check_left_pending_under_a_finished_run_gets_one_re_run_of_that_run() {
    let clock = Arc::new(Sleeps::default());
    let (kit, shown) = kit(clock.clone(), check_runs("stale"));
    let change = kit
        .enqueue(kit.open_pr(7, "qa", &[add("qa.txt", "qa\n")]))
        .await;
    let waits = "its own head's `qa (ubuntu-latest, 1/4)` stayed pending after its workflow run finished; the train \
                 re-ran that run and waits for the fresh result";

    assert_eq!(
        kit.train.own_ci(REPO, &change, "main").await.as_deref(),
        Some(waits)
    );
    assert_eq!(*kit.gh.run_reruns.lock().unwrap(), [STALE_RUN]);
    assert!(
        kit.gh.reruns.lock().unwrap().is_empty(),
        "the run, not a job"
    );

    // GitHub still shows the stale check, long after: the head waits, and the run is not re-run again.
    clock.sleep(Duration::from_secs(30 * 60)).await;
    assert_eq!(
        kit.train.own_ci(REPO, &change, "main").await.as_deref(),
        Some(waits)
    );
    assert_eq!(
        *kit.gh.run_reruns.lock().unwrap(),
        [STALE_RUN],
        "once per head"
    );

    // The re-run's checks come in: still going, then green.
    let mut going = check_runs("rerun");
    going[0]["status"] = json!("in_progress");
    going[0]["conclusion"] = Value::Null;
    show(&shown, going);
    assert_eq!(
        kit.train.own_ci(REPO, &change, "main").await.as_deref(),
        Some("its own head's `qa (ubuntu-latest, 1/4)` still running")
    );
    show(&shown, check_runs("rerun"));
    assert_eq!(kit.train.own_ci(REPO, &change, "main").await, None);
    assert_eq!(*kit.gh.run_reruns.lock().unwrap(), [STALE_RUN]);
}

/// A run finished only a moment ago is left its few minutes: GitHub may still be writing its checks.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_finished_a_moment_ago_is_not_re_run_yet() {
    let clock = Arc::new(Sleeps::default());
    let (kit, _) = kit(clock.clone(), check_runs("stale"));
    let at = |since: Duration| {
        crate::hub::store::iso_ms(crate::hub::store::system_ms(clock.now() - since))
    };
    kit.gh
        .workflow_runs
        .lock()
        .unwrap()
        .get_mut(&STALE_RUN)
        .unwrap()["updated_at"] = json!(at(Duration::from_secs(60)));
    let change = kit
        .enqueue(kit.open_pr(7, "qa", &[add("qa.txt", "qa\n")]))
        .await;

    assert_eq!(
        kit.train.own_ci(REPO, &change, "main").await.as_deref(),
        Some("its own head's `qa (ubuntu-latest, 1/4)` still running")
    );
    assert!(kit.gh.run_reruns.lock().unwrap().is_empty());

    clock.sleep(Duration::from_secs(5 * 60)).await;
    assert!(kit.train.own_ci(REPO, &change, "main").await.is_some());
    assert_eq!(*kit.gh.run_reruns.lock().unwrap(), [STALE_RUN]);
}

/// A check whose workflow run is still going is CI at work: never re-run, however long it takes.
#[tokio::test(flavor = "multi_thread")]
async fn a_check_of_a_run_still_going_is_not_re_run() {
    let clock = Arc::new(Sleeps::default());
    let (kit, _) = kit(clock.clone(), check_runs("pending"));
    let change = kit
        .enqueue(kit.open_pr(7, "site", &[add("site.txt", "site\n")]))
        .await;

    for _ in 0..3 {
        assert_eq!(
            kit.train.own_ci(REPO, &change, "main").await.as_deref(),
            Some("its own head's `site` still running")
        );
        clock.sleep(Duration::from_secs(20 * 60)).await;
    }
    assert!(kit.gh.run_reruns.lock().unwrap().is_empty());
    assert!(kit.gh.reruns.lock().unwrap().is_empty());
}

/// The train's wait on a head's CI re-runs the stale run once too, and merges on the fresh green result. The PR is
/// green on its own head, behind main: the train rebases it, and the new head's QA shard is left pending.
#[tokio::test(flavor = "multi_thread")]
async fn the_ci_wait_re_runs_a_stale_run_once_and_merges_on_its_fresh_result() {
    let clock = Arc::new(Sleeps::default());
    let (kit, shown) = kit(clock, check_runs("stale"));
    let rerun = kit.gh.run_reruns.clone();
    let reads = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let counted = reads.clone();
    answer_checks(&kit, move || {
        let mut runs = shown.lock().unwrap().clone();
        // The re-run's checks come in a few reads after it.
        if !rerun.lock().unwrap().is_empty()
            && counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= 3
        {
            for r in check_runs("rerun") {
                runs.retain(|s| s["name"] != r["name"]);
                runs.push(r);
            }
        }
        runs
    });
    let pr = kit.open_pr(7, "qa", &[add("qa.txt", "qa\n")]);
    let mut green = check_runs("rerun");
    green.push(job(5, 1, "site", "success"));
    kit.gh
        .head_runs
        .lock()
        .unwrap()
        .insert(kit.head_of("qa"), json!(green));
    kit.commit("main", &[("other.txt", Some("other\n"))], None);
    let (_, change_id) = kit.author_task(Some(&pr)).await;

    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::Merged);
    assert_eq!(*kit.gh.run_reruns.lock().unwrap(), [STALE_RUN]);
    assert!(
        reads.load(std::sync::atomic::Ordering::SeqCst) > 3,
        "merged on the re-run's checks"
    );
}
