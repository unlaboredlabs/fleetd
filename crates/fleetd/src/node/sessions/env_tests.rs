//! An order's variables, a session's own fleetd calls and worktree setup, over the fake runner.
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::project_settings::WorktreeSetup;

use super::*;
use crate::node::secrets::{SecretsContext, deliver_secret};

fn in_order(id: &str, order: &str, workspace: SessionWorkspace) -> SessionCall {
    let mut call = launch(id, RuntimeMode::FullAccess, workspace);
    if let SessionCall::Launch(l) = &mut call {
        l.order_id = Some(WorkstreamId::unchecked(order));
        l.run_id = NonEmpty::unchecked(format!("{id}-r1"));
    }
    call
}

fn send_as(id: &str, run_id: &str) -> SessionCall {
    let mut call = send(id, run_id);
    if let SessionCall::Send { run_id: r, .. } = &mut call {
        *r = NonEmpty::unchecked(run_id);
    }
    call
}

/// What the person enters for an `order:` sink, as the hub relays it: sealed to this node's box key.
pub(super) fn deliver(home: &Path, order: &str, name: &str, value: &str) {
    let key = crate::node::identity::load_or_create_box_key(home).unwrap();
    let frame: crate::node::wire::SecretDeliver = serde_json::from_value(serde_json::json!({
        "id": "d1", "sink": format!("order:lab:{order}"), "secretKey": name.to_lowercase().replace('_', "."),
        "envName": name, "projectId": "p1",
        "sealed": crate::node::project_env::seal(home, value),
    }))
    .unwrap();
    let ctx = SecretsContext {
        machine_id: "lab",
        roots: &[],
        home,
        box_key: Some(&key),
    };
    let result = deliver_secret(&frame, &ctx);
    assert!(result.error.is_none(), "{result:?}");
    assert_eq!(
        result.fingerprint.unwrap().as_str(),
        crate::node::secrets::fingerprint_of(value.as_bytes())
    );
}

fn var<'a>(spec: &'a crate::node::runner::SessionSpec, k: &str) -> Option<&'a str> {
    spec.env
        .iter()
        .rev()
        .find(|(key, _)| key == k)
        .map(|(_, v)| v.as_str())
}

/// A writer asks mid-run for a variable it lacks; the lead relays it with an `order:` sink and the person's value
/// lands on that order only: the order's running agent gets it in a new claude at its next turn, resumed in its
/// conversation, while an agent of another order never has it. Once the order closes it is gone again.
#[tokio::test]
async fn an_order_variable_reaches_only_that_orders_agents_from_their_next_turn() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("node");
    let mut node = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    node.project(dir.path()).await;
    node.ok(in_order("a", "W1", SessionWorkspace::Root)).await;
    node.settled("a-r1").await;
    node.ok(in_order("b", "W2", SessionWorkspace::Root)).await;
    node.settled("b-r1").await;
    assert_eq!(node.runner.spawned().len(), 2);
    assert!(
        node.runner
            .spawned()
            .iter()
            .all(|s| var(s, "DB_URL").is_none())
    );

    deliver(&home, "W1", "DB_URL", "postgres://w1:pw-81f2@db/x");
    node.ok(send_as("a", "a-r2")).await;
    node.settled("a-r2").await;
    node.ok(send_as("b", "b-r2")).await;
    node.settled("b-r2").await;
    let spawned = node.runner.spawned();
    assert_eq!(spawned.len(), 3, "only W1's agent starts again");
    let renewed = &spawned[2];
    assert_eq!(renewed.session_id, "a");
    assert!(renewed.resume, "it resumes its conversation");
    assert_eq!(var(renewed, "DB_URL"), Some("postgres://w1:pw-81f2@db/x"));
    assert!(spawned[..2].iter().all(|s| var(s, "DB_URL").is_none()));
    // A new agent of the other order doesn't get it either; one of the order does, named in its brief.
    node.ok(in_order("c", "W2", SessionWorkspace::Root)).await;
    node.settled("c-r1").await;
    node.ok(in_order("d", "W1", SessionWorkspace::Root)).await;
    node.settled("d-r1").await;
    let spawned = node.runner.spawned();
    assert_eq!(var(&spawned[3], "DB_URL"), None);
    assert_eq!(
        var(&spawned[4], "DB_URL"),
        Some("postgres://w1:pw-81f2@db/x")
    );
    let brief = |id: &str, run: &str| node.service.store().message(id, run).unwrap().unwrap().text;
    assert!(
        brief("d", "d-r1").contains("Set for order W1's agents: `DB_URL` (secret)"),
        "{}",
        brief("d", "d-r1")
    );
    assert!(!brief("d", "d-r1").contains("pw-81f2"));
    assert!(!brief("c", "c-r1").contains("DB_URL"));

    // The order closes: its agents run on without it from their next turn.
    assert_eq!(
        node.ok(SessionCall::OrderEnvDrop {
            project_id: ProjectId::unchecked("p1"),
            order_id: WorkstreamId::unchecked("W1"),
            name: None,
            fingerprint: None,
        })
        .await,
        SessionOutput::Done
    );
    node.ok(send_as("a", "a-r3")).await;
    node.settled("a-r3").await;
    let last = node.runner.spawned().last().unwrap().clone();
    assert_eq!(last.session_id, "a");
    assert_eq!(var(&last, "DB_URL"), None);
}

