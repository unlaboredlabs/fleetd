//! Steers for the bench and screenshots (which run without a hub), and the fake hub's answers to the steer tools,
//! so the composer, receipts and sheet can be clicked through there.

use fleetd_contracts::app::{AppCallId, AppClientMessage, AppServerMessage};
use fleetd_contracts::mcp::TailItem;
use serde_json::{Value, json};

use super::{Steer, SteerStage};
use crate::fake::{FIXTURE_NOW, FIXTURE_ORDER};
use crate::shell::Shell;
use crate::state::State;

fn at(m: &str) -> String {
    format!("2026-10-18T10:{m}.000Z")
}

fn steer(id: &str, target: Value, mode: &str, text: &str, stage: &str, queued: &str, extra: Value) -> Steer {
    let mut v = json!({ "id": id, "target": target, "workstreamId": FIXTURE_ORDER, "runId": format!("run-{id}"),
        "thread": { "machineId": "devbox", "threadId": if target.get("taskId").is_some() { "s-31" } else { "s-lead" } },
        "by": { "kind": "human", "keyName": "laptop" }, "mode": mode, "text": text, "stage": stage, "queuedAt": at(queued) });
    if let (Value::Object(v), Value::Object(extra)) = (&mut v, extra) {
        v.extend(extra);
    }
    serde_json::from_value(v).expect("steer fixture")
}

fn lead() -> Value {
    json!({ "workstreamId": FIXTURE_ORDER })
}

fn task(t: &str) -> Value {
    json!({ "taskId": t })
}

/// `scene`: "steer" (acknowledged, not acknowledged, queued behind a running command), "steer-more" (delivered,
/// withdrawn, failed) or "sheet" (T31's steers).
pub fn steers(scene: &str) -> Vec<Steer> {
    let acked = steer(
        "S11",
        lead(),
        "now",
        "Skip the docs page for now; ship the rounding fix first.",
        "acknowledged",
        "03:40",
        json!({
        "deliveredAt": at("03:40"), "how": "stopped", "stoppedTool": "npm run docs:build", "ackedAt": at("03:42"),
        "ackExcerpt": "S11: dropping the docs page from W14; plan −1 item, finishing the rounding fix.", "planChange": "−1 item" }),
    );
    let missed = steer(
        "S12",
        task("T31"),
        "queue",
        "Round half to even, not half up; finance asked for banker's rounding.",
        "unacknowledged",
        "05:10",
        json!({
        "deliveredAt": at("05:31"), "how": "boundary", "ackExcerpt": "Continuing with the rounding tests in src/cart/total.test.ts." }),
    );
    let queued = steer("S13", lead(), "queue", "Also cover JPY, which has no minor unit.", "queued", "07:02", json!({}));
    match scene {
        "steer" => vec![acked, missed, queued],
        "sheet" => vec![missed, steer("S14", task("T31"), "queue", "Keep the old helper exported until #212 lands.", "queued", "07:05", json!({}))],
        _ => vec![
            acked,
            steer(
                "S15",
                task("T33"),
                "queue",
                "Review against the multi-currency cases too.",
                "delivered",
                "05:40",
                json!({
                "deliveredAt": at("06:32"), "how": "boundary" }),
            ),
            steer("S16", lead(), "queue", "Hold the PR until I check the totals page.", "withdrawn", "06:10", json!({})),
            steer(
                "S17",
                task("T30"),
                "now",
                "Reopen #211 and add the missing test.",
                "failed",
                "06:50",
                json!({
                "detail": "T30 has ended; its session was reaped. Send it to the lead instead." }),
            ),
        ],
    }
}

/// The lead's log with the steers it took in: the hub's text for each, then its reply naming it.
pub fn lead_tail(base: &[TailItem]) -> Vec<TailItem> {
    let mut items = base.to_vec();
    let more: Vec<TailItem> = serde_json::from_value(json!([
        { "kind": "message", "at": at("03:40"), "role": "user",
          "text": "S11 · the human steers you (lead of W14): 'Skip the docs page for now; ship the rounding fix first.'\nBegin your next message with \"S11:\" and one line on what you will do; then carry on unless this changes it." },
        { "kind": "message", "at": at("03:42"), "role": "assistant", "text": "S11: dropping the docs page from W14; plan −1 item, finishing the rounding fix." },
    ]))
    .expect("tail fixture");
    for item in more {
        let at = match &item {
            TailItem::Message(m) => m.at.to_string(),
            TailItem::Action(a) => a.at.to_string(),
        };
        let ix = items
            .iter()
            .position(|i| match i {
                TailItem::Message(m) => m.at.to_string() > at,
                TailItem::Action(a) => a.at.to_string() > at,
            })
            .unwrap_or(items.len());
        items.insert(ix, item);
    }
    items
}

