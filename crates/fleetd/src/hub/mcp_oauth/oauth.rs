//! The OAuth side of MCP's authorization spec, as a client: where a server signs in (its 401's resource metadata, the
//! protected resource's and the authorization server's well-known metadata, with the 2025-03-26 defaults for a server
//! that has neither), dynamic client registration, PKCE (S256), and the token endpoint's two grants. Every call has
//! [`TIMEOUT`], follows redirects only within its origin, and goes over https unless its host is this machine or on a
//! tailnet, so a token never crosses the internet in the clear.
use std::net::IpAddr;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::Digest;
use zeroize::Zeroizing;

/// Each call to the service.
pub const TIMEOUT: Duration = Duration::from_secs(20);

/// Where a server signs in, as discovered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Discovered {
    /// The MCP server as the token's audience (RFC 8707's `resource`).
    pub resource: String,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    pub revocation_endpoint: Option<String>,
    /// What to ask for: the 401's `scope`, else what the resource lists; none asks for the service's default.
    pub scope: Option<String>,
    /// How the token endpoint takes a client secret, as the service lists them.
    pub auth_methods: Vec<String>,
}

/// A client fleetd registered for itself.
pub struct Registered {
    pub client_id: String,
    pub client_secret: Option<Zeroizing<String>>,
    /// `client_secret_basic` or `client_secret_post` with a secret; none for a public client.
    pub token_auth: Option<String>,
}

/// What the token endpoint gave.
pub struct Tokens {
    pub access: Zeroizing<String>,
    pub refresh: Option<Zeroizing<String>>,
    /// Seconds the access token lasts, when the service says.
    pub expires_in: Option<i64>,
}

/// Why the token endpoint gave none.
#[derive(Debug, PartialEq, Eq)]
pub enum TokenError {
    /// The service refused the grant itself (`invalid_grant`, `invalid_client`, `unauthorized_client`): signing in
    /// again is the only way back. Its words: the service's description, else its error code.
    Refused(String),
    /// Anything else (no answer, a 5xx, another error code): trying again later may work. What happened, naming the
    /// service.
    Failed(String),
}

/// A client that keeps every redirect within its first origin, as the MCP client does.
fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(format!("fleetd/{}", env!("CARGO_PKG_VERSION")))
        .redirect(crate::cli::mcp_client::same_origin_redirects())
        .build()
        .unwrap_or_default()
}

/// The host part of a URL as a message names it, as code: `` `auth.example.com` ``.
pub fn host_of(url: &str) -> String {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| url.to_owned());
    format!("`{host}`")
}

/// https, or http to this machine or a tailnet (Tailscale's `.ts.net` names and 100.64.0.0/10): anything else would
/// carry a code or token in the clear.
pub fn secure(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url).map_err(|_| format!("{url} is no URL"))?;
    let private = match parsed.host() {
        Some(url::Host::Domain(d)) => {
            let d = d.to_ascii_lowercase();
            d == "localhost" || d.ends_with(".ts.net")
        }
        Some(url::Host::Ipv4(ip)) => {
            IpAddr::V4(ip).is_loopback() || (ip.octets()[0] == 100 && (ip.octets()[1] & 0xc0) == 64)
        }
        Some(url::Host::Ipv6(ip)) => {
            ip.is_loopback() || ip.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0]
        }
        None => return Err(format!("{url} names no host")),
    };
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if private => Ok(parsed),
        "http" => Err(format!(
            "{} signs in over plain HTTP, which would send your sign-in in the clear",
            host_of(url)
        )),
        other => Err(format!("{url} is {other}:, not https")),
    }
}

/// A PKCE verifier and its S256 challenge.
pub fn pkce() -> (Zeroizing<String>, String) {
    let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>()));
    let challenge = URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// A fresh OAuth `state`: what ties the callback to its sign-in.
pub fn state() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