/// A project secret pasted into an `ask_lead` (or any fleetd call of a session) goes out over the link masked: the
/// hub gets, and so stores and shows, `***NAME***`. A call whose masked form no longer fits is refused, never sent.
#[tokio::test]
async fn a_secret_in_a_sessions_own_fleetd_call_reaches_the_hub_masked() {
    use crate::node::lead::{LeadRelay, MaskFor, lead_socket_path, serve_lead_socket};
    use crate::node::runner::process::PeerSession;
    use fleetd_contracts::project_settings::{EnvVarName, EnvVarSet};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // Shorter than its mask, `***STRIPE_KEY***`.
    let secret = "sk7731qqzx";
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("node");
    let mut node = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    node.project(dir.path()).await;
    node.ok(SessionCall::ProjectEnv {
        project_id: ProjectId::unchecked("p1"),
        set: vec![EnvVarSet::Secret {
            name: EnvVarName::new("STRIPE_KEY").unwrap(),
            sealed: crate::node::project_env::seal(&home, secret),
        }],
        remove: vec![],
    })
    .await;
    node.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    node.settled("r1").await;

    let relay = LeadRelay::new();
    let (link_tx, mut link) = mpsc::unbounded_channel::<String>();
    let _attached = relay.attach(link_tx);
    let sessions = node.service.clone();
    let mask_for: MaskFor = Arc::new(move |id| sessions.call_masker(id));
    let socket = lead_socket_path(&dir.path().join("sock"));
    let _serving = serve_lead_socket(
        socket.clone(),
        relay.clone(),
        Arc::new(|_| PeerSession::Session("s1".into())),
        mask_for,
        None,
    )
    .await
    .unwrap();
    let ask = |question: String| {
        let socket = socket.clone();
        async move {
            let mut conn = tokio::net::UnixStream::connect(&socket).await.unwrap();
            let frame = serde_json::json!({ "t": "lead_call", "id": "cli-1", "cwd": "/w",
                "call": { "op": "ask_lead", "question": question } });
            conn.write_all(format!("{frame}\n").as_bytes())
                .await
                .unwrap();
            let mut answer = String::new();
            conn.read_to_string(&mut answer).await.unwrap();
            answer
        }
    };
    let asked = tokio::spawn(ask(format!(
        "The key {secret} is refused by Stripe: which one?"
    )));
    let sent = tokio::time::timeout(Duration::from_secs(30), link.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        sent.contains("The key ***STRIPE_KEY*** is refused"),
        "{sent}"
    );
    assert!(!sent.contains(secret), "{sent}");
    assert!(sent.contains("\"threadId\":\"s1\""), "{sent}");
    let id = serde_json::from_str::<serde_json::Value>(&sent).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    relay.resolve(
        serde_json::from_value(
            serde_json::json!({ "id": id, "error": { "code": "invalid", "message": "x" } }),
        )
        .unwrap(),
    );
    asked.await.unwrap();

    // Masked, it would pass the question's 4000 characters: refused at the node.
    let long = format!("{}{secret}", "x".repeat(4000 - secret.len()));
    let answer = ask(long).await;
    assert!(
        answer.contains("masking it left the call too long"),
        "{answer}"
    );
    assert!(link.try_recv().is_err(), "nothing went out");

    // The project's secrets can't be read now (the file doesn't parse): no masker, so the call is refused, never
    // sent with the secret in it.
    let env_file = home.join("project-env/p1.json");
    let kept = std::fs::read(&env_file).unwrap();
    std::fs::write(&env_file, b"{ not json").unwrap();
    let answer = ask(format!("The key {secret} again")).await;
    assert!(
        answer.contains("could not read the session's secrets"),
        "{answer}"
    );
    assert!(answer.contains("project-env/p1.json"), "{answer}");
    assert!(!answer.contains(secret));
    assert!(link.try_recv().is_err(), "nothing went out");
    std::fs::write(&env_file, kept).unwrap();

    // No masker (reading the secrets failed): the call is refused, never sent unmasked.
    drop(_serving);
    let broken: MaskFor = Arc::new(|_| panic!("the project env does not read"));
    let _serving = serve_lead_socket(
        socket.clone(),
        relay.clone(),
        Arc::new(|_| PeerSession::Session("s1".into())),
        broken,
        None,
    )
    .await
    .unwrap();
    let answer = ask(format!("The key {secret} again")).await;
    assert!(
        answer.contains("could not read the session's secrets"),
        "{answer}"
    );
    assert!(!answer.contains(secret));
    assert!(link.try_recv().is_err(), "nothing went out");
}

