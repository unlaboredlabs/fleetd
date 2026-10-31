//! A Navi's purchase end to end (D265), on a real Chrome with the hub in process and a fake 1Password: a fake checkout
//! (the shop on one origin, its payment provider's card frame on another, as Stripe Elements are) and a bank's
//! confirmation after it. The purchase asks the person; approved, the node fills the card into the provider's frame
//! (cross-origin, so in another process) and the shop's page, once, and only on the approved shop. The card's details
//! never reach the Navi: its tool results, its raw CDP reads and the recording are checked for every form of them.
use zeroize::Zeroizing;

use super::super::onepassword::{
    Card, CardFuture, CredError, CredFuture, TOKEN_ENV, Vault, VaultFor,
};
use super::*;

const TOKEN: &str = "ops_fake-service-account-token-0123456789";
const CARD: &str = "op://Personal/Visa";
const NUMBER: &str = "4242424242424242";
const CVC: &str = "737";
const HOLDER: &str = "Ada Devbox";
/// A secure input the person types, and one from a Passport item.
const TYPED: &str = "C01X00T47";
const PASSPORT: &str = "P5551234X";
const PASSPORT_REF: &str = "op://Personal/Passport/number";

/// A fake 1Password holding one Credit Card item, Visa in Personal, for the session's token.
struct FakeCards;

impl Vault for FakeCards {
    fn resolve(&self, reference: &str) -> CredFuture {
        let reference = reference.to_owned();
        Box::pin(async move {
            Err(CredError {
                message: format!("no login {reference}"),
                rate_limited: false,
            })
        })
    }

    fn identity(&self, reference: &str) -> CredFuture {
        let known = reference == PASSPORT_REF;
        Box::pin(async move {
            if !known {
                return Err(CredError {
                    message: "no such item".into(),
                    rate_limited: false,
                });
            }
            Ok(super::super::onepassword::Credential {
                value: Zeroizing::new(PASSPORT.into()),
                urls: Vec::new(),
            })
        })
    }

    fn card(&self, reference: &str) -> CardFuture {
        let known = reference == CARD;
        Box::pin(async move {
            if !known {
                return Err(CredError {
                    message: "no such item".into(),
                    rate_limited: false,
                });
            }
            Ok(Card {
                number: Zeroizing::new(NUMBER.into()),
                month: Zeroizing::new("03".into()),
                year: Zeroizing::new("2030".into()),
                cvc: Zeroizing::new(CVC.into()),
                name: Zeroizing::new(HOLDER.into()),
            })
        })
    }
}

fn vaults() -> VaultFor {
    Arc::new(|token| {
        assert_eq!(token.as_str(), TOKEN, "the session's token");
        Arc::new(FakeCards) as Arc<dyn Vault>
    })
}

