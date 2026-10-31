//! A Navi's secure input in its browser (fleetd-contracts' secure_input.rs): something only the person may give.
//! - [`request`]: on the page, the node checks it is on the site and the field is there (in the page or one of the
//!   site's own frames), then opens the request on the hub. Typed by the person, the session waits for it.
//! - [`deliver`]: the sealed value for a `fill:` sink, from the link: opened here, the session sealed as a login fill
//!   seals it (credentials.rs), and typed into the field on that site, once.
//! - [`fill_approved`]: a 1Password field (an Identity, Passport, Driver License or Social Security item's), once the
//!   person approved it: claimed on the hub, read with the session's token and typed in the same way.
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

use fleetd_contracts::browser::{BrowserCallResult, Filled};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::node_link::{SecretDeliver, SecretResult};
use fleetd_contracts::prim::Line;
use fleetd_contracts::purchase::on_domain;
use fleetd_contracts::secure_input::{
    FILL_WINDOW_MINUTES, SecureInputAsked, SecureInputCall, SecureInputClaimCall,
    SecureInputFillCall, SecureInputFilledCall, SecureInputOpenCall,
};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::cards::{
    CardError, FOCUS, HIDE, WAIT_ON_PERSON, docs, navi_session, not_typed, one_line,
};
use super::credentials::page_url;
use super::onepassword::host_of;
use super::session::Session;
use super::{Broker, agent_browser, lock, refuse};

/// A typed secure input its session waits for: where it fills.
#[derive(Clone)]
pub struct Waiting {
    pub request_id: String,
    pub domain: String,
    pub target: String,
    pub label: String,
}

/// Where a typed secure input waits: by its browser session and its request, as a session may wait for several.
fn waiting_key(session: &str, request: &str) -> String {
    format!("{session}/{request}")
}

/// The session's page, or why the value can't go there.
async fn on_site(session: &Session, domain: &str) -> Result<(), String> {
    let page = page_url(session).await.unwrap_or_default();
    let host = host_of(&page).unwrap_or_default();
    if on_domain(&host, domain) {
        Ok(())
    } else {
        Err(format!(
            "the page is on {}, not {domain}",
            if host.is_empty() { "no website" } else { &host }
        ))
    }
}

/// The field `target` matches in the page or one of its frames on `domain`: its document's CDP session, its browser
/// target and the field's object.
async fn locate(session: &Session, target: &str, domain: &str) -> Option<(String, String, Value)> {
    let (page_target, page) = session.page()?;
    let allowed = |url: &str| host_of(url).is_some_and(|h| on_domain(&h, domain));
    for doc in docs(session, &page_target, &page, &allowed).await {
        let Ok(world) = session
            .cdp
            .call(
                Some(&doc.session),
                "Page.createIsolatedWorld",
                json!({ "frameId": doc.frame, "worldName": "fleetd input" }),
            )
            .await
        else {
            continue;
        };
        let Some(context) = world["executionContextId"].as_i64() else {
            continue;
        };
        let expression = format!("document.querySelector({})", json!(target));
        let Ok(found) = session
            .cdp
            .call(
                Some(&doc.session),
                "Runtime.evaluate",
                json!({ "expression": expression, "contextId": context, "returnByValue": false }),
            )
            .await
        else {
            continue;
        };
        if let Some(object) = found.pointer("/result/objectId").cloned() {
            return Some((doc.session, doc.target, object));
        }
    }
    None
}

/// What the node reads of the field before it types: whether it takes text and its document's address.
const FIELD: &str = "function() { const tag = this.tagName.toLowerCase(); const type = (this.type || '').toLowerCase(); \
     const field = tag === 'textarea' || (tag === 'input' && \
       !['hidden','checkbox','radio','submit','button','file','image','reset','color','range'].includes(type)); \
     return { field, url: this.ownerDocument.location.href }; }";

