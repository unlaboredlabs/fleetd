//! Status docs for the bench and screenshots, which run without a hub: the fleet, the storefront project and its
//! order W14 (the board fixture's), live or with two sources gone quiet. Built as the hub would send them and
//! decoded through the contracts, so a shape change fails here first.

use fleetd_contracts::status::{StatusDoc, StatusScope};
use serde_json::{Value, json};

use crate::fake::FIXTURE_NOW;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    Live,
    /// buildbox stopped sending heartbeats and GitHub stopped answering for acme/storefront.
    Stale,
}

fn at(hm: &str) -> String {
    format!("2026-10-18T{hm}.000Z")
}

fn stale(since: &str, reason: &str) -> Value {
    json!({ "since": at(since), "reason": reason })
}

pub fn doc(scope: &StatusScope, variant: Variant) -> StatusDoc {
    let quiet = variant == Variant::Stale;
    let github = quiet.then(|| stale("10:01:02", "GitHub not reached since 10:01: gh: connect: network is unreachable"));
    let buildbox = quiet.then(|| stale("10:03:02", "no heartbeat from buildbox since 10:03"));
    let (title, scope_json) = match scope {
        StatusScope::Fleet => ("Fleet", json!({ "kind": "fleet" })),
        StatusScope::Project { .. } => {
            ("storefront", json!({ "kind": "project", "projectRef": { "machineId": "devbox", "projectId": "storefront" } }))
        }
        StatusScope::Order { .. } => ("Fix cart total rounding", json!({ "kind": "order", "workstreamId": "W14" })),
    };
    let kind = scope_json["kind"].as_str().unwrap_or("fleet").to_string();
    let (pct, done, total, polish_done, polish_total, was) = match kind.as_str() {
        "fleet" => (72, 13, 18, 2, 5, 80),
        "project" => (64, 7, 11, 1, 3, 69),
        _ => (62, 3, 5, 0, 1, 71),
    };
    let marker = match kind.as_str() {
        "order" => {
            json!({ "at": at("09:58:20"), "text": "+1 item: rounding for JPY carts added", "pctBefore": was, "pctAfter": pct, "deltaItems": 1 })
        }
        _ => json!({ "at": at("10:00:04"), "text": "+3 items: currency table export added", "pctBefore": was, "pctAfter": pct, "deltaItems": 3 }),
    };
    let mut markers = vec![marker.clone()];
    if kind != "order" {
        markers.push(json!({ "at": at("08:41:00"), "text": "−1 item: W9 stopped", "pctBefore": 70, "pctAfter": 71, "deltaItems": -1 }));
    }
    let eta = match kind.as_str() {
        "fleet" => json!({ "current": "2026-10-22T14:00:00.000Z", "rate": 4.1, "samples": 18, "basis": "fleet", "chain": "P12 full lab run" }),
        "project" => json!({ "current": "2026-10-22T14:00:00.000Z", "original": "2026-10-21T18:00:00.000Z",
            "slip": { "scopeMinutes": 360, "speedMinutes": 840 }, "rate": 3.2, "samples": 11, "basis": "project", "chain": "P12 full lab run" }),
        _ => json!({ "current": "2026-10-18T15:10:00.000Z", "original": "2026-10-18T12:30:00.000Z",
            "slip": { "scopeMinutes": 40, "speedMinutes": 120 }, "lead": "2026-10-18T11:30:00.000Z", "rate": 1.4, "samples": 6, "basis": "order" }),
    };
    let gates = match kind.as_str() {
        "order" => json!([
            { "kind": "live", "label": "review of #212", "serial": true, "since": at("10:03:11"), "workstreamId": "W14" },
            { "kind": "live", "label": "your answer on fixture.ask0", "serial": false, "since": at("09:41:00"), "workstreamId": "W14" }
        ]),
        _ => json!([
            { "kind": "plan", "label": "P12 full lab run", "serial": true, "itemId": "P12", "workstreamId": "W14" },
            { "kind": "live", "label": "CI on #212 (rust (macos) 8m)", "serial": false, "workstreamId": "W14" }
        ]),
    };
    let headline_text = match (kind.as_str(), quiet) {
        ("fleet", false) => "Fixing cart rounding and speeding up product search, waiting on the full lab run. 3 decisions need you.",
        ("fleet", true) => {
            "Not live: buildbox silent 4m · GitHub unchecked 6m. Fixing cart rounding and speeding up product search, waiting on the full lab run."
        }
        ("project", _) => "Rounding fix in review, search speedup merging; the lab run gates the rest. 1 decision needs you.",
        _ => "T31 is fixing the rounding while #212 is reviewed; it waits on your answer about the health path.",
    };
    let headline = if kind == "project" {
        json!({ "text": headline_text, "source": "template", "reason": "facts changed, rewriting", "at": at("10:07:05") })
    } else {
        json!({ "text": headline_text, "source": "generated", "promptRef": "status.headline@3f2a9c41d0", "at": at("10:06:40") })
    };
    let since = match kind.as_str() {
        "fleet" => json!({ "seenAt": at("09:12:30"), "merged": 7, "verified": 3, "started": 2, "failed": 1, "asked": 1, "scopeItems": 3 }),
        "project" => json!({ "seenAt": at("09:12:30"), "merged": 3, "verified": 2, "started": 1, "failed": 0, "asked": 1, "scopeItems": 3 }),
        _ => json!({ "merged": 0, "verified": 0, "started": 0, "failed": 0, "asked": 0, "scopeItems": 0 }),
    };
    let progress = |pct: i64, done: i64, total: i64, marker: Option<&str>, stale: Option<&Value>| {
        let mut p = json!({ "pct": pct, "done": done, "total": total, "polishDone": 0, "polishTotal": 0, "asOf": at("10:07:10") });
        if let Some(m) = marker {
            p["marker"] = json!({ "at": at("10:00:04"), "text": m, "pctBefore": pct + 5, "pctAfter": pct, "deltaItems": 3 });
        }
        if let Some(s) = stale {
            p["stale"] = s.clone();
        }
        p
    };
    let parts = match kind.as_str() {
        "fleet" => json!([
            { "title": "storefront", "scope": { "kind": "project", "projectRef": { "machineId": "devbox", "projectId": "storefront" } },
              "progress": progress(64, 7, 11, Some("+3 items"), github.as_ref()), "eta": "2026-10-22T14:00:00.000Z" },
            { "title": "web-app", "scope": { "kind": "project", "projectRef": { "machineId": "buildbox", "projectId": "web-app" } },
              "progress": progress(86, 6, 7, None, None), "eta": "2026-10-18T17:00:00.000Z" },
            { "title": "mailer", "scope": { "kind": "project", "projectRef": { "machineId": "devbox", "projectId": "mailer" } },
              "progress": progress(0, 0, 1, None, None) }
        ]),
        "project" => json!([
            { "title": "M1 Multi-currency checkout", "milestoneId": "M1", "progress": progress(58, 4, 7, Some("+3 items"), github.as_ref()),
              "eta": "2026-10-22T14:00:00.000Z" },
            { "title": "M2 Search under 200 ms", "milestoneId": "M2", "progress": progress(75, 3, 4, None, None), "eta": "2026-10-18T16:00:00.000Z" }
        ]),
        _ => json!([
            { "title": "M1 Multi-currency checkout", "milestoneId": "M1", "progress": progress(62, 3, 5, None, github.as_ref()),
              "eta": "2026-10-18T15:10:00.000Z" }
        ]),
    };
    let doing_t31 = json!({ "itemId": "P12", "workstreamId": "W14", "title": "Round totals per currency, not per line",
        "taskIds": ["T31"], "changeIds": [], "eta": "2026-10-18T10:40:00.000Z" });
    let doing_t33 = json!({ "itemId": "P13", "workstreamId": "W14", "title": "Review #212", "taskIds": ["T33"], "changeIds": ["X12"],
        "gate": "CI on #212", "eta": "2026-10-18T09:55:00.000Z", "overdueMinutes": 12 });
    let mut doing_w9 = json!({ "itemId": "P21", "workstreamId": "W9", "title": "Login form keeps the email on error",
        "taskIds": ["T41"], "changeIds": [], "eta": "2026-10-18T11:20:00.000Z" });
    if let Some(s) = &buildbox {
        doing_w9["stale"] = s.clone();
    }
    let in_progress = match kind.as_str() {
        "fleet" => json!([doing_t31, doing_t33, doing_w9]),
        _ => json!([doing_t31, doing_t33]),
    };
    let next = json!([
        { "itemId": "P14", "workstreamId": "W14", "title": "JPY and KRW carts round to whole units", "after": ["P12"] },
        { "itemId": "P15", "title": "Currency table export for finance", "after": ["P12", "P14"] },
        { "itemId": "P16", "title": "Docs page: how totals are rounded", "after": [] }
    ]);
    let done_rows = json!([
        { "itemId": "P9", "workstreamId": "W14", "title": "Totals use integer minor units", "doneAt": at("09:46:12"),
          "evidence": "#208 merged by the train 09:46 · check 2 passed C7" },
        { "itemId": "P8", "workstreamId": "W12", "title": "Search index warms on deploy", "doneAt": at("09:12:40"),
          "evidence": "#205 merged by the train 09:12 · check 1 passed C5" },
        { "workstreamId": "W11", "title": "Product page shows stock per size", "doneAt": at("08:30:02"),
          "evidence": "W11 verified: 3 of 3 checks passed C4" }
    ]);
    let (needs_count, ask_ids) = match kind.as_str() {
        "fleet" => (3, json!(["A7", "A2", "A3"])),
        _ => (1, json!(["A7"])),
    };
    let mut risks = vec![
        json!({ "rule": "ci_red_main", "level": "danger", "message": "main CI red on acme/storefront: rust (macos) since 09:40" }),
        json!({ "rule": "machine_flaky", "level": "warning", "message": "buildbox went offline 2× today (last 09:02, 11m)" }),
        json!({ "rule": "slipping", "level": "warning", "message": "ETA slipped 20h (6h scope, 14h slower)" }),
        json!({ "rule": "riskiest_item", "level": "warning", "message": "riskiest: P12 Round totals per currency (l, 2 failed attempts)" }),
    ];
    if kind == "order" {
        risks.insert(1, json!({ "rule": "estimate_drift", "level": "warning", "message": "lead estimated 1h 30m; measured speed says 5h" }));
        risks.truncate(4);
    }
    let mut ci_store = json!({ "repo": "acme/storefront", "state": "red", "sha": "a41c09e", "failing": ["rust (macos)"],
        "since": at("09:40:00"), "asOf": at(if quiet { "10:01:02" } else { "10:06:58" }) });
    if let Some(s) = &github {
        ci_store["stale"] = s.clone();
    }
    let ci = match kind.as_str() {
        "fleet" => {
            json!([ci_store, { "repo": "acme/web-app", "state": "green", "sha": "9be20f1", "failing": [], "since": at("08:02:00"), "asOf": at("10:06:51") }])
        }
        _ => json!([ci_store]),
    };
    let mut buildbox_m = if quiet {
        json!({ "machineId": "buildbox", "status": "offline", "lastSeenAt": at("10:03:02"), "dropsToday": 3 })
    } else {
        json!({ "machineId": "buildbox", "status": "online", "lastSeenAt": at("10:07:01"),
            "slept": { "fromMs": crate::live::state::parse_ms(&at("08:51:10")).unwrap_or(0), "toMs": crate::live::state::parse_ms(&at("09:01:56")).unwrap_or(0) },
            "dropsToday": 2 })
    };
    if let Some(s) = &buildbox {
        buildbox_m["stale"] = s.clone();
    }
    let mut usage_b =
        json!({ "limitType": "seven_day", "machineId": "buildbox", "utilization": 0.41, "status": "allowed", "observedAt": at("09:58:30") });
    if let Some(s) = &buildbox {
        usage_b["stale"] = s.clone();
    }
    let health = json!({
        "ci": ci,
        "machines": [{ "machineId": "devbox", "status": "online", "lastSeenAt": at("10:07:05"), "dropsToday": 0 }, buildbox_m],
        "usage": [{ "limitType": "five_hour", "machineId": "devbox", "utilization": 0.58, "status": "allowed", "observedAt": at("10:05:20") }, usage_b],
        "slots": { "running": 8, "used": 8, "cap": 40, "queued": 1 }
    });
    let stale_list = match (&github, &buildbox) {
        (Some(g), Some(b)) => json!([
            { "source": "machine:buildbox", "since": b["since"], "reason": b["reason"] },
            { "source": "usage:buildbox", "since": b["since"], "reason": "buildbox is silent, so its usage reading is from 09:58" },
            { "source": "github:acme/storefront", "since": g["since"], "reason": g["reason"] }
        ]),
        _ => json!([]),
    };
    let mut progress_top = json!({ "pct": pct, "polishPct": (polish_done * 100) / polish_total.max(1), "done": done, "total": total,
        "polishDone": polish_done, "polishTotal": polish_total, "asOf": at(if quiet { "10:01:02" } else { "10:07:10" }), "marker": marker });
    if let Some(g) = &github {
        progress_top["stale"] = g.clone();
    }
    let doc = json!({
        "scope": scope_json, "title": title, "version": 12, "seq": 4810, "now": FIXTURE_NOW,
        "progress": progress_top, "markers": markers, "eta": eta, "gates": gates, "headline": headline, "since": since,
        "parts": parts, "done": done_rows, "inProgress": in_progress, "next": next,
        "needsYou": { "count": needs_count, "askIds": ask_ids }, "risks": risks, "health": health, "stale": stale_list,
        "more": { "done": if kind == "fleet" { 6 } else { 2 }, "inProgress": 0, "next": 1, "risks": 0, "parts": 0, "stale": 0 }
    });
    serde_json::from_value(doc).expect("status fixture matches the contracts")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_fixture_scope_decodes() {
        for scope in [StatusScope::Fleet, super::super::project_scope("devbox", "storefront"), super::super::order_scope("W14")] {
            for v in [Variant::Live, Variant::Stale] {
                let d = doc(&scope, v);
                assert_eq!(d.scope.key(), scope.key());
                assert_eq!(d.stale.is_empty(), v == Variant::Live);
            }
        }
    }
}
