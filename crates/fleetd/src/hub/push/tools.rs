//! The push tools: push_device_register, push_devices_list and push_device_remove for a person's own phones (a human
//! key with a person), and push_relay_set for a key with Admin on every machine.
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    ErrorCode, PushDeviceRegisterInput, PushDeviceRegisterOutput, PushDeviceRemoveInput,
    PushDeviceRemoveOutput, PushDevicesListInput, PushDevicesListOutput, PushRelaySetInput,
    PushRelaySetOutput,
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
            Ok(Ok((device, super::relay(c)?.is_some())))
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
            "The hub has no push relay yet: an owner or admin sets one with push_relay_set.".into()
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
    let (devices, relay) = hub
        .db
        .with(|c| Ok((super::list(c, &me)?, super::relay(c)?.is_some())))?;
    Ok(PushDevicesListOutput {
        devices: List::unchecked(devices),
        relay,
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
        Some(url.to_owned())
    };
    hub.db
        .transaction(|c| super::set_relay(c, url.as_deref()))?;
    Ok(PushRelaySetOutput {
        url,
        next: None,
        truncated: None,
    })
}
