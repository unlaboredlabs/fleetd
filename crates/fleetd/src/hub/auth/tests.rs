use super::*;
use crate::hub::store::test_clock::ManualClock;
use fleetd_contracts::subscriptions::Star;
use std::time::Duration;

fn m(id: &str) -> MachineId {
    MachineId::new(id).unwrap()
}

fn operate_all() -> Vec<Grant> {
    vec![Grant {
        role: Role::Operate,
        machines: GrantMachines::All(Star::Value),
    }]
}

fn setup() -> (Auth, Arc<HubDb>, Arc<ManualClock>) {
    let db = HubDb::open_memory().unwrap();
    let clock = ManualClock::at(0);
    (Auth::new(db.clone(), clock.clone()), db, clock)
}

fn unauthorized<T: std::fmt::Debug>(result: Result<T, AuthError>) -> Unauthorized {
    match result {
        Err(AuthError::Unauthorized(u)) => u,
        other => panic!("expected Unauthorized, got {other:?}"),
    }
}

#[test]
fn creates_fld_keys_in_lowercase_base32_and_stores_only_their_sha256() {
    let (auth, db, _) = setup();
    let CreatedKey { key, info } = auth
        .create_key("ci", &operate_all(), KeyKind::Agent)
        .unwrap();
    assert!(is_agent_key(&key), "{key}");
    assert_eq!(info.prefix.as_str(), &key[..10]);
    assert!(info.key_id.as_str().starts_with("key_") && info.key_id.as_str().len() == 12);
    let (hash, everything): (String, String) = db
        .with(|c| {
            Ok(c.query_row(
                "SELECT hash, key_id || prefix || name || grants || hash FROM agent_keys",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(hash, sha256(&key));
    assert!(!everything.contains(&key[4..]));
    assert_eq!(auth.list().unwrap(), vec![info]);
}

#[test]
fn base32_matches_rfc_4648() {
    assert_eq!(base32(b"foobar"), "mzxw6ytboi");
    assert_eq!(base32(&[0xff; 5]), "77777777");
    assert_eq!(base32(&[0u8; 32]).len(), 52);
}

#[test]
fn verifies_with_or_without_the_bearer_scheme_and_rejects_others() {
    let (auth, _, _) = setup();
    let CreatedKey { key, info } = auth
        .create_key("ci", &operate_all(), KeyKind::Agent)
        .unwrap();
    assert_eq!(auth.verify(&key).unwrap().key_id, info.key_id);
    assert_eq!(
        auth.verify(&format!("Bearer {key}")).unwrap().key_id,
        info.key_id
    );
    assert_eq!(
        auth.verify(&format!("bearer\t{key} ")).unwrap().key_id,
        info.key_id
    );
    let unknown = unauthorized(auth.verify(&format!("fld_{}", "a".repeat(52))));
    assert_eq!(
        (unknown.code, unknown.message.as_str()),
        (ErrorCode::Forbidden, "unknown agent key")
    );
    assert_eq!(
        unauthorized(auth.verify("Bearer nope")).code,
        ErrorCode::Invalid
    );
}

#[test]
fn revokes_immediately_and_idempotently() {
    let (auth, _, clock) = setup();
    let CreatedKey { key, info } = auth
        .create_key("ci", &operate_all(), KeyKind::Agent)
        .unwrap();
    let verified = auth.verify(&key).unwrap();
    auth.revoke(&info.key_id).unwrap();
    let error = unauthorized(auth.verify(&key));
    assert_eq!(
        (error.code, error.message),
        (
            ErrorCode::Forbidden,
            format!("agent key {} was revoked", info.prefix)
        )
    );
    assert!(error.fix.unwrap().contains("fleetd hub key create"));

    clock.advance(Duration::from_secs(3600));
    auth.revoke(&info.key_id).unwrap();
    let listed = auth.list().unwrap().remove(0);
    assert_eq!(
        listed.revoked_at.as_ref().map(|t| t.as_str()),
        Some("1970-01-01T00:00:00.000Z")
    );
    assert!(allows(&verified, Role::Read, None));
    assert!(!allows(&listed, Role::Read, None));
    assert!(
        matches!(auth.revoke("key_missing"), Err(AuthError::KeyNotFound { key_id }) if key_id == "key_missing")
    );
}

#[test]
fn writes_last_used_at_at_most_once_a_minute() {
    let (auth, _, clock) = setup();
    let CreatedKey { key, info } = auth
        .create_key("ci", &operate_all(), KeyKind::Agent)
        .unwrap();
    assert_eq!(info.last_used_at, None);
    let last_used = || auth.list().unwrap().remove(0).last_used_at.map(|t| t.0);
    assert_eq!(
        auth.verify(&key)
            .unwrap()
            .last_used_at
            .as_ref()
            .map(|t| t.as_str().to_owned())
            .as_deref(),
        Some("1970-01-01T00:00:00.000Z")
    );
    clock.advance(Duration::from_secs(59));
    auth.verify(&key).unwrap();
    assert_eq!(last_used().as_deref(), Some("1970-01-01T00:00:00.000Z"));
    clock.advance(Duration::from_secs(1));
    auth.verify(&key).unwrap();
    assert_eq!(last_used().as_deref(), Some("1970-01-01T00:01:00.000Z"));
}

#[test]
fn grants_rank_read_operate_admin_and_scope_by_machine() {
    let info = |grants: Vec<Grant>| AgentKeyInfo {
        key_id: Text::unchecked("key_x"),
        name: "x".into(),
        kind: None,
        prefix: AgentKeyPrefix::unchecked("fld_abcdef"),
        grants,
        created_at: "1970-01-01T00:00:00.000Z".into(),
        last_used_at: None,
        revoked_at: None,
    };
    let key = info(vec![
        Grant {
            role: Role::Operate,
            machines: GrantMachines::Only(vec![m("lab-a")]),
        },
        Grant {
            role: Role::Read,
            machines: GrantMachines::All(Star::Value),
        },
    ]);
    assert!(allows(&key, Role::Operate, Some(&m("lab-a"))));
    assert!(allows(&key, Role::Read, Some(&m("lab-a"))));
    assert!(!allows(&key, Role::Admin, Some(&m("lab-a"))));
    assert!(!allows(&key, Role::Operate, Some(&m("lab-b"))));
    assert!(allows(&key, Role::Read, Some(&m("lab-b"))));
    // Fleet-wide calls need the role on some machine; results are filtered per machine afterwards.
    assert!(allows(&key, Role::Operate, None));
    assert!(!allows(&key, Role::Admin, None));
    assert!(!allows(&info(vec![]), Role::Read, None));
    assert!(!allows(
        &info(vec![Grant {
            role: Role::Admin,
            machines: GrantMachines::Only(vec![])
        }]),
        Role::Read,
        Some(&m("lab-a"))
    ));
}

#[test]
fn enrollment_tokens_are_one_time_and_record_the_node_key() {
    let (auth, _, _) = setup();
    let EnrollToken { token, expires_at } = auth.create_enroll_token(&m("lab-a")).unwrap();
    assert!(token.starts_with("fle_") && token.len() == 56);
    assert_eq!(expires_at, "1970-01-01T00:15:00.000Z");
    assert_eq!(auth.node_pub_key(&m("lab-a")).unwrap(), None);
    auth.consume_enroll_token(&token, &m("lab-a"), "pub-1")
        .unwrap();
    assert_eq!(
        auth.node_pub_key(&m("lab-a")).unwrap().as_deref(),
        Some("pub-1")
    );
    let again = unauthorized(auth.consume_enroll_token(&token, &m("lab-a"), "pub-2"));
    assert_eq!(
        (again.code, again.message.as_str()),
        (ErrorCode::Forbidden, "enrollment token was already used")
    );
    assert!(
        again
            .fix
            .unwrap()
            .contains("fleetd hub token create --machine lab-a")
    );
    assert_eq!(
        auth.node_pub_key(&m("lab-a")).unwrap().as_deref(),
        Some("pub-1")
    );

    assert!(auth.revoke_node(&m("lab-a")).unwrap());
    assert_eq!(auth.node_pub_key(&m("lab-a")).unwrap(), None);
    assert!(!auth.revoke_node(&m("lab-a")).unwrap());
}

#[test]
fn enrollment_tokens_expire_after_15_minutes() {
    let (auth, _, clock) = setup();
    let early = auth.create_enroll_token(&m("lab-a")).unwrap();
    let late = auth.create_enroll_token(&m("lab-b")).unwrap();
    clock.advance(Duration::from_secs(14 * 60));
    auth.consume_enroll_token(&early.token, &m("lab-a"), "pub-a")
        .unwrap();
    clock.advance(Duration::from_secs(60));
    assert_eq!(
        unauthorized(auth.consume_enroll_token(&late.token, &m("lab-b"), "pub-b")).message,
        "enrollment token expired"
    );
    assert_eq!(auth.node_pub_key(&m("lab-b")).unwrap(), None);
}

#[test]
fn enrollment_tokens_only_enroll_their_machine_and_survive_a_wrong_machine_attempt() {
    let (auth, _, _) = setup();
    let EnrollToken { token, .. } = auth.create_enroll_token(&m("lab-a")).unwrap();
    assert_eq!(
        unauthorized(auth.consume_enroll_token(&token, &m("lab-b"), "pub")).message,
        "enrollment token is for machine lab-a, not lab-b"
    );
    assert_eq!(
        unauthorized(auth.consume_enroll_token("fle_bogus", &m("lab-a"), "pub")).message,
        "unknown enrollment token"
    );
    auth.consume_enroll_token(&token, &m("lab-a"), "pub")
        .unwrap();
    assert_eq!(
        auth.node_pub_key(&m("lab-a")).unwrap().as_deref(),
        Some("pub")
    );
}

/// Agents run as the hub's OS user, so the owner key pre-release CLIs kept in the hub home was theirs to read too.
/// Retiring revokes the key in owner.key, whatever its name, and every other key minted as the owner's (a human key
/// named "owner", admin on every machine), and deletes the file. Every other key stays.
#[test]
fn retiring_revokes_the_owner_keys_and_deletes_their_file() {
    let (auth, _, _) = setup();
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join(RETIRED_OWNER_KEY_FILE);
    let admin_all = vec![Grant {
        role: Role::Admin,
        machines: GrantMachines::All(Star::Value),
    }];
    let mint = |name: &str, grants: &[Grant], kind| auth.create_key(name, grants, kind).unwrap();
    let in_file = mint("renamed", &operate_all(), KeyKind::Human);
    let earlier = mint("owner", &admin_all, KeyKind::Human);
    let device = mint("owner", &operate_all(), KeyKind::Human);
    let agent = mint("owner", &admin_all, KeyKind::Agent);
    let cli = mint("fleetd-cli", &admin_all, KeyKind::Agent);
    std::fs::write(&file, format!("{}\n", in_file.key)).unwrap();

    assert_eq!(auth.retire_owner_keys(home.path()).unwrap(), 2);
    assert!(!file.exists());
    for revoked in [&in_file, &earlier] {
        assert!(auth.verify(&revoked.key).is_err(), "{}", revoked.info.name);
    }
    for kept in [&device, &agent, &cli] {
        assert!(auth.verify(&kept.key).is_ok(), "{}", kept.info.name);
    }
    // Every start runs it; with nothing left to retire it changes nothing.
    assert_eq!(auth.retire_owner_keys(home.path()).unwrap(), 0);
    assert!(auth.verify(&device.key).is_ok());
}
