//! A stand-in hub for the Add project sheet, for the bench and screenshots: it answers `project_discover` and
//! `project_add` on the wire and plays a clone's `project.clone_progress` and `project.added` events on a timer, so
//! the sheet runs the same decoding and event path it runs against a real hub.

use std::time::Duration;

use fleetd_contracts::app::{AppClientMessage, AppError, AppServerMessage};
use fleetd_contracts::mcp::ErrorCode;
use serde_json::{Value, json};

/// This computer, in the fixture: a worker, so Browse… shows.
pub const LOCAL: &str = "devbox";
const AT: &str = "2026-10-18T10:07:12.000Z";

#[derive(Default)]
pub struct AddHub {
    /// Discovery finds nothing (the empty-list screenshot).
    pub empty: bool,
    /// Plays only this many of a clone's events (a screenshot part way through).
    pub freeze_after: Option<usize>,
    pub seq: i64,
}

/// The fixture's discovery: checkouts on devbox and buildbox, and what gh on the hub lists.
pub fn discover(empty: bool) -> Value {
    if empty {
        return json!({
            "machines": [
                { "machineId": "devbox", "online": true, "cloneRoot": "/home/dev/src", "repos": [] },
                { "machineId": "buildbox", "online": true, "cloneRoot": "/home/ci/code", "repos": [] } ],
            "github": { "owners": [], "repos": [], "problem": { "code": "gh_unavailable", "message": "gh isn't logged in on the hub.", "fix": "Run gh auth login on the hub, then reopen this." } },
            "best": "devbox"
        });
    }
    let repo = |path: &str, remote: Option<&str>, project: Option<&str>| json!({ "path": path, "name": path.rsplit('/').next().unwrap(), "remote": remote.map(|r| format!("github.com/{r}")), "repo": remote, "projectId": project });
    json!({
        "machines": [
            { "machineId": "devbox", "online": true, "cloneRoot": "/home/dev/src", "repos": [
                repo("/home/dev/src/storefront", Some("acme/storefront"), Some("storefront")),
                repo("/home/dev/src/ledger-ui", Some("acme/ledger-ui"), None),
                repo("/home/dev/src/pricing", Some("acme/pricing"), None),
                repo("/home/dev/code/notes-cli", None, None) ] },
            { "machineId": "buildbox", "online": true, "cloneRoot": "/home/ci/code", "repos": [
                repo("/home/ci/code/infra", Some("acme/infra"), Some("infra")),
                repo("/home/ci/dev/ci-images", Some("acme/ci-images"), None) ] } ],
        "github": { "ghOn": "hub", "owners": ["acme", "acme-labs"], "repos": [
            { "repo": "acme/storefront", "url": "https://github.com/acme/storefront", "private": false,
              "checkouts": [{ "machineId": "devbox", "path": "/home/dev/src/storefront", "projectId": "storefront" }] },
            { "repo": "acme/checkout-v2", "url": "https://github.com/acme/checkout-v2", "private": true, "description": "Checkout rewrite", "checkouts": [] },
            { "repo": "acme/brand-site", "url": "https://github.com/acme/brand-site", "private": false, "description": "Marketing site", "checkouts": [] },
            { "repo": "acme/warehouse-sync", "url": "https://github.com/acme/warehouse-sync", "private": true, "checkouts": [] },
            { "repo": "acme-labs/edge-cache", "url": "https://github.com/acme-labs/edge-cache", "private": false, "description": "CDN worker", "checkouts": [] } ] },
        "best": "devbox"
    })
}

/// What `project.added` and a path add carry: a repo with no CI, so the lead line is a warning.
pub fn inspect(repo: Option<&str>) -> Value {
    json!({ "repo": repo, "defaultBranch": "main", "ci": { "workflows": [], "requiredChecks": [] },
        "merge": { "protected": false, "rulesets": [], "squashAllowed": true },
        "leadNeeds": "no CI found: the merge train will only use local checks", "notes": [] })
}

