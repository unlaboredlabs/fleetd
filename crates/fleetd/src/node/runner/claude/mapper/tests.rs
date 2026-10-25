//! Replays the recorded claude 2.1.302 transcripts through the mapper. "in" lines drive fleetd's side (send,
//! answer, interrupt) and must come out byte-for-byte as recorded; "out" and "stderr" lines are fed; the "meta" exit
//! ends the process. The classifier is a recorder, so these tests pin the evidence R2's classifier receives.
use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

use super::*;

const AT: &str = "2026-10-18T10:00:00.000Z";

fn now() -> Now {
    now_at(0)
}

/// The recorded line's time: fixtures carry ms since the process started.
fn now_at(ms: u64) -> Now {
    Now {
        at: Timestamp::from(AT),
        ms: 1_792_000_000_000 + ms,
    }
}

struct Replay {
    /// Everything but the time spans, which are in `spans`.
    events: Vec<RunnerEvent>,
    spans: Vec<fleetd_contracts::time::SpanWire>,
    evidence: Vec<FailureEvidence>,
    /// (recorded stdin line, the line the mapper wrote for it)
    inputs: Vec<(Value, Value)>,
    replies: Vec<Input>,
    /// Recorded stdin lines the mapper writes itself as replies (a `send_now` on its message's `queued`).
    expected_replies: Vec<Value>,
    sent: Vec<String>,
}

fn fixtures() -> Vec<String> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/node/runner/fixtures");
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn replay(name: &str) -> Replay {
    replay_with(name, |_| {})
}