/// The checkout: the shop's page at 127.0.0.1 (/checkout) with its name-on-card field and the provider's card frame
/// from localhost (/card), a different site, so Chrome runs it in a process of its own. Pay asks the frame to charge
/// (POST /charge, kept), which answers with a bank's confirmation (3-D Secure) the shop shows in a frame.
async fn checkout() -> (String, Arc<std::sync::Mutex<Vec<String>>>, AbortOnDrop) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let charges: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let kept = charges.clone();
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
                let (kind, page) = if head.starts_with("POST /charge") {
                    kept.lock().unwrap().push(body);
                    ("application/json", r#"{"challenge":true}"#.to_owned())
                } else if head.starts_with("GET /card") {
                    (
                        "text/html",
                                                    "<html><body>\
                         <input id=number name=cardnumber autocomplete=cc-number placeholder='1234 1234 1234 1234'>\
                         <input id=exp name=exp-date autocomplete=cc-exp placeholder='MM / YY'>\
                         <input id=cvc name=cvc autocomplete=cc-csc placeholder=CVC>\
                         <script>\
                         parent.postMessage({ ready: true }, '*');\
                         addEventListener('message', async (e) => { if (!e.data || e.data.pay === undefined) return;\
                           const masked = ['number', 'exp', 'cvc'].every((id) =>\
                             getComputedStyle(document.getElementById(id)).filter.includes('blur'));\
                           const body = JSON.stringify({ number: number.value, exp: exp.value, cvc: cvc.value,\
                             holder: e.data.pay, masked });\
                           const r = await fetch('/charge', { method: 'POST', body });\
                           parent.postMessage(await r.json(), '*'); });\
                         </script></body></html>"
                        .to_owned(),
                    )
                } else if head.starts_with("POST /typed") {
                    kept.lock().unwrap().push(body);
                    ("application/json", "{}".to_owned())
                } else if head.starts_with("GET /passport") {
                    // A field in the site's own frame, which says what it holds once typed in, and whether it shows.
                    (
                        "text/html",
                        "<html><body><label>Passport number <input id=passport name=passport></label><script>\
                         parent.postMessage({ ready: true }, '*');\
                         passport.addEventListener('input', () => fetch('/typed', { method: 'POST', body: \
                           JSON.stringify({ value: passport.value, \
                             masked: getComputedStyle(passport).filter.includes('blur') }) }));\
                         </script></body></html>"
                            .to_owned(),
                    )
                } else if head.starts_with("GET /form") {
                    // The visa form: a decoy frame on another site with a field of the same id first, then the site's own.
                    (
                        "text/html",
                        format!(
                            "<html><head><title>Visa form</title></head><body><h1>Visa application</h1>\
                             <iframe id=decoy src='http://localhost:{port}/passport'></iframe>\
                             <iframe id=own src='/passport'></iframe><script>let ready = 0;\
                             addEventListener('message', (e) => {{ if (e.data && e.data.ready && ++ready === 2) \
                               document.title = 'Form ready'; }});</script></body></html>"
                        ),
                    )
                } else if head.starts_with("GET /3ds") {
                    (
                        "text/html",
                        "<html><head><title>Bank</title></head><body><h1>Order 42 confirmed</h1><p>Confirm the payment in your bank app</p><button>Continue shopping</button></body></html>"
                            .to_owned(),
                    )
                } else {
                    (
                        "text/html",
                        format!(
                            "<html><head><title>Checkout</title></head><body><h1>Hotel Devbox</h1><p>Total 129.90 EUR</p>\
                         <label>Name on card <input id=holder name=holder autocomplete=cc-name></label>\
                         <iframe id=card src='http://localhost:{port}/card' style='width:420px;height:120px'></iframe>\
                         <button id=pay style='display:block;width:200px;height:40px'>Pay 129.90 EUR</button>\
                         <script>\
                         document.getElementById('pay').onclick = () => document.getElementById('card').contentWindow\
                           .postMessage({{ pay: document.getElementById('holder').value }}, '*');\
                         addEventListener('message', (e) => {{\
                           if (e.data && e.data.ready) document.title = 'Checkout ready';\
                           if (e.data && e.data.challenge) {{ const f = document.createElement('iframe');\
                             f.src = 'http://localhost:{port}/3ds'; document.body.append(f);\
                             document.title = 'Confirm in your bank app'; }} }});\
                         </script></body></html>"
                        ),
                    )
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}",
                    page.len()
                );
                let _ = tcp.write_all(response.as_bytes()).await;
            });
        }
    });
    (
        format!("http://127.0.0.1:{port}"),
        charges,
        AbortOnDrop(serving),
    )
}

fn purchase(domain: &str, item: &str) -> Value {
    json!({
        "op": "purchase_request",
        "shop": { "domain": domain, "name": "Hotel Devbox" },
        "total": { "amount": "129.90", "currency": "EUR" },
        "items": [{ "name": item, "quantity": 1, "amount": "129.90" }],
    })
}

