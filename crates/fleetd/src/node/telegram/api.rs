//! The Telegram Bot API, as the bridge uses it: JSON calls to `<base>/bot<token>/<method>`, uploads as
//! multipart/form-data, and file downloads from `<base>/file/bot<token>/<path>`. The token is in every URL, so no
//! error carries a URL (`without_url`), and every message the node keeps or sends passes [`Api::mask`].
use std::time::Duration;

use rand::RngCore;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::node::mask::Masker;

/// Telegram's own server.
pub const TELEGRAM: &str = "https://api.telegram.org";
/// How a masked token reads.
pub const TOKEN_NAME: &str = "TELEGRAM_BOT_TOKEN";

#[derive(Debug, Clone, PartialEq)]
pub enum ApiError {
    /// 401: the token is wrong or was revoked.
    Unauthorized,
    /// 409: another getUpdates (another program with this token) is reading.
    Conflict,
    /// 429: wait this many seconds.
    RateLimited(u64),
    /// Any other answer Telegram refused, in its words.
    Refused(String),
    /// Telegram couldn't be reached, or failed (5xx, a broken answer).
    Down(String),
}

impl ApiError {
    /// Plain words for the person, the token masked.
    pub fn words(&self) -> String {
        match self {
            Self::Unauthorized => {
                "Telegram refused the token: it is wrong or was revoked. Paste a new one from @BotFather.".into()
            }
            Self::Conflict => "Another program is reading this bot's messages. Stop it, or make a new bot for this Navi.".into(),
            Self::RateLimited(s) => format!("Telegram asked to slow down for {s} s."),
            Self::Refused(why) => format!("Telegram said: {why}"),
            Self::Down(why) => format!("Telegram couldn't be reached: {why}"),
        }
    }
}

pub struct Api {
    base: String,
    token: Zeroizing<String>,
    masker: Masker,
    http: reqwest::Client,
}

impl Api {
    pub fn new(base: &str, token: Zeroizing<String>) -> Self {
        let masker = Masker::new(&[(TOKEN_NAME.to_owned(), token.to_string())]);
        Self {
            base: base.trim_end_matches('/').to_owned(),
            token,
            masker,
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
        }
    }

    /// `text` with the token masked.
    pub fn mask(&self, text: &str) -> String {
        self.masker.text(text).into_owned()
    }

    fn url(&self, method: &str) -> String {
        format!("{}/bot{}/{method}", self.base, self.token.as_str())
    }

    fn down(&self, e: reqwest::Error) -> ApiError {
        let e = e.without_url();
        let why = if e.is_timeout() {
            "it didn't answer in time".to_owned()
        } else if e.is_connect() {
            "no connection".to_owned()
        } else {
            e.to_string()
        };
        ApiError::Down(self.mask(&why))
    }

    /// One answer: its `result`, or what went wrong.
    async fn answer(&self, response: reqwest::Response) -> Result<Value, ApiError> {
        let status = response.status();
        let body: Value = match response.json().await {
            Ok(body) => body,
            Err(_) if status.is_server_error() => {
                return Err(ApiError::Down(format!("it answered {status}")));
            }
            Err(e) => return Err(self.down(e)),
        };
        if body["ok"] == true {
            return Ok(body["result"].clone());
        }
        let said = self.mask(body["description"].as_str().unwrap_or("no reason given"));
        Err(
            match body["error_code"]
                .as_u64()
                .unwrap_or(status.as_u16().into())
            {
                // A token of the wrong shape is a 404 for the whole bot path.
                401 => ApiError::Unauthorized,
                404 if said == "Not Found" => ApiError::Unauthorized,
                409 => ApiError::Conflict,
                429 => ApiError::RateLimited(
                    body["parameters"]["retry_after"]
                        .as_u64()
                        .unwrap_or(5)
                        .clamp(1, 3600),
                ),
                code if code >= 500 => ApiError::Down(said),
                _ => ApiError::Refused(said),
            },
        )
    }

    /// A JSON call that may take up to `wait`.
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        wait: Duration,
    ) -> Result<Value, ApiError> {
        let response = self
            .http
            .post(self.url(method))
            .timeout(wait)
            .json(&params)
            .send()
            .await
            .map_err(|e| self.down(e))?;
        self.answer(response).await
    }

    /// An upload: `fields` as text parts, then the file as `file_field`.
    pub async fn upload(
        &self,
        method: &str,
        fields: &[(&str, String)],
        file_field: &str,
        name: &str,
        mime: &str,
        bytes: &[u8],
    ) -> Result<Value, ApiError> {
        let (boundary, body) = multipart(fields, file_field, name, mime, bytes);
        let response = self
            .http
            .post(self.url(method))
            .timeout(Duration::from_secs(120))
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .map_err(|e| self.down(e))?;
        self.answer(response).await
    }

    /// A file by the `file_path` getFile gave, at most `max` bytes.
    pub async fn download(&self, file_path: &str, max: usize) -> Result<Vec<u8>, ApiError> {
        let url = format!("{}/file/bot{}/{file_path}", self.base, self.token.as_str());
        let response = self
            .http
            .get(url)
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| self.down(e))?;
        if !response.status().is_success() {
            return Err(ApiError::Down(format!(
                "the file download answered {}",
                response.status()
            )));
        }
        if response.content_length().is_some_and(|n| n > max as u64) {
            return Err(ApiError::Refused("the file is too large".into()));
        }
        let bytes = response.bytes().await.map_err(|e| self.down(e))?;
        if bytes.len() > max {
            return Err(ApiError::Refused("the file is too large".into()));
        }
        Ok(bytes.to_vec())
    }

    /// getFile, then the download: the file's bytes.
    pub async fn file(&self, file_id: &str, max: usize) -> Result<Vec<u8>, ApiError> {
        let got = self
            .call(
                "getFile",
                json!({ "file_id": file_id }),
                Duration::from_secs(30),
            )
            .await?;
        let Some(path) = got["file_path"].as_str() else {
            return Err(ApiError::Refused(
                "Telegram gave no path for the file".into(),
            ));
        };
        self.download(path, max).await
    }
}

/// A multipart/form-data body by hand: text fields, then one file.
fn multipart(
    fields: &[(&str, String)],
    file_field: &str,
    name: &str,
    mime: &str,
    bytes: &[u8],
) -> (String, Vec<u8>) {
    let mut random = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let boundary: String = format!(
        "fleetd{}",
        random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    let clean = |s: &str| s.replace(['"', '\r', '\n', '\\'], "_");
    let mut body = Vec::with_capacity(bytes.len() + 1024);
    for (field, value) in fields {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{value}\r\n",
                clean(field)
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
            clean(file_field),
            clean(name),
            clean(mime)
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (boundary, body)
}
