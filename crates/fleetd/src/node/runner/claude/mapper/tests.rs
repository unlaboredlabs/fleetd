//! Replays the recorded claude 2.1.302 transcripts through the mapper. "in" lines drive fleetd's side (send,
//! answer, interrupt) and must come out byte-for-byte as recorded; "out" and "stderr" lines are fed; the "meta" exit
//! ends the process. The classifier is a recorder, so these tests pin the evidence R2's classifier receives.
use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

use super::*;

const AT: &str = "2026-10-18T10:00:00.000Z";

fn now() -> Now {
    Now {
        at: Timestamp::from(AT),
        ms: 1_792_000_000_000,
    }
}

struct Replay {
    events: Vec<RunnerEvent>,
    evidence: Vec<FailureEvidence>,
    /// (recorded stdin line, the line the mapper wrote for it)
    inputs: Vec<(Value, Value)>,
    replies: Vec<Input>,
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
        })
    });
    let mut mapper = StreamMapper::new("s", classify);
    let mut before_exit = Some(before_exit);
    let mut out = Replay {
        events: Vec::new(),
        evidence: Vec::new(),
        inputs: Vec::new(),
        replies: Vec::new(),
        sent: Vec::new(),
    };
    for raw in std::fs::read_to_string(&path).unwrap().lines() {
        let rec: Value = serde_json::from_str(raw).unwrap();
        let msg = &rec["msg"];
        match rec["dir"].as_str().unwrap() {
            "in" => {
                let ours = match msg["type"].as_str().unwrap() {
                    "user" => {
                        let run_id = msg["uuid"].as_str().unwrap();
                        out.sent.push(run_id.to_owned());
                        mapper.send(run_id, msg["message"]["content"].as_str().unwrap())
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
                            .answer(request_id, &decision)
                            .expect("claude waits for this answer")
                    }
                    other => panic!("{file}: unexpected stdin line {other}"),
                };
                out.inputs
                    .push((msg.clone(), serde_json::to_value(ours).unwrap()));
            }
            "out" => {
                let mapped = mapper.feed(serde_json::from_value(msg.clone()).unwrap(), &now());
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
                out.events.extend(mapper.exited(exit, &now()));
            }
            _ => {}
        }
    }
    out.evidence = evidence.lock().unwrap().clone();
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
        assert!(replay.replies.is_empty(), "{name}: unexpected replies");
    }
}

#[test]
fn two_turns_in_one_process() {
    let replay = replay("init-partial-two-turns");
    let init = RunnerEvent::Init {
        version: "2.1.302".into(),
        model: "claude-haiku-5-5".into(),
        cwd: "/work/project".into(),
        // Recorded before fleetd turned auto memory off.
        auto_memory: true,
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
            cache_read_input_tokens: cache_read,
            cache_creation_input_tokens: cache_creation,
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
            RunnerEvent::RunStarted { run_id: run.into() },
            init.clone(),
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
    use crate::node::runner::failure::classify;
    let cases = [
        ("invalid-model", FailureClass::InvalidRequest),
        ("not-logged-in", FailureClass::Auth),
        ("auth-expired-401", FailureClass::Auth),
        ("overloaded-529", FailureClass::Overloaded),
        ("server-500", FailureClass::Overloaded),
        ("network-refused", FailureClass::Network),
        ("rate-limit-429", FailureClass::RateLimit),
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
    assert!(crate::node::runner::claude::session_in_use(exit));
    assert_eq!(replay.evidence[0].exit.as_ref(), Some(exit));
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
    assert!(mapper.answer("p1", &allow).is_none());
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
                    usage.cache_read_input_tokens,
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