/// `key="value"` (or a bare token) from a `WWW-Authenticate: Bearer …` challenge.
pub fn challenge_param(header: &str, key: &str) -> Option<String> {
    let rest = header.trim();
    let rest = rest
        .strip_prefix("Bearer")
        .or_else(|| rest.strip_prefix("bearer"))?;
    let mut chars = rest.char_indices().peekable();
    // Split on commas outside quotes.
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '\\' if quoted => {
                chars.next();
            }
            ',' if !quoted => {
                parts.push(&rest[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&rest[start..]);
    parts.into_iter().find_map(|p| {
        let (k, v) = p.split_once('=')?;
        if !k.trim().eq_ignore_ascii_case(key) {
            return None;
        }
        let v = v.trim();
        let v = v
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .unwrap_or(v);
        Some(v.replace("\\\"", "\""))
    })
}

/// What a request with no credentials gets: whether it was a 401, and its `WWW-Authenticate`.
async fn knock(url: &str, sse: bool) -> Result<(bool, Option<String>), String> {
    let request = if sse {
        http().get(url).header("accept", "text/event-stream")
    } else {
        http()
            .post(url)
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .body(
                json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                    "protocolVersion": crate::cli::mcp_client::PROTOCOL_VERSION, "capabilities": {},
                    "clientInfo": { "name": "fleetd", "version": env!("CARGO_PKG_VERSION") } } })
                .to_string(),
            )
    };
    let answer = request.send().await.map_err(|e| {
        format!(
            "{} can't be reached: {}",
            host_of(url),
            crate::cli::mcp_client::describe(&e)
        )
    })?;
    let header = answer
        .headers()
        .get_all("www-authenticate")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find(|v| v.trim_start().to_ascii_lowercase().starts_with("bearer"))
        .map(str::to_owned);
    Ok((answer.status().as_u16() == 401, header))
}

/// A JSON document at `url`, or None for anything but a 200 with a JSON object.
async fn json_at(url: &str) -> Option<Value> {
    secure(url).ok()?;
    let answer = http()
        .get(url)
        .header("accept", "application/json")
        .send()
        .await
        .ok()?;
    if !answer.status().is_success() {
        return None;
    }
    answer.json::<Value>().await.ok().filter(Value::is_object)
}

/// `origin + "/.well-known/<name>" + path`, and without the path when it has one (RFC 8414 and 9728's order).
fn well_known(base: &url::Url, name: &str) -> Vec<String> {
    let origin = base.origin().ascii_serialization();
    let path = base.path().trim_end_matches('/');
    let mut out = Vec::new();
    if !path.is_empty() {
        out.push(format!("{origin}/.well-known/{name}{path}"));
    }
    out.push(format!("{origin}/.well-known/{name}"));
    out
}

/// Whether the server at `url` asks for OAuth sign-in: a 401 with a Bearer challenge, or protected resource metadata.
pub async fn offers_sign_in(url: &str, sse: bool) -> bool {
    match knock(url, sse).await {
        Ok((true, Some(_))) => true,
        Ok((true, None)) => resource_metadata(url, None).await.is_some(),
        _ => false,
    }
}

async fn resource_metadata(url: &str, advertised: Option<&str>) -> Option<Value> {
    if let Some(at) = advertised
        && let Some(found) = json_at(at).await
    {
        return Some(found);
    }
    let base = url::Url::parse(url).ok()?;
    for candidate in well_known(&base, "oauth-protected-resource") {
        if let Some(found) = json_at(&candidate).await {
            return Some(found);
        }
    }
    None
}

