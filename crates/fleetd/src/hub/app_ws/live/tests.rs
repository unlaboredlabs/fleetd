use fleetd_contracts::live::{Activity, ActivityNow, LaneStatus, LiveLane, Spark, Tokens};
use fleetd_contracts::prim::{List, Text};

use super::*;

fn lane(id: &str, status: LaneStatus, activity: Option<&str>, samples: Vec<u8>) -> LaneNow {
    LaneNow {
        lane: LiveLane {
            lane_id: Text::unchecked(id),
            status,
            activity: activity.map(|cmd| ActivityNow {
                activity: Activity::Command {
                    text: Text::unchecked(cmd),
                },
                since: "2026-10-18T10:00:00.000Z".into(),
            }),
            tokens: Some(Tokens {
                input: 10,
                output: 2,
                cache_read: 0,
                live: false,
            }),
            spark: Some(Spark {
                end_at: "2026-10-18T10:00:00.000Z".into(),
                samples: List::unchecked(samples),
            }),
        },
        text: None,
    }
}

fn tick(lanes: Vec<LaneNow>) -> TickInput {
    TickInput {
        now_ms: 1_000,
        lanes,
        board_complete: true,
        machines: None,
        slots: None,
    }
}

fn ids(frame: &LiveFrame) -> Vec<&str> {
    frame.lanes.iter().map(|l| l.lane_id.as_str()).collect()
}

#[test]
fn only_what_changed_is_sent_after_the_full_frame() {
    let mut pump = Pump::default();
    let first = pump
        .frame(tick(vec![
            lane("T1", LaneStatus::Working, Some("cargo test"), vec![0, 16]),
            lane("T2", LaneStatus::Queued, None, vec![0, 0]),
        ]))
        .unwrap();
    assert!(first.full);
    assert_eq!(ids(&first).len(), 2);

    // Nothing moved: no frame at all.
    let same = vec![
        lane("T1", LaneStatus::Working, Some("cargo test"), vec![0, 16]),
        lane("T2", LaneStatus::Queued, None, vec![0, 0]),
    ];
    assert!(pump.frame(tick(same)).is_none());

    // T1's command changed; its sparkline did not, so it goes without one.
    let frame = pump
        .frame(tick(vec![
            lane("T1", LaneStatus::Working, Some("git push"), vec![0, 16]),
            lane("T2", LaneStatus::Queued, None, vec![0, 0]),
        ]))
        .unwrap();
    assert!(!frame.full);
    assert_eq!(ids(&frame), vec!["T1"]);
    assert!(frame.lanes[0].spark.is_none());

    // A new bucket on T2 alone sends T2 with its sparkline.
    let frame = pump
        .frame(tick(vec![
            lane("T1", LaneStatus::Working, Some("git push"), vec![0, 16]),
            lane("T2", LaneStatus::Queued, None, vec![0, 32]),
        ]))
        .unwrap();
    assert_eq!(ids(&frame), vec!["T2"]);
    assert!(frame.lanes[0].spark.is_some());
}

#[test]
fn streamed_text_is_sent_once_in_order() {
    let mut pump = Pump::default();
    let with_text = |total: u64, tail: &str| {
        let mut l = lane("lead:lab-a/p1", LaneStatus::Working, None, vec![]);
        l.text = Some(StreamText {
            message_id: "m1".into(),
            tail: tail.into(),
            total,
        });
        tick(vec![l])
    };
    let first = pump.frame(with_text(5, "Hello")).unwrap();
    assert_eq!(first.text[0].append.as_str(), "Hello");
    let next = pump.frame(with_text(11, "Hello world")).unwrap();
    assert_eq!(next.text[0].append.as_str(), " world");
    assert!(pump.frame(with_text(11, "Hello world")).is_none());
}

#[test]
fn a_frame_stays_under_its_byte_limit_and_the_rest_waits() {
    let mut pump = Pump::default();
    let long = "x".repeat(150);
    let lanes = |n: usize| -> Vec<LaneNow> {
        (0..n)
            .map(|i| {
                lane(
                    &format!("T{}", i + 1),
                    LaneStatus::Working,
                    Some(&long),
                    vec![255; 30],
                )
            })
            .collect()
    };
    let first = pump.frame(tick(lanes(60))).unwrap();
    let bytes = serde_json::to_vec(&first).unwrap().len();
    assert!(bytes <= LIVE_MAX_FRAME_BYTES, "{bytes} bytes");
    let sent = first.lanes.len();
    assert!(sent < 60);
    // The lanes that did not fit go in the next frame, unchanged as they are.
    let second = pump.frame(tick(lanes(60))).unwrap();
    assert_eq!(sent + second.lanes.len(), 60);
}

#[test]
fn a_slow_socket_gets_the_latest_values_not_every_step() {
    let slot = LiveSlot::default();
    let mut pump = Pump::default();
    let build = |pump: &mut Pump, cmd: &str| {
        pump.frame(tick(vec![lane(
            "T1",
            LaneStatus::Working,
            Some(cmd),
            vec![],
        )]))
        .map(|f| serde_json::to_string(&f).unwrap())
    };
    assert!(slot.offer(build(&mut pump, "step 1").unwrap()));
    // The socket is busy: the driver checks `pending` and builds nothing while the frame waits.
    assert!(slot.pending());
    assert!(!slot.offer("ignored".into()));
    // Steps 2 and 3 happen meanwhile; only the state when the socket is free again is sent.
    let taken = slot.take().unwrap();
    assert!(taken.contains("step 1"));
    let next = build(&mut pump, "step 3").unwrap();
    assert!(next.contains("step 3") && !next.contains("step 2"));
    assert!(slot.offer(next));
}