impl AddHub {
    /// The answer to one call, and the events that follow it with their delays. None: not a call this fakes.
    pub fn answer(&mut self, message: &AppClientMessage) -> Option<(AppServerMessage, Vec<(Duration, AppServerMessage)>)> {
        let AppClientMessage::Call { id, tool, input } = message else { return None };
        let result = |output: Value| AppServerMessage::Result { id: id.clone(), output };
        match tool.as_str() {
            "project_discover" => Some((result(discover(self.empty)), Vec::new())),
            "project_inspect" => {
                let machine = input["machineId"].as_str().unwrap_or("devbox").to_string();
                let repo = input["url"].as_str().unwrap_or("acme/x").to_string();
                let name = repo.rsplit('/').next().unwrap_or(&repo).to_string();
                let mut out = inspect(Some(&repo));
                let project = existing(&machine, &repo).flatten();
                out["clone"] = json!({ "machineId": machine, "path": dest(&machine, &name), "exists": existing(&machine, &repo).is_some(),
                    "sameRemote": existing(&machine, &repo).is_some(), "projectId": project });
                Some((result(out), Vec::new()))
            }
            "project_add" => {
                let machine = input["machineId"].as_str().unwrap_or("devbox").to_string();
                if let Some(path) = input["path"].as_str() {
                    let name = path.rsplit('/').next().unwrap_or(path);
                    return Some((
                        result(json!({ "machineId": machine, "path": path, "projectId": name, "created": true, "inspect": inspect(None) })),
                        Vec::new(),
                    ));
                }
                let repo = input["url"].as_str().unwrap_or("acme/x").to_string();
                let name = repo.rsplit('/').next().unwrap_or(&repo).to_string();
                let path = dest(&machine, &name);
                // As the hub does: a destination that exists is refused before cloning, as a call error.
                if existing(&machine, &repo).is_some() {
                    if input["useExisting"].as_bool() == Some(true) {
                        return Some((
                            result(
                                json!({ "machineId": machine, "path": path, "projectId": name, "created": true, "inspect": inspect(Some(&repo)) }),
                            ),
                            Vec::new(),
                        ));
                    }
                    let error = AppError {
                        id: Some(id.clone()),
                        code: ErrorCode::Invalid,
                        message: format!("{machine} already has a checkout of {repo} at {path}"),
                        fix: Some(format!("Add it as it is: fleetd project add {path} --machine {machine} (useExisting: true)")),
                    };
                    return Some((AppServerMessage::Error(error), Vec::new()));
                }
                let add_id = format!("add-{}", self.seq + 1);
                let answer = result(json!({ "machineId": machine, "path": path, "created": true, "addId": add_id }));
                let mut events = Vec::new();
                let mut at = |ms: u64, kind: &str, project: Option<&str>, data: Value| {
                    self.seq += 1;
                    let event =
                        json!({ "seq": self.seq, "at": AT, "type": kind, "machineId": machine, "projectId": project, "summary": "", "data": data });
                    events.push((Duration::from_millis(ms), AppServerMessage::Event(serde_json::from_value(event).expect("fixture event"))));
                };
                let progress = |phase: &str, percent: Option<i64>, detail: Option<&str>| json!({ "addId": add_id, "repo": repo, "path": path, "phase": phase, "percent": percent, "detail": detail });
                at(200, "project.clone_progress", None, progress("starting", None, None));
                for pct in [12, 42, 73, 100] {
                    at(350, "project.clone_progress", None, progress("receiving", Some(pct), Some("4.10 MiB | 2.31 MiB/s")));
                }
                at(250, "project.clone_progress", None, progress("resolving", Some(100), None));
                at(200, "project.clone_progress", None, progress("checking_out", Some(100), None));
                at(250, "project.clone_progress", None, progress("inspecting", None, None));
                at(
                    700,
                    "project.added",
                    Some(&name),
                    json!({ "addId": add_id, "title": name, "path": path, "created": true, "inspect": inspect(Some(&repo)) }),
                );
                events.truncate(self.freeze_after.unwrap_or(usize::MAX));
                Some((answer, events))
            }
            _ => None,
        }
    }
}

/// Where a clone of `name` goes on the fixture's machines.
fn dest(machine: &str, name: &str) -> String {
    let root = if machine == "buildbox" { "/home/ci/code" } else { "/home/dev/src" };
    format!("{root}/{name}")
}

/// A checkout of `repo` already at its clone destination: Some(its project, if it is one).
fn existing(machine: &str, repo: &str) -> Option<Option<&'static str>> {
    match (machine, repo) {
        ("devbox", "acme/storefront") => Some(Some("storefront")),
        ("devbox", "acme/ledger-ui" | "acme/pricing") => Some(None),
        _ => None,
    }
}
