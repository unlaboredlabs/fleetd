//! `fleetd push-relay`: runs the push relay (crate::push_relay), or with `set` points this hub at one.
use serde_json::json;

use super::args::{self, Kind, Spec};
use super::time::Hub;

pub const PUSH_RELAY_USAGE: &str = "  push-relay [--listen 127.0.0.1:4795]
             forward hubs' sealed phone notifications to APNs and FCM with your own
             credentials: FLEETD_APNS_KEY_FILE (a .p8), FLEETD_APNS_KEY_ID, FLEETD_APNS_TEAM_ID,
             FLEETD_APNS_TOPIC (the app's bundle id), FLEETD_APNS_SANDBOX=1 for development
             builds; FLEETD_FCM_SERVICE_ACCOUNT (a Firebase service account's JSON key).
             FLEETD_PUSH_RELAY_KEY_FILE (a file holding a key): take only hubs that send it; set one
             when the relay is reachable beyond this machine. It never reads, keeps or logs a
             notification. Run your own only for an app you build yourself
  push-relay set <url|off> [--relay-key-file <path>] [--hub <url> --key-file <path> | --home <dir>]
             hubs send phone notifications through https://push.fleetd.sh, the relay for the
             published app, without a key. <url> sends them through your own relay instead, with
             the key in --relay-key-file when it takes one, sealed to the hub;
             https://push.fleetd.sh goes back to the default; off sends none
             (admin key on every machine)
";

pub async fn push_relay_command(argv: &[String]) -> u8 {
    let spec = Spec {
        options: &[
            ("listen", Kind::Str),
            ("relay-key-file", Kind::Str),
            ("hub", Kind::Str),
            ("key-file", Kind::Str),
            ("home", Kind::Str),
        ],
        positionals: true,
    };
    let v = match args::parse(argv, &spec) {
        Ok(v) => v,
        Err(message) => {
            eprint!("fleetd: {message}\n\nusage:\n{PUSH_RELAY_USAGE}");
            return 2;
        }
    };
    match v.positionals.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        [] => serve(v.str("listen").unwrap_or(crate::push_relay::DEFAULT_LISTEN)).await,
        ["set", url] => set(&v, url).await,
        _ => {
            eprint!(
                "fleetd: push-relay takes `set <url|off>` or nothing\n\nusage:\n{PUSH_RELAY_USAGE}"
            );
            2
        }
    }
}

async fn serve(listen: &str) -> u8 {
    let Ok(listen) = listen.parse() else {
        eprintln!("fleetd push-relay: --listen must be <ip>:<port>, got '{listen}'");
        return 2;
    };
    let served = match crate::push_relay::Relay::from_env() {
        Ok(relay) => crate::push_relay::serve(listen, relay).await,
        Err(e) => Err(e),
    };
    match served {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("fleetd push-relay: {e}");
            1
        }
    }
}

async fn set(v: &args::Parsed, url: &str) -> u8 {
    let hub = match (v.string("hub"), v.string("key-file")) {
        (Some(hub), Some(key)) => Some((hub, key)),
        (None, None) => None,
        _ => {
            eprintln!("fleetd push-relay: --hub and --key-file go together");
            return 2;
        }
    };
    let mut hub = match Hub::connect(&hub, v.str("home"), "push-relay").await {
        Ok(hub) => hub,
        Err(code) => return code,
    };
    let url = if url == "off" { "" } else { url };
    let mut input = json!({ "url": url });
    if let Some(path) = v.str("relay-key-file") {
        let key = match std::fs::read_to_string(path) {
            Ok(key) => zeroize::Zeroizing::new(key),
            Err(e) => {
                eprintln!("fleetd push-relay: can't read {path}: {e}");
                return 1;
            }
        };
        // Sealed here to the hub's box key: the key never crosses the connection in the clear.
        let box_pub_key = match hub.call("hub_links_get", json!({})).await {
            Ok(got) => got["boxPubKey"].as_str().unwrap_or_default().to_owned(),
            Err(code) => return code,
        };
        let Some(sealed) = seal(&box_pub_key, key.trim().as_bytes()) else {
            eprintln!("fleetd push-relay: the hub sent no key to seal the relay's key to");
            return 1;
        };
        input["key"] = json!(sealed);
    }
    match hub.call("push_relay_set", input).await {
        Ok(set) => {
            let default = set["default"].as_bool() == Some(true);
            match (set["url"].as_str(), set["key"].as_bool() == Some(true)) {
                (Some(url), _) if default => {
                    println!("phone notifications go through {url}, the default relay")
                }
                (Some(url), true) => println!("phone notifications go through {url}, with its key"),
                (Some(url), false) => println!("phone notifications go through {url}"),
                (None, _) => println!("phone notifications are off"),
            }
            0
        }
        Err(code) => code,
    }
}

/// `plain` in a sealed box to `public_key`, standard base64.
fn seal(public_key: &str, plain: &[u8]) -> Option<String> {
    use base64::Engine;
    let public: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(public_key)
        .ok()?
        .try_into()
        .ok()?;
    Some(crate::hub::push::seal(&public, plain))
}