/// Clicks the element `selector` matches as agent-browser does: its box, then a press and a release at its centre.
async fn click(driver: &mut Driver, page: &str, selector: &str) {
    let doc = driver
        .ok(Some(page), "DOM.getDocument", json!({ "depth": 0 }))
        .await;
    let node = driver
        .ok(
            Some(page),
            "DOM.querySelector",
            json!({ "nodeId": doc["root"]["nodeId"], "selector": selector }),
        )
        .await["nodeId"]
        .clone();
    let model = driver
        .ok_settled(Some(page), "DOM.getBoxModel", json!({ "nodeId": node }))
        .await;
    let quad = model["model"]["content"].as_array().unwrap();
    let at = |i: usize| quad[i].as_f64().unwrap();
    let (x, y) = ((at(0) + at(4)) / 2.0, (at(1) + at(5)) / 2.0);
    for kind in ["mousePressed", "mouseReleased"] {
        driver
            .ok(
                Some(page),
                "Input.dispatchMouseEvent",
                json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 }),
            )
            .await;
    }
}

/// Every form the card's number and expiry could show in: as typed, grouped, encoded.
fn card_forms() -> Vec<String> {
    let grouped = "4242 4242 4242 4242";
    vec![
        NUMBER.to_owned(),
        grouped.to_owned(),
        grouped.replace(' ', "%20"),
        grouped.replace(' ', "+"),
        B64.encode(NUMBER),
        NUMBER.chars().rev().collect(),
        "03/30".to_owned(),
        "03%2F30".to_owned(),
        "03/2030".to_owned(),
        // The code is too short to mask everywhere: it must never be a value of its own, a JSON string or an attribute.
        format!("\"{CVC}\""),
        format!("value=\\\"{CVC}"),
        format!("value='{CVC}"),
    ]
}

fn assert_clean(what: &str, text: &str) {
    for form in card_forms() {
        assert!(!text.contains(&form), "{what} holds {form:?}: {text}");
    }
}

