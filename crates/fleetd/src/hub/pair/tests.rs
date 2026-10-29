use super::*;
use crate::hub::api::{CallError, Caller, ToolError};
use crate::hub::store::test_clock::ManualClock;
use std::time::Duration;

fn setup() -> (PairCodes, Arc<HubDb>, Arc<ManualClock>) {
    let db = HubDb::open_memory().unwrap();
    let clock = ManualClock::at(1_000_000);
    (PairCodes::new(db.clone(), clock.clone()), db, clock)
}

#[test]
fn new_codes_are_eight_crockford_chars_split_by_a_hyphen() {
    for _ in 0..200 {
        let code = new_code();
        assert_eq!(code.len(), 9, "{code}");
        assert_eq!(&code[4..5], "-");
        assert!(
            code.bytes()
                .filter(|&b| b != b'-')
                .all(|b| ALPHABET.contains(&b) && !b"ILOU".contains(&b)),
            "{code}"
        );
        assert_eq!(normalize(&code).unwrap(), code.replace('-', ""));
    }
}

#[test]
fn codes_parse_in_any_case_with_or_without_the_hyphen_and_with_look_alikes() {
    let canon = Some("0123ABCD".to_owned());
    assert_eq!(normalize("0123-ABCD"), canon);
    assert_eq!(normalize("0123abcd"), canon);
    assert_eq!(normalize("  0123-abcd \n"), canon);
    assert_eq!(normalize("oI23-AbCd"), canon);
    assert_eq!(normalize("OIL3ABCD"), Some("0113ABCD".to_owned()));
    for bad in [
        "0123-ABC",
        "0123-ABCDE",
        "012-3ABCD",
        "0123--ABCD",
        "0123-ABCU",
        "0123 ABCD",
        "",
    ] {
        assert_eq!(normalize(bad), None, "{bad}");
    }
}

#[test]
fn a_code_redeems_once_in_any_spelling_and_returns_its_name() {
    let (codes, db, _) = setup();
    let minted = codes.create(Some("laptop"), Role::Operate).unwrap();
    let stored: String = db
        .with(|c| Ok(c.query_row("SELECT hash FROM pair_codes", [], |r| r.get(0))?))
        .unwrap();
    assert_ne!(
        stored,
        minted.code.replace('-', ""),
        "only the hash is stored"
    );
    let typed = minted.code.to_lowercase().replace('-', "");
    assert_eq!(
        codes.redeem(&typed).map(|r| (r.name, r.role)).unwrap(),
        (Some("laptop".to_owned()), Role::Operate)
    );
    assert!(matches!(
        codes.redeem(&minted.code),
        Err(RedeemError::Invalid)
    ));
    assert!(matches!(
        codes.redeem("0000-0000"),
        Err(RedeemError::Invalid)
    ));
}

#[test]
fn a_code_expires_after_fifteen_minutes() {
    let (codes, _, clock) = setup();
    let early = codes.create(None, DEFAULT_ROLE).unwrap();
    let late = codes.create(None, DEFAULT_ROLE).unwrap();
    assert_eq!(late.expires_at, iso_ms(1_000_000 + CODE_TTL_MS));
    clock.advance(Duration::from_millis(CODE_TTL_MS as u64 - 1));
    assert_eq!(
        codes.redeem(&early.code).map(|r| (r.name, r.role)).unwrap(),
        (None, DEFAULT_ROLE)
    );
    clock.advance(Duration::from_millis(1));
    assert!(matches!(
        codes.redeem(&late.code),
        Err(RedeemError::Expired)
    ));
}

#[test]
fn five_failures_in_a_minute_block_that_address_only_until_the_minute_passes() {
    let limiter = Limiter::default();
    let a = Some("100.64.0.1".parse().unwrap());
    let b = Some("100.64.0.2".parse().unwrap());
    for at in 0..5 {
        assert!(!limiter.blocked(a, at * 1000));
        limiter.failed(a, at * 1000);
    }
    assert!(limiter.blocked(a, 5000));
    assert!(!limiter.blocked(b, 5000));
    assert!(limiter.blocked(a, 59_999));
    assert!(!limiter.blocked(a, 60_000), "the first failure aged out");
}

/// A hub with an in-memory database, as the app reaches it.
fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = crate::hub::api::HubConfig {
        home: home.path().to_path_buf(),
        listen: Default::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config,
        ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    (hub, home)
}

