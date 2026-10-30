//! A Navi's sign-ins (D221), on a real Chrome against the local site: a Navi signs in in one session and is still
//! signed in in its next; another Navi and a regular agent start signed out; one browser at a time runs on a Navi's
//! profile; forgetting its sign-ins ends its session and deletes the profile.
use super::*;

const ADA: &str = "th-navi-ada";
const BEE: &str = "th-navi-bee";

async fn call_as(broker: &Arc<Broker>, thread: &str, call: Value) -> Value {
    let frame: BrowserCallFrame = serde_json::from_value(json!({
        "id": "t1", "cwd": "/work/navi", "threadId": thread, "call": call,
    }))
    .unwrap();
    serde_json::to_value(broker.handle(thread.to_owned(), frame).await).unwrap()
}

/// A session of `thread`'s, open on `url`: its driver and page.
async fn open_on(broker: &Arc<Broker>, thread: &str, url: &str) -> (Driver, String) {
    let started = call_as(
        broker,
        thread,
        json!({ "op": "session_start", "purpose": "Check who is signed in" }),
    )
    .await;
    let cdp = started["result"]["cdp"]
        .as_str()
        .unwrap_or_else(|| panic!("{thread} started no session: {started}"));
    navigate(cdp, url).await
}

/// The session at `cdp`, driven to `url`: its driver and page.
async fn navigate(cdp: &str, url: &str) -> (Driver, String) {
    let mut driver = Driver::connect(cdp).await.unwrap();
    let page = driver.page().await;
    driver
        .ok(Some(&page), "Page.navigate", json!({ "url": url }))
        .await;
    driver
        .wait_for(
            &page,
            "document.readyState === 'complete' && location.href.startsWith('http') && !!document.body.innerText",
        )
        .await;
    (driver, page)
}