/// Types `value` into the field `target` matches on `domain` (the page or one of its frames), over the node's own
/// connection, hidden as it is typed. The session must be sealed first.
async fn type_into(
    session: &Session,
    target: &str,
    domain: &str,
    value: &str,
) -> Result<(), CardError> {
    let Some((via, in_target, object)) = locate(session, target, domain).await else {
        return Err(not_typed(format!("no field on the page matches {target}")));
    };
    let on = |function: &'static str| {
        session.cdp.call(
            Some(&via),
            "Runtime.callFunctionOn",
            json!({ "objectId": object, "functionDeclaration": function, "returnByValue": true }),
        )
    };
    let about = on(FIELD).await.map_err(not_typed)?;
    let about = &about["result"]["value"];
    if about["field"] != true {
        return Err(not_typed(format!("{target} is not a text field")));
    }
    let url = about["url"].as_str().unwrap_or_default();
    if !host_of(url).is_some_and(|h| on_domain(&h, domain)) {
        return Err(not_typed(format!("{target} is in a frame off {domain}")));
    }
    if let Ok(described) = session
        .cdp
        .call(
            Some(&via),
            "DOM.describeNode",
            json!({ "objectId": object }),
        )
        .await
        && let Some(backend) = described
            .pointer("/node/backendNodeId")
            .and_then(Value::as_i64)
    {
        session.filled_field(&in_target, &host_of(url).unwrap_or_default(), backend);
    }
    on(HIDE).await.map_err(not_typed)?;
    on(FOCUS).await.map_err(not_typed)?;
    // The one copy of the value the node makes for the page, wiped once sent.
    let mut sent = session
        .cdp
        .call_secret(Some(&via), "Input.insertText", json!({ "text": value }))
        .await;
    if sent.is_err()
        && let Some((_, page)) = session.page()
        && page != via
    {
        sent = session
            .cdp
            .call_secret(Some(&page), "Input.insertText", json!({ "text": value }))
            .await;
    }
    sent.map(drop).map_err(|message| CardError {
        message,
        typed: true,
    })
}

/// Seals the session against reading `value` back, as a login fill does: scrubbed from all the driver and the agent's
/// transcript see, its reads refused.
fn seal(broker: &Broker, session: &Session, name: &str, value: &str) {
    session.add_secret(name, value);
    broker.credentials.filled(&session.thread, name, value);
    session.credentials_filled.fetch_add(1, Ordering::Relaxed);
    if let Err(e) = agent_browser::write_policy(&broker.home, &session.thread, true) {
        tracing::warn!(session = %session.id, error = %e, "agent-browser's sealed policy not written");
    }
}

/// An agent's `request_secure_input`.
pub async fn request(
    broker: &Arc<Broker>,
    thread: &str,
    call: SecureInputCall,
) -> Result<BrowserCallResult, McpToolError> {
    let session = navi_session(broker, thread)?;
    let domain = call.site.domain.to_string();
    if let Err(why) = on_site(&session, &domain).await {
        return Err(refuse(
            ErrorCode::Forbidden,
            format!("Not asked: {why}."),
            "open the page with the field first, then ask with its own domain",
        ));
    }
    let target = call.target.to_string();
    if locate(&session, &target, &domain).await.is_none() {
        return Err(refuse(
            ErrorCode::Invalid,
            format!("No field on the page matches {target}."),
            "check the selector with agent-browser snapshot -i, then ask again",
        ));
    }
    let typed = call.reference.is_none();
    let label = call.label.to_string();
    let args = json!({ "site": domain, "label": label, "target": target });
    let opened = broker
        .in_turn(
            &session,
            LeadCall::SecureInputOpen(SecureInputOpenCall {
                session_id: session.id.clone(),
                input: call,
            }),
        )
        .await?;
    let LeadCallResult::SecureInputOpen(opened) = opened else {
        return Err(refuse(
            ErrorCode::Failed,
            "The hub answered request_secure_input with something else.",
            "try again",
        ));
    };
    let id = opened.request_id;
    if typed {
        lock(&broker.cards.waiting).insert(
            waiting_key(session.id.as_str(), id.as_str()),
            Waiting {
                request_id: id.to_string(),
                domain,
                target: target.clone(),
                label: label.clone(),
            },
        );
    }
    session.hold_for_answer(WAIT_ON_PERSON);
    session.step("request_secure_input", args, true, None, 0);
    let message = if typed {
        format!(
            "Asked the person to type {label} ({id}) in a sealed field. Stay on this page and end your turn: once they \
             do, fleetd types it into {target} and you are woken. You never see it; don't ask for it in the chat."
        )
    } else {
        format!(
            "Asked the person to approve filling {label} from 1Password ({id}). Stay on this page and end your turn. \
             Approved, call secure_input_fill with requestId {id} within {FILL_WINDOW_MINUTES} minutes."
        )
    };
    Ok(BrowserCallResult::RequestSecureInput(SecureInputAsked {
        request_id: id,
        message,
    }))
}