/// Where the MCP server at `url` signs in. An `sse` server is knocked on with a GET, as its stream opens.
pub async fn discover(url: &str, sse: bool) -> Result<Discovered, String> {
    let host = host_of(url);
    secure(url)?;
    let (unauthorized, challenge) = knock(url, sse).await?;
    let advertised = challenge
        .as_deref()
        .and_then(|h| challenge_param(h, "resource_metadata"));
    let prm = resource_metadata(url, advertised.as_deref()).await;
    if !unauthorized && prm.is_none() {
        return Err(format!(
            "{host} answers without asking anyone to sign in: if it takes a key, add it with one instead"
        ));
    }
    let same_origin = |a: &str| {
        let origin = |u: &str| url::Url::parse(u).ok().map(|u| u.origin());
        origin(a).is_some() && origin(a) == origin(url)
    };
    let resource = prm
        .as_ref()
        .and_then(|p| p["resource"].as_str())
        .filter(|r| same_origin(r))
        .unwrap_or(url)
        .to_owned();
    let scope = challenge
        .as_deref()
        .and_then(|h| challenge_param(h, "scope"))
        .or_else(|| {
            let listed: Vec<&str> = prm
                .as_ref()?
                .get("scopes_supported")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .collect();
            (!listed.is_empty()).then(|| listed.join(" "))
        })
        .filter(|s| !s.trim().is_empty());
    // The resource names its authorization server; one without metadata is its own (MCP 2025-03-26).
    let (issuer, legacy) = match prm.as_ref().and_then(|p| {
        p["authorization_servers"]
            .as_array()?
            .first()?
            .as_str()
            .map(str::to_owned)
    }) {
        Some(issuer) => (issuer, false),
        None => {
            let base = url::Url::parse(url).map_err(|_| format!("{url} is no URL"))?;
            (base.origin().ascii_serialization(), true)
        }
    };
    let issuer_url = secure(&issuer)?;
    let mut candidates = well_known(&issuer_url, "oauth-authorization-server");
    candidates.extend(well_known(&issuer_url, "openid-configuration"));
    candidates.push(format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    ));
    candidates.dedup();
    let mut meta = None;
    for candidate in &candidates {
        if let Some(found) = json_at(candidate).await {
            meta = Some(found);
            break;
        }
    }
    let base = issuer.trim_end_matches('/');
    let (
        authorization_endpoint,
        token_endpoint,
        registration_endpoint,
        revocation_endpoint,
        auth_methods,
        pkce,
    ) = match &meta {
        Some(m) => {
            let s = |k: &str| m[k].as_str().map(str::to_owned);
            let list = |k: &str| -> Option<Vec<String>> {
                Some(
                    m.get(k)?
                        .as_array()?
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect(),
                )
            };
            (
                s("authorization_endpoint"),
                s("token_endpoint"),
                s("registration_endpoint"),
                s("revocation_endpoint"),
                list("token_endpoint_auth_methods_supported").unwrap_or_default(),
                list("code_challenge_methods_supported"),
            )
        }
        None if legacy => (
            Some(format!("{base}/authorize")),
            Some(format!("{base}/token")),
            Some(format!("{base}/register")),
            None,
            Vec::new(),
            None,
        ),
        None => {
            return Err(format!(
                "{} publishes no sign-in details (no OAuth authorization server metadata)",
                host_of(&issuer)
            ));
        }
    };
    if let Some(methods) = pkce
        && !methods.iter().any(|m| m == "S256")
    {
        return Err(format!(
            "{} doesn't support PKCE (S256), which fleetd needs to sign in safely",
            host_of(&issuer)
        ));
    }
    let need = |v: Option<String>, what: &str| -> Result<String, String> {
        let v = v.ok_or_else(|| format!("{} names no {what}", host_of(&issuer)))?;
        secure(&v)?;
        Ok(v)
    };
    let optional = |v: Option<String>| v.filter(|v| secure(v).is_ok());
    Ok(Discovered {
        resource,
        issuer: issuer.clone(),
        authorization_endpoint: need(authorization_endpoint, "sign-in page")?,
        token_endpoint: need(token_endpoint, "token endpoint")?,
        registration_endpoint: optional(registration_endpoint),
        revocation_endpoint: optional(revocation_endpoint),
        scope,
        auth_methods,
    })
}

/// The service's own words for an OAuth refusal: its `error_description`, else its `error` as code, else the status.
fn said(status: reqwest::StatusCode, body: &Value) -> (Option<String>, String) {
    let error = body["error"]
        .as_str()
        .filter(|e| !e.is_empty())
        .map(str::to_owned);
    let described = body["error_description"]
        .as_str()
        .map(str::trim)
        .filter(|d| !d.is_empty());
    let words = match (&error, described) {
        (_, Some(d)) => d.to_owned(),
        (Some(e), None) => format!("`{e}`"),
        (None, None) => format!("HTTP {}", status.as_u16()),
    };
    (error, words)
}

/// Registers fleetd as a client of the service for `redirect` (RFC 7591), a public one unless the service insists on
/// a secret.
pub async fn register(d: &Discovered, redirect: &str) -> Result<Registered, String> {
    let at = d
        .registration_endpoint
        .as_deref()
        .ok_or("the service doesn't let apps register themselves")?;
    let mut body = json!({
        "client_name": "fleetd",
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    if let Some(scope) = &d.scope {
        body["scope"] = Value::from(scope.as_str());
    }
    let host = host_of(at);
    let answer = http()
        .post(at)
        .header("accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format!(
                "{host} can't be reached to register fleetd: {}",
                crate::cli::mcp_client::describe(&e)
            )
        })?;
    let status = answer.status();
    let mut out: Value = answer.json().await.unwrap_or_default();
    if !status.is_success() {
        let (_, words) = said(status, &out);
        return Err(format!(
            "{host} wouldn't register fleetd as an app ({words})"
        ));
    }
    let client_id = out["client_id"]
        .as_str()
        .filter(|c| !c.is_empty())
        .ok_or_else(|| format!("{host} registered fleetd but sent no client id"))?
        .to_owned();
    let client_secret = match out.get_mut("client_secret").map(Value::take) {
        Some(Value::String(s)) if !s.is_empty() => Some(Zeroizing::new(s)),
        _ => None,
    };
    let token_auth = client_secret.as_ref().map(|_| {
        match out["token_endpoint_auth_method"].as_str() {
            Some("client_secret_post") => "client_secret_post",
            _ => "client_secret_basic",
        }
        .to_owned()
    });
    Ok(Registered {
        client_id,
        client_secret,
        token_auth,
    })
}

