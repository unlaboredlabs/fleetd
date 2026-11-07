//! The agents' Mac's 6-digit setup code (mac.rs): minted by an admin, traded once at /pair/mac within 10 minutes for
//! an enroll token, one open at a time, and few guesses allowed from anywhere.
use super::mac::*;
use super::tests::hub;
use super::*;
use crate::hub::api::{CallError, Caller};
use crate::hub::store::test_clock::ManualClock;
use fleetd_contracts::ids::MachineId;
use std::time::Duration;

fn setup() -> (PairCodes, Arc<ManualClock>) {
    let db = HubDb::open_memory().unwrap();
    let clock = ManualClock::at(1_000_000);
    (PairCodes::new(db, clock.clone()), clock)
}

fn mid(id: &str) -> MachineId {
    MachineId::new(id).unwrap()
}

fn open(_: &MachineId) -> Result<(), ()> {
    Ok(())
}

fn trade(
    hub: &Hub,
    limiter: &Limiter,
    global: &Limiter,
    from: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let remote = Some(from.parse().unwrap());
    super::mac::handle(
        hub,
        limiter,
        global,
        remote,
        Some("devbox:4790"),
        body.to_string().as_bytes(),
    )
}

fn admin(hub: &Hub, role: Role) -> Caller {
    let created = hub
        .auth
        .create_key_for(
            "laptop",
            &[Grant {
                role,
                machines: GrantMachines::All(Star::Value),
            }],
            KeyKind::Human,
            None,
        )
        .unwrap();
    hub.auth.verify(&created.key).unwrap()
}

async fn mint(hub: &Arc<Hub>, caller: &Caller) -> Result<serde_json::Value, CallError> {
    crate::hub::api::registry()
        .call(
            hub,
            caller,
            "mac_code_create",
            serde_json::json!({ "hubUrl": "http://devbox:4790" }),
        )
        .await
}

#[test]
fn a_code_is_six_digits_typed_with_or_without_spaces() {
    for _ in 0..200 {
        let code = new_mac_code();
        assert_eq!(code.len(), 6, "{code}");
        assert_eq!(normalize_mac(&code), Some(code));
    }
    assert_eq!(normalize_mac(" 012 345\n"), Some("012345".into()));
    assert_eq!(normalize_mac("012-345"), Some("012345".into()));
    for bad in ["01234", "0123456", "01234a", "ABCD-EFGH", ""] {
        assert_eq!(normalize_mac(bad), None, "{bad}");
    }
}

#[test]
fn a_code_trades_once_for_its_machine_and_only_its_hash_is_kept() {
    let (codes, _) = setup();
    let minted = codes.create_mac(&mid("mac")).unwrap();
    let stored: String = codes
        .db
        .with(|c| Ok(c.query_row("SELECT hash FROM pair_codes", [], |r| r.get(0))?))
        .unwrap();
    assert!(!stored.contains(&minted.code));
    let spaced = format!("{} {}", &minted.code[..3], &minted.code[3..]);
    assert_eq!(codes.redeem_mac(&spaced, open).unwrap(), Ok(mid("mac")));
    assert!(matches!(
        codes.redeem_mac(&minted.code, open),
        Err(RedeemError::Invalid)
    ));
}

#[test]
fn a_code_expires_after_ten_minutes() {
    let (codes, clock) = setup();
    let minted = codes.create_mac(&mid("mac")).unwrap();
    assert_eq!(minted.expires_at, iso_ms(1_000_000 + MAC_CODE_TTL_MS));
    clock.advance(Duration::from_millis(MAC_CODE_TTL_MS as u64));
    assert!(matches!(
        codes.redeem_mac(&minted.code, open),
        Err(RedeemError::Expired)
    ));
}

#[test]
fn a_new_code_revokes_the_one_still_open_so_there_is_one_at_a_time() {
    let (codes, _) = setup();
    let first = codes.create_mac(&mid("mac")).unwrap();
    let second = codes.create_mac(&mid("mac")).unwrap();
    if first.code != second.code {
        assert!(matches!(
            codes.redeem_mac(&first.code, open),
            Err(RedeemError::Invalid)
        ));
    }
    assert_eq!(
        codes.redeem_mac(&second.code, open).unwrap(),
        Ok(mid("mac"))
    );
}

#[test]
fn a_refused_code_stays_open_and_a_mac_code_and_a_pairing_code_never_meet() {
    let (codes, _) = setup();
    let minted = codes.create_mac(&mid("mac")).unwrap();
    assert_eq!(
        codes
            .redeem_mac(&minted.code, |_| Err("other computer"))
            .unwrap(),
        Err("other computer")
    );
    assert!(
        matches!(codes.redeem(&minted.code), Err(RedeemError::Invalid)),
        "never a key"
    );
    let pairing = codes.create(None, Role::Admin).unwrap();
    assert!(matches!(
        codes.redeem_mac(&pairing.code, open),
        Err(RedeemError::Invalid)
    ));
    assert_eq!(
        codes.redeem_mac(&minted.code, open).unwrap(),
        Ok(mid("mac"))
    );
}

