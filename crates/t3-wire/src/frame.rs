//! Effect RPC's JSON framing (effect 4 `RpcSerialization.json` + `RpcMessage`), as T3's `/ws` speaks it.
//!
//! One JSON value per WebSocket text frame; a frame holding an array carries several messages. The client sends
//! `Request`, `Ack` (after taking each stream `Chunk`; the server sends the next chunk only after it), `Interrupt`,
//! `Ping` and `Eof`; the server sends `Chunk`, `Exit`, `Defect` and `Pong`. Request ids are numbers counting up
//! from 0 per client, as effect's `RpcClient` makes them. Key order matches what effect's client writes.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "_tag")]
pub enum ClientMessage {
    Request {
        id: u64,
        tag: String,
        payload: Value,
        /// Effect sends `Object.entries(headers)`; T3 needs none.
        headers: Vec<(String, String)>,
    },
    Ack {
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    Interrupt {
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    Ping,
    Eof,
}

impl ClientMessage {
    pub fn encode(&self) -> String {
        serde_json::to_string(self).expect("client messages always serialize")
    }
}

/// The server echoes the request id as it got it; effect's codec allows a string or a number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestId(pub u64);

impl<'de> Deserialize<'de> for RequestId {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            N(u64),
            S(String),
        }
        match Raw::deserialize(d)? {
            Raw::N(n) => Ok(RequestId(n)),
            Raw::S(s) => s.parse().map(RequestId).map_err(serde::de::Error::custom),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "_tag")]
pub enum ServerMessage {
    Chunk {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        values: Vec<Value>,
    },
    Exit {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        exit: ExitEncoded,
    },
    /// A failure not tied to one request: every in-flight request fails with it.
    Defect {
        defect: Value,
    },
    Pong,
    /// Anything else the server might send (effect also defines `ClientProtocolError`, client-side only).
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "_tag")]
pub enum ExitEncoded {
    /// A stream's exit carries no value (`undefined` drops out of the JSON).
    Success {
        #[serde(default)]
        value: Value,
    },
    Failure {
        cause: Vec<CauseEncoded>,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "_tag")]
pub enum CauseEncoded {
    Fail {
        error: Value,
    },
    Die {
        #[serde(default)]
        defect: Value,
    },
    Interrupt {
        #[serde(rename = "fiberId", default)]
        fiber_id: Option<Value>,
    },
}

/// Decodes one text frame into its messages.
pub fn decode_frame(text: &str) -> Result<Vec<ServerMessage>, serde_json::Error> {
    match serde_json::from_str::<Value>(text)? {
        Value::Array(items) => items.into_iter().map(serde_json::from_value).collect(),
        one => Ok(vec![serde_json::from_value(one)?]),
    }
}