/// Each file under `dir`, read as text.
fn texts(dir: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_owned()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(bytes) = std::fs::read(&path) {
                out.push((path, String::from_utf8_lossy(&bytes).into_owned()));
            }
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_approved_purchase_fills_the_card_into_the_providers_frame_once_and_the_navi_never_sees_it()
 {
    let Some(rig) = rig_with(vec![(TOKEN_ENV.into(), TOKEN.into())]).await else {
        return;
    };
    let (shop, charges, _shop) = checkout().await;
    rig.broker.set_vaults(vaults());
    // The fake provider's frames are on localhost; the shop is on 127.0.0.1.
    rig.broker.allow_payment_frames("localhost");
    rig.navi(THREAD, "ada");
    let hub = &rig.hub.hub;
    // Approvals announce and wake through the ops ports, which the hub's loops bind.
    hub.ops.bind(hub);
    let project = rig.hub.project.clone();
    hub.db
        .with(|c| {
            crate::hub::navi::store::put(
                c,
                &project,
                &fleetd_contracts::model::ProjectCreator {
                    key_id: "k1".into(),
                    name: "desk".into(),
                },
                None,
                0,
            )?;
            Ok(())
        })
        .unwrap();
    *rig.hub.agent.lock().unwrap() = CallerAgent::Lead;
    // Everything the Navi hears: tool results, raw CDP answers and events.
    let mut heard = String::new();

    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Book the hotel" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    driver.ok(Some(&page), "Page.enable", json!({})).await;
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{shop}/checkout") }),
        )
        .await;
    driver
        .wait_for(&page, "document.title === 'Checkout ready'")
        .await;

    // With no card picked, the Navi can't ask.
    let no_card = call(&rig.broker, purchase("127.0.0.1", "Double room, 2 nights")).await;
    assert!(
        no_card["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no card to pay with"),
        "{no_card}"
    );
    hub.db
        .with(|c| Ok(crate::hub::navi::store::set_card(c, &project, Some(CARD))?))
        .unwrap();
    // A shop other than the page's is refused before anyone is asked.
    let elsewhere = call(
        &rig.broker,
        purchase("hotel.devbox.test", "Double room, 2 nights"),
    )
    .await;
    assert_eq!(elsewhere["error"]["code"], "forbidden", "{elsewhere}");
    assert!(
        elsewhere["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not hotel.devbox.test"),
        "{elsewhere}"
    );
    assert!(
        hub.approvals.purchases(&convert(&project), 10).is_empty(),
        "nothing was asked"
    );

    // The purchase asks the person; the session waits for them without idling out.
    let asked = call(&rig.broker, purchase("127.0.0.1", "Double room, 2 nights")).await;
    let id = asked["result"]["requestId"]
        .as_str()
        .unwrap_or_else(|| panic!("{asked}"))
        .to_owned();
    assert!(
        asked["result"]["message"]
            .as_str()
            .unwrap()
            .contains("purchase_fill"),
        "{asked}"
    );
    heard.push_str(&asked.to_string());
    let session = rig.broker.live(THREAD).unwrap();
    assert_eq!(
        session.idle_for(),
        Duration::ZERO,
        "held while the person decides"
    );
    let open = hub.approvals.get(&id).unwrap();
    assert_eq!(open.state, fleetd_contracts::ledger::RequestState::Open);
    assert!(crate::hub::approvals::purchases::person_only(&open));
    let fill = json!({ "op": "purchase_fill", "requestId": id });
    let early = call(&rig.broker, fill.clone()).await;
    assert!(
        early["error"]["message"]
            .as_str()
            .unwrap()
            .contains("hasn't answered"),
        "{early}"
    );

    // The person approves; the node fills the card, once.
    let person = crate::hub::approvals::Caller {
        human: true,
        name: "desk",
        person: None,
        allows_operate: &|_: &str| true,
    };
    hub.approvals
        .answer(&person, &id, true, None)
        .await
        .unwrap();
    let filled = call(&rig.broker, fill.clone()).await;
    let message = filled["result"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("{filled}"));
    assert!(
        message.starts_with(
            "Filled the card's number, expiry, security code, name on the card from Visa (Personal)"
        ),
        "{message}"
    );
    assert!(message.contains("request_takeover"), "{message}");
    heard.push_str(&filled.to_string());
    let twice = call(&rig.broker, fill.clone()).await;
    assert!(
        twice["error"]["message"]
            .as_str()
            .unwrap()
            .contains("fills once"),
        "{twice}"
    );
    let ran = hub.approvals.get(&id).unwrap();
    assert_eq!(ran.state, fleetd_contracts::ledger::RequestState::Ran);
    assert!(
        ran.evidence
            .unwrap()
            .as_str()
            .starts_with("card filled into the checkout")
    );

    // The Navi reads nothing back: not in the provider's frame, not on the shop's page. With site isolation the frame
    // is a target of its own; without it (a headless shell's default), it is reached through the page in a world of
    // the driver's own.
    let targets = driver.ok(None, "Target.getTargets", json!({})).await;
    let frame_target = targets["targetInfos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["type"] == "iframe" && t["url"].as_str().is_some_and(|u| u.ends_with("/card")))
        .map(|t| t["targetId"].clone());
    let (in_frame, context, frame_id) = match frame_target {
        Some(target) => {
            let attached = driver
                .ok(
                    None,
                    "Target.attachToTarget",
                    json!({ "targetId": target, "flatten": true }),
                )
                .await;
            (
                attached["sessionId"].as_str().unwrap().to_owned(),
                None,
                None,
            )
        }
        None => {
            let tree = driver.ok(Some(&page), "Page.getFrameTree", json!({})).await;
            let child = tree["frameTree"]["childFrames"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| {
                    f["frame"]["url"]
                        .as_str()
                        .is_some_and(|u| u.ends_with("/card"))
                })
                .unwrap_or_else(|| panic!("the card frame: {tree}"))["frame"]["id"]
                .clone();
            let world = driver
                .ok(
                    Some(&page),
                    "Page.createIsolatedWorld",
                    json!({ "frameId": child }),
                )
                .await;
            (
                page.clone(),
                world["executionContextId"].as_i64(),
                Some(child),
            )
        }
    };
    for (session, context, expression) in [
        (
            &in_frame,
            context,
            "document.getElementById('number').value",
        ),
        (
            &in_frame,
            context,
            "btoa(document.getElementById('cvc').value)",
        ),
        (&in_frame, context, "document.body.innerHTML"),
        (&page, None, "document.getElementById('holder').value"),
    ] {
        let mut params = json!({ "expression": expression, "returnByValue": true });
        if let Some(context) = context {
            params["contextId"] = context.into();
        }
        let answer = driver.send(Some(session), "Runtime.evaluate", params).await;
        heard.push_str(&answer.to_string());
        assert!(
            answer["error"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("This script is refused")),
            "{expression}: {answer}"
        );
    }
    for (session, method) in [
        (&in_frame, "DOMSnapshot.captureSnapshot"),
        (&page, "Page.captureSnapshot"),
    ] {
        let answer = driver
            .send(Some(session), method, json!({ "computedStyles": [] }))
            .await;
        assert!(answer.get("error").is_some(), "{method}: {answer}");
    }
    // Screenshots and the accessibility tree (agent-browser's snapshots) still work, and hold no card: a filled field's
    // value is redacted there, the code's too.
    let in_card_frame = frame_id.map_or(json!({}), |f| json!({ "frameId": f }));
    for (session, method, params) in [
        (&in_frame, "Accessibility.getFullAXTree", in_card_frame),
        (&page, "Accessibility.getFullAXTree", json!({})),
        (&page, "Page.captureScreenshot", json!({})),
    ] {
        let answer = driver.send(Some(session), method, params).await;
        assert!(answer.get("error").is_none(), "{method}: {answer}");
        if method == "Accessibility.getFullAXTree" {
            assert!(
                answer.to_string().contains("***filled***"),
                "a filled field shows redacted: {answer}"
            );
        }
        heard.push_str(&answer.to_string());
    }

    // The Navi pays; the bank asks to confirm, and the person takes over without the session idling out.
    click(&mut driver, &page, "#pay").await;
    // agent-browser's `get title`, which a sealed session runs.
    let deadline = Instant::now() + Duration::from_secs(15);
    while driver.eval(&page, "document.title").await != "Confirm in your bank app" {
        assert!(Instant::now() < deadline, "the bank's confirmation shows");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let charged: Value = serde_json::from_str(&charges.lock().unwrap()[0]).unwrap();
    assert_eq!(
        charged["number"], NUMBER,
        "the provider's frame got the number"
    );
    assert_eq!(charged["exp"], "03/30");
    assert_eq!(charged["cvc"], CVC);
    assert_eq!(
        charged["holder"], HOLDER,
        "the shop's own field got the name"
    );
    assert_eq!(
        charged["masked"], true,
        "each filled field shows dots, blurred"
    );
    let takeover = call(
        &rig.broker,
        json!({ "op": "request_takeover", "reason": "Confirm the payment in your bank app" }),
    )
    .await;
    assert!(takeover["result"].is_object(), "{takeover}");
    assert_eq!(
        session.idle_for(),
        Duration::ZERO,
        "held while the person confirms"
    );

    // A page from another site after the fill reads as it is: a node id there names nothing the node filled.
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{}/3ds", shop.replace("127.0.0.1", "localhost")) }),
        )
        .await;
    let deadline = Instant::now() + Duration::from_secs(15);
    while driver.eval(&page, "document.title").await != "Bank" {
        assert!(Instant::now() < deadline, "the bank's page loads");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let tree = driver
        .ok_settled(Some(&page), "Accessibility.getFullAXTree", json!({}))
        .await
        .to_string();
    for text in [
        "Order 42 confirmed",
        "Confirm the payment in your bank app",
        "Continue shopping",
    ] {
        assert!(tree.contains(text), "{text} reads normally: {tree}");
    }
    assert!(
        !tree.contains("***filled***"),
        "nothing on another site is redacted: {tree}"
    );
    heard.push_str(&tree);

    heard.push_str(&serde_json::to_string(&driver.events).unwrap());
    assert_clean("what the Navi heard", &heard);
    drop(driver);
    let ended = call(&rig.broker, json!({ "op": "session_end" })).await;
    assert!(ended["result"].is_object(), "{ended}");
    for (path, text) in texts(&rig.node_home.path().join("browser")) {
        if path
            .extension()
            .is_some_and(|e| e == "webm" || e == "jpg" || e == "png")
        {
            continue;
        }
        assert_clean(&path.display().to_string(), &text);
    }
}

/// A checkout that moved to another site after the approval gets nothing, and the approval may still fill once the
/// Navi is back on the shop's page.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_card_fills_only_on_the_approved_shop() {
    let Some(rig) = rig_with(vec![(TOKEN_ENV.into(), TOKEN.into())]).await else {
        return;
    };
    let (shop, charges, _shop) = checkout().await;
    rig.broker.set_vaults(vaults());
    rig.broker.allow_payment_frames("localhost");
    rig.navi(THREAD, "ada");
    let hub = &rig.hub.hub;
    // Approvals announce and wake through the ops ports, which the hub's loops bind.
    hub.ops.bind(hub);
    let project = rig.hub.project.clone();
    hub.db
        .with(|c| {
            crate::hub::navi::store::put(
                c,
                &project,
                &fleetd_contracts::model::ProjectCreator {
                    key_id: "k1".into(),
                    name: "desk".into(),
                },
                None,
                0,
            )?;
            crate::hub::navi::store::set_card(c, &project, Some(CARD))?;
            Ok(())
        })
        .unwrap();
    *rig.hub.agent.lock().unwrap() = CallerAgent::Lead;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Book the hotel" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{shop}/checkout") }),
        )
        .await;
    driver
        .wait_for(&page, "document.title === 'Checkout ready'")
        .await;
    let asked = call(&rig.broker, purchase("127.0.0.1", "Double room, 2 nights")).await;
    let id = asked["result"]["requestId"]
        .as_str()
        .unwrap_or_else(|| panic!("{asked}"))
        .to_owned();
    let person = crate::hub::approvals::Caller {
        human: true,
        name: "desk",
        person: None,
        allows_operate: &|_: &str| true,
    };
    hub.approvals
        .answer(&person, &id, true, None)
        .await
        .unwrap();
    // Held while the person decided; the Navi's next browser command, once woken with the answer, ends the hold.
    let session = rig.broker.live(THREAD).unwrap();
    assert_eq!(session.idle_for(), Duration::ZERO);
    rig.broker.item(
        THREAD,
        &command_item("agent-browser get title", "Checkout ready"),
    );
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert!(session.idle_for() > Duration::ZERO, "no longer held");

    // The same checkout, on another site (localhost): refused, nothing typed, and the approval kept.
    let away = shop.replace("127.0.0.1", "localhost");
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{away}/checkout") }),
        )
        .await;
    driver
        .wait_for(
            &page,
            "location.hostname === 'localhost' && document.title === 'Checkout ready'",
        )
        .await;
    let fill = json!({ "op": "purchase_fill", "requestId": id });
    let refused = call(&rig.broker, fill.clone()).await;
    let why = refused["error"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("{refused}"));
    assert!(why.contains("not the approved shop's 127.0.0.1"), "{why}");
    assert_eq!(
        hub.approvals.get(&id).unwrap().state,
        fleetd_contracts::ledger::RequestState::Approved,
        "nothing was typed: it may still be filled"
    );
    assert!(charges.lock().unwrap().is_empty());

    // Back on the shop: it fills.
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{shop}/checkout") }),
        )
        .await;
    driver
        .wait_for(
            &page,
            "location.hostname === '127.0.0.1' && document.title === 'Checkout ready'",
        )
        .await;
    let filled = call(&rig.broker, fill).await;
    assert!(filled["result"]["message"].is_string(), "{filled}");
}