/// The sealed value of a `fill:` sink, from the hub: typed into its session's waiting field, once.
pub async fn deliver(
    broker: &Arc<Broker>,
    frame: &SecretDeliver,
    box_key: Option<&crate::node::identity::NodeBoxKey>,
    machine: &str,
) -> SecretResult {
    let fail = |error: String| SecretResult {
        id: frame.id.clone(),
        fingerprint: None,
        error: Some(crate::node::wire::head_text(&error)),
    };
    let Some(sink) = fleetd_contracts::secrets::parse_secret_sink(&frame.sink) else {
        return fail("the sink does not parse".into());
    };
    if sink.machine_id.as_str() != machine {
        return fail(format!(
            "the sink is on {}, not on {machine}",
            sink.machine_id
        ));
    }
    let Some(box_key) = box_key else {
        return fail("this node takes no secrets: it has no box key".into());
    };
    let session = lock(&broker.sessions)
        .values()
        .find(|s| s.id.as_str() == sink.path)
        .cloned();
    let Some(session) = session else {
        return fail(
            "that browser session has ended: ask the Navi to open the page and ask again".into(),
        );
    };
    let Some(request) = frame.request_id.as_ref() else {
        return fail(
            "the hub didn't say which secure input this is: update fleetd on the hub".into(),
        );
    };
    let key = waiting_key(&sink.path, request.as_str());
    let Some(waiting) = lock(&broker.cards.waiting).remove(&key) else {
        return fail(format!(
            "nothing waits for {request} in that browser session: it was filled already"
        ));
    };
    let give_back = |waiting: Waiting| {
        lock(&broker.cards.waiting).insert(key.clone(), waiting);
    };
    let sealed = Zeroizing::new(
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            frame.sealed.as_str(),
        )
        .unwrap_or_default(),
    );
    let Some(plain) = box_key.open(&sealed) else {
        give_back(waiting);
        return fail(
            "the value was not sealed to this machine's current box key: seal it again".into(),
        );
    };
    let Ok(value) = std::str::from_utf8(&plain).map(|v| Zeroizing::new(v.to_owned())) else {
        give_back(waiting);
        return fail("the value is not text".into());
    };
    if let Err(why) = on_site(&session, &waiting.domain).await {
        give_back(waiting);
        return fail(format!(
            "not filled: {why}; enter it again once the Navi is back on that page"
        ));
    }
    seal(
        broker,
        &session,
        &format!("{} {}", waiting.request_id, waiting.label),
        &value,
    );
    let started = Instant::now();
    let typed = type_into(&session, &waiting.target, &waiting.domain, &value).await;
    session.hold(None);
    session.write_meta(None);
    match typed {
        Ok(()) => {
            let seq = session.step(
                "secure_input",
                json!({ "requestId": waiting.request_id, "target": waiting.target }),
                true,
                Some(&format!("Filled {} from the person", waiting.label)),
                started.elapsed().as_millis() as u64,
            );
            session.queue_capture(seq, None);
            SecretResult {
                id: frame.id.clone(),
                fingerprint: Some(fleetd_contracts::secrets::SecretFingerprint::unchecked(
                    crate::node::secrets::fingerprint_of(value.as_bytes()),
                )),
                error: None,
            }
        }
        Err(e) => {
            if !e.typed {
                session.credentials_filled.fetch_sub(1, Ordering::Relaxed);
                give_back(waiting);
            }
            fail(format!("not filled: {}", e.message))
        }
    }
}