/// How to send a person's own client secret: the service's listed way, basic by default.
pub fn token_auth_for(methods: &[String]) -> String {
    if !methods.is_empty()
        && !methods.iter().any(|m| m == "client_secret_basic")
        && methods.iter().any(|m| m == "client_secret_post")
    {
        "client_secret_post".into()
    } else {
        "client_secret_basic".into()
    }
}

/// The sign-in page's address, with PKCE, the state and the resource.
pub fn authorize_url(
    endpoint: &str,
    client_id: &str,
    redirect: &str,
    challenge: &str,
    state: &str,
    scope: Option<&str>,
    resource: &str,
) -> Result<String, String> {
    let mut url = secure(endpoint)?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state)
            .append_pair("resource", resource);
        if let Some(scope) = scope {
            q.append_pair("scope", scope);
        }
    }
    Ok(url.into())
}

/// The client as the token endpoint sees it.
pub struct Client<'a> {
    pub id: &'a str,
    pub secret: Option<&'a str>,
    /// `client_secret_basic` or `client_secret_post`; ignored without a secret.
    pub auth: Option<&'a str>,
}

/// One call to the token endpoint: `form` is the grant's fields; the client and the resource are added.
pub async fn token(
    endpoint: &str,
    client: &Client<'_>,
    resource: &str,
    form: &[(&str, &str)],
) -> Result<Tokens, TokenError> {
    secure(endpoint).map_err(TokenError::Failed)?;
    let host = host_of(endpoint);
    let mut fields: Vec<(&str, &str)> = form.to_vec();
    fields.push(("resource", resource));
    let mut request = http().post(endpoint).header("accept", "application/json");
    match (client.secret, client.auth) {
        (Some(secret), Some("client_secret_post")) => {
            fields.push(("client_id", client.id));
            fields.push(("client_secret", secret));
        }
        (Some(secret), _) => {
            // RFC 6749 2.3.1: each form-encoded before the basic pair.
            let enc =
                |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
            request = request.basic_auth(enc(client.id), Some(enc(secret)));
        }
        (None, _) => fields.push(("client_id", client.id)),
    }
    let answer = request.form(&fields).send().await.map_err(|e| {
        TokenError::Failed(format!(
            "{host} can't be reached: {}",
            crate::cli::mcp_client::describe(&e)
        ))
    })?;
    let status = answer.status();
    let mut body: Value = answer.json().await.unwrap_or_default();
    if !status.is_success() || body.get("error").is_some() {
        let (error, words) = said(status, &body);
        let refused = matches!(
            error.as_deref(),
            Some("invalid_grant" | "invalid_client" | "unauthorized_client")
        );
        return Err(if refused {
            TokenError::Refused(words)
        } else {
            TokenError::Failed(format!("{host} answered {words}"))
        });
    }
    if let Some(kind) = body["token_type"].as_str()
        && !kind.eq_ignore_ascii_case("bearer")
    {
        return Err(TokenError::Failed(format!(
            "{host} sent a {kind} token; MCP takes a Bearer one"
        )));
    }
    let mut take = |k: &str| match body.get_mut(k).map(Value::take) {
        Some(Value::String(s)) if !s.is_empty() => Some(Zeroizing::new(s)),
        _ => None,
    };
    let access = take("access_token")
        .ok_or_else(|| TokenError::Failed(format!("{host} sent no access token")))?;
    let refresh = take("refresh_token");
    // A header value can't hold a line break.
    if access.contains(['\r', '\n']) {
        return Err(TokenError::Failed(format!(
            "{host} sent a token that isn't a header value"
        )));
    }
    let expires_in = body["expires_in"]
        .as_i64()
        .or_else(|| body["expires_in"].as_str()?.parse().ok())
        .filter(|s| *s > 0);
    Ok(Tokens {
        access,
        refresh,
        expires_in,
    })
}

/// Revokes `token` where the service offers it (RFC 7009); whether it said yes.
pub async fn revoke(endpoint: &str, client: &Client<'_>, token: &str, hint: &str) -> bool {
    if secure(endpoint).is_err() {
        return false;
    }
    let mut fields = vec![("token", token), ("token_type_hint", hint)];
    let mut request = http().post(endpoint);
    match (client.secret, client.auth) {
        (Some(secret), Some("client_secret_post")) => {
            fields.push(("client_id", client.id));
            fields.push(("client_secret", secret));
        }
        (Some(secret), _) => {
            let enc =
                |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
            request = request.basic_auth(enc(client.id), Some(enc(secret)));
        }
        (None, _) => fields.push(("client_id", client.id)),
    }
    request
        .form(&fields)
        .send()
        .await
        .is_ok_and(|a| a.status().is_success())
}