fn convert(r: &ProjectRef) -> crate::hub::usage::ports::ProjectRef {
    crate::hub::usage::wire::convert(r).unwrap()
}

/// A Navi rig with the hub in process: its project a Navi with a card, the test hub's calls its lead's.
async fn navi_rig() -> Option<(Rig, String, Arc<std::sync::Mutex<Vec<String>>>, AbortOnDrop)> {
    let rig = rig_with(vec![(TOKEN_ENV.into(), TOKEN.into())]).await?;
    let (site, kept, serving) = checkout().await;
    rig.broker.set_vaults(vaults());
    rig.navi(THREAD, "ada");
    let hub = rig.hub.hub.clone();
    hub.ops.bind(&hub);
    let project = rig.hub.project.clone();
    hub.db
        .with(|c| {
            crate::hub::navi::store::put(
                c,
                &project,
                &fleetd_contracts::model::ProjectCreator {
                    key_id: "k1".into(),
                    name: "desk".into(),
                },
                None,
                0,
            )?;
            Ok(())
        })
        .unwrap();
    *rig.hub.agent.lock().unwrap() = CallerAgent::Lead;
    Some((rig, site, kept, serving))
}

fn secure(domain: &str, target: &str, reference: Option<&str>) -> Value {
    let mut call = json!({
        "op": "request_secure_input",
        "site": { "domain": domain, "name": "Visa application" },
        "target": target,
        "label": "Passport number",
        "why": "The visa form needs it to continue",
    });
    if let Some(reference) = reference {
        call["ref"] = reference.into();
    }
    call
}