/// `before_exit` runs just before the recorded exit, e.g. to mark the node as stopping.
fn replay_with(name: &str, before_exit: impl FnOnce(&mut StreamMapper)) -> Replay {
    let file = if name.ends_with(".jsonl") {
        name.to_owned()
    } else {
        format!("claude-2.1.302-{name}.jsonl")
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/node/runner/fixtures")
        .join(&file);
    let evidence = Arc::new(Mutex::new(Vec::new()));
    let seen = evidence.clone();
    let classify: Classify = Arc::new(move |e: &FailureEvidence| {
        seen.lock().unwrap().push(e.clone());
        let text = if e.text.is_empty() {
            "no text"
        } else {
            &e.text
        };
        Some(RunFailure {
            class: FailureClass::Other,
            message: Text::unchecked(text),
            api_status: e.api_error_status,
            reset_at: None,
            retries: 0,
            model: None,
        })
    });
    let mut mapper = StreamMapper::new("s", classify);
    let mut before_exit = Some(before_exit);
    let mut out = Replay {
        events: Vec::new(),
        evidence: Vec::new(),
        inputs: Vec::new(),
        replies: Vec::new(),
        expected_replies: Vec::new(),
        sent: Vec::new(),
        spans: Vec::new(),
    };
    // The steer probe's fixtures name their steer, and which mode sent it.
    let mut steer: Option<(String, String)> = None;
    for raw in std::fs::read_to_string(&path).unwrap().lines() {
        let rec: Value = serde_json::from_str(raw).unwrap();
        let msg = &rec["msg"];
        let ms = rec["ms"].as_u64().unwrap_or(0);
        match rec["dir"].as_str().unwrap() {
            "meta" if msg.get("steer").is_some() => {
                let scenario = msg["scenario"].as_str().unwrap().to_owned();
                steer = Some((msg["steer"].as_str().unwrap().to_owned(), scenario));
            }
            "in" => {
                let ours = match msg["type"].as_str().unwrap() {
                    "user" => {
                        let run_id = msg["uuid"].as_str().unwrap();
                        out.sent.push(run_id.to_owned());
                        let mode = match (&steer, msg["priority"].as_str()) {
                            (_, Some("now")) => SendMode::Boundary,
                            (Some((id, scenario)), _)
                                if id == run_id && scenario == "steer-send-now" =>
                            {
                                SendMode::Now
                            }
                            _ => SendMode::Plain,
                        };
                        let mut lines =
                            mapper.send(run_id, msg["message"]["content"].as_str().unwrap(), mode);
                        assert_eq!(lines.len(), 1, "{file}: one stdin line per send");
                        lines.pop().unwrap()
                    }
                    "control_request" if msg["request"]["send_now"] == true => {
                        out.expected_replies.push(msg.clone());
                        continue;
                    }
                    "control_request" if msg["request"]["subtype"] == "cancel_async_message" => {
                        let run_id = msg["request"]["message_uuid"].as_str().unwrap();
                        mapper.withdraw(run_id).expect("claude still holds it")
                    }
                    // `initialize` is the conformance probe's (R2), not a session's.
                    "control_request" if msg["request"]["subtype"] == "interrupt" => {
                        mapper.interrupt()
                    }
                    "control_request" => continue,
                    "control_response" => {
                        let answer = &msg["response"]["response"];
                        let decision = match answer["behavior"].as_str().unwrap() {
                            "allow" => PermissionDecision::Allow {
                                updated_input: None,
                            },
                            _ => PermissionDecision::Deny {
                                message: Text::unchecked(answer["message"].as_str().unwrap()),
                            },
                        };
                        let request_id = msg["response"]["request_id"].as_str().unwrap();
                        mapper
                            .answer(request_id, &decision, Some(DecidedBy::Human), &now_at(ms))
                            .expect("claude waits for this answer")
                    }
                    other => panic!("{file}: unexpected stdin line {other}"),
                };
                out.inputs
                    .push((msg.clone(), serde_json::to_value(ours).unwrap()));
            }
            "out" => {
                let mapped = mapper.feed(serde_json::from_value(msg.clone()).unwrap(), &now_at(ms));
                out.events.extend(mapped.events);
                out.replies.extend(mapped.replies);
            }
            "stderr" => mapper.stderr(rec["raw"].as_str().unwrap().trim_end_matches('\n')),
            "meta" if msg.get("exit").is_some() => {
                (before_exit.take().unwrap())(&mut mapper);
                let signal = match msg["signal"].as_str() {
                    Some("SIGKILL") => Some(9),
                    Some("SIGTERM") => Some(15),
                    _ => None,
                };
                let exit = ExitInfo {
                    code: msg["exit"].as_i64().map(|c| c as i32),
                    signal,
                    stderr_tail: mapper.stderr_tail(),
                };
                out.events.extend(mapper.exited(exit, &now_at(ms)));
            }
            _ => {}
        }
    }
    out.evidence = evidence.lock().unwrap().clone();
    let events = std::mem::take(&mut out.events);
    for e in events {
        match e {
            RunnerEvent::Spans(s) => out.spans.extend(s),
            other => out.events.push(other),
        }
    }
    out
}

fn run_ends(events: &[RunnerEvent]) -> Vec<(&str, &RunOutcome)> {
    events
        .iter()
        .filter_map(|e| match e {
            RunnerEvent::RunEnded {
                run_id, outcome, ..
            } => Some((run_id.as_str(), outcome)),
            _ => None,
        })
        .collect()
}

fn items(events: &[RunnerEvent]) -> Vec<&ThreadItem> {
    events
        .iter()
        .filter_map(|e| match e {
            RunnerEvent::Item(item) => Some(item),
            _ => None,
        })
        .collect()
}

fn texts(events: &[RunnerEvent]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|e| match e {
            RunnerEvent::AssistantText { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn the_stdin_writer_reproduces_every_recorded_input_line() {
    let mut checked = 0;
    for name in fixtures() {
        for (recorded, ours) in replay(&name).inputs {
            assert_eq!(ours, recorded, "{name}");
            checked += 1;
        }
    }
    // A user message per fixture, plus the permission answers and the interrupt.
    assert!(checked >= 22, "only {checked} input lines checked");
}

#[test]
fn every_sent_run_ends_exactly_once_and_the_exit_comes_last() {
    for name in fixtures() {
        let replay = replay(&name);
        let ends = run_ends(&replay.events);
        for run_id in &replay.sent {
            let n = ends.iter().filter(|(id, _)| id == run_id).count();
            assert_eq!(n, 1, "{name}: run {run_id} ended {n} times");
        }
        assert!(
            matches!(replay.events.last(), Some(RunnerEvent::Exited(_))),
            "{name}: Exited is not last"
        );
        let mut last_status = HashMap::new();
        for item in items(&replay.events) {
            last_status.insert(item.id.as_str(), item.status);
        }
        assert!(
            last_status.values().all(|s| *s != ItemStatus::Running),
            "{name}: an item never finished: {last_status:?}"
        );
        let replies: Vec<Value> = replay
            .replies
            .iter()
            .map(|r| serde_json::to_value(r).unwrap())
            .collect();
        assert_eq!(replies, replay.expected_replies, "{name}: replies");
    }
}

#[test]
fn two_turns_in_one_process() {
    let replay = replay("init-partial-two-turns");
    let init = RunnerEvent::Init {
        version: "2.1.302".into(),
        model: "claude-haiku-5-5".into(),
        cwd: "/work/project".into(),
        // Recorded without fleetd's deny list.
        agent_tools: Some(
            ["Task", "ListAgents", "SendMessage", "TaskStop", "Workflow"]
                .map(String::from)
                .into(),
        ),
    };
    let (r1, m1) = (
        "e8d52832-5cea-4aac-ba3b-f1e6763315a8",
        "msg_011Cg9aDpP7fzKKzDbb8vkFt",
    );
    let (r2, m2) = (
        "a87c3994-cb34-4cef-a995-187ea281a4c5",
        "msg_011Cg9aDvUxvevdzsgdPectE",
    );
    let usage = |cache_creation, cache_read, output, cost| {
        Some(RunUsage {
            input_tokens: 2,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_creation,
            cost_usd: Some(cost),
        })
    };
    let turn = |run: &str, message: &str, text: &str, usage: Option<RunUsage>| {
        // The streamed usage (message_start, then message_delta) is the result's, without claude's cost estimate.
        let live = RunnerEvent::Usage {
            run_id: run.into(),
            usage: RunUsage {
                cost_usd: None,
                ..usage.clone().unwrap()
            },
        };
        vec![
            RunnerEvent::Queued { run_id: run.into() },
            RunnerEvent::RunStarted { run_id: run.into() },
            init.clone(),
            RunnerEvent::Seen {
                run_ids: vec![run.into()],
            },
            live.clone(),
            RunnerEvent::Delta {
                message_id: message.into(),
                append: text.into(),
            },
            RunnerEvent::AssistantText {
                message_id: message.into(),
                text: text.into(),
            },
            live,
            RunnerEvent::RunEnded {
                run_id: run.into(),
                outcome: RunOutcome::Completed { text: text.into() },
                usage,
            },
        ]
    };
    let mut expected = turn(r1, m1, "OK", usage(27181, 0, 4, 0.003399825));
    expected.extend(turn(r2, m2, "TWO", usage(3055, 24171, 5, 0.00402611)));
    expected.push(RunnerEvent::Exited(ExitInfo {
        code: Some(0),
        signal: None,
        stderr_tail: String::new(),
    }));
    assert_eq!(replay.events, expected);
}

#[test]
fn deltas_keep_arriving_in_order_and_match_the_complete_text() {
    let replay = replay("resume");
    let deltas: Vec<(&str, &str)> = replay
        .events
        .iter()
        .filter_map(|e| match e {
            RunnerEvent::Delta { message_id, append } => {
                Some((message_id.as_str(), append.as_str()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(deltas.len(), 2);
    let joined: String = deltas.iter().map(|(_, a)| *a).collect();
    let complete = replay.events.iter().find_map(|e| match e {
        RunnerEvent::AssistantText { message_id, text } => {
            Some((message_id.as_str(), text.as_str()))
        }
        _ => None,
    });
    assert_eq!(complete, Some((deltas[0].0, joined.as_str())));
    assert_eq!(joined, "OK, then TWO.");
}

#[test]
fn permission_prompts_carry_what_a_person_needs_and_the_answer_shows_on_the_tool() {
    let allow = replay("permission-allow");
    let request = allow.events.iter().find_map(|e| match e {
        RunnerEvent::PermissionRequest {
            request_id,
            tool_use_id,
            tool_name,
            input,
            summary,
        } => Some((request_id, tool_use_id, tool_name, input, summary)),
        _ => None,
    });
    let (request_id, tool_use_id, tool_name, input, summary) =
        request.expect("a permission request");
    assert_eq!(request_id, "7b61bb9d-782a-4cbe-b52a-01bcfaf05da6");
    assert_eq!(tool_use_id, "toolu_01BkSaeJX8QfJhbbZVabhXdh");
    assert_eq!(tool_name, "Bash");
    assert_eq!(input["command"], "touch perm-test.txt");
    assert_eq!(summary, "touch perm-test.txt");
    let bash = items(&allow.events);
    assert_eq!(
        bash.iter()
            .map(|i| (i.id.as_str(), i.status))
            .collect::<Vec<_>>(),
        vec![
            ("toolu_01BkSaeJX8QfJhbbZVabhXdh", ItemStatus::Running),
            ("toolu_01BkSaeJX8QfJhbbZVabhXdh", ItemStatus::Completed),
        ]
    );
    assert!(matches!(
        &bash[1].kind,
        ItemKind::Command { command, exit_code: Some(0), .. } if command == "touch perm-test.txt"
    ));
    assert_eq!(bash[1].title, "Create empty file perm-test.txt");
    assert_eq!(texts(&allow.events), vec!["DONE"]);

    let deny = replay("permission-deny");
    let done = *items(&deny.events).last().unwrap();
    assert_eq!(done.status, ItemStatus::Failed);
    assert!(matches!(
        &done.kind,
        ItemKind::Command { output: Some(o), .. } if o == "Denied by fleetd policy (test)."
    ));
    // A denied tool is the agent's business, not a failed run.
    assert!(
        matches!(run_ends(&deny.events)[..], [(_, RunOutcome::Completed { text })] if text == "DENIED")
    );
}

#[test]
fn an_allowlisted_command_reports_its_output() {
    let replay = replay("allowlisted-tool");
    let done = *items(&replay.events).last().unwrap();
    assert_eq!(done.status, ItemStatus::Completed);
    assert_eq!(
        done.run_id.as_deref(),
        Some("e27de424-2034-45ed-b5db-519db39424c1")
    );
    assert!(matches!(
        &done.kind,
        ItemKind::Command { command, output: Some(o), exit_code: Some(0), .. } if command == "echo hi" && o == "hi"
    ));
}

#[test]
fn an_interrupt_cancels_the_tool_and_ends_the_run_interrupted() {
    let replay = replay("interrupt-mid-tool");
    let tool = items(&replay.events);
    assert_eq!(tool.len(), 2);
    assert_eq!(tool[1].status, ItemStatus::Cancelled);
    assert!(matches!(
        &tool[1].kind,
        ItemKind::Command {
            exit_code: None,
            ..
        }
    ));
    // `result` aborted_tools, then lifecycle cancelled: one end, and claude's later exit 1 is no failure.
    assert_eq!(
        run_ends(&replay.events),
        vec![(
            "105ae926-5ace-4713-b671-c4f58f91803f",
            &RunOutcome::Interrupted
        )]
    );
    assert!(replay.evidence.is_empty());
}

#[test]
fn a_killed_process_ends_its_run_and_its_open_tool() {
    let crashed = replay("sigkill-mid-tool");
    let [(_, RunOutcome::Failed(_))] = run_ends(&crashed.events)[..] else {
        panic!("expected one failed run: {:?}", crashed.events);
    };
    let [evidence] = &crashed.evidence[..] else {
        panic!("classified {} times", crashed.evidence.len());
    };
    assert_eq!(evidence.exit.as_ref().map(|e| e.signal), Some(Some(9)));
    let cut = items(&crashed.events)
        .into_iter()
        .find(|i| {
            i.id.as_str() == "toolu_01JjFcFnWCNBKPLAWMKG1J3R" && i.status != ItemStatus::Running
        })
        .expect("the cut tool call ends");
    assert_eq!(cut.status, ItemStatus::Cancelled);

    // The same kill, but the node asked for it: the run was stopped, not failed.
    let stopped = replay_with("sigkill-mid-tool", |m| m.stopping());
    assert_eq!(run_ends(&stopped.events)[0].1, &RunOutcome::Interrupted);
    assert!(stopped.evidence.is_empty());

    // SIGTERM: claude kills its own tool child (exit 137) before exiting 143.
    let termed = replay("sigterm-mid-tool");
    let tool = items(&termed.events)[1];
    assert_eq!(tool.status, ItemStatus::Failed);
    assert!(matches!(
        &tool.kind,
        ItemKind::Command {
            exit_code: Some(137),
            ..
        }
    ));
    assert_eq!(
        termed.evidence[0].exit.as_ref().and_then(|e| e.code),
        Some(143)
    );
}

#[test]
fn api_errors_become_failure_evidence_and_never_the_agents_reply() {
    // (fixture, assistant error, api status, text starts with)
    let cases = [
        (
            "invalid-model",
            Some("unknown"),
            Some(400),
            "API Error: 400 unknown provider for model",
        ),
        (
            "not-logged-in",
            Some("authentication_failed"),
            None,
            "Not logged in · Please run /login",
        ),
        (
            "auth-expired-401",
            Some("authentication_failed"),
            Some(401),
            "Failed to authenticate. API Error: 401",
        ),
        (
            "overloaded-529",
            Some("server_error"),
            Some(529),
            "API Error: 529 Overloaded.",
        ),
        (
            "server-500",
            Some("server_error"),
            Some(500),
            "API Error: 500 Internal server error.",
        ),
        (
            "network-refused",
            Some("server_error"),
            None,
            "API Error: Connection refused",
        ),
        (
            "rate-limit-429",
            Some("rate_limit"),
            Some(429),
            "API Error: Request rejected (429)",
        ),
        (
            "usage-429-api-key",
            Some("rate_limit"),
            Some(429),
            "API Error: Request rejected (429)",
        ),
        (
            "usage-limit-subscription.documented",
            Some("rate_limit"),
            Some(429),
            "You've hit your limit",
        ),
    ];
    for (name, error, status, text) in cases {
        let replay = replay(name);
        let [evidence] = &replay.evidence[..] else {
            panic!("{name}: classified {} times", replay.evidence.len());
        };
        assert_eq!(evidence.assistant_error.as_deref(), error, "{name}");
        assert_eq!(evidence.api_error_status, status, "{name}");
        assert!(
            evidence.text.starts_with(text),
            "{name}: {:?}",
            evidence.text
        );
        assert_eq!(
            evidence.terminal_reason.as_deref(),
            Some("api_error"),
            "{name}"
        );
        assert!(evidence.exit.is_none(), "{name}");
        assert!(
            texts(&replay.events).is_empty(),
            "{name}: error text emitted as a reply"
        );
        // The failure is an item too, right before the run ends, so actions_list shows it.
        let n = replay.events.len();
        assert!(
            matches!(
                &replay.events[n - 3],
                RunnerEvent::Item(ThreadItem {
                    kind: ItemKind::Error { .. },
                    ..
                })
            ),
            "{name}: {:?}",
            replay.events
        );
    }

    // claude's stderr for the run goes to the classifier, which puts it under claude's text.
    let invalid = replay("invalid-model");
    assert!(invalid.evidence[0].is_error);
    assert_eq!(
        invalid.evidence[0].stderr,
        "[claude-code:unrecognized_model] {\"model\":\"claude-does-not-exist-9\",\"query_source\":\"sdk\"}"
    );
}

/// The mapper's evidence through R2's real classifier: each recorded failure lands in its §3.6 class.
#[test]
fn recorded_failures_land_in_their_class() {
    use crate::node::runner::claude::failure::classify;
    let cases = [
        ("invalid-model", FailureClass::InvalidRequest),
        ("not-logged-in", FailureClass::Auth),
        ("auth-expired-401", FailureClass::Auth),
        ("overloaded-529", FailureClass::Overloaded),
        ("server-500", FailureClass::Overloaded),
        ("network-refused", FailureClass::Network),
        ("rate-limit-429", FailureClass::RateLimit),
        (
            "claude-2.1.310-proxy-cooldown-429.jsonl",
            FailureClass::RateLimit,
        ),
        (
            "usage-limit-subscription.documented",
            FailureClass::UsageLimit,
        ),
        ("sigkill-mid-tool", FailureClass::ProcessExited),
        ("sigterm-mid-tool", FailureClass::ProcessExited),
        ("session-id-in-use", FailureClass::ProcessExited),
    ];
    for (name, class) in cases {
        let replay = replay(name);
        let classified =
            classify(&replay.evidence[0]).unwrap_or_else(|| panic!("{name}: no failure"));
        assert_eq!(
            classified.class,
            class,
            "{name}: {}",
            classified.message.as_str()
        );
    }
    let refused = classify(&replay("session-id-in-use").evidence[0]).unwrap();
    assert!(
        refused.message.contains("is already in use"),
        "{}",
        refused.message.as_str()
    );
}

#[test]
fn subscription_limits_arrive_structured() {
    let replay = replay("usage-limit-subscription.documented");
    let limit = RateLimit {
        status: "rejected".into(),
        resets_at: Some(1_792_335_600),
        limit_type: Some("five_hour".into()),
        utilization: None,
    };
    assert!(
        replay
            .events
            .contains(&RunnerEvent::RateLimit(limit.clone()))
    );
    assert_eq!(replay.evidence[0].rate_limit, Some(limit));
}

#[test]
fn retries_and_compaction_become_items() {
    let retried = replay("overloaded-529");
    let retries: Vec<_> = items(&retried.events)
        .into_iter()
        .filter_map(|i| match &i.kind {
            ItemKind::ApiRetry {
                attempt,
                max_retries,
                error_status,
                error,
                ..
            } => Some((
                *attempt,
                *max_retries,
                *error_status,
                error.as_str(),
                i.status,
            )),
            _ => None,
        })
        .collect();
    assert_eq!(
        retries,
        vec![
            (1, 2, Some(529), "overloaded", ItemStatus::Completed),
            (2, 2, Some(529), "overloaded", ItemStatus::Completed),
        ]
    );

    let replay = replay("compact-manual");
    let shape: Vec<String> = replay
        .events
        .iter()
        .filter_map(|e| match e {
            RunnerEvent::Compacting(on) => Some(format!("compacting {on}")),
            RunnerEvent::Item(ThreadItem {
                kind:
                    ItemKind::Compaction {
                        trigger,
                        pre_tokens,
                        post_tokens,
                    },
                ..
            }) => Some(format!("{trigger} {pre_tokens:?} -> {post_tokens:?}")),
            RunnerEvent::RunEnded { outcome, .. } => Some(format!("{outcome:?}")),
            RunnerEvent::AssistantText { .. } => Some("text".into()),
            _ => None,
        })
        .collect();
    assert_eq!(
        shape,
        vec![
            "compacting true",
            "compacting false",
            "manual Some(27287) -> Some(868)",
            r#"Completed { text: "" }"#,
        ]
    );
}

#[test]
fn a_refused_start_ends_the_run_with_claudes_words() {
    let replay = replay("session-id-in-use");
    let [(_, RunOutcome::Failed(_))] = run_ends(&replay.events)[..] else {
        panic!("expected a failed run: {:?}", replay.events);
    };
    let Some(RunnerEvent::Exited(exit)) = replay.events.last() else {
        panic!("no exit");
    };
    assert_eq!(
        exit.stderr_tail,
        "Error: Session ID 289edad3-c10d-43bc-9a66-699588cecfc8 is already in use."
    );
    assert_eq!(replay.evidence[0].exit.as_ref(), Some(exit));
    // What the session service reads to send the run again to a resumed process.
    let failure = crate::node::runner::claude::failure::classify(&replay.evidence[0]).unwrap();
    assert_eq!(failure.class, FailureClass::ProcessExited);
    assert!(crate::node::runner::claude::session_in_use(
        failure.message.as_str()
    ));
}

fn line(json: Value) -> Line {
    serde_json::from_value(json).unwrap()
}

fn recorder() -> Classify {
    Arc::new(|_| None)
}

#[test]
fn a_control_request_fleetd_does_not_handle_is_refused_so_claude_never_waits() {
    let mut mapper = StreamMapper::new("s", recorder());
    let mapped = mapper.feed(
        line(json!({"type":"control_request","request_id":"h1","request":{"subtype":"hook_callback"}})),
        &now(),
    );
    assert!(mapped.events.is_empty());
    assert_eq!(
        serde_json::to_value(&mapped.replies).unwrap(),
        json!([{"type":"control_response","response":{
            "subtype":"error","request_id":"h1","error":"fleetd does not handle hook_callback"}}])
    );
}

#[test]
fn a_prompt_claude_withdraws_is_cancelled_and_can_no_longer_be_answered() {
    let mut mapper = StreamMapper::new("s", recorder());
    mapper.feed(
        line(
            json!({"type":"control_request","request_id":"p1","request":{
            "subtype":"can_use_tool","tool_name":"Write","tool_use_id":"t1",
            "input":{"file_path":"/w/a.txt","content":"x"}}}),
        ),
        &now(),
    );
    let mapped = mapper.feed(
        line(json!({"type":"control_cancel_request","request_id":"p1"})),
        &now(),
    );
    let [RunnerEvent::Item(item)] = &mapped.events[..] else {
        panic!("{:?}", mapped.events);
    };
    assert_eq!(
        (item.id.as_str(), item.status),
        ("p1", ItemStatus::Cancelled)
    );
    assert!(
        matches!(&item.kind, ItemKind::Permission { summary, decision: None, .. } if summary == "/w/a.txt")
    );
    let allow = PermissionDecision::Allow {
        updated_input: None,
    };
    assert!(mapper.answer("p1", &allow, None, &now()).is_none());
}

#[test]
fn several_text_blocks_of_one_message_keep_distinct_ids_shared_with_their_deltas() {
    let mut mapper = StreamMapper::new("s", recorder());
    let stream =
        |event: Value| line(json!({"type":"stream_event","event":event,"parent_tool_use_id":null}));
    let mut events = Vec::new();
    for event in [
        json!({"type":"message_start","message":{"id":"m1"}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"one"}}),
        json!({"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"two"}}),
    ] {
        events.extend(mapper.feed(stream(event), &now()).events);
    }
    for text in ["one", "two"] {
        let assistant = json!({"type":"assistant","parent_tool_use_id":null,
            "message":{"id":"m1","content":[{"type":"text","text":text}]}});
        events.extend(mapper.feed(line(assistant), &now()).events);
    }
    let ids: Vec<(&str, &str)> = events
        .iter()
        .filter_map(|e| match e {
            RunnerEvent::Delta { message_id, append } => {
                Some((message_id.as_str(), append.as_str()))
            }
            RunnerEvent::AssistantText { message_id, text } => {
                Some((message_id.as_str(), text.as_str()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        ids,
        vec![
            ("m1", "one"),
            ("m1:1", "two"),
            ("m1", "one"),
            ("m1:1", "two")
        ]
    );
}

#[test]
fn summarized_thinking_becomes_a_finished_item_and_never_the_reply() {
    let mut mapper = StreamMapper::new("s", recorder());
    let assistant = json!({"type":"assistant","parent_tool_use_id":null,"message":{"id":"m1","content":[
        {"type":"thinking","thinking":"Weighing a rebase against a merge.\nA rebase keeps the history linear."},
        {"type":"thinking","thinking":""},
        {"type":"redacted_thinking","data":"…"},
        {"type":"text","text":"Rebased."}]}});
    let events = mapper.feed(line(assistant), &now()).events;
    let [
        RunnerEvent::Item(item),
        RunnerEvent::AssistantText { text, .. },
    ] = &events[..]
    else {
        panic!("{events:?}");
    };
    assert_eq!(
        (item.id.as_str(), item.status),
        ("m1:thinking:1", ItemStatus::Completed)
    );
    assert_eq!(item.title, "Thinking: Weighing a rebase against a merge.");
    assert!(
        matches!(&item.kind, ItemKind::Tool { tool_name, output: Some(o), .. }
        if tool_name == "Thinking" && o.ends_with("keeps the history linear."))
    );
    assert_eq!(text, "Rebased.");
}

#[test]
fn streamed_usage_adds_up_over_the_run_s_messages() {
    let mut mapper = StreamMapper::new("s", recorder());
    let stream =
        |event: Value| line(json!({"type":"stream_event","event":event,"parent_tool_use_id":null}));
    // Usage before any run started is not reported.
    let early = mapper.feed(
        stream(json!({"type":"message_start","message":{"id":"m0","usage":{"input_tokens":1}}})),
        &now(),
    );
    assert!(early.events.is_empty());
    mapper.feed(
        line(json!({"type":"command_lifecycle","command_uuid":"r1","state":"started"})),
        &now(),
    );
    let mut totals = Vec::new();
    for event in [
        json!({"type":"message_start","message":{"id":"m1","usage":{"input_tokens":100,"cache_read_input_tokens":40,"output_tokens":1}}}),
        json!({"type":"message_delta","usage":{"output_tokens":30}}),
        json!({"type":"message_start","message":{"id":"m2","usage":{"input_tokens":20,"output_tokens":1}}}),
        json!({"type":"message_delta","usage":{"output_tokens":7}}),
    ] {
        for e in mapper.feed(stream(event), &now()).events {
            if let RunnerEvent::Usage { run_id, usage } = e {
                totals.push((
                    run_id,
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.cache_read_tokens,
                ));
            }
        }
    }
    let r = || "r1".to_owned();
    assert_eq!(
        totals,
        vec![
            (r(), 100, 1, 40),
            (r(), 100, 30, 40),
            (r(), 120, 31, 40),
            (r(), 120, 37, 40)
        ]
    );
}

fn spans_of(replay: &Replay) -> Vec<&fleetd_contracts::time::SpanWire> {
    replay.spans.iter().collect()
}

/// Every recorded run tiles exactly: its spans' exclusive times add up to the run's wall time in ms, and each tool
/// call's span carries the item's exit code and the full output's size.
#[test]
fn every_run_s_spans_tile_its_wall_time_and_match_its_tool_items() {
    use fleetd_contracts::time::SpanKind;
    for name in fixtures() {
        if name.contains("initialize-probe") {
            continue;
        }
        let replay = replay(&name);
        let spans = spans_of(&replay);
        let runs: Vec<_> = spans.iter().filter(|s| s.kind == SpanKind::Run).collect();
        for run in &runs {
            let of_run: Vec<_> = spans.iter().filter(|s| s.run_id == run.run_id).collect();
            let excl: i64 = of_run
                .iter()
                .map(|s| s.excl_ms.map_or(0, |e| e.get()))
                .sum();
            assert_eq!(
                excl,
                run.end_ms.get() - run.start_ms.get(),
                "{name}: {:?}",
                run.run_id
            );
        }
        for item in items(&replay.events) {
            let (exit, output) = match &item.kind {
                ItemKind::Command {
                    exit_code,
                    output: Some(o),
                    ..
                } => (*exit_code, o.len()),
                ItemKind::Tool {
                    output: Some(o),
                    tool_name,
                    ..
                } if tool_name != "Thinking" => (None, o.len()),
                _ => continue,
            };
            let key = format!("s/{}", item.id);
            let span = spans
                .iter()
                .find(|s| s.key.as_str() == key)
                .unwrap_or_else(|| panic!("{name}: no span for {key}"));
            assert_eq!(span.exit_code.map(i64::from), exit, "{name}: {key}");
            assert_eq!(
                span.out_bytes.map(|b| b.get()),
                Some(output as i64),
                "{name}: {key}"
            );
        }
    }
}

#[test]
fn a_tool_s_permission_wait_is_its_own_span_and_the_model_has_phases() {
    use fleetd_contracts::time::{DecidedBy, SpanKind};
    let replay = replay("permission-allow");
    let spans = spans_of(&replay);
    let wait = spans
        .iter()
        .find(|s| s.kind == SpanKind::WaitPermission)
        .unwrap();
    assert_eq!(
        wait.extra.as_ref().unwrap().decided_by,
        Some(DecidedBy::Human)
    );
    let bash = spans.iter().find(|s| s.kind == SpanKind::ToolBash).unwrap();
    assert_eq!(wait.parent.as_deref(), Some(bash.key.as_str()));
    assert!(wait.start_ms.get() >= bash.start_ms.get() && wait.end_ms.get() <= bash.end_ms.get());
    // The first message: started 1330 ms in, the lifecycle at 174 ms; it stopped at 1559.
    let first = spans
        .iter()
        .filter(|s| s.kind == SpanKind::ModelFirstToken)
        .min_by_key(|s| s.start_ms.get())
        .unwrap();
    assert_eq!(first.end_ms.get() - first.start_ms.get(), 1330 - 174);
    let message = spans
        .iter()
        .filter(|s| s.kind == SpanKind::ModelMessage)
        .min_by_key(|s| s.start_ms.get())
        .unwrap();
    assert_eq!(message.end_ms.get() - message.start_ms.get(), 1559 - 174);
    assert_eq!(
        message.extra.as_ref().unwrap().stop_reason.as_deref(),
        Some("tool_use")
    );
    let run = spans.iter().find(|s| s.kind == SpanKind::Run).unwrap();
    assert_eq!(
        run.extra.as_ref().unwrap().duration_api_ms.map(|d| d.get()),
        Some(2308)
    );
}

/// The probe's task run and its steer, from the fixture's meta line.
fn task_and_steer(name: &str) -> (String, String) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "src/node/runner/fixtures/claude-2.1.302-{name}.jsonl"
    ));
    let text = std::fs::read_to_string(path).unwrap();
    let first: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    let steer = first["msg"]["steer"].as_str().unwrap().to_owned();
    let task = text
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .find(|r| r["dir"] == "in" && r["msg"]["type"] == "user")
        .unwrap()["msg"]["uuid"]
        .as_str()
        .unwrap()
        .to_owned();
    (task, steer)
}

fn item_status(events: &[RunnerEvent], id: &str) -> Option<(ItemStatus, Option<String>)> {
    items(events)
        .into_iter()
        .rev()
        .find(|i| i.id == id)
        .map(|i| (i.status, i.run_id.as_ref().map(|r| r.to_string())))
}

#[test]
fn a_boundary_steer_supersedes_the_running_turn_after_its_tool_and_gets_its_own_turn() {
    let replay = replay("steer-boundary");
    let (task, steer) = task_and_steer("steer-boundary");
    let ends = run_ends(&replay.events);
    assert_eq!(
        ends,
        vec![
            (task.as_str(), &RunOutcome::Superseded { by: steer.clone() }),
            (
                steer.as_str(),
                &RunOutcome::Completed {
                    text: "REDIRECTED".into()
                }
            ),
        ]
    );
    // The running tool was not cut: its result is kept.
    assert_eq!(
        item_status(&replay.events, "toolu_01JE4mGrY2TaxcDU99QyXGUR"),
        Some((ItemStatus::Completed, Some(task.clone())))
    );
    assert!(replay.events.contains(&RunnerEvent::RunStarted {
        run_id: steer.clone()
    }));
}

#[test]
fn a_send_now_steer_stops_the_running_tool_and_names_it() {
    let replay = replay("steer-send-now");
    let (task, steer) = task_and_steer("steer-send-now");
    let send_now = replay.events.iter().find_map(|e| match e {
        RunnerEvent::SendNow {
            run_id,
            outcome,
            stopped_tool,
        } => Some((run_id.clone(), *outcome, stopped_tool.clone())),
        _ => None,
    });
    assert_eq!(
        send_now,
        Some((
            steer.clone(),
            SendNow::Stopped,
            Some("Sleep 5 seconds then echo one".into())
        ))
    );
    assert_eq!(
        item_status(&replay.events, "toolu_01CWvUjo2u8omdJKzvvJu3qq"),
        Some((ItemStatus::Cancelled, Some(task.clone())))
    );
    let ends = run_ends(&replay.events);
    assert_eq!(
        ends[0],
        (task.as_str(), &RunOutcome::Superseded { by: steer.clone() })
    );
    assert_eq!(
        ends[1],
        (
            steer.as_str(),
            &RunOutcome::Completed {
                text: "REDIRECTED".into()
            }
        )
    );
}

#[test]
fn a_withdrawn_steer_never_starts_and_the_turn_runs_on() {
    let replay = replay("steer-withdraw");
    let (task, steer) = task_and_steer("steer-withdraw");
    // claude says `cancelled` before it answers the withdraw: the withdraw is reported first, then the run's end.
    let withdrawn = replay.events.iter().position(|e| {
        *e == RunnerEvent::Withdrawn {
            run_id: steer.clone(),
            cancelled: true,
            by_stop: false,
        }
    });
    let ended = replay
        .events
        .iter()
        .position(|e| matches!(e, RunnerEvent::RunEnded { run_id, .. } if *run_id == steer));
    assert!(
        withdrawn.is_some() && withdrawn < ended,
        "{:?}",
        replay.events
    );
    assert_eq!(
        replay
            .events
            .iter()
            .filter(|e| matches!(e, RunnerEvent::Withdrawn { .. }))
            .count(),
        1
    );
    assert!(!replay.events.contains(&RunnerEvent::RunStarted {
        run_id: steer.clone()
    }));
    let ends = run_ends(&replay.events);
    assert_eq!(
        ends,
        vec![
            (steer.as_str(), &RunOutcome::Interrupted),
            (
                task.as_str(),
                &RunOutcome::Completed {
                    text: "DONE".into()
                }
            ),
        ]
    );
}

#[test]
fn a_joined_send_stays_filed_under_the_turn_and_ends_with_it() {
    let replay = replay("steer-joined");
    let (task, steer) = task_and_steer("steer-joined");
    assert!(replay.events.contains(&RunnerEvent::Joined {
        run_id: steer.clone()
    }));
    assert!(!replay.events.contains(&RunnerEvent::RunStarted {
        run_id: steer.clone()
    }));
    let done = RunOutcome::Completed {
        text: "REDIRECTED".into(),
    };
    assert_eq!(
        run_ends(&replay.events),
        vec![(task.as_str(), &done), (steer.as_str(), &done)]
    );
    // Work after the boundary stays the turn's.
    assert!(
        items(&replay.events)
            .iter()
            .all(|i| i.run_id.as_deref() == Some(task.as_str()))
    );
}

fn mid_turn(capabilities: &[&str]) -> StreamMapper {
    let classify: Classify = Arc::new(|_: &FailureEvidence| None);
    let mut mapper = StreamMapper::new("s", classify);
    mapper.send("task", "work", SendMode::Plain);
    for line in [
        serde_json::json!({"type": "command_lifecycle", "command_uuid": "task", "state": "started"}),
        serde_json::json!({"type": "system", "subtype": "init", "capabilities": capabilities}),
    ] {
        mapper.feed(serde_json::from_value(line).unwrap(), &now());
    }
    mapper
}

#[test]
fn a_now_steer_falls_back_by_capability() {
    let request = |input: &Input| serde_json::to_value(input).unwrap()["request"].clone();
    // send_now: only the message now; the stop follows its `queued`.
    let mut mapper = mid_turn(&[
        "interrupt_receipt_v1",
        "interrupt_send_now_v1",
        "msg_lifecycle_v1",
    ]);
    let lines = mapper.send("steer", "stop", SendMode::Now);
    assert_eq!(lines.len(), 1);
    let queued = serde_json::json!({"type": "command_lifecycle", "command_uuid": "steer", "state": "queued"});
    let mapped = mapper.feed(serde_json::from_value(queued).unwrap(), &now());
    assert_eq!(
        request(&mapped.replies[0]),
        serde_json::json!({"subtype": "interrupt", "send_now": true, "message_uuid": "steer"})
    );
    // Without send_now: an interrupt scoped to the running message, then the message.
    let mut mapper = mid_turn(&["interrupt_receipt_v1", "msg_lifecycle_v1"]);
    let lines = mapper.send("steer", "stop", SendMode::Now);
    assert_eq!(
        request(&lines[0]),
        serde_json::json!({"subtype": "interrupt", "for_user_message_uuids": ["task"]})
    );
    assert_eq!(serde_json::to_value(&lines[1]).unwrap()["uuid"], "steer");
    // Without interrupt receipts: today's plain interrupt.
    let mut mapper = mid_turn(&[]);
    let lines = mapper.send("steer", "stop", SendMode::Now);
    assert_eq!(
        request(&lines[0]),
        serde_json::json!({"subtype": "interrupt"})
    );
    // Between turns every mode is one plain new turn.
    let classify: Classify = Arc::new(|_: &FailureEvidence| None);
    let mut idle = StreamMapper::new("s", classify);
    assert_eq!(idle.send("steer", "stop", SendMode::Now).len(), 1);
}

#[test]
fn a_persons_stop_ends_the_turn_interrupted_and_withdraws_the_waiting_steer() {
    let mut mapper = mid_turn(&["interrupt_receipt_v1", "msg_lifecycle_v1"]);
    mapper.send("steer", "do this instead", SendMode::Boundary);
    let lines: Vec<Value> = mapper
        .stop()
        .iter()
        .map(|i| serde_json::to_value(i).unwrap()["request"].clone())
        .collect();
    assert_eq!(
        lines,
        [
            serde_json::json!({"subtype": "interrupt"}),
            serde_json::json!({"subtype": "cancel_async_message", "message_uuid": "steer"}),
        ]
    );
    let mut events = Vec::new();
    for line in [
        serde_json::json!({"type": "result", "subtype": "error_during_execution", "is_error": true,
            "terminal_reason": "aborted_tools", "user_message_uuid": "task"}),
        serde_json::json!({"type": "command_lifecycle", "command_uuid": "steer", "state": "cancelled"}),
        serde_json::json!({"type": "control_response", "response": {"subtype": "success",
            "request_id": "fleetd-withdraw-1", "response": {"cancelled": true}}}),
    ] {
        events.extend(
            mapper
                .feed(serde_json::from_value(line).unwrap(), &now())
                .events,
        );
    }
    assert_eq!(
        run_ends(&events),
        vec![
            ("task", &RunOutcome::Interrupted),
            ("steer", &RunOutcome::Interrupted)
        ]
    );
    let withdrawn: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, RunnerEvent::Withdrawn { .. }))
        .collect();
    assert_eq!(
        withdrawn,
        [&RunnerEvent::Withdrawn {
            run_id: "steer".into(),
            cancelled: true,
            by_stop: true
        }]
    );
}

/// Seen live on a resumed lead: claude first runs its own turn for a background task's notice left from the previous
/// process (a `result` with an `origin` and no `user_message_uuid`), then the message fleetd sent. That first result
/// ended fleetd's waiting run before its turn began, so the run read as over while the lead was still working, and
/// its reply came after.
#[test]
fn a_notice_turn_on_resume_ends_no_run_of_fleetds() {
    let classify: Classify = Arc::new(|_: &FailureEvidence| None);
    let mut mapper = StreamMapper::new("s", classify);
    mapper.send("chat", "The human writes in your chat", SendMode::Plain);
    let mut ends = Vec::new();
    for line in [
        serde_json::json!({"type": "system", "subtype": "task_notification", "task_id": "b1", "status": "stopped",
            "summary": "Background shell command didn't finish before the previous session ended"}),
        serde_json::json!({"type": "command_lifecycle", "command_uuid": "chat", "state": "queued"}),
        serde_json::json!({"type": "result", "subtype": "success", "is_error": false, "result": "", "num_turns": 0,
            "origin": {"kind": "task-notification"}}),
        serde_json::json!({"type": "command_lifecycle", "command_uuid": "chat", "state": "started"}),
        serde_json::json!({"type": "result", "subtype": "success", "is_error": false, "result": "W8 is closed.",
            "user_message_uuid": "chat"}),
        serde_json::json!({"type": "command_lifecycle", "command_uuid": "chat", "state": "completed"}),
    ] {
        let events = mapper
            .feed(serde_json::from_value(line).unwrap(), &now())
            .events;
        ends.extend(events.into_iter().filter_map(|e| match e {
            RunnerEvent::RunStarted { run_id } => Some(format!("started {run_id}")),
            RunnerEvent::RunEnded {
                run_id, outcome, ..
            } => Some(format!("ended {run_id}: {outcome:?}")),
            _ => None,
        }));
    }
    assert_eq!(
        ends,
        [
            "started chat".to_owned(),
            format!(
                "ended chat: {:?}",
                RunOutcome::Completed {
                    text: "W8 is closed.".into()
                }
            ),
        ]
    );
    assert!(!mapper.has_open_run());
}

#[test]
fn claudes_tools_arrive_classified() {
    let class = |name: &str, input: Value| tool_class(name, &input);
    assert_eq!(
        class("Read", json!({ "file_path": "/x/a.rs" })),
        Some(ToolClass::Read {
            path: Some("/x/a.rs".into())
        })
    );
    assert_eq!(
        class("Glob", json!({ "pattern": "**/*.rs" })),
        Some(ToolClass::Search {
            pattern: Some("**/*.rs".into())
        })
    );
    assert_eq!(
        class("WebSearch", json!({ "query": "tokio" })),
        Some(ToolClass::Web {
            url: None,
            query: Some("tokio".into())
        })
    );
    assert_eq!(class("TodoWrite", json!({})), Some(ToolClass::Plan));
    assert_eq!(
        class("mcp__fleetd__spawn_agent", json!({})),
        Some(ToolClass::Mcp {
            server: "fleetd".into(),
            tool: "spawn_agent".into()
        })
    );
    assert_eq!(class("Skill", json!({})), None);
    assert_eq!(class("mcp__broken", json!({})), None);
}