#[tokio::test]
async fn an_admin_mints_a_code_the_mac_trades_for_a_token_that_enrolls_it() {
    let (hub, _home) = hub();
    let out = mint(&hub, &admin(&hub, Role::Admin)).await.unwrap();
    assert_eq!(out["machineId"], "mac");
    assert_eq!(out["hubUrl"], "http://devbox:4790");
    let code = out["code"].as_str().unwrap();
    let (status, answer) = trade(
        &hub,
        &Limiter::default(),
        &Limiter::default(),
        "100.64.0.1",
        serde_json::json!({ "code": code, "fingerprint": "abc" }),
    );
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["machineId"], "mac");
    assert_eq!(answer["existing"], false);
    assert_eq!(answer["version"], crate::version());
    let token = answer["token"].as_str().unwrap();
    hub.auth
        .enroll_node(token, &mid("mac"), "pub", Some("abc"))
        .unwrap();
    let (again, _) = trade(
        &hub,
        &Limiter::default(),
        &Limiter::default(),
        "100.64.0.1",
        serde_json::json!({ "code": code }),
    );
    assert_eq!(again, StatusCode::UNAUTHORIZED, "single use");
}

#[tokio::test]
async fn only_an_admin_mints_one() {
    let (hub, _home) = hub();
    let refused = mint(&hub, &admin(&hub, Role::Operate)).await.unwrap_err();
    assert!(
        matches!(refused, CallError::Tool(ref e) if e.code == fleetd_contracts::mcp::ErrorCode::Forbidden),
        "{refused:?}"
    );
}

#[tokio::test]
async fn the_code_joins_the_hubs_agents_mac_and_refuses_another_computer_before_it_is_spent() {
    let (hub, _home) = hub();
    let machine = serde_json::from_value(serde_json::json!({
        "machineId": "studio", "name": "studio", "tags": [], "status": "offline", "lastSeenAt": "2026-11-07T10:00:00.000Z", "nodeVersion": "0.1.0", "agentsMac": true,
    }))
    .unwrap();
    hub.store.machine_upsert(&machine, Some("pub")).unwrap();
    hub.auth
        .set_node_fingerprint(&mid("studio"), "old-mac")
        .unwrap();
    let out = mint(&hub, &admin(&hub, Role::Admin)).await.unwrap();
    assert_eq!(out["machineId"], "studio");
    let code = out["code"].as_str().unwrap();
    let (limiter, global) = (Limiter::default(), Limiter::default());
    let (status, answer) = trade(
        &hub,
        &limiter,
        &global,
        "100.64.0.1",
        serde_json::json!({ "code": code, "fingerprint": "new-mac" }),
    );
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(answer["code"], "mac_other_computer");
    assert!(
        answer["fix"].as_str().unwrap().contains("Remove"),
        "{answer}"
    );
    let (status, answer) = trade(
        &hub,
        &limiter,
        &global,
        "100.64.0.1",
        serde_json::json!({ "code": code, "fingerprint": "old-mac" }),
    );
    assert_eq!(status, StatusCode::OK, "the same Mac again: {answer}");
    assert_eq!(answer["existing"], true);
}

#[test]
fn wrong_codes_are_limited_per_address_and_across_every_address() {
    let (hub, _home) = hub();
    let codes = PairCodes::new(hub.db.clone(), hub.clock.clone());
    let minted = codes.create_mac(&mid("mac")).unwrap();
    let wrong = if minted.code == "000000" {
        "111111"
    } else {
        "000000"
    };
    let (limiter, global) = (Limiter::default(), Limiter::default());
    for _ in 0..5 {
        let (status, _) = trade(
            &hub,
            &limiter,
            &global,
            "100.64.0.1",
            serde_json::json!({ "code": wrong }),
        );
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, _) = trade(
        &hub,
        &limiter,
        &global,
        "100.64.0.1",
        serde_json::json!({ "code": minted.code }),
    );
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "that address waits");
    for i in 2..7 {
        let (status, _) = trade(
            &hub,
            &limiter,
            &global,
            &format!("100.64.0.{i}"),
            serde_json::json!({ "code": wrong }),
        );
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, answer) = trade(
        &hub,
        &limiter,
        &global,
        "100.64.0.9",
        serde_json::json!({ "code": minted.code }),
    );
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "ten wrong codes from anywhere stop every address: {answer}"
    );
    assert_eq!(answer["code"], "pair_rate_limited");
}

#[test]
fn a_spent_code_is_pruned_with_the_others_and_an_open_one_kept() {
    let (codes, clock) = setup();
    let spent = codes.create_mac(&mid("mac")).unwrap();
    assert_eq!(codes.redeem_mac(&spent.code, open).unwrap(), Ok(mid("mac")));
    clock.advance(Duration::from_millis(
        crate::hub::auth::SPENT_CODE_KEPT_MS as u64 + 1,
    ));
    let fresh = codes.create_mac(&mid("mac")).unwrap();
    assert_eq!(codes.prune().unwrap(), 1);
    assert_eq!(
        codes.open_mac().unwrap().map(|c| c.expires_at),
        Some(fresh.expires_at)
    );
}
