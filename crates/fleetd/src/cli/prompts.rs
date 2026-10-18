//! `fleetd prompts …` and `fleetd instructions …`: every prompt fleetd sends a model, read and edited on the hub
//! machine. They open the hub home directly (as `hub key` does): an edit is a file the running hub reads at the next
//! session it starts.
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::Arc;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId};
use fleetd_contracts::prompts::PromptScope;
use serde_json::json;

use super::CliResult;
use super::args::{self, Kind, Spec};
use super::hub_key::resolve_home;
use crate::clock::SystemClock;
use crate::hub::prompts::registry::{ENTRIES, Entry, INSTRUCTIONS};
use crate::hub::prompts::render::warnings;
use crate::hub::prompts::store::entry;
use crate::hub::store::{EventLog, HubDb, iso_ms, now_ms};

pub const PROMPTS_USAGE: &str = r#"  prompts list [--project <machine>/<project>] [--home <dir>]
             every prompt fleetd sends a model, which text is in effect, and
             "update" where a release changed the default you edited
  prompts show <id> [--project <machine>/<project>] [--default] [--home <dir>]
  prompts show --session <machine>/<thread> [--home <dir>]
             the text in effect (or the shipped one), or exactly what a session was told
  prompts edit <id> [--project <machine>/<project>] [--home <dir>]
             edit it in $VISUAL or $EDITOR; warns when a placeholder or a safety rule is gone
  prompts reset <id> [--project <machine>/<project>] [--home <dir>]
  prompts diff <id> [--project <machine>/<project>] [--home <dir>]
             shipped vs yours; after a release changed it, what changed in each
  instructions show|edit [--project <machine>/<project>] [--home <dir>]
             your custom instructions, appended to every lead and task
"#;

fn usage(message: &str) -> CliResult {
    CliResult::err(2, format!("fleetd: {message}\n\nusage:\n{PROMPTS_USAGE}"))
}

fn ok(stdout: String) -> CliResult {
    CliResult {
        code: 0,
        stdout,
        stderr: String::new(),
    }
}

fn split_ref(raw: &str, what: &str) -> Result<(MachineId, String), String> {
    let (m, rest) = raw
        .split_once('/')
        .filter(|(_, rest)| !rest.is_empty())
        .ok_or_else(|| format!("{what} must be <machine>/<id>, got '{raw}'"))?;
    let m = MachineId::new(m).map_err(|_| format!("'{m}' is not a machine id"))?;
    Ok((m, rest.to_owned()))
}

/// `fleetd instructions show|edit …` is `fleetd prompts show|edit instructions …`.
pub fn instructions_command(argv: &[String]) -> CliResult {
    match argv.first().map(String::as_str) {
        Some(verb @ ("show" | "edit")) => {
            let mut rewritten = vec![verb.to_owned(), INSTRUCTIONS.to_owned()];
            rewritten.extend(argv[1..].iter().cloned());
            prompts_command(&rewritten)
        }
        other => usage(&format!(
            "unknown instructions command '{}'",
            other.unwrap_or("")
        )),
    }
}