fn setup(commands: &[&str], run_anyway: bool) -> WorktreeSetup {
    serde_json::from_value(serde_json::json!({
        "commands": commands, "timeoutSec": 30, "runAnyway": run_anyway, "inputs": ["deps.lock"],
    }))
    .unwrap()
}

fn with_setup(id: &str, branch: &str, setup: WorktreeSetup) -> SessionCall {
    let mut call = in_order(
        id,
        "W5",
        SessionWorkspace::Worktree {
            base_ref: NonEmpty::unchecked("main"),
            branch: NonEmpty::unchecked(branch),
            from_session: None,
        },
    );
    if let SessionCall::Launch(l) = &mut call {
        l.setup = Some(Box::new(setup));
    }
    call
}

/// Setup commands run in the new worktree, with the project's variables, before claude starts there: each is an item
/// of the first run with the end of its output, and the brief says what ran. A failure fails the start with the
/// command and its output, unless the project starts agents anyway, when the agent hears what failed.
#[tokio::test]
async fn setup_runs_before_the_agent_starts_and_a_failure_is_surfaced() {
    use fleetd_contracts::project_settings::{EnvValue, EnvVarName, EnvVarSet};
    let dir = tempfile::tempdir().unwrap();
    let (_, root) = cloned(dir.path(), "repo", "origin");
    let mut node = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    node.project(&root).await;
    node.ok(SessionCall::ProjectEnv {
        project_id: ProjectId::unchecked("p1"),
        set: vec![EnvVarSet::Plain {
            name: EnvVarName::new("REGISTRY").unwrap(),
            value: EnvValue::new("https://npm.devbox.test").unwrap(),
        }],
        remove: vec![],
    })
    .await;

    let ok = setup(
        &[
            "echo \"installing from $REGISTRY\"; echo dep > deps.txt",
            "test -f deps.txt",
        ],
        false,
    );
    node.ok(with_setup("s1", "fleetd/T1-setup", ok)).await;
    node.settled("s1-r1").await;
    let spec = node.runner.spawned()[0].clone();
    assert!(
        spec.cwd.join("deps.txt").is_file(),
        "setup ran in the worktree"
    );
    let service = node.service.clone();
    let store = service.store();
    let first = store.item("s1", "setup-s1-r1-0").unwrap().unwrap();
    assert_eq!(first.status, ItemStatus::Completed);
    let ItemKind::Command {
        output, exit_code, ..
    } = &first.kind
    else {
        panic!("{first:?}")
    };
    assert_eq!(*exit_code, Some(0));
    assert!(
        output
            .as_deref()
            .unwrap()
            .contains("installing from https://npm.devbox.test")
    );
    assert!(store.item("s1", "setup-s1-r1-1").unwrap().is_some());
    let brief = store.message("s1", "s1-r1").unwrap().unwrap().text;
    assert!(
        brief.contains("## Setup\nSetup ran in this worktree before you started"),
        "{brief}"
    );
    assert!(brief.contains("Set for the project's agents: `REGISTRY=https://npm.devbox.test`"));

    // A failure: the run fails naming the command and its output, and no claude starts.
    let failing = setup(
        &[
            "echo resolving; echo 'ERR! 404 left-pad' >&2; exit 4",
            "true",
        ],
        false,
    );
    node.ok(with_setup("s2", "fleetd/T2-setup", failing.clone()))
        .await;
    let ended = node.settled("s2-r1").await;
    assert_eq!(ended.latest_run.as_ref().unwrap().status, RunStatus::Failed);
    let failure = store.runs("s2").unwrap()[0].failure.clone().unwrap();
    let why = failure.message.as_str();
    assert!(
        why.starts_with("setup failed, so the agent did not start"),
        "{why}"
    );
    assert!(why.contains("exited 4"), "{why}");
    assert!(why.contains("ERR! 404 left-pad"), "{why}");
    assert_eq!(
        store.item("s2", "setup-s2-r1-0").unwrap().unwrap().status,
        ItemStatus::Failed
    );
    assert!(store.item("s2", "setup-s2-r1-1").unwrap().is_none());
    assert_eq!(node.runner.spawned().len(), 1, "no claude for s2");

    // Run anyway: the agent starts and hears what failed.
    let mut anyway = failing;
    anyway.run_anyway = true;
    node.ok(with_setup("s3", "fleetd/T3-setup", anyway)).await;
    node.settled("s3-r1").await;
    assert_eq!(node.runner.spawned().len(), 2);
    let brief = store.message("s3", "s3-r1").unwrap().unwrap().text;
    assert!(brief.contains("starts its agents anyway"), "{brief}");
    assert!(brief.contains("ERR! 404 left-pad"), "{brief}");
}