/// What `url` says to `thread`'s browser, in a session of its own that ends after.
async fn visit(broker: &Arc<Broker>, thread: &str, url: &str) -> String {
    let (mut driver, page) = open_on(broker, thread, url).await;
    let text = driver.eval(&page, "document.body.innerText").await;
    drop(driver);
    let ended = call_as(broker, thread, json!({ "op": "session_end" })).await;
    assert!(ended["result"].is_object(), "{ended}");
    text.as_str().unwrap().trim().to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_navi_stays_signed_in_between_sessions_and_no_other_navi_or_agent_is() {
    let Some(rig) = rig().await else { return };
    let (site, _site) = site().await;
    let broker = &rig.broker;
    rig.navi(ADA, "ada");
    rig.navi(BEE, "bee");

    assert_eq!(
        visit(broker, ADA, &format!("{site}/remember?user=ada")).await,
        "Welcome ada"
    );
    let kept = super::super::chrome::kept_dir(rig.node_home.path(), "ada").unwrap();
    assert!(kept.join("Default").is_dir(), "Ada's profile is kept");
    assert_eq!(
        visit(broker, ADA, &format!("{site}/whoami")).await,
        "Signed in as ada",
        "the next session of Ada's is still signed in"
    );
    assert_eq!(
        visit(broker, BEE, &format!("{site}/whoami")).await,
        "Signed out",
        "another Navi has a profile of its own"
    );
    assert_eq!(
        visit(broker, THREAD, &format!("{site}/whoami")).await,
        "Signed out",
        "a regular agent gets a fresh profile"
    );
    // And a regular agent's profile is thrown away, as before: only the Navis' are kept.
    let navis: Vec<String> = std::fs::read_dir(kept.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(!navis.iter().any(|n| n != "ada" && n != "bee"), "{navis:?}");
    assert_eq!(
        visit(broker, ADA, &format!("{site}/whoami")).await,
        "Signed in as ada",
        "still, after the others' sessions"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_browser_at_a_time_runs_on_a_navis_profile_and_forgetting_it_signs_the_navi_out() {
    let Some(rig) = rig().await else { return };
    let (site, _site) = site().await;
    let broker = &rig.broker;
    rig.navi(ADA, "ada");
    // Another chat of the same Navi.
    let ada_too = "th-navi-ada-2";
    rig.navi(ada_too, "ada");
    assert_eq!(
        visit(broker, ADA, &format!("{site}/remember?user=ada")).await,
        "Welcome ada"
    );

    let (_driver, _page) = open_on(broker, ADA, &format!("{site}/whoami")).await;
    let second = call_as(
        broker,
        ada_too,
        json!({ "op": "session_start", "purpose": "Two at once" }),
    )
    .await;
    let message = second["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("open in another of its sessions"),
        "{second}"
    );
    assert!(
        second["error"]["fix"]
            .as_str()
            .unwrap_or_default()
            .contains("session_end"),
        "{second}"
    );

    // Forgetting its sign-ins ends the open session and deletes the profile.
    let kept = super::super::chrome::kept_dir(rig.node_home.path(), "ada").unwrap();
    assert!(kept.is_dir());
    broker.forget_signins("ada").await.unwrap();
    assert!(broker.live(ADA).is_none(), "its session ended");
    assert!(!kept.exists(), "its profile is gone");
    assert_eq!(
        visit(broker, ADA, &format!("{site}/whoami")).await,
        "Signed out"
    );
    // Its other chat may open the browser now, and a Navi with nothing kept has nothing to forget.
    assert_eq!(
        visit(broker, ada_too, &format!("{site}/whoami")).await,
        "Signed out"
    );
    broker.forget_signins("cy").await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_session_that_ended_is_no_navis_and_a_screen_ending_keeps_it_one() {
    let Some(rig) = rig().await else { return };
    let (site, _site) = site().await;
    let broker = &rig.broker;
    rig.navi(ADA, "ada");
    assert_eq!(
        visit(broker, ADA, &format!("{site}/remember?user=ada")).await,
        "Welcome ada"
    );
    // The hub ends its screen; its claude runs on, still Ada's.
    let (_driver, _page) = open_on(broker, ADA, &format!("{site}/whoami")).await;
    let id = broker.live(ADA).unwrap().id.to_string();
    SessionHooks::screen_ended(broker.as_ref(), ADA, &id);
    assert!(broker.live(ADA).is_none(), "its screen ended");
    // Its browser closes in the background, holding the profile until it is gone.
    let deadline = Instant::now() + Duration::from_secs(15);
    let cdp = loop {
        let started = call_as(
            broker,
            ADA,
            json!({ "op": "session_start", "purpose": "Again" }),
        )
        .await;
        if let Some(cdp) = started["result"]["cdp"].as_str() {
            break cdp.to_owned();
        }
        let closing = started["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("open in another of its sessions"));
        assert!(closing && Instant::now() < deadline, "{started}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let (mut driver, page) = navigate(&cdp, &format!("{site}/whoami")).await;
    assert_eq!(
        driver.eval(&page, "document.body.innerText.trim()").await,
        "Signed in as ada"
    );
    drop(driver);
    call_as(broker, ADA, json!({ "op": "session_end" })).await;
    // Its claude exits: a later agent session of that id is nobody's Navi.
    SessionHooks::ended(broker.as_ref(), ADA);
    assert_eq!(
        visit(broker, ADA, &format!("{site}/whoami")).await,
        "Signed out"
    );
}

/// A person's own browser screen for a Navi (D239): the hub seals its start to the Navi's machine naming the Navi, and
/// the node runs it on the profile the Navi keeps. What the person signs in to there, the Navi is signed in to next.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_persons_screen_for_a_navi_runs_on_its_kept_profile() {
    let Some(rig) = rig().await else { return };
    let (site, _site) = site().await;
    let broker = &rig.broker;
    let folder = rig.navi(ADA, "ada");
    let box_key = crate::node::identity::load_or_create_box_key(rig.node_home.path()).unwrap();
    let hosted = crate::node::session_route::Hosted::default();
    let key = "H0123456789abcdef0123456789abcdef";
    let seal = json!({ "secrets": [], "relayKey": B64.encode([7u8; 32]) });
    let sealed = B64.encode(box_key.seal(seal.to_string().as_bytes()).unwrap());
    // The Navi comes in the hub's own frame, never in a seal.
    let host_as = |key: &'static str, call: Value, sealed: Option<&str>, navi: Option<&str>| {
        let frame: fleetd_contracts::node_link::HubToNode = serde_json::from_value(json!({
            "t": "session_host", "id": "h1", "hostKey": key, "sealed": sealed, "navi": navi,
            "frame": { "id": "f1", "cwd": "/", "call": call },
        }))
        .unwrap();
        let folder = folder.clone();
        crate::node::session_route::host(
            Some(broker.clone()),
            None,
            "http://hub.invalid",
            frame,
            &hosted,
            Some(&box_key),
            move |navi| (navi == "ada").then(|| folder.clone()),
        )
    };
    let host =
        |call: Value, sealed: Option<&str>, navi: Option<&str>| host_as(key, call, sealed, navi);
    let started = host(
        json!({ "op": "session_start", "purpose": "Browser opened by Ada" }),
        Some(&sealed),
        Some("ada"),
    )
    .await
    .unwrap();
    let cdp = started
        .frame
        .result
        .as_ref()
        .map(|r| serde_json::to_value(r).unwrap());
    let cdp = cdp
        .as_ref()
        .and_then(|r| r["cdp"].as_str())
        .unwrap_or_else(|| panic!("no screen started: {:?}", started.frame))
        .to_owned();
    assert!(broker.is_navi(key), "the screen is the Navi's");
    let (mut driver, page) = navigate(&cdp, &format!("{site}/remember?user=ada")).await;
    assert_eq!(
        driver
            .eval(&page, "document.body.innerText")
            .await
            .as_str()
            .unwrap()
            .trim(),
        "Welcome ada"
    );
    drop(driver);
    let ended = host(json!({ "op": "session_end" }), None, None)
        .await
        .unwrap();
    assert!(ended.frame.result.is_some(), "{:?}", ended.frame);
    assert!(!broker.is_navi(key), "the key is no Navi's once it ended");
    assert_eq!(
        visit(broker, ADA, &format!("{site}/whoami")).await,
        "Signed in as ada",
        "the Navi's own next session is signed in"
    );

    // A Navi this machine doesn't have opens nothing.
    let refused = host(
        json!({ "op": "session_start", "purpose": "Browser opened by Bee" }),
        Some(&sealed),
        Some("bee"),
    )
    .await
    .unwrap();
    assert!(refused.frame.error.is_some(), "{:?}", refused.frame);

    // A seal that names the Navi, as any node could make one, opens a fresh profile: only the hub's frame names one.
    let forged = json!({ "secrets": [], "relayKey": B64.encode([7u8; 32]), "navi": "ada" });
    let forged = B64.encode(box_key.seal(forged.to_string().as_bytes()).unwrap());
    let other = "H00000000000000000000000000000abc";
    let started = host_as(
        other,
        json!({ "op": "session_start", "purpose": "An agent's screen" }),
        Some(&forged),
        None,
    )
    .await
    .unwrap();
    assert!(started.frame.result.is_some(), "{:?}", started.frame);
    assert!(
        !broker.is_navi(other),
        "a seal never makes a screen a Navi's"
    );
    let cdp = serde_json::to_value(started.frame.result.as_ref().unwrap()).unwrap()["cdp"]
        .as_str()
        .unwrap()
        .to_owned();
    let (mut driver, page) = navigate(&cdp, &format!("{site}/whoami")).await;
    assert_eq!(
        driver
            .eval(&page, "document.body.innerText")
            .await
            .as_str()
            .unwrap()
            .trim(),
        "Signed out"
    );
    drop(driver);
    host_as(other, json!({ "op": "session_end" }), None, None)
        .await
        .unwrap();
}
