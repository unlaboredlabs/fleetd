//! FCM HTTP v1 with a Firebase service account: an RS256 JWT traded at the account's `token_uri` for an access token
//! (RFC 7523), kept until a minute before it expires. Each push is a high-priority data message carrying the
//! ciphertext as `c`; the app decrypts it and posts the notification itself.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::RsaKeyPair;
use serde_json::{Value, json};

use super::{Delivery, RelayPush};

pub const API: &str = "https://fcm.googleapis.com";
const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";

pub struct Fcm {
    key: RsaKeyPair,
    client_email: String,
    project_id: String,
    token_uri: String,
    /// [`API`] (a fake in tests).
    pub url: String,
    access: Mutex<Option<(Instant, String)>>,
}

impl Fcm {
    /// `account` is the service account's JSON key file.
    pub fn new(account: &str, url: &str) -> Result<Self, String> {
        let account: Value =
            serde_json::from_str(account).map_err(|_| "the FCM service account isn't JSON")?;
        let text = |k: &str| {
            account[k]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("the FCM service account has no {k}"))
        };
        let der = super::pem_der(&text("private_key")?)
            .ok_or("the FCM service account's private_key isn't PEM")?;
        let key = RsaKeyPair::from_pkcs8(&der)
            .map_err(|_| "the FCM service account's private_key isn't an RSA key Google made")?;
        Ok(Self {
            key,
            client_email: text("client_email")?,
            project_id: text("project_id")?,
            token_uri: text("token_uri")
                .unwrap_or_else(|_| "https://oauth2.googleapis.com/token".into()),
            url: url.trim_end_matches('/').to_owned(),
            access: Mutex::new(None),
        })
    }

    /// From `FLEETD_FCM_SERVICE_ACCOUNT`, the path of the key file. None without one.
    pub fn from_env() -> Result<Option<Self>, String> {
        match super::read_named("FLEETD_FCM_SERVICE_ACCOUNT")? {
            None => Ok(None),
            Some(account) => Self::new(&account, API).map(Some),
        }
    }

    async fn access_token(&self, http: &reqwest::Client) -> Result<String, String> {
        if let Some((until, token)) = self.access.lock().unwrap().as_ref()
            && Instant::now() < *until
        {
            return Ok(token.clone());
        }
        let now = super::unix_now();
        let head = URL_SAFE_NO_PAD.encode(json!({ "alg": "RS256", "typ": "JWT" }).to_string());
        let claims = URL_SAFE_NO_PAD.encode(
            json!({
                "iss": self.client_email, "scope": SCOPE, "aud": self.token_uri,
                "iat": now, "exp": now + 3600,
            })
            .to_string(),
        );
        let signed = format!("{head}.{claims}");
        let mut signature = vec![0; self.key.public().modulus_len()];
        self.key
            .sign(
                &ring::signature::RSA_PKCS1_SHA256,
                &ring::rand::SystemRandom::new(),
                signed.as_bytes(),
                &mut signature,
            )
            .map_err(|_| "the FCM service account couldn't sign")?;
        let assertion = format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature));
        let answer = http
            .post(&self.token_uri)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .await
            .map_err(|e| format!("Google's token endpoint can't be reached: {e}"))?;
        let status = answer.status();
        let body: Value = answer.json().await.unwrap_or_default();
        let (Some(token), true) = (body["access_token"].as_str(), status.is_success()) else {
            return Err(format!("Google refused the FCM service account ({status})"));
        };
        let lasts = body["expires_in"]
            .as_u64()
            .unwrap_or(3600)
            .saturating_sub(60);
        *self.access.lock().unwrap() = Some((
            Instant::now() + Duration::from_secs(lasts),
            token.to_owned(),
        ));
        Ok(token.to_owned())
    }

    /// The JSON FCM gets: a data message, so the app decrypts it before anything shows.
    pub fn body(push: &RelayPush) -> Value {
        let mut android = json!({ "priority": "high" });
        if let Some(key) = &push.collapse_key {
            android["collapse_key"] = json!(key);
        }
        json!({ "message": { "token": push.token, "data": { "c": push.ciphertext }, "android": android } })
    }

    pub async fn send(&self, http: &reqwest::Client, push: &RelayPush) -> Delivery {
        let token = match self.access_token(http).await {
            Ok(token) => token,
            Err(why) => return Delivery::Failed(why),
        };
        let answer = match http
            .post(format!(
                "{}/v1/projects/{}/messages:send",
                self.url, self.project_id
            ))
            .bearer_auth(token)
            .json(&Self::body(push))
            .send()
            .await
        {
            Ok(answer) => answer,
            Err(e) => return Delivery::Failed(format!("FCM can't be reached: {e}")),
        };
        let status = answer.status().as_u16();
        if status == 200 {
            return Delivery::Sent;
        }
        let body: Value = answer.json().await.unwrap_or_default();
        let unregistered = body["error"]["details"]
            .as_array()
            .is_some_and(|d| d.iter().any(|d| d["errorCode"] == "UNREGISTERED"));
        if status == 401 {
            *self.access.lock().unwrap() = None;
        }
        if status == 404 || unregistered {
            return Delivery::Dead;
        }
        Delivery::Failed(format!(
            "FCM answered {status} {}",
            body["error"]["status"].as_str().unwrap_or_default()
        ))
    }
}
