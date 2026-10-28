//! What a Navi's browser may touch on this machine (local.rs), on a real Chrome: no `file:` page, asked for directly,
//! through a redirect, a link or the driver's own interception; only agent-browser's commands, run by the real
//! agent-browser too; a fence the driver can't take down, and a session that ends should it go; uploads only of files
//! in its folder, not through a link out of it; downloads only into its folder. A regular agent's session opens files
//! as before.
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

const ADA: &str = "th-navi-ada";
const AGENT: &str = "th-agent";
/// What another Navi's kept profile holds: its cookies.
const BEE_COOKIES: &str = "bee-cookie-secret-31";

/// A site for the checks: a redirect and a link to `file`, a file input, a download.
async fn site(file: &Path) -> (String, AbortOnDrop) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let file = format!("file://{}", file.display());
    let serving = tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let file = file.clone();
            tokio::spawn(async move {
                let mut request = [0u8; 4096];
                let n = tcp.read(&mut request).await.unwrap_or(0);
                let line = String::from_utf8_lossy(&request[..n]).into_owned();
                let path = line.split(' ').nth(1).unwrap_or("/").to_owned();
                let (head, body) = match path.as_str() {
                    "/redirect" => (format!("302 Found\r\nlocation: {file}"), String::new()),
                    "/link" => (
                        "200 OK\r\ncontent-type: text/html".to_owned(),
                        format!("<html><body><a id=a href=\"{file}\">cookies</a></body></html>"),
                    ),
                    "/upload" => (
                        "200 OK\r\ncontent-type: text/html".to_owned(),
                        "<html><body><input type=file id=f><a id=d href=\"/download\">report</a></body></html>"
                            .to_owned(),
                    ),
                    "/drop" => (
                        "200 OK\r\ncontent-type: text/html".to_owned(),
                        "<html><body style=\"margin:0\"><div id=z style=\"width:100vw;height:100vh\"></div><script>\
                         z.addEventListener('dragover', e => e.preventDefault());\
                         z.addEventListener('drop', async e => { e.preventDefault(); const f = e.dataTransfer.files[0];\
                         window.dropped = f.name + ': ' + await f.text(); });</script></body></html>"
                            .to_owned(),
                    ),
                    "/download" => (
                        "200 OK\r\ncontent-type: application/octet-stream\r\ncontent-disposition: attachment; \
                         filename=\"report.txt\""
                            .to_owned(),
                        "the report".to_owned(),
                    ),
                    _ => (
                        "200 OK\r\ncontent-type: text/html".to_owned(),
                        "<html><body>A page</body></html>".to_owned(),
                    ),
                };
                let response = format!(
                    "HTTP/1.1 {head}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = tcp.write_all(response.as_bytes()).await;
            });
        }
    });
    (base, AbortOnDrop(serving))
}

/// Another Navi's kept cookies, as the node keeps them.
fn bee_cookies(rig: &Rig) -> PathBuf {
    let dir = super::super::chrome::kept_dir(rig.node_home.path(), "bee")
        .unwrap()
        .join("Default");
    std::fs::create_dir_all(&dir).unwrap();
    let cookies = dir.join("Cookies");
    std::fs::write(&cookies, BEE_COOKIES).unwrap();
    cookies
}

/// A session of `thread`'s: its driver and page.
async fn start(rig: &Rig, thread: &str) -> (Driver, String) {
    let frame: BrowserCallFrame = serde_json::from_value(json!({
        "id": "t1", "cwd": "/work/navi", "threadId": thread,
        "call": { "op": "session_start", "purpose": "Look around" },
    }))
    .unwrap();
    let started = serde_json::to_value(rig.broker.handle(thread.to_owned(), frame).await).unwrap();
    let cdp = started["result"]["cdp"]
        .as_str()
        .unwrap_or_else(|| panic!("{thread} started no session: {started}"));
    let mut driver = Driver::connect(cdp).await.unwrap();
    let page = driver.page().await;
    (driver, page)
}

