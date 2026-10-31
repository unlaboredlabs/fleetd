//! Migrations run by name: an older set, then one with a file inserted, replaced or changed.
use super::migrations::{Drift, MIGRATIONS, Migration, migrate, user_version};
use rusqlite::Connection;

// Each creates a table, so one that ran twice fails.
const A: Migration = Migration {
    name: "202601010000_a",
    sql: "CREATE TABLE a (x)",
};
const B: Migration = Migration {
    name: "202601020000_b",
    sql: "CREATE TABLE b (x)",
};
const C: Migration = Migration {
    name: "202601030000_c",
    sql: "CREATE TABLE c (x)",
};

fn tables(conn: &Connection) -> Vec<String> {
    conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn applied(conn: &Connection) -> Vec<String> {
    conn.prepare("SELECT name FROM migrations_applied ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn a_fresh_database_runs_every_migration_once() {
    let mut conn = Connection::open_in_memory().unwrap();
    assert_eq!(migrate(&mut conn, &[A, B, C]).unwrap(), []);
    assert_eq!(tables(&conn), ["a", "b", "c", "migrations_applied"]);
    assert_eq!(applied(&conn), [A.name, B.name, C.name]);
    assert_eq!(user_version(&conn).unwrap(), 3);
    // Opening it again runs nothing.
    assert_eq!(migrate(&mut conn, &[A, B, C]).unwrap(), []);
}

/// The case counting missed: a hub that ran a and c skipped b, which landed between them, because it counted 2.
#[test]
fn a_migration_inserted_before_one_already_run_still_runs() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate(&mut conn, &[A, C]).unwrap();
    assert_eq!(migrate(&mut conn, &[A, B, C]).unwrap(), []);
    assert_eq!(tables(&conn), ["a", "b", "c", "migrations_applied"]);
    assert_eq!(user_version(&conn).unwrap(), 3);
}

/// #914's: a file at a place already run replaced by another. The new one runs, and the gone one is reported.
#[test]
fn a_migration_replacing_one_already_run_runs_and_the_old_one_is_reported() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate(&mut conn, &[A, B]).unwrap();
    let telegram = Migration {
        name: "202601020001_telegram",
        sql: "CREATE TABLE telegram (x)",
    };
    assert_eq!(
        migrate(&mut conn, &[A, telegram]).unwrap(),
        [Drift::Unknown(B.name.to_owned())]
    );
    assert_eq!(tables(&conn), ["a", "b", "migrations_applied", "telegram"]);
}

#[test]
fn a_migration_changed_after_it_ran_is_reported_and_never_run_again() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate(&mut conn, &[A, B]).unwrap();
    let edited = Migration {
        name: B.name,
        sql: "CREATE TABLE b (x, y)",
    };
    for _ in 0..2 {
        assert_eq!(
            migrate(&mut conn, &[A, edited, C]).unwrap(),
            [Drift::Changed(B.name)]
        );
    }
    assert_eq!(tables(&conn), ["a", "b", "c", "migrations_applied"]);
}

/// A hub from before names counted 2: a and b are recorded as run without running again, then c runs.
#[test]
fn a_database_that_counted_its_migrations_upgrades_in_place() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE a (x); CREATE TABLE b (x); PRAGMA user_version = 2")
        .unwrap();
    assert_eq!(migrate(&mut conn, &[A, B, C]).unwrap(), []);
    assert_eq!(tables(&conn), ["a", "b", "c", "migrations_applied"]);
    assert_eq!(applied(&conn), [A.name, B.name, C.name]);
    assert_eq!(user_version(&conn).unwrap(), 3);
    // The count is read once: a later file inserted before c still runs.
    let early = Migration {
        name: "202601020500_early",
        sql: "CREATE TABLE early (x)",
    };
    assert_eq!(migrate(&mut conn, &[A, B, early, C]).unwrap(), []);
    assert!(tables(&conn).contains(&"early".to_owned()));
}

/// Every shipped migration is recorded under its file's name, and a hub's database opened again runs none twice.
#[test]
fn the_shipped_migrations_are_recorded_by_name() {
    let home = tempfile::tempdir().unwrap();
    super::HubDb::open(home.path()).unwrap();
    let db = super::HubDb::open(home.path()).unwrap();
    let names = db.with(|c| Ok(applied(c))).unwrap();
    let mut shipped: Vec<&str> = MIGRATIONS.iter().map(|m| m.name).collect();
    shipped.sort();
    assert_eq!(names, shipped);
    assert!(shipped.contains(&"202610311202_chat_pins"));
}
