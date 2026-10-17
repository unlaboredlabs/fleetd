//! Live check against a lab T3 (never the live :3773 one). Costs one tiny claude-haiku turn.
//!   T3_BEARER=<lab session token> cargo run -p t3-wire --example live -- http://127.0.0.1:4711 <workspace root>
//! The workspace root is registered as a project if T3 has none for it.
use std::time::Duration;

use futures_util::StreamExt;
use t3_wire::T3Client;
use t3_wire::types::*;

fn id(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{prefix}-{nanos:x}")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let url = args.next().ok_or("usage: live <t3 url> <workspace root>")?;
    let root = args.next().ok_or("usage: live <t3 url> <workspace root>")?;
    let bearer = std::env::var("T3_BEARER")?;
    let client = T3Client::connect(&url, &bearer).await?;
    println!("connected");

    let config = client.get_config().await?;
    for p in config.providers.iter() {
        println!(
            "provider {} ({}) enabled={} installed={} status={} auth={} models={}",
            p.instance_id,
            p.driver,
            p.enabled,
            p.installed,
            p.status,
            p.auth.status,
            p.models.len()
        );
    }
    println!("logs dir: {}", config.observability.logs_directory_path);
    let settings = client.get_settings().await?;
    println!(
        "settings: instances={:?} autoResumeLimitedThreads={:?}",
        settings
            .provider_instances
            .as_ref()
            .map(|m| m.keys().cloned().collect::<Vec<_>>()),
        settings.auto_resume_limited_threads
    );
    let updated = client
        .update_settings(&UpdateSettingsInput {
            patch: SettingsPatch {
                auto_resume_limited_threads: Some(false),
            },
            provider_instance_mutation: None,
        })
        .await?;
    println!(
        "updateSettings: autoResumeLimitedThreads={:?}",
        updated.auto_resume_limited_threads
    );

    let mut shell = client.subscribe_shell(&SubscribeShellInput::default());
    let Some(Ok(ShellStreamItem::Snapshot(snap))) = shell.next().await else {
        return Err("shell stream did not open with a snapshot".into());
    };
    let cursor = snap.snapshot.snapshot_sequence;
    println!(
        "shell snapshot: seq={cursor} projects={} threads={}",
        snap.snapshot.projects.len(),
        snap.snapshot.threads.len()
    );
    let project_id = match snap
        .snapshot
        .projects
        .iter()
        .find(|p| p.workspace_root == root)
    {
        Some(p) => p.id.clone(),
        None => {
            let created = client
                .mutate_project(&ProjectMutation::Create(ProjectCreate {
                    command_id: id("cmd"),
                    project_id: id("proj"),
                    title: "t3-wire live".into(),
                    workspace_root: root.clone(),
                }))
                .await?;
            println!(
                "projects.mutate: created {} at {}",
                created.id, created.workspace_root
            );
            created.id
        }
    };

    let refs = client
        .list_refs(&ListRefsInput {
            cwd: root.clone(),
            ref_kind: Some(RefKind::Local),
            limit: Some(200),
        })
        .await?;
    println!(
        "vcs.listRefs: {:?}",
        refs.refs
            .iter()
            .map(|r| (&r.name, r.is_default, r.current))
            .collect::<Vec<_>>()
    );
    let readme = client
        .read_file(&ReadFileInput {
            cwd: root.clone(),
            relative_path: "README.md".into(),
        })
        .await?;
    println!(
        "projects.readFile README.md: {} bytes",
        readme.contents.len()
    );
    match client
        .read_file(&ReadFileInput {
            cwd: root.clone(),
            relative_path: "no-such-file".into(),
        })
        .await
    {
        Err(t3_wire::Error::Rpc { error, .. }) => println!(
            "projects.readFile missing: {} operation={:?}",
            error.tag, error.operation
        ),
        other => println!("projects.readFile missing: unexpected {other:?}"),
    }

    let launched = client
        .launch_thread(&LaunchThreadInput {
            command_id: id("cmd"),
            project_id,
            title: "t3-wire live check".into(),
            generate_title: Some(false),
            model_selection: ModelSelectionInput {
                instance_id: "fleetd".into(),
                model: "claude-haiku-5-5".into(),
                options: vec![ModelOptionInput {
                    id: "effort".into(),
                    value: "low".into(),
                }],
            },
            runtime_mode: RuntimeMode::ApprovalRequired,
            interaction_mode: InteractionMode::Default,
            workspace_strategy: WorkspaceStrategy::Root(RootWorkspace::default()),
            initial_message: Some(InitialMessage {
                text: "Reply with the word OK and nothing else.".into(),
                attachments: vec![],
            }),
        })
        .await?;
    let thread_id = launched.thread_id;
    println!("launchThread: {thread_id}");

    // Follow the shell from the snapshot cursor and the thread until the run ends.
    let mut resumed = client.subscribe_shell(&SubscribeShellInput {
        after_sequence: Some(cursor),
        request_completion_marker: None,
    });
    let mut thread = client.subscribe_thread(&SubscribeThreadInput {
        thread_id: thread_id.clone(),
        accept_bounded_snapshot: Some(true),
        ..Default::default()
    });
    let mut last_run = None;
    let follow = async {
        while let Some(item) = thread.next().await {
            match item? {
                ThreadStreamItem::Snapshot(s) => println!(
                    "thread snapshot: seq={} runs={} items={}",
                    s.snapshot_sequence,
                    s.projection.runs.len(),
                    s.projection.turn_items.len()
                ),
                ThreadStreamItem::Event(e) => match e.event {
                    ThreadEvent::MessageUpdated(m) => println!(
                        "  #{} message {} {:?}",
                        e.sequence, m.payload.role, m.payload.text
                    ),
                    ThreadEvent::TurnItemUpdated(i) => println!(
                        "  #{} item {} {:?}",
                        e.sequence, i.payload.status, i.payload.kind
                    ),
                    ThreadEvent::RunCreated(r) | ThreadEvent::RunUpdated(r) => {
                        println!(
                            "  #{} run {} {}",
                            e.sequence, r.payload.id, r.payload.status
                        );
                        last_run = Some(r.payload.id.clone());
                        if ["completed", "failed", "interrupted", "cancelled"]
                            .contains(&r.payload.status.as_str())
                        {
                            return Ok::<_, t3_wire::Error>(r.payload.status);
                        }
                    }
                    ThreadEvent::Other => {}
                },
                ThreadStreamItem::Synchronized | ThreadStreamItem::Other => {}
            }
        }
        Err(t3_wire::Error::Closed("thread stream ended".into()))
    };
    let status = tokio::time::timeout(Duration::from_secs(180), follow).await??;
    println!("run ended: {status}");
    let mut shell_items = 0;
    while let Ok(Some(item)) = tokio::time::timeout(Duration::from_secs(2), resumed.next()).await {
        match item? {
            ShellStreamItem::ThreadUpdated(t) if t.thread.id == thread_id => println!(
                "  shell #{} thread {} status={} activeRun={:?}",
                t.sequence, t.location, t.thread.status, t.thread.active_run_id
            ),
            _ => {}
        }
        shell_items += 1;
    }
    println!("shell resume from {cursor}: {shell_items} items");

    let projection = client.get_thread_projection(&thread_id).await?;
    println!(
        "getThreadProjection: messages={} items={} runs={} checkpoints={} branch={:?}",
        projection.messages.len(),
        projection.turn_items.len(),
        projection.runs.len(),
        projection.checkpoints.len(),
        projection.thread.branch
    );
    if let Some(item) = projection.turn_items.last() {
        let one = client
            .get_turn_item(&GetTurnItemInput {
                thread_id: thread_id.clone(),
                item_id: item.id.clone(),
            })
            .await?;
        println!("getTurnItem {}: found={}", item.id, one.item.is_some());
    }
    match client
        .get_turn_diff(&GetTurnDiffInput {
            thread_id: thread_id.clone(),
            from_turn_count: 0,
            to_turn_count: 1,
        })
        .await
    {
        Ok(d) => println!("getTurnDiff: {} bytes", d.diff.len()),
        Err(e) => println!("getTurnDiff: {e}"),
    }
    if let Some(run_id) = last_run {
        let r = client
            .dispatch_command(&Command::RunInterrupt(RunInterrupt {
                command_id: id("cmd"),
                thread_id: thread_id.clone(),
                run_id,
                reason: Some("t3-wire live check".into()),
            }))
            .await;
        println!("dispatchCommand run.interrupt on the finished run: {r:?}");
    }
    client.close();
    println!("closed: {}", client.closed().await);
    Ok(())
}
