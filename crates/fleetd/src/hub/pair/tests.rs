use super::*;
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
    let minted = codes.create(Some("wynn-mac")).unwrap();
    let stored: String = db
        .with(|c| Ok(c.query_row("SELECT hash FROM pair_codes", [], |r| r.get(0))?))
        .unwrap();
    assert_ne!(
        stored,
        minted.code.replace('-', ""),
        "only the hash is stored"
    );
    let typed = minted.code.to_lowercase().replace('-', "");
    assert_eq!(codes.redeem(&typed).unwrap(), Some("wynn-mac".to_owned()));
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
    let early = codes.create(None).unwrap();
    let late = codes.create(None).unwrap();
    assert_eq!(late.expires_at, iso_ms(1_000_000 + CODE_TTL_MS));
    clock.advance(Duration::from_millis(CODE_TTL_MS as u64 - 1));
    assert_eq!(codes.redeem(&early.code).unwrap(), None);
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