pub fn prompts_command(argv: &[String]) -> CliResult {
    let Some(verb) = argv.first().map(String::as_str) else {
        return usage("missing prompts command");
    };
    const OPTIONS: &[(&str, Kind)] = &[
        ("project", Kind::Str),
        ("home", Kind::Str),
        ("default", Kind::Bool),
        ("session", Kind::Str),
    ];
    let v = match args::parse(
        &argv[1..],
        &Spec {
            options: OPTIONS,
            positionals: true,
        },
    ) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    let project = match v.str("project").map(|p| split_ref(p, "--project")) {
        None => None,
        Some(Ok((machine_id, p))) => Some(ProjectRef {
            machine_id,
            project_id: ProjectId::unchecked(p),
        }),
        Some(Err(message)) => return usage(&message),
    };
    let db = match resolve_home(v.str("home")).and_then(|home| open(&home)) {
        Ok(db) => db,
        Err(message) => return CliResult::err(1, format!("fleetd: {message}\n")),
    };
    let id = v.positionals.first().map(String::as_str);
    if verb == "list" {
        return ok(list(&db, project.as_ref()));
    }
    if verb == "show"
        && let Some(raw) = v.str("session")
    {
        return match split_ref(raw, "--session") {
            Err(message) => usage(&message),
            Ok((m, t)) => match db.prompts().session(&m, &ThreadId::unchecked(t)) {
                Ok(Some(session)) => ok(session.text + "\n"),
                Ok(None) => CliResult::err(
                    1,
                    format!(
                        "fleetd: no first message kept for {raw}: fleetd did not start it, or started it before prompts were kept\n"
                    ),
                ),
                Err(error) => CliResult::err(1, format!("fleetd: {error}\n")),
            },
        };
    }
    let Some(id) = id else {
        return usage(&format!(
            "prompts {verb} needs a prompt id (see fleetd prompts list)"
        ));
    };
    let e = match entry(id) {
        Ok(e) => e,
        Err(error) => {
            return CliResult::err(2, format!("fleetd: {error} See fleetd prompts list.\n"));
        }
    };
    if project.is_some() && !e.per_project() {
        return usage(&format!(
            "{} has one hub-wide text; leave out --project",
            e.id
        ));
    }
    let scope = if project.is_some() {
        PromptScope::Project
    } else {
        PromptScope::Global
    };
    let result = match verb {
        "show" => {
            let detail = db.prompts().detail(e, project.as_ref());
            Ok(if v.flag("default") {
                detail.default.text
            } else {
                detail.effective.text
            })
        }
        "diff" => Ok(diff(&db, e, project.as_ref())),
        "reset" => db
            .prompts()
            .reset(e, scope, project.as_ref())
            .map_err(|e| e.to_string())
            .and_then(|()| announce(&db, e, scope, project.as_ref(), json!({})))
            .map(|()| {
                let detail = db.prompts().detail(e, project.as_ref());
                let level = match detail.scope {
                    PromptScope::Default => "the shipped text",
                    PromptScope::Global => "the hub-wide override",
                    PromptScope::Project => "the project override",
                };
                format!("{} is back to {level} ({}).", e.id, detail.effective.r#ref)
            }),
        "edit" => edit(&db, e, scope, project.as_ref()),
        other => return usage(&format!("unknown prompts command '{other}'")),
    };
    match result {
        Ok(text) if text.ends_with('\n') || text.is_empty() => ok(text),
        Ok(text) => ok(text + "\n"),
        Err(message) => CliResult::err(1, format!("fleetd: {message}\n")),
    }
}

fn open(home: &Path) -> Result<Arc<HubDb>, String> {
    if !home.join("hub.sqlite").exists() {
        return Err(format!(
            "no hub in {}; run this on the hub machine, or pass --home",
            home.display()
        ));
    }
    HubDb::open(home).map_err(|e| e.to_string())
}

fn list(db: &HubDb, project: Option<&ProjectRef>) -> String {
    let rows = db.prompts().list(project);
    let width = ENTRIES.iter().map(|e| e.id.len()).max().unwrap_or(0);
    rows.iter()
        .map(|r| {
            let scope = serde_json::to_value(r.scope)
                .ok()
                .and_then(|s| s.as_str().map(str::to_owned))
                .unwrap_or_default();
            let kind = serde_json::to_value(r.kind)
                .ok()
                .and_then(|s| s.as_str().map(str::to_owned))
                .unwrap_or_default();
            format!(
                "{:width$}  {kind:12} {scope:8}{}  {}\n",
                r.id.as_str(),
                if r.stale { " update" } else { "" },
                r.title
            )
        })
        .collect()
}

fn diff(db: &HubDb, e: &Entry, project: Option<&ProjectRef>) -> String {
    let detail = db.prompts().detail(e, project);
    match &detail.stale {
        Some(stale) => {
            let base = stale.base.as_ref().map_or("", |b| b.text.as_str());
            format!(
                "fleetd changed the shipped text since you edited it.\n\n# what fleetd changed (your base -> shipped now)\n{}\n# what you changed (your base -> yours)\n{}",
                diffy::create_patch(base, &stale.current.text),
                diffy::create_patch(base, &stale.yours.text)
            )
        }
        None if detail.effective.r#ref == detail.default.r#ref => {
            format!("{} is the shipped text.\n", e.id)
        }
        None => diffy::create_patch(&detail.default.text, &detail.effective.text).to_string(),
    }
}

