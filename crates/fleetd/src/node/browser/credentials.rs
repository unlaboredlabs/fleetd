//! Credential sessions: everything about filling logins lives here, behind three seams the rest of the broker calls.
//! - [`fill_credential`]: the broker's entry point for an agent's `fill_credential`.
//! - [`refusal`]: the proxy asks it, for each of the driver's commands, whether a session that filled a credential
//!   refuses it.
//! - [`outgoing`]: the proxy passes each message for the driver through it.
//!
//! Work in progress (W46, handed over): onepassword.rs resolves `op://` references; [`fill`] types a value over the
//! node's own connection and submits; [`sealed_refusal`] and the scrub in [`outgoing`] are the proxy's rules once a
//! session filled a credential. Still to do: wire [`fill_credential`] (token from the session's secrets, the session's
//! cache, the origin check, sealing: the session's scrubber, the policy file, the hub report), keep the token out of
//! agents' environments, mask filled values in what the node reports, the agent tool, and the leak tests.
use std::sync::Arc;

use fleetd_contracts::browser::{BrowserCallResult, FillCredentialCall};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use serde_json::{Value, json};

use super::Broker;
use super::session::Session;

/// An agent's `fill_credential` in its live session.
pub async fn fill_credential(
    _broker: &Arc<Broker>,
    _thread: &str,
    _call: FillCredentialCall,
) -> Result<BrowserCallResult, McpToolError> {
    Err(McpToolError::new(
        ErrorCode::Invalid,
        "fill_credential is not available on this machine yet.",
    )
    .with_fix("do without it and say so in your result"))
}

/// Whether the session filled a credential: from then on it is sealed.
pub fn sealed(session: &Session) -> bool {
    session
        .credentials_filled
        .load(std::sync::atomic::Ordering::Relaxed)
        > 0
}

/// Why the session refuses the driver's `method`, once it filled a credential; None lets it through.
pub fn refusal(session: &Session, method: &str, params: &Value) -> Option<String> {
    if !sealed(session) {
        return None;
    }
    sealed_refusal(method, params)
}

/// A message from the browser on its way to the driver: once the session filled a credential, every form of it
/// (literal, escaped, encoded) is scrubbed first.
pub fn outgoing(session: &Session, message: Value) -> Value {
    if !sealed(session) {
        return message;
    }
    let mut message = message;
    session.scrub().value(&mut message);
    message
}

/// The page the session follows, as its target says.
pub async fn page_url(session: &Session) -> Option<String> {
    let (target, _) = session.page()?;
    let info = session
        .cdp
        .call(None, "Target.getTargetInfo", json!({ "targetId": target }))
        .await
        .ok()?;
    info.pointer("/targetInfo/url")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Types `value` into the field `target` (a CSS selector) of the followed page over the node's own connection,
/// then submits its form (or presses Enter in it) when `submit`, so the value sits in the page as briefly as it
/// can. The value never passes the proxy.
pub async fn fill(
    session: &Session,
    target: &str,
    value: &str,
    submit: bool,
) -> Result<(), String> {
    let Some((_, page)) = session.page() else {
        return Err("the browser has no page".into());
    };
    let call = |method: &'static str, params: Value| session.cdp.call(Some(&page), method, params);
    let doc = call("DOM.getDocument", json!({ "depth": 0 })).await?;
    let root = doc.pointer("/root/nodeId").cloned().unwrap_or_default();
    let found = call(
        "DOM.querySelector",
        json!({ "nodeId": root, "selector": target }),
    )
    .await?;
    let node = found["nodeId"].as_u64().unwrap_or(0);
    if node == 0 {
        return Err(format!("no field on the page matches {target}"));
    }
    let object = call("DOM.resolveNode", json!({ "nodeId": node })).await?;
    let object = object
        .pointer("/object/objectId")
        .cloned()
        .unwrap_or_default();
    let on = |function: &'static str| {
        call(
            "Runtime.callFunctionOn",
            json!({ "objectId": object, "functionDeclaration": function, "returnByValue": true }),
        )
    };
    on("function() { this.focus(); if (this.select) this.select(); }").await?;
    call("Input.insertText", json!({ "text": value })).await?;
    if submit {
        let submitted = on("function() { const f = this.form; if (!f) return false; \
             if (f.requestSubmit) f.requestSubmit(); else f.submit(); return true; }")
        .await?;
        if submitted.pointer("/result/value") != Some(&Value::Bool(true)) {
            for kind in ["keyDown", "keyUp"] {
                let mut key = json!({ "type": kind, "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13 });
                if kind == "keyDown" {
                    key["text"] = "\r".into();
                }
                call("Input.dispatchKeyEvent", key).await?;
            }
        }
    }
    Ok(())
}

/// Methods a sealed session refuses outright: whole-page reads in encodings the scrubber can't see into (DOM snapshots
/// with input values, MHTML, PDF), request bodies, and the hooks that run script of the driver's in every page or
/// intercept traffic.
const SEALED_METHODS: &[&str] = &[
    "DOMSnapshot.captureSnapshot",
    "DOMSnapshot.getSnapshot",
    "Page.captureSnapshot",
    "Page.printToPDF",
    "Network.getRequestPostData",
    "Fetch.enable",
    "Fetch.getResponseBody",
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.addBinding",
    "Runtime.queryObjects",
    "Debugger.enable",
    "Debugger.evaluateOnCallFrame",
    "HeapProfiler.takeHeapSnapshot",
];

/// A script that reads a value (an input's `value`, its attribute, a form's data)…
static READS_VALUE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(
        r#"\.value\b\s*(?:[^=\s]|==|$)|\[\s*['"`]value['"`]\s*\]|getAttribute\s*\(\s*['"`]value|FormData|\.elements\b|type\s*=\s*['"]?password"#,
    )
    .expect("a valid pattern")
});

/// …and reshapes or sends it: what would get it past the scrubber.
static RESHAPES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(
        r"split|reverse|charCode|codePoint|fromCharCode|encodeURI|escape\s*\(|atob|btoa|toUpperCase|toLowerCase|substr|slice|padStart|padEnd|repeat|replace|\.map\s*\(|\.join\s*\(|fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|postMessage|Storage|cookie|location\s*=|\.src\s*=|\.href\s*=|eval\s*\(|Function\s*\(|import\s*\(|crypto|TextEncoder|\.at\s*\(|\[\s*\d+\s*\]",
    )
    .expect("a valid pattern")
});

/// Why a session that filled a credential refuses `method`, if it does. Every answer it lets through is scrubbed of
/// the value's forms ([`Session::outgoing`]); these are the reads that could carry it in another.
pub fn sealed_refusal(method: &str, params: &Value) -> Option<String> {
    let sealed = || {
        Some(format!(
            "{method} is off in this browser session: it filled a login from 1Password, and nothing may read that \
             value back. Use snapshots, clicks and typing; start a new session for anything else."
        ))
    };
    if SEALED_METHODS.contains(&method) {
        return sealed();
    }
    let script = match method {
        "Runtime.evaluate" | "Runtime.compileScript" => params["expression"].as_str(),
        "Runtime.callFunctionOn" => params["functionDeclaration"].as_str(),
        "Page.navigate" | "Target.createTarget" => params["url"].as_str().filter(|u| {
            u.trim_start()
                .to_ascii_lowercase()
                .starts_with("javascript:")
        }),
        _ => None,
    }?;
    (READS_VALUE.is_match(script) && RESHAPES.is_match(script)).then(sealed)?
}
