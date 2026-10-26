//! agent-browser's own script shapes: its commands, run through a relay in front of the session's proxy that keeps every
//! script it evaluates. With FLEETD_WRITE_SHAPES set, `scripts/agent-browser-shapes.sh` writes them to
//! `agent_browser_shapes.json`; without, every one must already be there.
use std::collections::BTreeMap;
use std::sync::Mutex;

use super::super::shapes::{self, Kind, Pinned};
use super::*;

/// A page with one of each thing agent-browser's commands act on, and a second to go back and forth to.
async fn playground() -> (String, AbortOnDrop) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let serving = tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut chunk = [0u8; 4096];
                let Ok(n) = tcp.read(&mut chunk).await else {
                    return;
                };
                let head = String::from_utf8_lossy(&chunk[..n]).into_owned();
                let page = if head.starts_with("GET /next") {
                    "<html><head><title>Next</title></head><body><p id=n>Next page</p></body></html>"
                } else {
                    "<html><head><title>Playground</title></head><body style='height:3000px'>\
                     <h1 id=h>Playground</h1><a id=link href=/next>Next</a>\
                     <label for=name>Name</label><input id=name placeholder=Name data-testid=name>\
                     <input id=agree type=checkbox><label><input id=news type=checkbox>News</label>\
                     <select id=pick><option value=a>Apple</option><option value=b>Banana</option></select>\
                     <button id=b title=Go aria-label=Go>Go</button><img alt=Logo src=data:,>\
                     <textarea id=t></textarea><p id=far style='margin-top:2000px'>Far</p></body></html>"
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}",
                    page.len()
                );
                let _ = tcp.write_all(response.as_bytes()).await;
            });
        }
    });
    (base, AbortOnDrop(serving))
}

type Seen = Arc<Mutex<Vec<(Kind, String)>>>;

/// A CDP relay to `upstream` that keeps every script its client sends.
async fn relay(upstream: String) -> (String, Seen, AbortOnDrop) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "ws://127.0.0.1:{}/devtools/browser/relay",
        listener.local_addr().unwrap().port()
    );
    let seen: Seen = Arc::default();
    let kept = seen.clone();
    let serving = tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let (upstream, kept) = (upstream.clone(), kept.clone());
            tokio::spawn(async move {
                let Ok(client) = tokio_tungstenite::accept_async(tcp).await else {
                    return;
                };
                let (browser, _) = tokio_tungstenite::connect_async(&upstream).await.unwrap();
                let (mut to_client, mut from_client) = client.split();
                let (mut to_browser, mut from_browser) = browser.split();
                let back = tokio::spawn(async move {
                    while let Some(Ok(message)) = from_browser.next().await {
                        if to_client.send(message).await.is_err() {
                            break;
                        }
                    }
                });
                while let Some(Ok(message)) = from_client.next().await {
                    if let Message::Text(text) = &message {
                        let command: Value = serde_json::from_str(text).unwrap_or_default();
                        let script = match command["method"].as_str() {
                            Some("Runtime.evaluate" | "Runtime.compileScript") => {
                                Some((Kind::Script, &command["params"]["expression"]))
                            }
                            Some("Runtime.callFunctionOn") => {
                                Some((Kind::Function, &command["params"]["functionDeclaration"]))
                            }
                            _ => None,
                        };
                        if let Some((kind, Value::String(script))) = script {
                            kept.lock().unwrap().push((kind, script.clone()));
                        }
                    }
                    if to_browser.send(message).await.is_err() {
                        break;
                    }
                }
                back.abort();
            });
        }
    });
    (url, seen, AbortOnDrop(serving))
}

