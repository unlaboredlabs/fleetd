//! The push tools: push_device_register, push_devices_list, push_device_remove and push_badge for a person's own phones
//! (a human key with a person), and push_relay_set for a key with Admin on every machine.
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    ErrorCode, PushBadgeInput, PushBadgeOutput, PushDeviceRegisterInput, PushDeviceRegisterOutput,
    PushDeviceRemoveInput, PushDeviceRemoveOutput, PushDevicesListInput, PushDevicesListOutput,
    PushRelaySetInput, PushRelaySetOutput,
};
use fleetd_contracts::people::PersonId;
use fleetd_contracts::prim::List;
use fleetd_contracts::push::PUSH_DEVICES_MAX;

use crate::hub::api::{Caller, Hub, Registry, ToolError, allows_everywhere, error, is_human};
use crate::hub::store::now_ms;

pub fn register(tools: &mut Registry) {
    tools.add("push_device_register", push_device_register);
    tools.add("push_devices_list", push_devices_list);
    tools.add("push_device_remove", push_device_remove);
    tools.add("push_badge", push_badge);
    tools.add("push_relay_set", push_relay_set);
}

/// The caller's person: phones are a person's, so only a person's own device registers or reads them.
fn person(caller: &Caller) -> Result<PersonId, ToolError> {
    caller
        .person
        .as_ref()
        .filter(|_| is_human(caller))
        .map(|p| p.person_id.clone())
        .ok_or_else(|| {
            error(
                ErrorCode::Forbidden,
                "Phone notifications are a person's: only a person's own paired device registers them.",
                "Pair the phone with the hub (`fleetd pair` or an invite), then register it from the app.",
            )
        })
}

async fn push_device_register(
    hub: Arc<Hub>,
    caller: Caller,
    input: PushDeviceRegisterInput,
) -> Result<PushDeviceRegisterOutput, ToolError> {
    let me = person(&caller)?;
    let public_key: [u8; 32] = B64
        .decode(input.public_key.as_str().trim())
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or_else(|| {
            error(
                ErrorCode::Invalid,
                "publicKey isn't an X25519 public key.",
                "Send the device's 32-byte public key in standard base64.",
            )
        })?;
    let token = input.token.as_str().trim();
    if token.is_empty() || token.chars().any(char::is_whitespace) {
        return Err(error(
            ErrorCode::Invalid,
            "token isn't a push token.",
            "Send the APNs device token or the FCM registration token as the OS gave it.",
        ));
    }
    let now = now_ms(hub.clock.as_ref());
    let (device, relay) = hub
        .db
        .transaction(|c| {
            let mine = super::list(c, &me)?;
            let known: bool = c
                .prepare_cached("SELECT 1 FROM push_devices WHERE token = ? AND person_id = ?")?
                .query_row([token, me.as_str()], |_| Ok(()))
                .is_ok();
            if !known && mine.len() >= PUSH_DEVICES_MAX {
                return Ok(Err(()));
            }
            let device = super::register(
                c,
                &super::NewDevice {
                    person: &me,
                    key_id: caller.key_id.as_str(),
                    platform: input.platform,
                    token,
                    public_key: &public_key,
                    name: input.name.as_str(),
                },
                now,
            )?;
            Ok(Ok((
                device,
                super::relay(c, super::DEFAULT_RELAY)?.is_some(),
            )))
        })?
        .map_err(|()| {
            error(
                ErrorCode::Invalid,
                format!("You have {PUSH_DEVICES_MAX} phones registered already."),
                "Remove one with push_device_remove, then register this one.",
            )
        })?;
    Ok(PushDeviceRegisterOutput {
        device,
        relay,
        next: (!relay).then(|| {
            "Phone notifications are off on this hub: an owner or admin turns them on with push_relay_set.".into()
        }),
        truncated: None,
    })
}

async fn push_devices_list(
    hub: Arc<Hub>,
    caller: Caller,
    _input: PushDevicesListInput,
) -> Result<PushDevicesListOutput, ToolError> {
    let me = person(&caller)?;
    let (devices, relay) = hub.db.with(|c| {
        Ok((
            super::list(c, &me)?,
            super::relay(c, super::DEFAULT_RELAY)?.is_some(),
        ))
    })?;
    Ok(PushDevicesListOutput {
        devices: List::unchecked(devices),
        relay,
        next: None,
        truncated: None,
    })
}

async fn push_badge(
    hub: Arc<Hub>,
    caller: Caller,
    _input: PushBadgeInput,
) -> Result<PushBadgeOutput, ToolError> {
    let me = person(&caller)?;
    Ok(PushBadgeOutput {
        badge: super::badge(&hub, &me)?,
        next: None,
        truncated: None,
    })
}