async fn until_item(node: &Hub, id: &str, item: &str) {
    tokio::time::timeout(Duration::from_secs(60), async {
        while node.service.store().item(id, item).unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the setup command never started");
}

async fn until_setup_ends(node: &Hub, id: &str) {
    tokio::time::timeout(Duration::from_secs(60), async {
        while node.service.st().setting_up.contains_key(id) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("setup never ended");
}

/// An interrupt or a stop during setup ends it there: the command is killed, the run closes, no claude starts, and a
/// stop that removes the worktree removes it.
#[tokio::test]
async fn an_interrupt_or_stop_during_setup_ends_it_and_starts_no_claude() {
    let dir = tempfile::tempdir().unwrap();
    let (_, root) = cloned(dir.path(), "repo", "origin");
    let mut node = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    node.project(&root).await;
    let after = dir.path().join("after-sleep.txt");
    let slow = setup(
        &[&format!("sleep 30; touch {}", after.display()), "true"],
        true,
    );
    node.ok(with_setup("s1", "fleetd/T1-slow", slow.clone()))
        .await;
    until_item(&node, "s1", "setup-s1-r1-0").await;
    // An interrupt for another run leaves the setup of this one running.
    node.ok(SessionCall::Interrupt {
        session_id: ThreadId::unchecked("s1"),
        run_id: Some(NonEmpty::unchecked("s1-other")),
        reason: None,
    })
    .await;
    assert!(node.service.st().setting_up.contains_key("s1"));
    assert!(
        node.service
            .st()
            .setup_cancel
            .get("s1")
            .is_some_and(|(_, c)| !*c.borrow())
    );
    node.ok(SessionCall::Interrupt {
        session_id: ThreadId::unchecked("s1"),
        run_id: None,
        reason: None,
    })
    .await;
    let ended = node.settled("s1-r1").await;
    assert_eq!(ended.latest_run.unwrap().status, RunStatus::Interrupted);
    until_setup_ends(&node, "s1").await;
    let service = node.service.clone();
    let store = service.store();
    let item = store.item("s1", "setup-s1-r1-0").unwrap().unwrap();
    assert_eq!(item.status, ItemStatus::Cancelled);
    assert!(store.item("s1", "setup-s1-r1-1").unwrap().is_none());
    assert!(
        node.runner.spawned().is_empty(),
        "no claude for an interrupted run"
    );
    assert!(!after.exists(), "the command was killed");
    // Setup stays due: it never ran to its end.
    assert!(store.session("s1").unwrap().unwrap().local.setup_pending);

    node.ok(with_setup("s2", "fleetd/T2-slow", slow)).await;
    until_item(&node, "s2", "setup-s2-r1-0").await;
    let cwd = store.session("s2").unwrap().unwrap().local.cwd;
    assert!(cwd.exists());
    node.ok(SessionCall::Stop {
        session_id: ThreadId::unchecked("s2"),
        remove_worktree: true,
    })
    .await;
    until_setup_ends(&node, "s2").await;
    assert!(!cwd.exists(), "the stop removed the worktree");
    assert!(node.runner.spawned().is_empty());
}

/// A worktree that is gone when its session goes on comes back and is set up again before claude starts there.
#[tokio::test]
async fn a_rebuilt_worktree_is_set_up_again_before_the_agent_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    let (_, root) = cloned(dir.path(), "repo", "origin");
    let mut node = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    node.project(&root).await;
    node.ok(with_setup(
        "s1",
        "fleetd/T1-rebuild",
        setup(&["echo dep >> deps.txt"], false),
    ))
    .await;
    node.settled("s1-r1").await;
    let cwd = node.runner.spawned()[0].cwd.clone();
    assert!(cwd.join("deps.txt").is_file());
    node.ok(SessionCall::Stop {
        session_id: ThreadId::unchecked("s1"),
        remove_worktree: false,
    })
    .await;
    std::fs::remove_dir_all(&cwd).unwrap();

    node.ok(send_as("s1", "s1-r2")).await;
    node.settled("s1-r2").await;
    assert!(
        cwd.join("deps.txt").is_file(),
        "setup ran in the rebuilt worktree"
    );
    let service = node.service.clone();
    let store = service.store();
    let again = store.item("s1", "setup-s1-r2-0").unwrap().unwrap();
    assert_eq!(again.status, ItemStatus::Completed);
    assert_eq!(node.runner.spawned().len(), 2);
    let sent = node
        .runner
        .received()
        .into_iter()
        .rev()
        .find_map(|c| match c {
            SessionCommand::Send { text, .. } => Some(text),
            _ => None,
        })
        .unwrap();
    assert!(
        sent.contains("Setup ran in this worktree before you went on"),
        "{sent}"
    );
    assert!(!store.session("s1").unwrap().unwrap().local.setup_pending);
}

/// The node stops in the middle of setup: nothing marks it done, so the session's next start runs it again first.
#[tokio::test]
async fn a_node_restart_mid_setup_runs_it_again_at_the_next_start() {
    let dir = tempfile::tempdir().unwrap();
    let (_, root) = cloned(dir.path(), "repo", "origin");
    let db = dir.path().join("sessions.sqlite");
    let hold = dir.path().join("hold");
    std::fs::write(&hold, "").unwrap();
    let runs = dir.path().join("setup-runs.txt");
    let command = format!(
        "if [ -f {} ]; then sleep 300; fi; echo ran >> {}",
        hold.display(),
        runs.display()
    );
    let before = hub(
        dir.path(),
        NodeStore::open(&db).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    before.project(&root).await;
    before
        .ok(with_setup(
            "s1",
            "fleetd/T1-restart",
            setup(&[&command], false),
        ))
        .await;
    until_item(&before, "s1", "setup-s1-r1-0").await;
    assert!(
        before
            .service
            .store()
            .session("s1")
            .unwrap()
            .unwrap()
            .local
            .setup_pending,
        "no done mark while it runs"
    );

    // The node stops; the next one finds setup still due.
    std::fs::remove_file(&hold).unwrap();
    let mut after = hub(
        dir.path(),
        NodeStore::open(&db).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    let row = after.service.store().session("s1").unwrap().unwrap();
    assert!(row.local.setup_pending);
    assert_eq!(
        row.summary.latest_run.unwrap().status,
        RunStatus::Interrupted
    );
    assert!(!runs.exists());
    after.ok(send_as("s1", "s1-r2")).await;
    after.settled("s1-r2").await;
    assert_eq!(std::fs::read_to_string(&runs).unwrap(), "ran\n");
    assert_eq!(after.runner.spawned().len(), 1);
    let store = after.service.clone();
    assert!(
        !store
            .store()
            .session("s1")
            .unwrap()
            .unwrap()
            .local
            .setup_pending
    );
    // Done now: the next turn doesn't run it again.
    after.ok(send_as("s1", "s1-r3")).await;
    after.settled("s1-r3").await;
    assert_eq!(std::fs::read_to_string(&runs).unwrap(), "ran\n");
    drop(before);
}