/// T31's recent items, for its sheet.
fn agent_tail() -> Value {
    let msg = |m: &str, role: &str, text: &str| json!({ "kind": "message", "at": at(m), "role": role, "text": text });
    let act = |m: &str, kind: &str, summary: &str| json!({ "kind": "action", "at": at(m), "action": { "at": at(m), "kind": kind, "status": "completed", "summary": summary, "failed": false } });
    json!([
        act("07:01", "file_change", "src/cart/total.ts"),
        act("06:44", "command", "npm test -- cart"),
        msg("06:40", "assistant", "Tests pass for USD and EUR. Adding the GBP and JPY cases next."),
        act("06:02", "command", "rg -n roundTotal src"),
        msg("05:33", "assistant", "Continuing with the rounding tests in src/cart/total.test.ts."),
        msg(
            "05:31",
            "user",
            "S12 · the human steers you (T31, writer of W14): 'Round half to even, not half up; finance asked for banker's rounding.'"
        ),
        msg("03:10", "user", "Implement W14: fix the cart total rounding for multi-currency orders."),
    ])
}

/// The fake hub's answer to a steer call, as the hub's tools would give it.
pub fn answer(message: &AppClientMessage, state: &State) -> Option<AppServerMessage> {
    let AppClientMessage::Call { id, tool, input } = message else { return None };
    let output = match tool.as_str() {
        "steer_send" => {
            let n = state.steers.iter().filter_map(|s| s.id.strip_prefix('S')?.parse::<u64>().ok()).max().unwrap_or(10) + 1;
            json!({ "id": format!("S{n}"), "target": input["target"], "workstreamId": FIXTURE_ORDER, "runId": format!("run-S{n}"),
                "thread": { "machineId": "devbox", "threadId": "s-lead" }, "by": { "kind": "human", "keyName": "laptop" }, "mode": input["mode"], "text": input["text"], "stage": "queued", "queuedAt": FIXTURE_NOW })
        }
        "steer_withdraw" => {
            let s = state.steers.iter().find(|s| s.id == input["steerId"].as_str().unwrap_or_default())?;
            serde_json::to_value(Steer { stage: SteerStage::Withdrawn, ..s.clone() }).ok()?
        }
        "steers_list" => json!({ "steers": state.steers }),
        "thread_tail" => json!({ "items": agent_tail(), "thread": { "threadId": input["threadId"], "machineId": input["machineId"],
            "projectId": "storefront", "title": "T31", "status": "running", "headline": "", "latestMessageTail": "",
            "lastProgressAt": FIXTURE_NOW, "stale": false, "asOf": FIXTURE_NOW } }),
        _ => return None,
    };
    Some(AppServerMessage::Result { id: AppCallId::unchecked(id.as_str()), output })
}

/// The lead's live activity for the "steer" scene: a long command, so a queued steer has something to wait on.
pub fn lead_running_frame() -> Value {
    json!({ "t": "live", "at": FIXTURE_NOW, "full": false, "lanes": [
        { "laneId": "lead:devbox/storefront", "status": "working",
          "activity": { "activity": { "kind": "command", "text": "npm run test:e2e" }, "since": at("06:00") } } ] })
}

impl Shell {
    /// `FLEETD_SCREEN=order+steer|steer-more|sheet|sheet-lead|palette-steer`, for screenshots.
    pub(crate) fn bench_steer(&mut self, scene: &str, window: &mut gpui::Window, cx: &mut gpui::Context<Self>) {
        self.state.steers = steers(if scene.starts_with("sheet") { "sheet" } else { scene });
        if scene == "sheet-lead" || scene == "palette-steer" {
            self.state.steers.extend(steers("steer"));
            self.state.steers.sort_by_key(|s| s.id.n());
        }
        if let Some(detail) = self.state.detail.as_mut() {
            detail.tail = lead_tail(&detail.tail);
            detail.version += 1;
        }
        let frame: AppServerMessage = serde_json::from_value(lead_running_frame()).expect("live frame");
        if let AppServerMessage::Live(frame) = frame {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
            self.state.live.apply(frame, now);
        }
        match scene {
            "sheet" => self.open_lane_sheet("T31", cx),
            "sheet-lead" => {
                if let Some(agent) = self.lead_agent() {
                    self.open_steer_sheet(agent, cx);
                }
            }
            "palette-steer" => {
                self.toggle_palette(window, cx);
                if let Some(p) = &self.palette {
                    p.update(cx, |p, cx| p.set_query("Steer ", cx));
                }
            }
            _ => {}
        }
    }
}