/// Redeems a code minted with `role` as the app does, and returns the key it was given.
fn pair(hub: &Hub, role: Option<Role>) -> Caller {
    let codes = PairCodes::new(hub.db.clone(), hub.clock.clone());
    let minted = match role {
        Some(role) => codes.create(None, role),
        None => codes.create(None, DEFAULT_ROLE),
    }
    .unwrap();
    let body = serde_json::json!({ "code": minted.code, "deviceName": "laptop" }).to_string();
    let (status, out) = handle(hub, &Limiter::default(), None, None, body.as_bytes());
    assert_eq!(status, StatusCode::OK, "{out}");
    hub.auth.verify(out["key"].as_str().unwrap()).unwrap()
}

async fn set_max_agents(hub: &Arc<Hub>, key: &Caller) -> Result<(), ToolError> {
    match crate::hub::api::registry()
        .call(hub, key, "cap_set", serde_json::json!({ "cap": 6 }))
        .await
    {
        Ok(_) => Ok(()),
        Err(CallError::Tool(error)) => Err(error),
        Err(other) => panic!("cap_set: {other:?}"),
    }
}

#[tokio::test]
async fn the_app_paired_with_a_fleetd_pair_code_may_change_max_agents() {
    let (hub, _home) = hub();
    let key = pair(&hub, None);
    assert_eq!(key.kind, Some(KeyKind::Human));
    assert_eq!(
        key.grants,
        [Grant {
            role: Role::Admin,
            machines: GrantMachines::All(Star::Value),
        }]
    );
    set_max_agents(&hub, &key).await.unwrap();
}

#[tokio::test]
async fn a_device_paired_with_role_operate_is_still_refused_admin_writes_and_told_to_re_pair() {
    let (hub, _home) = hub();
    let key = pair(&hub, Some(Role::Operate));
    assert_eq!(key.grants[0].role, Role::Operate);
    let refused = set_max_agents(&hub, &key).await.unwrap_err();
    assert_eq!(refused.code, fleetd_contracts::mcp::ErrorCode::Forbidden);
    assert_eq!(refused.message, "This key lacks the admin role.");
    assert_eq!(refused.fix.as_deref(), Some(crate::hub::api::REPAIR_FIX));
}

#[test]
fn a_code_keeps_the_role_it_was_minted_with_and_the_app_cannot_ask_for_more() {
    let (hub, _home) = hub();
    let codes = PairCodes::new(hub.db.clone(), hub.clock.clone());
    let minted = codes.create(Some("tablet"), Role::Read).unwrap();
    let body = serde_json::json!({ "code": minted.code, "role": "admin", "grants": [{ "role": "admin", "machines": "*" }] })
        .to_string();
    let (status, out) = handle(&hub, &Limiter::default(), None, None, body.as_bytes());
    assert_eq!(status, StatusCode::OK, "{out}");
    let key = hub.auth.verify(out["key"].as_str().unwrap()).unwrap();
    assert_eq!(key.name, "tablet");
    assert_eq!(key.grants[0].role, Role::Read);
}