async fn push_device_remove(
    hub: Arc<Hub>,
    caller: Caller,
    input: PushDeviceRemoveInput,
) -> Result<PushDeviceRemoveOutput, ToolError> {
    let me = person(&caller)?;
    let device = hub
        .db
        .transaction(|c| super::remove(c, &me, &input.device_id))?
        .ok_or_else(|| {
            error(
                ErrorCode::NotFound,
                format!("You have no phone {}.", input.device_id),
                "Call push_devices_list to see your phones.",
            )
        })?;
    Ok(PushDeviceRemoveOutput {
        device,
        next: None,
        truncated: None,
    })
}

async fn push_relay_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: PushRelaySetInput,
) -> Result<PushRelaySetOutput, ToolError> {
    // Every person's notifications go through it.
    if !allows_everywhere(&caller, Role::Admin) {
        return Err(error(
            ErrorCode::Forbidden,
            "The push relay is hub-wide: it needs Admin on every machine.",
            "Ask an owner or admin of the hub, or run `fleetd push-relay set` on the hub.",
        ));
    }
    let url = input.url.as_str().trim().trim_end_matches('/');
    let url = if url.is_empty() {
        None
    } else {
        let parsed = url::Url::parse(url).ok().filter(|u| {
            matches!(u.scheme(), "http" | "https") && u.host_str().is_some() && u.query().is_none()
        });
        if parsed.is_none() {
            return Err(error(
                ErrorCode::Invalid,
                format!("{url} isn't an http(s) URL."),
                "Give the relay's address, such as https://push.example.com or http://devbox:4795.",
            ));
        }
        // The public relay takes no key, and nothing goes to it in the clear.
        if super::default_host(url) && (!url.starts_with("https://") || input.key.is_some()) {
            return Err(error(
                ErrorCode::Invalid,
                format!(
                    "{} takes pushes over https, without a key.",
                    super::DEFAULT_RELAY
                ),
                format!("Set {} without a relay key.", super::DEFAULT_RELAY),
            ));
        }
        Some(url.to_owned())
    };
    let key_sealed = match (&url, &input.key) {
        (Some(_), Some(sealed)) => Some(reseal(&hub, sealed.as_str())?),
        _ => None,
    };
    // Off is kept as an empty URL, so it outlasts a restart; the default relay without a key is kept as no setting,
    // so it follows DEFAULT_RELAY.
    let relay = match url {
        None => Some(super::RelaySetting {
            url: String::new(),
            key_sealed: None,
        }),
        Some(url) if url == super::DEFAULT_RELAY && key_sealed.is_none() => None,
        Some(url) => Some(super::RelaySetting { url, key_sealed }),
    };
    let relay = hub.db.transaction(|c| {
        super::set_relay(c, relay.as_ref())?;
        super::relay(c, super::DEFAULT_RELAY)
    })?;
    Ok(PushRelaySetOutput {
        key: relay.as_ref().is_some_and(|r| r.key_sealed.is_some()),
        default: relay
            .as_ref()
            .is_some_and(|r| r.url == super::DEFAULT_RELAY && r.key_sealed.is_none()),
        url: relay.map(|r| r.url),
        next: None,
        truncated: None,
    })
}

/// The relay's key, sealed to this hub's box key by the caller: opened to check it and trim a pasted newline, then
/// sealed again to the hub.
fn reseal(hub: &Hub, sealed: &str) -> Result<String, ToolError> {
    let refused = || {
        error(
            ErrorCode::Invalid,
            "The relay key wasn't sealed to this hub, or is empty.",
            "Seal the relay's key to boxPubKey from hub_links_get, or run `fleetd push-relay set <url> --relay-key-file <path>`.",
        )
    };
    let box_key = crate::hub::hub_links::box_key(hub).map_err(|e| {
        tracing::error!(error = %e, "push: the hub's box key");
        crate::hub::api::internal_error()
    })?;
    let plain = B64
        .decode(sealed)
        .ok()
        .and_then(|s| box_key.open(&s))
        .and_then(|p| String::from_utf8(p.to_vec()).ok())
        .map(zeroize::Zeroizing::new)
        .ok_or_else(refused)?;
    let key = plain.trim();
    if key.is_empty() || key.chars().any(char::is_whitespace) {
        return Err(refused());
    }
    let resealed = box_key
        .seal(key.as_bytes())
        .ok_or_else(crate::hub::api::internal_error)?;
    Ok(B64.encode(resealed))
}