/// An agent's `secure_input_fill`: an approved 1Password field, typed into the page.
pub async fn fill_approved(
    broker: &Arc<Broker>,
    thread: &str,
    call: SecureInputFillCall,
) -> Result<BrowserCallResult, McpToolError> {
    let started = Instant::now();
    let session = navi_session(broker, thread)?;
    let id = call.request_id.clone();
    let args = json!({ "requestId": id.as_str() });
    let failed = |error: McpToolError| {
        session.step(
            "secure_input_fill",
            args.clone(),
            false,
            Some(&error.message),
            started.elapsed().as_millis() as u64,
        );
        error
    };
    let claimed = broker
        .in_turn(
            &session,
            LeadCall::SecureInputClaim(SecureInputClaimCall {
                request_id: id.clone(),
                session_id: session.id.clone(),
            }),
        )
        .await
        .map_err(failed)?;
    let LeadCallResult::SecureInputClaim(claimed) = claimed else {
        return Err(failed(refuse(
            ErrorCode::Failed,
            "The hub answered secure_input_fill with something else.",
            "try again",
        )));
    };
    let domain = claimed.domain.to_string();
    let target = claimed.target.to_string();
    let outcome = async {
        on_site(&session, &domain).await.map_err(not_typed)?;
        let vault = broker
            .vault(&session)
            .await
            .map_err(|e| not_typed(e.message.trim_end_matches('.').to_owned()))?;
        let read = vault
            .vault
            .identity(claimed.reference.as_str())
            .await
            .map_err(|e| {
                not_typed(format!(
                    "{} was not read: {}",
                    claimed.reference,
                    e.message.trim_end_matches('.')
                ))
            })?;
        seal(broker, &session, claimed.reference.as_str(), &read.value);
        let typed = type_into(&session, &target, &domain, &read.value).await;
        if typed.as_ref().is_err_and(|e| !e.typed) {
            session.credentials_filled.fetch_sub(1, Ordering::Relaxed);
        }
        typed
    }
    .await;
    let (ok, typed, message) = match &outcome {
        Ok(()) => (true, true, format!("filled {target}")),
        Err(e) => (false, e.typed, e.message.clone()),
    };
    if let Err(e) = broker
        .in_turn(
            &session,
            LeadCall::SecureInputFilled(SecureInputFilledCall {
                request_id: id.clone(),
                ok,
                typed,
                message: Line::unchecked(one_line(&message)),
            }),
        )
        .await
    {
        tracing::warn!(session = %session.id, request = %id, error = e.message, "a secure input's fill was not reported");
    }
    session.hold(None);
    session.write_meta(None);
    match outcome {
        Ok(()) => {
            let message = format!(
                "Filled {target} from 1Password; this browser session now refuses reading it back. Carry on with the page."
            );
            let seq = session.step(
                "secure_input_fill",
                args,
                true,
                Some(&message),
                started.elapsed().as_millis() as u64,
            );
            session.queue_capture(seq, None);
            Ok(BrowserCallResult::SecureInputFill(Filled {
                message: session.scrub().text(&message),
            }))
        }
        Err(e) => Err(failed(refuse(
            ErrorCode::Invalid,
            format!("{target} was not filled: {}.", e.message),
            if e.typed {
                "part of it may be in the page: tell the person"
            } else {
                "nothing was typed: open that page and call secure_input_fill again within the window"
            },
        ))),
    }
}