#[test]
fn a_code_minted_before_codes_carried_a_role_still_grants_operate() {
    let (codes, db, _) = setup();
    let canon = normalize("0123-ABCD").unwrap();
    db.with(|c| {
        c.execute(
            "INSERT INTO pair_codes (hash, name, expires_ms) VALUES (?, NULL, ?)",
            params![hash(&canon), 2_000_000],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        codes.redeem("0123-ABCD").map(|r| (r.name, r.role)).unwrap(),
        (None, Role::Operate)
    );
}

/// A hub whose own address is `url` (its `--url`), listening on loopback, and its clock.
fn hub_at(url: Option<&str>) -> (Arc<Hub>, Arc<ManualClock>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = crate::hub::api::HubConfig {
        home: home.path().to_path_buf(),
        listen: Default::default(),
        url: url.map(str::to_owned),
        queue_ttl_sec: None,
    };
    let clock = ManualClock::at(1_792_000_000_000);
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    (hub, clock, home)
}

async fn pair_a_phone(
    hub: &Arc<Hub>,
    key: &Caller,
    app_url: &str,
) -> Result<serde_json::Value, ToolError> {
    match crate::hub::api::registry()
        .call(
            hub,
            key,
            "pair_code_create",
            serde_json::json!({ "hubUrl": app_url }),
        )
        .await
    {
        Ok(out) => Ok(out),
        Err(CallError::Tool(error)) => Err(error),
        Err(other) => panic!("pair_code_create: {other:?}"),
    }
}

fn trade(hub: &Hub, code: &str) -> (StatusCode, serde_json::Value) {
    let body = serde_json::json!({ "code": code, "deviceName": "iPhone" }).to_string();
    handle(hub, &Limiter::default(), None, None, body.as_bytes())
}

#[tokio::test]
async fn pair_a_phone_mints_a_one_time_code_for_the_callers_own_person_at_the_apps_address() {
    let (hub, _clock, _home) = hub_at(None);
    let desk = pair(&hub, None);
    let out = pair_a_phone(&hub, &desk, "http://devbox.tail1234.ts.net:4790/")
        .await
        .unwrap();
    let code = out["code"].as_str().unwrap();
    assert_eq!(out["hubUrl"], "http://devbox.tail1234.ts.net:4790");
    assert_eq!(
        out["link"].as_str().unwrap(),
        format!("fleetd://pair?hub=http%3A%2F%2Fdevbox.tail1234.ts.net%3A4790&code={code}")
    );
    // 15 minutes, as `fleetd pair`'s: the QR lives no longer than the code.
    assert_eq!(out["expiresAt"], iso_ms(1_792_000_000_000 + CODE_TTL_MS));

    let (status, paired) = trade(&hub, code);
    assert_eq!(status, StatusCode::OK, "{paired}");
    let phone = hub.auth.verify(paired["key"].as_str().unwrap()).unwrap();
    assert_eq!(phone.name, "iPhone");
    assert_eq!(
        phone.person.as_ref().map(|p| &p.person_id),
        desk.person.as_ref().map(|p| &p.person_id)
    );
    assert_eq!(phone.grants[0].role, Role::Admin);
    // The view notices the phone by this event.
    let paired_events = hub
        .events
        .page(0, Some(&[HubEventType::KeyPaired]), None)
        .unwrap()
        .events;
    assert!(
        paired_events
            .iter()
            .any(|e| e.summary == "iPhone paired with the hub")
    );

    let (status, again) = trade(&hub, code);
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(again["code"], "pair_code_invalid");
}

#[tokio::test]
async fn pair_a_phone_on_the_hub_machine_puts_the_hubs_own_address_in_the_link_never_loopback() {
    let (hub, _clock, _home) = hub_at(Some("http://100.101.102.103:4790"));
    let desk = pair(&hub, None);
    for app_url in [
        "http://127.0.0.1:4790",
        "http://localhost:4790",
        "http://[::1]:4790",
        "127.0.0.1:4790",
    ] {
        let out = pair_a_phone(&hub, &desk, app_url).await.unwrap();
        assert_eq!(out["hubUrl"], "http://100.101.102.103:4790", "{app_url}");
        assert!(
            out["link"]
                .as_str()
                .unwrap()
                .starts_with("fleetd://pair?hub=http%3A%2F%2F100.101.102.103%3A4790&code="),
            "{out}"
        );
    }
}

#[test]
fn an_app_address_saved_without_its_scheme_reaches_the_phone_as_http() {
    let (hub, _clock, _home) = hub_at(None);
    assert_eq!(
        tools::phone_hub_url(&hub, Some("devbox.tail1234.ts.net:4790")).as_deref(),
        Some("http://devbox.tail1234.ts.net:4790")
    );
}

#[tokio::test]
async fn a_hub_only_on_loopback_is_refused_with_how_to_give_it_an_address_and_mints_nothing() {
    let (hub, _clock, _home) = hub_at(None);
    let desk = pair(&hub, None);
    let codes = |hub: &Hub| -> i64 {
        hub.db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM pair_codes", [], |r| r.get(0))?))
            .unwrap()
    };
    let before = codes(&hub);
    let refused = pair_a_phone(&hub, &desk, "http://127.0.0.1:4790")
        .await
        .unwrap_err();
    assert_eq!(refused.code, fleetd_contracts::mcp::ErrorCode::Failed);
    assert_eq!(
        refused.message,
        "The hub is only at http://127.0.0.1:4790, which a phone can't reach."
    );
    assert!(
        refused.fix.as_deref().unwrap().contains("fleetd init"),
        "{refused:?}"
    );
    assert_eq!(codes(&hub), before);
}

#[tokio::test]
async fn a_phone_code_expires_after_15_minutes_and_gives_no_more_than_the_callers_role() {
    let (hub, clock, _home) = hub_at(Some("http://192.168.1.20:4790"));
    let desk = pair(&hub, Some(Role::Operate));
    let out = pair_a_phone(&hub, &desk, "http://127.0.0.1:4790")
        .await
        .unwrap();
    clock.advance(Duration::from_millis(CODE_TTL_MS as u64));
    let (status, expired) = trade(&hub, out["code"].as_str().unwrap());
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(expired["code"], "pair_code_expired");

    let out = pair_a_phone(&hub, &desk, "http://192.168.1.20:4790")
        .await
        .unwrap();
    let (status, paired) = trade(&hub, out["code"].as_str().unwrap());
    assert_eq!(status, StatusCode::OK, "{paired}");
    let phone = hub.auth.verify(paired["key"].as_str().unwrap()).unwrap();
    assert_eq!(phone.grants[0].role, Role::Operate);
}
