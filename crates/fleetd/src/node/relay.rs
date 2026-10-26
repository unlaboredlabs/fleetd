//! The node's ends of a session relay (hub/machine_roles/relay.rs), for sessions the hub placed on another machine
//! than their agent's. On the agent's machine, the broker's proxy hands each connection of the agent's driver to
//! [`to_hub`], which connects the session's relay on the hub. On the runner, each `relay_dial` from the hub is a
//! channel [`dial`] connects between the hub and the session's own end (its CDP proxy now; a device's stream later).
//! Both pipe frames as they are and log neither frames, payloads nor the relay's URL, whose path is its token.
use fleetd_contracts::machine_roles::{RELAY_PATH, RelayDialFrame, RelayStream};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use super::browser::Broker;

/// As the proxy and the hub's relay allow: a full-page screenshot or a large DOM is several MB.
const MAX_MESSAGE: usize = 128 << 20;

fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_frame_size(Some(MAX_MESSAGE))
        .max_message_size(Some(MAX_MESSAGE))
}

/// The hub's relay at `token`, from the hub's URL as node.json names it.
pub fn relay_url(hub: &str, token: &str) -> Result<String, String> {
    let mut url =
        reqwest::Url::parse(hub).map_err(|e| format!("hub URL '{hub}' does not parse: {e}"))?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_path(&format!("{RELAY_PATH}{token}"));
    url.set_query(None);
    url.set_fragment(None);
    let rest = &url.as_str()[url.scheme().len()..];
    Ok(format!("{scheme}{rest}"))
}

async fn connect(
    url: &str,
) -> Result<
    WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::tungstenite::Error,
> {
    tokio_tungstenite::connect_async_with_config(url, Some(config()), false)
        .await
        .map(|(ws, _)| ws)
}

/// The agent's side: one connection of its driver, piped to the session's relay on the hub.
pub async fn to_hub<S>(mut driver: WebSocketStream<S>, relay: &str)
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    match connect(relay).await {
        Ok(hub) => pipe(driver, hub).await,
        Err(_) => {
            // Its error may quote the URL, and with it the token.
            tracing::info!("session relay: hub not reached");
            let _ = driver
                .close(Some(CloseFrame {
                    code: CloseCode::Again,
                    reason: "the browser's machine can't be reached through the hub".into(),
                }))
                .await;
        }
    }
}

/// The runner's side: the hub's channel for a session hosted here, piped to the session's own end.
pub async fn dial(hub: &str, broker: &Broker, frame: RelayDialFrame) {
    let target = match frame.stream {
        RelayStream::Cdp => broker.cdp_url(frame.host_key.as_str()),
    };
    let (Some(target), Ok(relay)) = (target, relay_url(hub, frame.token.as_str())) else {
        tracing::info!("session relay: nothing here to connect");
        return;
    };
    let (session, hub) = match tokio::join!(connect(&target), connect(&relay)) {
        (Ok(session), Ok(hub)) => (session, hub),
        _ => {
            tracing::info!("session relay: channel not connected");
            return;
        }
    };
    pipe(session, hub).await;
}

/// Each side's frames to the other as they come, until either side closes.
pub async fn pipe<A, B>(a: WebSocketStream<A>, b: WebSocketStream<B>)
where
    A: AsyncRead + AsyncWrite + Unpin + Send,
    B: AsyncRead + AsyncWrite + Unpin + Send,
{
    let (mut a_out, mut a_in) = a.split();
    let (mut b_out, mut b_in) = b.split();
    let a_to_b = async {
        while let Some(Ok(message)) = a_in.next().await {
            if matches!(message, Message::Frame(_)) {
                continue;
            }
            let end = matches!(message, Message::Close(_));
            if b_out.send(message).await.is_err() || end {
                break;
            }
        }
        let _ = b_out.close().await;
    };
    let b_to_a = async {
        while let Some(Ok(message)) = b_in.next().await {
            if matches!(message, Message::Frame(_)) {
                continue;
            }
            let end = matches!(message, Message::Close(_));
            if a_out.send(message).await.is_err() || end {
                break;
            }
        }
        let _ = a_out.close().await;
    };
    tokio::select! {
        () = a_to_b => {}
        () = b_to_a => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_relay_is_on_the_hubs_own_address() {
        let token = "ab".repeat(32);
        assert_eq!(
            relay_url("http://devbox.example.ts.net:4790", &token).unwrap(),
            format!("ws://devbox.example.ts.net:4790/relay/{token}")
        );
        assert_eq!(
            relay_url("https://hub.example.com/", &token).unwrap(),
            format!("wss://hub.example.com/relay/{token}")
        );
    }
}