/// What the site's own frame got, once it got it.
async fn typed(kept: &std::sync::Mutex<Vec<String>>) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let last = kept.lock().unwrap().last().cloned();
        if let Some(body) = last {
            return serde_json::from_str(&body).unwrap();
        }
        assert!(Instant::now() < deadline, "the site's frame got nothing");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_the_person_types_fills_the_sites_own_frame_once_and_the_navi_never_sees_it() {
    let Some((rig, site, kept, _site)) = navi_rig().await else {
        return;
    };
    let hub = &rig.hub.hub;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Apply for the visa" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{site}/form") }),
        )
        .await;
    driver
        .wait_for(&page, "document.title === 'Form ready'")
        .await;
    let mut heard = String::new();

    // Another site, or a field that isn't there, is refused before anyone is asked.
    let elsewhere = call(&rig.broker, secure("visas.devbox.test", "#passport", None)).await;
    assert_eq!(elsewhere["error"]["code"], "forbidden", "{elsewhere}");
    let missing = call(&rig.broker, secure("127.0.0.1", "#visa-number", None)).await;
    assert!(
        missing["error"]["message"]
            .as_str()
            .unwrap()
            .contains("No field"),
        "{missing}"
    );

    let asked = call(&rig.broker, secure("127.0.0.1", "#passport", None)).await;
    let id = asked["result"]["requestId"]
        .as_str()
        .unwrap_or_else(|| panic!("{asked}"))
        .to_owned();
    heard.push_str(&asked.to_string());
    let request = hub.approvals.get(&id).unwrap();
    let sink = request
        .secret
        .as_ref()
        .expect("a sealed field for the person")
        .sink
        .to_string();
    assert!(sink.starts_with("fill:devbox:B"), "{sink}");
    assert!(crate::hub::approvals::purchases::person_only(&request));
    assert!(matches!(
        crate::hub::approvals::chat_item(&request),
        fleetd_contracts::chat::ChatItem::SecretRequest(item) if item.secure_input.is_some()
    ));
    let session = rig.broker.live(THREAD).unwrap();
    assert_eq!(
        session.idle_for(),
        Duration::ZERO,
        "held while the person types"
    );

    // The person's app seals it to the node; the node fills the site's own frame, not the decoy on another site.
    let key_home = tempfile::tempdir().unwrap();
    let key = crate::node::identity::load_or_create_box_key(key_home.path()).unwrap();
    let frame: fleetd_contracts::node_link::SecretDeliver = serde_json::from_value(json!({
        "id": "s1", "sink": sink, "secretKey": "navi.secure_input",
        "sealed": B64.encode(key.seal(TYPED.as_bytes()).unwrap()),
    }))
    .unwrap();
    let delivered =
        super::super::secure_input::deliver(&rig.broker, &frame, Some(&key), "devbox").await;
    assert!(delivered.fingerprint.is_some(), "{delivered:?}");
    let got = typed(&kept).await;
    assert_eq!(got["value"], TYPED);
    assert_eq!(got["masked"], true, "the filled field shows dots, blurred");
    assert_eq!(
        kept.lock().unwrap().len(),
        1,
        "the decoy on another site got nothing"
    );
    let again =
        super::super::secure_input::deliver(&rig.broker, &frame, Some(&key), "devbox").await;
    assert!(again.error.unwrap().as_str().contains("filled already"));

    // Nothing reads it back.
    let answer = driver
        .send(
            Some(&page),
            "Runtime.evaluate",
            json!({ "expression": "document.getElementById('own').contentDocument.getElementById('passport').value", "returnByValue": true }),
        )
        .await;
    assert!(
        answer["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("This script is refused")),
        "{answer}"
    );
    heard.push_str(&answer.to_string());
    heard.push_str(&serde_json::to_string(&driver.events).unwrap());
    assert!(!heard.contains(TYPED), "{heard}");
    drop(driver);
    call(&rig.broker, json!({ "op": "session_end" })).await;
    for (path, text) in texts(&rig.node_home.path().join("browser")) {
        if !path
            .extension()
            .is_some_and(|e| e == "webm" || e == "jpg" || e == "png")
        {
            assert!(!text.contains(TYPED), "{} holds it", path.display());
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_approved_passport_from_1password_fills_once() {
    let Some((rig, site, kept, _site)) = navi_rig().await else {
        return;
    };
    let hub = &rig.hub.hub;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Apply for the visa" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{site}/form") }),
        )
        .await;
    driver
        .wait_for(&page, "document.title === 'Form ready'")
        .await;
    let asked = call(
        &rig.broker,
        secure("127.0.0.1", "#passport", Some(PASSPORT_REF)),
    )
    .await;
    let id = asked["result"]["requestId"]
        .as_str()
        .unwrap_or_else(|| panic!("{asked}"))
        .to_owned();
    let request = hub.approvals.get(&id).unwrap();
    assert_eq!(
        request.kind,
        fleetd_contracts::ledger::RequestKind::Approval
    );
    let fill = json!({ "op": "secure_input_fill", "requestId": id });
    let early = call(&rig.broker, fill.clone()).await;
    assert!(
        early["error"]["message"]
            .as_str()
            .unwrap()
            .contains("hasn't answered"),
        "{early}"
    );
    let person = crate::hub::approvals::Caller {
        human: true,
        name: "desk",
        person: None,
        allows_operate: &|_: &str| true,
    };
    hub.approvals
        .answer(&person, &id, true, None)
        .await
        .unwrap();
    let filled = call(&rig.broker, fill.clone()).await;
    assert!(
        filled["result"]["message"]
            .as_str()
            .unwrap_or_default()
            .starts_with("Filled #passport from 1Password"),
        "{filled}"
    );
    assert_eq!(typed(&kept).await["value"], PASSPORT);
    let twice = call(&rig.broker, fill).await;
    assert!(
        twice["error"]["message"]
            .as_str()
            .unwrap()
            .contains("fills once"),
        "{twice}"
    );
    assert!(!format!("{asked}{filled}{twice}").contains(PASSPORT));
}
