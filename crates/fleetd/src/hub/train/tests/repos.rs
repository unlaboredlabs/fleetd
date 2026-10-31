//! A project with several repos (W79): each repo's train is its own lane, a PR from a repo outside the project is
//! refused, and `after` merges PRs in order across repos, holding a downstream PR while its upstream one fails.
use super::*;
use crate::hub::train::next::WAITING_ON;

const API: &str = "acme/api";

/// The `api` repo's files are in a checkout of their own.
fn api_checkout() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("lab-a"),
        project_id: ProjectId::unchecked("p2"),
    }
}

/// A kit whose project holds the storefront (its own directory) and `api`.
fn two_repos() -> Kit {
    let kit = Kit::new();
    *kit.host.repos.lock().unwrap() = vec![(REPO.into(), project()), (API.into(), api_checkout())];
    kit
}

fn after(mut call: ChangeEnqueueCall, upstream: &str) -> ChangeEnqueueCall {
    call.after = Some(fleetd_contracts::prim::UniqueList::unchecked(vec![
        GitHubPrUrl::unchecked(upstream),
    ]));
    call
}

#[tokio::test(flavor = "multi_thread")]
async fn two_repos_merge_on_separate_lanes() {
    let kit = two_repos();
    let web = kit.open_pr(7, "fleetd/T1-web", &[add("web.txt", "web\n")]);
    let api = kit.open_pr_in(API, 8, "fleetd/T2-api", &[add("api.txt", "api\n")]);
    let web = kit.enqueue(web).await;
    let api = kit.enqueue(api).await;
    assert_eq!((web.repo.as_str(), api.repo.as_str()), (REPO, API));
    // Each first in its own line.
    assert_eq!(kit.get(&web.change_id).position.map(|p| p.get()), Some(0));
    assert_eq!(kit.get(&api.change_id).position.map(|p| p.get()), Some(0));
    let mut lanes: Vec<String> = kit.train.repos().into_iter().map(|(r, _)| r).collect();
    lanes.sort();
    assert_eq!(lanes, [API, REPO]);

    assert!(kit.train.step(API).await);
    assert_eq!(merged_prs(&kit), [8]);
    assert_eq!(state_of(&kit, &web), ChangeState::Ready);

    assert!(kit.train.step(REPO).await);
    assert_eq!(merged_prs(&kit), [8, 7]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pr_from_a_repo_outside_the_project_is_refused() {
    let kit = two_repos();
    let other = kit.open_pr_in("acme/other", 9, "fleetd/T3-other", &[add("o.txt", "o\n")]);
    let refused = kit
        .train
        .enqueue(&project(), enqueue_call(other))
        .await
        .unwrap_err();
    assert!(
        refused
            .message
            .contains("acme/other is not one of this project's repos (acme/storefront, acme/api)"),
        "{}",
        refused.message
    );
    assert!(kit.train.repos().is_empty());
    // Its own repos still go.
    let api = kit.open_pr_in(API, 8, "fleetd/T2-api", &[add("api.txt", "api\n")]);
    kit.enqueue(api).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn after_holds_the_downstream_pr_until_the_upstream_merges_then_it_goes() {
    let kit = two_repos();
    let api_url = kit.open_pr_in(API, 8, "fleetd/T2-api", &[add("api.txt", "api\n")]);
    let web_url = kit.open_pr(7, "fleetd/T1-web", &[add("web.txt", "web\n")]);
    let api = kit.enqueue_held(api_url.clone()).await;
    let web = kit
        .train
        .enqueue(&project(), after(enqueue_call(web_url.clone()), &api_url))
        .await
        .unwrap();
    assert_eq!(web.after, [GitHubPrUrl::unchecked(api_url.clone())]);
    // The other way round could never merge.
    let refused = kit
        .train
        .enqueue(&project(), after(enqueue_call(api_url.clone()), &web_url))
        .await
        .unwrap_err();
    assert!(
        refused.message.contains("already waits on it"),
        "{}",
        refused.message
    );

    // Ready, but its upstream is still in review.
    assert!(!kit.train.step(REPO).await);
    let held = kit.get(&web.change_id);
    assert_eq!(held.state, ChangeState::Ready);
    assert_eq!(
        held.last_error.as_deref(),
        Some(format!("{WAITING_ON}acme/api#8: it hasn't merged yet").as_str())
    );
    assert!(merged_prs(&kit).is_empty());

    let api = kit.get(&api.change_id);
    kit.train
        .mark_ready(&api.change_id, vec![clean_review(&api)])
        .unwrap();
    assert!(kit.train.step(API).await);
    assert_eq!(merged_prs(&kit), [8]);
    assert!(kit.train.step(REPO).await);
    assert_eq!(merged_prs(&kit), [8, 7]);
    assert!(
        kit.host
            .wakes
            .lock()
            .unwrap()
            .iter()
            .all(|w| !w.contains("held,"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_upstream_failure_keeps_the_downstream_held_and_tells_the_lead_once() {
    let kit = two_repos();
    let api_url = kit.open_pr_in(API, 8, "fleetd/T2-api", &[add("FAIL", "red\n")]);
    let web_url = kit.open_pr(7, "fleetd/T1-web", &[add("web.txt", "web\n")]);
    let api = kit.enqueue(api_url.clone()).await;
    let web = kit
        .train
        .enqueue(&project(), after(enqueue_call(web_url), &api_url))
        .await
        .unwrap();

    kit.train.step(API).await;
    assert_eq!(state_of(&kit, &api), ChangeState::CiFailed);
    kit.train.step(REPO).await;
    kit.train.step(REPO).await;
    let held = kit.get(&web.change_id);
    assert_eq!(held.state, ChangeState::Ready);
    assert_eq!(
        held.last_error.as_deref(),
        Some(format!("{WAITING_ON}acme/api#8: its CI failed").as_str())
    );
    assert!(merged_prs(&kit).is_empty());
    let told: Vec<String> = kit
        .host
        .wakes
        .lock()
        .unwrap()
        .iter()
        .filter(|w| w.contains("held, waiting on acme/api#8: its CI failed"))
        .cloned()
        .collect();
    assert_eq!(told.len(), 1, "{told:?}");
    assert!(told[0].starts_with("- PR #7 (X2): "), "{}", told[0]);
}

/// A one-repo project is held to nothing: its lead may enqueue another repo's PR, such as a fork's upstream, as before.
#[tokio::test(flavor = "multi_thread")]
async fn a_one_repo_project_still_takes_a_pr_from_another_repo() {
    let kit = Kit::new();
    *kit.host.repos.lock().unwrap() = vec![(REPO.into(), project())];
    let upstream = kit.open_pr_in(
        "upstream/storefront",
        9,
        "fleetd/T3-up",
        &[add("u.txt", "u\n")],
    );
    let change = kit.enqueue(upstream).await;
    assert_eq!(change.repo.as_str(), "upstream/storefront");
}

/// `after` can't stop a PR the train is already merging: adding it then is refused, with the `hold` label as the fix.
#[tokio::test(flavor = "multi_thread")]
async fn after_is_refused_for_a_pr_already_being_merged() {
    let kit = two_repos();
    let api_url = kit.open_pr_in(API, 8, "fleetd/T2-api", &[add("api.txt", "api\n")]);
    let web_url = kit.open_pr(7, "fleetd/T1-web", &[add("web.txt", "web\n")]);
    let web = kit.enqueue(web_url.clone()).await;
    let mut in_ci = kit.get(&web.change_id);
    in_ci.state = ChangeState::Ci;
    kit.train.records().put(&in_ci);
    let refused = kit
        .train
        .enqueue(&project(), after(enqueue_call(web_url), &api_url))
        .await
        .unwrap_err();
    assert!(
        refused.message.contains("already being merged"),
        "{}",
        refused.message
    );
    assert!(refused.fix.as_deref().is_some_and(|f| f.contains("`hold`")));
    assert!(kit.get(&web.change_id).after.is_empty());
}

/// Two enqueues at once, each after the other: one goes, the other is refused, so neither waits forever.
#[tokio::test(flavor = "multi_thread")]
async fn two_enqueues_at_once_after_each_other_cannot_both_go() {
    let kit = two_repos();
    let api_url = kit.open_pr_in(API, 8, "fleetd/T2-api", &[add("api.txt", "api\n")]);
    let web_url = kit.open_pr(7, "fleetd/T1-web", &[add("web.txt", "web\n")]);
    let r = project();
    let (a, b) = tokio::join!(
        kit.train
            .enqueue(&r, after(enqueue_call(web_url.clone()), &api_url)),
        kit.train
            .enqueue(&r, after(enqueue_call(api_url.clone()), &web_url)),
    );
    assert!(a.is_ok() != b.is_ok(), "{a:?} {b:?}");
    let refused = a.err().or(b.err()).unwrap();
    assert!(
        refused.message.contains("already waits on it"),
        "{}",
        refused.message
    );
}