/// What the page shows once it settled: its address and text.
async fn shown(driver: &mut Driver, page: &str) -> (String, String) {
    tokio::time::sleep(Duration::from_millis(500)).await;
    driver
        .wait_for(page, "document.readyState === 'complete'")
        .await;
    let at = driver.eval(page, "location.href").await;
    let text = driver
        .eval(page, "document.body ? document.body.innerText : ''")
        .await;
    (
        at.as_str().unwrap_or_default().to_owned(),
        text.as_str().unwrap_or_default().to_owned(),
    )
}

fn refusal(answer: &Value) -> String {
    answer["error"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("not refused: {answer}"))
        .to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_navis_browser_opens_no_file_however_it_is_asked_and_an_agents_still_does() {
    let Some(rig) = rig().await else { return };
    let cookies = bee_cookies(&rig);
    let file = format!("file://{}", cookies.display());
    let (site, _site) = site(&cookies).await;
    rig.navi(ADA, "ada");
    let (mut driver, page) = start(&rig, ADA).await;

    // Asked for directly: refused before it goes, saying why.
    for url in [file.clone(), format!("view-source:{file}")] {
        let answer = driver
            .send(Some(&page), "Page.navigate", json!({ "url": url }))
            .await;
        assert!(
            refusal(&answer).contains("opens no files on this machine"),
            "{answer}"
        );
    }
    let answer = driver
        .send(None, "Target.createTarget", json!({ "url": file }))
        .await;
    assert!(refusal(&answer).contains("opens no files"), "{answer}");

    // A redirect to it, and a link to it.
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{site}/redirect") }),
        )
        .await;
    let (at, text) = shown(&mut driver, &page).await;
    assert!(
        !at.starts_with("file:") && !text.contains(BEE_COOKIES),
        "{at}: {text}"
    );
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{site}/link") }),
        )
        .await;
    driver
        .wait_for(&page, "!!document.getElementById('a')")
        .await;
    driver
        .eval(&page, "document.getElementById('a').click()")
        .await;
    let (at, text) = shown(&mut driver, &page).await;
    assert!(
        !at.starts_with("file:") && !text.contains(BEE_COOKIES),
        "{at}: {text}"
    );

    // The driver's own interception turns a web request into the file: the node's fence still refuses it.
    driver
        .ok(
            Some(&page),
            "Fetch.enable",
            json!({ "patterns": [{ "urlPattern": "*/rewritten*" }] }),
        )
        .await;
    driver.next += 1;
    let navigate = driver.next;
    let message = json!({
        "id": navigate, "sessionId": page, "method": "Page.navigate",
        "params": { "url": format!("{site}/rewritten") },
    });
    driver
        .ws
        .send(Message::Text(message.to_string().into()))
        .await
        .unwrap();
    let mut rewrote = false;
    let answer = loop {
        let next = tokio::time::timeout(Duration::from_secs(20), driver.ws.next())
            .await
            .expect("the navigation's answer in 20 s");
        let Some(Ok(Message::Text(text))) = next else {
            panic!("the proxy closed");
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["id"] == navigate {
            break value;
        }
        if value["method"] == "Fetch.requestPaused" {
            rewrote = true;
            driver.next += 1;
            let rewrite = json!({
                "id": driver.next, "sessionId": page, "method": "Fetch.continueRequest",
                "params": { "requestId": value["params"]["requestId"], "url": file },
            });
            driver
                .ws
                .send(Message::Text(rewrite.to_string().into()))
                .await
                .unwrap();
        }
    };
    assert!(rewrote, "the driver's interception saw the request");
    assert_eq!(
        answer["result"]["errorText"], "net::ERR_ACCESS_DENIED",
        "{answer}"
    );
    driver.ok(Some(&page), "Fetch.disable", json!({})).await;
    let (_, text) = shown(&mut driver, &page).await;
    assert!(!text.contains(BEE_COOKIES), "{text}");
    drop(driver);

    // A regular agent's session opens files as before: it runs unsandboxed, so they are no more than it can read.
    let (mut driver, page) = start(&rig, AGENT).await;
    driver
        .ok(Some(&page), "Page.navigate", json!({ "url": file }))
        .await;
    let (_, text) = shown(&mut driver, &page).await;
    assert!(text.contains(BEE_COOKIES), "{text}");
    // What every session refuses: a way to the browser around the proxy's checks.
    let target = driver
        .ok(Some(&page), "Target.getTargetInfo", json!({}))
        .await["targetInfo"]["targetId"]
        .clone();
    let answer = driver
        .send(
            None,
            "Target.exposeDevToolsProtocol",
            json!({ "targetId": target, "bindingName": "cdp" }),
        )
        .await;
    assert!(
        refusal(&answer).contains("around fleetd's checks"),
        "{answer}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_navi_uploads_only_files_in_its_folder_and_downloads_only_into_it() {
    let Some(rig) = rig().await else { return };
    let cookies = bee_cookies(&rig);
    let (site, _site) = site(&cookies).await;
    let folder = rig.navi(ADA, "ada");
    std::fs::write(folder.join("report.txt"), "ada's report").unwrap();
    std::os::unix::fs::symlink(&cookies, folder.join("notes.txt")).unwrap();
    let (mut driver, page) = start(&rig, ADA).await;

    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{site}/upload") }),
        )
        .await;
    driver
        .wait_for(&page, "!!document.getElementById('f')")
        .await;
    let input = driver
        .ok(
            Some(&page),
            "Runtime.evaluate",
            json!({ "expression": "document.getElementById('f')" }),
        )
        .await["result"]["objectId"]
        .clone();
    let upload = |files: Vec<String>| json!({ "files": files, "objectId": input });
    let folder_named = folder.canonicalize().unwrap().display().to_string();
    for path in [
        cookies.display().to_string(),
        folder.join("notes.txt").display().to_string(),
        format!("{}/../bee/x", folder.display()),
    ] {
        let answer = driver
            .send(
                Some(&page),
                "DOM.setFileInputFiles",
                upload(vec![path.clone()]),
            )
            .await;
        let why = refusal(&answer);
        assert!(
            why.contains("outside your folder") && why.contains(&folder_named)
                || why.contains("can't be uploaded"),
            "{path}: {why}"
        );
    }
    // In its folder: Chrome gets a copy only the node can see, under the name the Navi gave it.
    for path in [
        folder.join("report.txt").display().to_string(),
        "report.txt".to_owned(),
    ] {
        driver
            .ok(Some(&page), "DOM.setFileInputFiles", upload(vec![path]))
            .await;
        let read = driver
            .ok(
                Some(&page),
                "Runtime.evaluate",
                json!({
                    "expression": "(async () => { const f = document.getElementById('f').files[0]; \
                                   return f.name + ': ' + await f.text(); })()",
                    "awaitPromise": true, "returnByValue": true,
                }),
            )
            .await;
        assert_eq!(read["result"]["value"], "report.txt: ada's report");
    }
    let staging = super::super::local::uploads_dir(rig.node_home.path());
    assert!(staging.is_dir(), "the copies are the node's");
    assert!(!staging.starts_with(&folder));

    // Downloads go to the folder by default, and only there, each under a name of Chrome's: none overwrites a file.
    let answer = driver
        .send(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{site}/download") }),
        )
        .await;
    assert_eq!(answer["result"]["isDownload"], true, "{answer}");
    let downloaded = || {
        std::fs::read_dir(&folder).unwrap().any(|e| {
            std::fs::read_to_string(e.unwrap().path()).ok().as_deref() == Some("the report")
        })
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !downloaded() {
        assert!(
            Instant::now() < deadline,
            "no download in the folder: {:?}",
            std::fs::read_dir(&folder)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect::<Vec<_>>()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        std::fs::read_to_string(folder.join("report.txt")).unwrap(),
        "ada's report"
    );
    std::fs::create_dir(folder.join("inbox")).unwrap();
    for (behavior, path) in [
        ("allow", folder.display().to_string()),
        ("allow", rig.node_home.path().display().to_string()),
        ("allowAndName", folder.join("inbox").display().to_string()),
        ("allowAndName", "/tmp".to_owned()),
        ("default", String::new()),
    ] {
        let answer = driver
            .send(
                None,
                "Browser.setDownloadBehavior",
                json!({ "behavior": behavior, "downloadPath": path }),
            )
            .await;
        let why = refusal(&answer);
        assert!(why.contains(&folder_named), "{behavior} {path}: {why}");
    }
    for (behavior, path) in [
        ("allowAndName", folder.display().to_string()),
        ("deny", String::new()),
    ] {
        driver
            .ok(
                None,
                "Browser.setDownloadBehavior",
                json!({ "behavior": behavior, "downloadPath": path }),
            )
            .await;
    }
    drop(driver);
    let ended = serde_json::to_value(
        rig.broker
            .handle(
                ADA.to_owned(),
                serde_json::from_value(json!({
                    "id": "t2", "cwd": "/work/navi", "threadId": ADA, "call": { "op": "session_end" },
                }))
                .unwrap(),
            )
            .await,
    )
    .unwrap();
    assert!(ended["result"].is_object(), "{ended}");
    assert_eq!(
        std::fs::read_dir(&staging).map(|d| d.count()).unwrap_or(0),
        0,
        "the copies go with the session"
    );
}

/// Files dropped on a page at (20, 20): the drag's events, as a driver sends them. The first refusal, if any.
async fn drop_files(driver: &mut Driver, page: &str, files: Vec<String>) -> Option<Value> {
    for kind in ["dragEnter", "dragOver", "drop"] {
        let answer = driver
            .send(
                Some(page),
                "Input.dispatchDragEvent",
                json!({
                    "type": kind, "x": 20, "y": 20,
                    "data": { "items": [], "files": files, "dragOperationsMask": 1 },
                }),
            )
            .await;
        if answer.get("error").is_some() {
            return Some(answer);
        }
    }
    None
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_navi_takes_only_agent_browsers_commands_its_fence_stays_up_and_its_session_ends_if_it_goes()
 {
    let Some(rig) = rig().await else { return };
    let cookies = bee_cookies(&rig);
    let file = format!("file://{}", cookies.display());
    let (site, _site) = site(&cookies).await;
    let folder = rig.navi(ADA, "ada");
    std::fs::write(folder.join("report.txt"), "ada's report").unwrap();
    let (mut driver, page) = start(&rig, ADA).await;

    // Only agent-browser's commands: a drag carrying files, a command wrapped in another, the protocol handed to the
    // page's script and a page snapshot are all refused, as are sessions it couldn't drive.
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{site}/drop") }),
        )
        .await;
    driver
        .wait_for(&page, "!!document.getElementById('z')")
        .await;
    let answer = drop_files(
        &mut driver,
        &page,
        vec![folder.join("report.txt").display().to_string()],
    )
    .await
    .expect("a drag is no command of agent-browser's");
    let not_listed = "takes only the commands agent-browser";
    assert!(refusal(&answer).contains(not_listed), "{answer}");
    let target = driver
        .ok(Some(&page), "Target.getTargetInfo", json!({}))
        .await["targetInfo"]["targetId"]
        .clone();
    let wrapped = json!({
        "id": 1, "method": "DOM.setFileInputFiles",
        "params": { "files": [cookies.display().to_string()], "backendNodeId": 1 },
    });
    for (method, params) in [
        (
            "Target.sendMessageToTarget",
            json!({ "sessionId": page, "message": wrapped.to_string() }),
        ),
        (
            "Target.exposeDevToolsProtocol",
            json!({ "targetId": target, "bindingName": "cdp" }),
        ),
        (
            "DOMSnapshot.captureSnapshot",
            json!({ "computedStyles": [] }),
        ),
    ] {
        let answer = driver.send(None, method, params).await;
        assert!(refusal(&answer).contains(not_listed), "{method}: {answer}");
    }
    for (method, params) in [
        (
            "Target.attachToTarget",
            json!({ "targetId": target, "flatten": false }),
        ),
        (
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": false }),
        ),
    ] {
        let answer = driver.send(None, method, params).await;
        assert!(
            refusal(&answer).contains("flatten: true"),
            "{method}: {answer}"
        );
    }
    assert_eq!(
        driver
            .eval(&page, "typeof window.cdp + ' ' + typeof window.dropped")
            .await,
        "undefined undefined"
    );

    // The driver can't detach the node's session on the browser target.
    let browser =
        driver.ok(None, "Target.getTargetInfo", json!({})).await["targetInfo"]["targetId"].clone();
    let answer = driver
        .send(
            None,
            "Target.detachFromTarget",
            json!({ "targetId": browser }),
        )
        .await;
    assert!(refusal(&answer).contains("by its sessionId"), "{answer}");
    let answer = driver
        .send(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{site}/a") }),
        )
        .await;
    assert!(
        answer.get("error").is_none(),
        "the session goes on: {answer}"
    );

    // Should that session go anyway, nothing more goes through and the browser session ends.
    let id = rig.broker.live(ADA).unwrap().id.clone();
    rig.broker.live(ADA).unwrap().cdp.post(
        None,
        "Target.detachFromTarget",
        json!({ "targetId": browser }),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while rig.broker.live(ADA).is_some_and(|s| s.id == id) {
        assert!(Instant::now() < deadline, "the session didn't end");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let answer = driver
        .send(Some(&page), "Page.navigate", json!({ "url": file }))
        .await;
    assert!(answer.get("error").is_some(), "{answer}");
}

/// The real agent-browser, driving a Navi's session from the Navi's folder: everything it does there gets through,
/// uploading a file of the folder and downloading into it among them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_browser_drives_a_navis_session_uploads_from_its_folder_and_downloads_into_it() {
    let Some(binary) = agent_browser() else {
        return;
    };
    let Some(rig) = rig().await else { return };
    let cookies = bee_cookies(&rig);
    let (site, _site) = site(&cookies).await;
    let folder = rig.navi(ADA, "ada");
    std::fs::write(folder.join("report.txt"), "ada's report").unwrap();
    let (driver, _page) = start(&rig, ADA).await;
    drop(driver);
    let env = SessionHooks::env(rig.broker.as_ref(), ADA, Some("/usr/bin:/bin"));
    let socket_dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let (binary, env, folder) = (binary.clone(), env.clone(), folder.clone());
        let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        let socket_dir = socket_dir.path().to_owned();
        async move {
            let out = tokio::process::Command::new(&binary)
                .args(&args)
                .envs(env)
                .env("AGENT_BROWSER_SOCKET_DIR", socket_dir)
                .current_dir(folder)
                .output()
                .await
                .unwrap();
            format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            )
        }
    };
    let opened = run(&["open", &format!("{site}/upload")]).await;
    assert!(opened.contains('✓'), "{opened}");
    let snapshot = run(&["snapshot", "-i"]).await;
    assert!(snapshot.contains("link"), "{snapshot}");
    let uploaded = run(&["upload", "#f", "report.txt"]).await;
    assert!(uploaded.contains('✓'), "{uploaded}");
    let named = run(&["eval", "document.getElementById('f').files[0].name"]).await;
    assert!(named.contains("report.txt"), "{named}");
    let refused = run(&["upload", "#f", &cookies.display().to_string()]).await;
    assert!(refused.contains("outside your folder"), "{refused}");
    let downloaded = run(&["download", "#d", "./got.txt"]).await;
    assert!(downloaded.contains('✓'), "{downloaded}");
    assert_eq!(
        std::fs::read_to_string(folder.join("got.txt")).unwrap(),
        "the report"
    );
    let shot = run(&["screenshot", "shot.png"]).await;
    assert!(shot.contains('✓'), "{shot}");
    let title = run(&["get", "url"]).await;
    assert!(title.contains("/upload"), "{title}");
    run(&["close"]).await;
}

/// The list a Navi's driver is held to is agent-browser's: each method on it is one its binary names.
#[test]
fn each_method_a_navi_may_send_is_one_agent_browser_names() {
    let Some(binary) = agent_browser() else {
        return;
    };
    // The npm wrapper's target: the binary for this platform.
    let binary = std::fs::canonicalize(binary).unwrap();
    let bytes = std::fs::read(&binary).unwrap();
    let text = String::from_utf8_lossy(&bytes);
    for method in super::super::local::AGENT_BROWSER_METHODS {
        assert!(
            text.contains(method),
            "{method} isn't in {}",
            binary.display()
        );
    }
}