/// agent-browser's commands, each the way an agent runs it, but `eval`, `get value` and `wait --fn`: their scripts
/// are the agent's own, and a sealed session's policy denies the first two anyway.
fn commands(site: &str) -> Vec<Vec<String>> {
    let next = format!("{site}/next");
    [
        &["open", site][..],
        &["snapshot"],
        &["snapshot", "-i"],
        &["snapshot", "-i", "-c"],
        &["click", "#b"],
        &["click", "@e1"],
        &["dblclick", "#h"],
        &["hover", "#b"],
        &["focus", "#name"],
        &["fill", "#name", "Ada"],
        &["type", "#t", "hello"],
        &["press", "Tab"],
        &["press", "Control+a"],
        &["keyboard", "type", "x"],
        &["keyboard", "inserttext", "y"],
        &["check", "#agree"],
        &["uncheck", "#agree"],
        &["check", "#news"],
        &["select", "#pick", "b"],
        &["select", "#pick", "Apple"],
        &["scroll", "down", "300"],
        &["scroll", "up"],
        &["scroll", "right", "10"],
        &["scrollintoview", "#far"],
        &["wait", "#h"],
        &["wait", "50"],
        &["wait", "--text", "Playground"],
        &["wait", "--load", "load"],
        &["get", "text", "#h"],
        &["get", "text", "body"],
        &["get", "html", "#h"],
        &["get", "attr", "#link", "href"],
        &["get", "title"],
        &["get", "url"],
        &["get", "count", "input"],
        &["get", "box", "#b"],
        &["get", "styles", "#b"],
        &["is", "visible", "#b"],
        &["is", "enabled", "#b"],
        &["is", "checked", "#agree"],
        &["find", "role", "button", "click", "--name", "Go"],
        &["find", "text", "Playground", "hover"],
        &["find", "label", "Name", "fill", "Grace"],
        &["find", "placeholder", "Name", "fill", "Ada"],
        &["find", "alt", "Logo", "hover"],
        &["find", "title", "Go", "hover"],
        &["find", "testid", "name", "fill", "Lin"],
        &["find", "first", "input", "check"],
        &["find", "nth", "1", "input", "hover"],
        &["find", "role", "heading", "text"],
        &["mouse", "move", "10", "10"],
        &["mouse", "wheel", "100"],
        &["highlight", "#h"],
        &["screenshot"],
        &["set", "viewport", "1024", "768"],
        &["scrollintoview", "#link"],
        &["click", "#link"],
        &["wait", "--url", "**/next"],
        &["back"],
        &["forward"],
        &["reload"],
        &["open", &next],
        &["tab", "list"],
        &["console"],
        &["errors"],
        &["diff", "snapshot"],
    ]
    .iter()
    .map(|args| args.iter().map(|a| (*a).to_owned()).collect())
    .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_browsers_scripts_are_all_pinned_shapes() {
    let Some(binary) = agent_browser() else {
        return;
    };
    let Some(rig) = rig().await else { return };
    let (site, _site) = playground().await;
    call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "agent-browser's scripts" }),
    )
    .await;
    let env = SessionHooks::env(rig.broker.as_ref(), THREAD, Some("/usr/bin:/bin"));
    let proxy = env
        .iter()
        .find(|(k, _)| k == "AGENT_BROWSER_CDP")
        .map(|(_, v)| v.clone())
        .unwrap();
    let (url, seen, _relay) = relay(proxy).await;
    let socket_dir = tempfile::tempdir().unwrap();
    let screenshots = tempfile::tempdir().unwrap();
    for args in commands(&site) {
        let out = tokio::process::Command::new(&binary)
            .args(&args)
            .envs(env.clone())
            .env("AGENT_BROWSER_CDP", &url)
            .env("AGENT_BROWSER_SOCKET_DIR", socket_dir.path())
            .current_dir(screenshots.path())
            .output()
            .await
            .unwrap();
        if !out.status.success() {
            eprintln!(
                "{args:?}: {}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }
    let _ = tokio::process::Command::new(&binary)
        .arg("close")
        .envs(env.clone())
        .env("AGENT_BROWSER_CDP", &url)
        .env("AGENT_BROWSER_SOCKET_DIR", socket_dir.path())
        .output()
        .await;
    call(&rig.broker, json!({ "op": "session_end" })).await;

    // By hash: each shape once, in a stable order. One that writes where a sealed session never lets a script write
    // is left out, as a sealed session would refuse it anyway.
    let mut found = BTreeMap::new();
    for (kind, script) in seen.lock().unwrap().iter() {
        let shape = shapes::shape(script, *kind).unwrap_or_else(|e| panic!("{e}: {script}"));
        match shapes::writes(script, *kind).unwrap() {
            Some(why) => eprintln!("left out, {why}: {script}"),
            None => {
                found.insert(shape.hash, shape.script);
            }
        }
    }
    assert!(found.len() > 10, "{found:?}");
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/node/browser/agent_browser_shapes.json");
    if std::env::var_os("FLEETD_WRITE_SHAPES").is_some() {
        let shapes: Vec<Value> = found
            .into_iter()
            .map(|(hash, script)| json!({ "hash": hash, "script": script }))
            .collect();
        let pinned =
            json!({ "agentBrowser": super::super::agent_browser::VERSION, "shapes": shapes });
        std::fs::write(&path, serde_json::to_string_pretty(&pinned).unwrap() + "\n").unwrap();
        return;
    }
    let pinned: Pinned = serde_json::from_str(shapes::PINNED).unwrap();
    for (hash, script) in found {
        assert!(
            pinned.shapes.iter().any(|p| p.hash == hash),
            "not pinned (run scripts/agent-browser-shapes.sh): {script}"
        );
    }
    // And a sealed session runs each of them as agent-browser sent it, its literals included.
    for (kind, script) in seen.lock().unwrap().iter() {
        assert_eq!(shapes::refusal(script, *kind), None, "{script}");
    }
}