fn announce(
    db: &Arc<HubDb>,
    e: &Entry,
    scope: PromptScope,
    project: Option<&ProjectRef>,
    data: serde_json::Value,
) -> Result<(), String> {
    let clock = Arc::new(SystemClock);
    let events = EventLog::new(Arc::clone(db), clock.clone()).map_err(|e| e.to_string())?;
    crate::hub::prompts::changed(
        &events,
        &iso_ms(now_ms(clock.as_ref())),
        e.id,
        scope,
        project,
        data,
    )
    .map_err(|e| e.to_string())
}

/// Opens the text in effect (the 3-way merge when a release changed the default you edited) in the editor, shows
/// what the edit may break, and saves it unless told not to.
fn edit(
    db: &Arc<HubDb>,
    e: &Entry,
    scope: PromptScope,
    project: Option<&ProjectRef>,
) -> Result<String, String> {
    let detail = db.prompts().detail(e, project);
    let (start, base) = match &detail.stale {
        Some(stale) => {
            eprintln!(
                "fleetd changed the shipped {} since you edited it: the file holds both, merged{}.",
                e.id,
                if stale.conflicts {
                    "; resolve the <<<<<<< blocks"
                } else {
                    ""
                }
            );
            (stale.merged.clone(), stale.current.r#ref.to_string())
        }
        None => (
            detail.effective.text.clone(),
            detail.default.r#ref.to_string(),
        ),
    };
    let file = std::env::temp_dir().join(format!("fleetd-{}-{}.md", e.id, std::process::id()));
    std::fs::write(&file, &start)
        .map_err(|err| format!("cannot write {}: {err}", file.display()))?;
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| "vi".into());
    // Through the shell, so an editor with arguments ("code --wait") works.
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{editor} \"$1\""))
        .arg("sh")
        .arg(&file)
        .status();
    let text = std::fs::read_to_string(&file);
    let _ = std::fs::remove_file(&file);
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => return Err(format!("{editor} exited with {s}; nothing saved")),
        Err(err) => return Err(format!("cannot run {editor}: {err}")),
    }
    let text = text.map_err(|err| format!("cannot read the edited file: {err}"))?;
    if text == start && detail.stale.is_none() {
        return Ok("No change.".into());
    }
    let found = warnings(e, &text);
    for w in &found {
        eprintln!("warning: {}", w.message);
    }
    if !confirm("Save? [Y/n] ") {
        return Ok("Not saved.".into());
    }
    let (saved, found) = db
        .prompts()
        .set(e, scope, project, &text, Some(&base))
        .map_err(|e| e.to_string())?;
    let codes: Vec<_> = found.iter().map(|w| w.code).collect();
    announce(
        db,
        e,
        scope,
        project,
        json!({ "ref": saved, "warnings": codes }),
    )?;
    Ok(format!(
        "Saved {saved}. New sessions get it now; a running lead gets it at its next restart (lead_restart), a task at its next attempt."
    ))
}

fn confirm(question: &str) -> bool {
    eprint!("{question}");
    let _ = std::io::stderr().flush();
    let mut answer = String::new();
    if std::io::stdin().lock().read_line(&mut answer).is_err() {
        return false;
    }
    !matches!(answer.trim(), "n" | "N" | "no" | "No")
}
