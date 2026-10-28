//! `fleetd push-relay`: runs the push relay (crate::push_relay), or with `set` points this hub at one.
use serde_json::json;

use super::args::{self, Kind, Spec};
use super::time::Hub;

pub const PUSH_RELAY_USAGE: &str = "  push-relay [--listen 127.0.0.1:4795]
             forward hubs' sealed phone notifications to APNs and FCM with your own
             credentials: FLEETD_APNS_KEY_FILE (a .p8), FLEETD_APNS_KEY_ID, FLEETD_APNS_TEAM_ID,
             FLEETD_APNS_TOPIC (the app's bundle id), FLEETD_APNS_SANDBOX=1 for development
             builds; FLEETD_FCM_SERVICE_ACCOUNT (a Firebase service account's JSON key). It
             never reads, keeps or logs a notification
  push-relay set <url|off> [--hub <url> --key-file <path> | --home <dir>]
             send this hub's phone notifications through the relay at <url>; off sends none
             (admin key on every machine)
";

pub async fn push_relay_command(argv: &[String]) -> u8 {
    let spec = Spec {
        options: &[
            ("listen", Kind::Str),
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
    match hub.call("push_relay_set", json!({ "url": url })).await {
        Ok(set) => {
            match set["url"].as_str() {
                Some(url) => println!("phone notifications go through {url}"),
                None => println!("phone notifications are off"),
            }
            0
        }
        Err(code) => code,
    }
}
