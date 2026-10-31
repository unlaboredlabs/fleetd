//! The app's setup fixtures (`app/desktop/fixtures/setup/steps.json`) are this catalog's own answers: `setup_list`,
//! and `setup_test` for a hub `fleetd init` just made on devbox, read from the checks the doctor would
//! report at each point. The app keeps no catalog of its own, so its screenshots and tests show exactly what a hub
//! says. `FLEETD_WRITE_FIXTURES=1 cargo test -p fleetd --lib hub::setup::fixtures` writes the file; without it, this
//! test fails while the file differs.
use fleetd_contracts::claude_accounts::ClaudeHubApi;
use fleetd_contracts::setup::HubSetupStep;
use serde_json::{Map, Value, json};

use super::{guides, read};
use crate::hub::doctor::checks::{
    self, ClaudeSetupView, CmdOutcome, DoctorCheck, DoctorStatus, Probe, SetupFacts,
};

/// The fixtures' hub (app/desktop/fixtures/kit HUB): a tailnet name would fail their leak check.
const HUB: &str = "http://devbox:4790";
const AT: &str = "2026-10-19T09:01:35.585Z";

fn machine(name: &str, status: DoctorStatus, message: &str) -> DoctorCheck {
    DoctorCheck {
        id: format!("devbox/{name}"),
        scope: "machine".into(),
        machine_id: Some("devbox".into()),
        status,
        message: message.into(),
        fix: None,
    }
}

fn gh(logged_in: bool) -> DoctorCheck {
    checks::gh_auth(&CmdOutcome::Ran {
        exit_code: if logged_in { 0 } else { 1 },
        stdout: String::new(),
        stderr: if logged_in {
            "Logged in to github.com account dev".into()
        } else {
            String::new()
        },
    })
    .check
}

/// The hub's Claude accounts: a tested API key, or none (and the owner, Dev, with no subscription).
fn claude(key: bool) -> Vec<DoctorCheck> {
    let api = key.then(|| -> ClaudeHubApi {
        serde_json::from_value(json!({
            "updatedAt": AT,
            "sealedOn": [{ "machineId": "devbox", "fingerprint": "5ec2e7a1" }],
            "lastTest": { "at": AT, "machineId": "devbox", "ok": true },
        }))
        .unwrap()
    });
    let view = ClaudeSetupView {
        configured: api.is_some(),
        hub_api: api,
        owner: Some(("Dev".into(), None)),
        machines: vec!["devbox".into()],
    };
    vec![
        checks::claude_key(&view).check,
        checks::claude_owner(&view).check,
    ]
}

/// Where the hub is after each point of a first run.
struct Point {
    key: bool,
    logins: bool,
    github: bool,
}

/// The checks at `p`, on a hub with no project yet (the fixtures' empty hub).
fn checks_at(p: &Point) -> Vec<DoctorCheck> {
    super::before_first_use(doctor_at(p), 0)
}

fn doctor_at(p: &Point) -> Vec<DoctorCheck> {
    let mut out = vec![
        checks::hub_reachable("http://127.0.0.1:4790/healthz", &Probe::Ok, String::new()).check,
        DoctorCheck {
            id: "hub/https".into(),
            scope: "hub".into(),
            machine_id: None,
            status: DoctorStatus::Ok,
            message: format!(
                "The hub's address {HUB} is plain HTTP, which is fine: it stays inside your tailnet's encrypted tunnel."
            ),
            fix: None,
        },
        gh(p.github),
        machine("online", DoctorStatus::Ok, "devbox is online."),
        if p.logins {
            machine(
                "claude_login",
                DoctorStatus::Ok,
                "devbox: claude is logged in.",
            )
        } else {
            machine(
                "claude_login",
                DoctorStatus::Fail,
                "devbox: claude is not logged in, so its sessions can't start.",
            )
        },
    ];
    out.extend(claude(p.key));
    let facts = SetupFacts {
        github_app: p.github.then(|| {
            serde_json::from_value(json!({
                "appId": 1048576, "slug": "fleetd-on-devbox", "name": "fleetd on devbox", "clientId": "Iv23liQ4fXk8w2ZsT0aB",
                "owner": "acme", "htmlUrl": "https://github.com/apps/fleetd-on-devbox",
                "settingsUrl": "https://github.com/organizations/acme/settings/apps/fleetd-on-devbox", "createdAt": AT,
                "installations": [{ "installationId": 51234567, "account": "acme", "allRepositories": false,
                  "repositoryCount": 2, "repositories": ["acme/storefront", "acme/api"] }],
                "lastTest": { "at": AT, "ok": true,
                  "said": "\"fleetd on devbox\" is installed on acme (2 repositories), and its tokens work." },
            }))
            .unwrap()
        }),
        ..SetupFacts::default()
    };
    out.extend(checks::setup_checks(&facts).into_iter().map(|e| e.check));
    out
}

/// What a read adds to a step's guide: its status and what its checks say. The guides are written once.
fn reads(steps: Vec<HubSetupStep>) -> Map<String, Value> {
    steps
        .into_iter()
        .map(|s| {
            let read = json!({
                "status": s.status, "said": s.said, "way": s.way, "fix": s.fix, "failing": s.failing,
            });
            let read: Map<String, Value> = read
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            (s.id.as_str().to_owned(), Value::Object(read))
        })
        .collect()
}

/// One fixture: `setup_list` now, and `setup_test` of each step as `after` finds it.
fn scenario(now: &Point, after: &Point) -> Value {
    let checks = checks_at(now);
    let steps = read(guides(HUB), &checks);
    let left = steps.iter().filter(|s| s.required_left()).count();
    json!({
        "requiredLeft": left,
        "list": reads(steps),
        "tests": reads(read(guides(HUB), &checks_at(after))),
    })
}

fn fixtures() -> Value {
    let fresh = Point {
        key: false,
        logins: false,
        github: false,
    };
    let key = Point { key: true, ..fresh };
    let github = Point {
        github: true,
        ..key
    };
    let logins = Point {
        logins: true,
        ..fresh
    };
    json!({
      "hub": HUB,
      "guides": guides(HUB),
      "scenarios": {
        "setup-fresh": scenario(&fresh, &fresh),
        "setup-claude-logins": scenario(&logins, &logins),
        "setup-github": scenario(&key, &github),
        "setup-done": scenario(&github, &github),
      },
    })
}

#[test]
fn the_apps_setup_fixtures_are_the_hubs_own_answers() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../app/desktop/fixtures/setup/steps.json");
    let text = format!("{}\n", serde_json::to_string_pretty(&fixtures()).unwrap());
    if std::env::var_os("FLEETD_WRITE_FIXTURES").is_some() {
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let saved = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        saved == text,
        "{} is out of date: run FLEETD_WRITE_FIXTURES=1 cargo test -p fleetd --lib hub::setup::fixtures and commit it",
        path.display()
    );
}
