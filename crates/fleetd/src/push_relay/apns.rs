//! APNs with token auth: an ES256 JWT from the publisher's .p8 key, renewed every 40 minutes (Apple takes one for an
//! hour and refuses a new one more often than every 20). Each push is an alert with `mutable-content: 1`, so the app's
//! Notification Service Extension decrypts `c` and shows the real text; the alert's own words are what shows if it
//! can't.
//!
//! Only 410 (Unregistered) marks a token dead outright. BadDeviceToken and DeviceTokenNotForTopic are what every token
//! gets when the relay has the wrong environment (`FLEETD_APNS_SANDBOX`) or bundle id, so they mark one dead only once
//! a push has gone through since the relay started, which proves its setup right.
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use serde_json::{Value, json};

use super::{Delivery, RelayPush};

pub const PRODUCTION: &str = "https://api.push.apple.com";
pub const SANDBOX: &str = "https://api.sandbox.push.apple.com";
const JWT_FOR: Duration = Duration::from_secs(40 * 60);
/// Shown when the extension can't decrypt (an app from before it, a key lost).
pub const FALLBACK_TITLE: &str = "fleetd";
pub const FALLBACK_BODY: &str = "New activity";

pub struct Apns {
    key: EcdsaKeyPair,
    key_id: String,
    team_id: String,
    /// The app's bundle id.
    topic: String,
    /// [`PRODUCTION`] or [`SANDBOX`] (a fake in tests).
    pub url: String,
    jwt: Mutex<Option<(Instant, String)>>,
    /// A push went through: the environment, topic and key are right.
    proven: AtomicBool,
}

impl Apns {
    /// `pem` is the .p8 file's text.
    pub fn new(
        pem: &str,
        key_id: &str,
        team_id: &str,
        topic: &str,
        url: &str,
    ) -> Result<Self, String> {
        let der = super::pem_der(pem).ok_or("the APNs key isn't a .p8 file")?;
        let key = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            &der,
            &ring::rand::SystemRandom::new(),
        )
        .map_err(|_| "the APNs key isn't an EC key Apple made")?;
        Ok(Self {
            key,
            key_id: key_id.to_owned(),
            team_id: team_id.to_owned(),
            topic: topic.to_owned(),
            url: url.trim_end_matches('/').to_owned(),
            jwt: Mutex::new(None),
            proven: AtomicBool::new(false),
        })
    }

    /// From `FLEETD_APNS_KEY_FILE`, `FLEETD_APNS_KEY_ID`, `FLEETD_APNS_TEAM_ID`, `FLEETD_APNS_TOPIC`, and
    /// `FLEETD_APNS_SANDBOX=1` for development builds. None without a key file.
    pub fn from_env() -> Result<Option<Self>, String> {
        let Some(pem) = super::read_named("FLEETD_APNS_KEY_FILE")? else {
            return Ok(None);
        };
        let sandbox = std::env::var("FLEETD_APNS_SANDBOX").is_ok_and(|v| v.trim() == "1");
        Self::new(
            &pem,
            &super::required("FLEETD_APNS_KEY_ID")?,
            &super::required("FLEETD_APNS_TEAM_ID")?,
            &super::required("FLEETD_APNS_TOPIC")?,
            if sandbox { SANDBOX } else { PRODUCTION },
        )
        .map(Some)
    }

    /// The provider token, made again once it is [`JWT_FOR`] old.
    fn jwt(&self) -> Result<String, String> {
        let mut cached = self.jwt.lock().unwrap();
        if let Some((made, jwt)) = cached.as_ref()
            && made.elapsed() < JWT_FOR
        {
            return Ok(jwt.clone());
        }
        let head =
            URL_SAFE_NO_PAD.encode(json!({ "alg": "ES256", "kid": self.key_id }).to_string());
        let claims = URL_SAFE_NO_PAD
            .encode(json!({ "iss": self.team_id, "iat": super::unix_now() }).to_string());
        let signed = format!("{head}.{claims}");
        let signature = self
            .key
            .sign(&ring::rand::SystemRandom::new(), signed.as_bytes())
            .map_err(|_| "the APNs key couldn't sign")?;
        let jwt = format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()));
        *cached = Some((Instant::now(), jwt.clone()));
        Ok(jwt)
    }

    /// The JSON APNs gets: a generic alert the extension replaces, and the ciphertext as `c`.
    pub fn body(push: &RelayPush) -> Value {
        json!({
            "aps": {
                "alert": { "title": FALLBACK_TITLE, "body": FALLBACK_BODY },
                "mutable-content": 1,
                "sound": "default",
            },
            "c": push.ciphertext,
        })
    }

    pub async fn send(&self, http: &reqwest::Client, push: &RelayPush) -> Delivery {
        let jwt = match self.jwt() {
            Ok(jwt) => jwt,
            Err(why) => return Delivery::Failed(why),
        };
        let mut request = http
            .post(format!("{}/3/device/{}", self.url, push.token))
            .bearer_auth(jwt)
            .header("apns-topic", &self.topic)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .json(&Self::body(push));
        if let Some(key) = &push.collapse_key {
            request = request.header("apns-collapse-id", key);
        }
        let answer = match request.send().await {
            Ok(answer) => answer,
            // Without the URL: it holds the token.
            Err(e) => {
                return Delivery::Failed(format!("APNs can't be reached: {}", e.without_url()));
            }
        };
        let status = answer.status().as_u16();
        if status == 200 {
            self.proven.store(true, Ordering::Relaxed);
            return Delivery::Sent;
        }
        let reason = answer
            .json::<Value>()
            .await
            .ok()
            .and_then(|b| b["reason"].as_str().map(str::to_owned))
            .unwrap_or_default();
        let environment = if self.url == SANDBOX {
            "sandbox"
        } else {
            "production"
        };
        match (status, reason.as_str()) {
            (410, _) => Delivery::Dead,
            (400, "BadDeviceToken" | "DeviceTokenNotForTopic")
                if self.proven.load(Ordering::Relaxed) =>
            {
                Delivery::Dead
            }
            (400, "BadDeviceToken" | "DeviceTokenNotForTopic") => Delivery::Failed(format!(
                "APNs answered {reason} and no push has gone through yet: the relay sends to {environment} \
                 (FLEETD_APNS_SANDBOX=1 for development builds, unset for TestFlight and release builds) as {} \
                 (FLEETD_APNS_TOPIC must be the app's bundle id)",
                self.topic
            )),
            (400, "BadTopic" | "TopicDisallowed" | "MissingTopic") | (403, "TopicDisallowed") => {
                Delivery::Failed(format!(
                    "APNs refused the topic {} ({reason}): FLEETD_APNS_TOPIC must be the app's bundle id, \
                     and the .p8 key must be from the same team",
                    self.topic
                ))
            }
            (403, "ExpiredProviderToken" | "InvalidProviderToken") => {
                *self.jwt.lock().unwrap() = None;
                Delivery::Failed(format!(
                    "APNs refused the provider token ({reason}): FLEETD_APNS_KEY_ID and FLEETD_APNS_TEAM_ID must \
                     be the .p8 key's"
                ))
            }
            _ => Delivery::Failed(format!("APNs answered {status} {reason}")),
        }
    }
}
