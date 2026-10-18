//! `fleetd project add|list|remove`: the hub's add-a-project service (project_discover, project_inspect,
//! project_add) from a terminal, one question at a time like `fleetd init`, or flags only without one.
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::Duration;

use fleetd_contracts::projects::{AddSource, add_source};
use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::hub_key::resolve_home;
use super::mcp_client::McpClient;
use super::setup::doctor::connect_to;
use super::setup::machine::{local_host_name, machine_id_from_host};
use super::setup::state::read_setup;

pub const PROJECT_USAGE: &str =
    "  project add [<path|github-url>] [--machine <id>] [--title <t>] [--dest <dir>]
         [--use-existing] [--yes] [--home <dir>] [--hub <url>]
             add a project: a checkout on a machine (this one by default), or a GitHub
             repo cloned onto one (the least busy worker by default), with progress;
             then its CI, merge rules and what the lead will need. No argument: pick one
  project list [--machine <id>] [--home <dir>] [--hub <url>]
  project remove <machine>/<project> [--yes] [--home <dir>] [--hub <url>]
             stop its agents and forget it; its files, branches and worktrees stay
";

const SPEC: Spec = Spec {
    options: &[
        ("machine", Kind::Str),
        ("title", Kind::Str),
        ("dest", Kind::Str),
        ("use-existing", Kind::Bool),
        ("yes", Kind::Bool),
        ("home", Kind::Str),
        ("hub", Kind::Str),
    ],
    positionals: true,
};

const CALL: Duration = Duration::from_secs(120);

fn usage(message: &str) -> u8 {
    eprint!("fleetd: {message}\n\nusage:\n{PROJECT_USAGE}");
    2
}

/// What went wrong, the fix, and the exit code: 1 failed, 3 refused, 4 the hub or machine is unreachable.
struct Stop(u8, String, Option<String>);

impl Stop {
    fn from_body(body: &Value) -> Self {
        let text = |k: &str| body.get(k).and_then(Value::as_str).map(str::to_owned);
        let code = if text("code").as_deref() == Some("machine_offline") {
            4
        } else {
            3
        };
        Stop(
            code,
            text("message").unwrap_or_else(|| body.to_string()),
            text("fix"),
        )
    }
}

struct Out {
    tty: bool,
}

impl Out {
    fn info(&self, text: &str) {
        if self.tty {
            let _ = cliclack::log::info(text);
        } else {
            println!("{text}");
        }
    }
    fn success(&self, text: &str) {
        if self.tty {
            let _ = cliclack::log::success(text);
        } else {
            println!("✓ {text}");
        }
    }
    fn fail(&self, stop: &Stop) -> u8 {
        let fix = stop
            .2
            .as_deref()
            .map(|f| format!("\n  Fix: {f}"))
            .unwrap_or_default();
        if self.tty {
            let _ = cliclack::log::error(format!("{}{fix}", stop.1));
        } else {
            eprintln!("✗ {}{fix}", stop.1);
        }
        stop.0
    }
}

async fn call(client: &mut McpClient, tool: &str, input: Value) -> Result<Value, Stop> {
    let result = client
        .call_tool(tool, input, CALL)
        .await
        .map_err(|e| Stop(4, format!("{tool} failed: {}", e.message()), None))?;
    if result.is_error {
        return Err(Stop::from_body(&result.body));
    }
    Ok(result.body)
}

/// `~/x` against `home`, `x` and `./x` against `cwd`; `/x` as given. No trailing `/`.
pub fn resolve_path(text: &str, cwd: &Path, home: &Path) -> PathBuf {
    let path = if text == "~" {
        home.to_path_buf()
    } else if let Some(rest) = text.strip_prefix("~/") {
        home.join(rest)
    } else {
        cwd.join(text)
    };
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// This machine's id: the one `fleetd init` set up here, else the one its host name gives.
fn local_machine(home: &Path) -> String {
    read_setup(home)
        .ok()
        .flatten()
        .and_then(|s| {
            s.machines
                .into_iter()
                .find(|(_, m)| m.local)
                .map(|(id, _)| id)
        })
        .unwrap_or_else(|| machine_id_from_host(&local_host_name()))
}

fn s<'a>(v: &'a Value, pointer: &str) -> &'a str {
    v.pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn tilde(path: &str) -> String {
    let home = super::home_dir();
    match Path::new(path).strip_prefix(&home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.to_owned(),
    }
}

/// The inspect, as a few lines for a person.
fn describe(inspect: &Value) -> String {
    let list = |p: &str| {
        inspect
            .pointer(p)
            .and_then(Value::as_array)
            .map(|a| {
                let names: Vec<&str> = a.iter().filter_map(Value::as_str).collect();
                let shown = names[..names.len().min(6)].join(", ");
                match names.len().saturating_sub(6) {
                    0 => shown,
                    more => format!("{shown} and {more} more"),
                }
            })
            .filter(|t| !t.is_empty())
    };
    let mut lines = vec![format!("Lead needs: {}", s(inspect, "/leadNeeds"))];
    if let Some(b) = inspect.get("defaultBranch").and_then(Value::as_str) {
        lines.push(format!("Default branch: {b}"));
    }
    lines.push(format!(
        "CI: {}; required checks: {}",
        list("/ci/workflows").unwrap_or_else(|| "none".into()),
        list("/ci/requiredChecks").unwrap_or_else(|| "none".into())
    ));
    let squash = match inspect
        .pointer("/merge/squashAllowed")
        .and_then(Value::as_bool)
    {
        Some(true) => "squash allowed",
        Some(false) => "squash OFF",
        None => "squash unknown",
    };
    let protected = if inspect.pointer("/merge/protected") == Some(&Value::Bool(true)) {
        "protected"
    } else {
        "unprotected"
    };
    let rulesets = list("/merge/rulesets")
        .map(|r| format!(", rulesets: {r}"))
        .unwrap_or_default();
    lines.push(format!("Merge: {protected}, {squash}{rulesets}"));
    for note in inspect
        .get("notes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        lines.push(format!("Note: {}", note.as_str().unwrap_or_default()));
    }
    lines.join("\n")
}

pub async fn project_command(argv: &[String]) -> u8 {
    let Some(verb) = argv.first().map(String::as_str) else {
        return usage("missing project command");
    };
    let v = match args::parse(&argv[1..], &SPEC) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    let home = match resolve_home(v.str("home")) {
        Ok(h) => h,
        Err(message) => return usage(&message),
    };
    let tty = std::io::stdin().is_terminal() && std::io::stdout().is_terminal() && !v.flag("yes");
    let out = Out { tty };
    let mut client = match connect_to(&home, v.str("hub"), "fleetd-project").await {
        Ok(c) => c,
        Err(f) => return out.fail(&Stop(4, f.message, Some(f.fix))),
    };
    let result = match verb {
        "add" => add(&mut client, &out, &v, &home).await,
        "list" => list(&mut client, &v).await,
        "remove" => remove(&mut client, &out, &v).await,
        other => return usage(&format!("unknown project command '{other}'")),
    };
    match result {
        Ok(()) => 0,
        Err(stop) if stop.0 == 2 => usage(&stop.1),
        Err(stop) => out.fail(&stop),
    }
}

async fn list(client: &mut McpClient, v: &args::Parsed) -> Result<(), Stop> {
    let body = call(
        client,
        "projects_list",
        json!({ "machineId": v.str("machine") }),
    )
    .await?;
    let projects = body
        .get("projects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if projects.is_empty() {
        println!("No projects yet: fleetd project add <path|github-url>");
    }
    for p in &projects {
        println!(
            "{}/{}  {}  {}",
            s(p, "/machineId"),
            s(p, "/projectId"),
            s(p, "/title"),
            tilde(s(p, "/workspaceRoot"))
        );
    }
    Ok(())
}

async fn remove(client: &mut McpClient, out: &Out, v: &args::Parsed) -> Result<(), Stop> {
    let Some(target) = v.positionals.first() else {
        return Err(Stop(
            2,
            "give the project as <machine>/<project id or title>".into(),
            None,
        ));
    };
    let Some((machine, which)) = target.split_once('/') else {
        return Err(Stop(
            2,
            format!("'{target}' is not <machine>/<project>"),
            None,
        ));
    };
    let body = call(client, "projects_list", json!({ "machineId": machine })).await?;
    let projects = body
        .get("projects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let found = projects
        .iter()
        .find(|p| s(p, "/projectId") == which)
        .or_else(|| {
            let by_title: Vec<&Value> = projects
                .iter()
                .filter(|p| s(p, "/title") == which)
                .collect();
            (by_title.len() == 1).then(|| by_title[0])
        });
    let Some(project) = found else {
        return Err(Stop(
            3,
            format!("no single project '{which}' on {machine}"),
            Some(format!(
                "fleetd project list --machine {machine} shows their ids"
            )),
        ));
    };
    let title = s(project, "/title").to_owned();
    if out.tty {
        let sure = cliclack::confirm(format!(
            "Remove {title} on {machine}? Its agents stop; its files stay."
        ))
        .initial_value(false)
        .interact()
        .unwrap_or(false);
        if !sure {
            return Ok(());
        }
    }
    call(
        client,
        "project_remove",
        json!({ "machineId": machine, "projectId": s(project, "/projectId") }),
    )
    .await?;
    out.success(&format!(
        "{title} removed from {machine}; its files, branches and worktrees stay"
    ));
    Ok(())
}

/// What to add, after the argument or the pick.
enum Pick {
    Path { machine: String, path: String },
    Clone { url: String },
}

async fn pick(client: &mut McpClient, out: &Out, machine: Option<&str>) -> Result<Pick, Stop> {
    let spinner = cliclack::spinner();
    spinner.start("Looking for repos on your machines and GitHub…");
    let found = call(client, "project_discover", json!({ "machineId": machine })).await;
    spinner.stop("Found");
    let found = found?;
    #[derive(Clone, PartialEq, Eq)]
    enum Item {
        Path(String, String),
        Clone(String),
        Paste,
    }
    let mut items: Vec<(Item, String, String)> = Vec::new();
    for m in found
        .get("machines")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = s(m, "/machineId");
        for r in m
            .get("repos")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if r.get("projectId").is_some() {
                continue;
            }
            items.push((
                Item::Path(id.to_owned(), s(r, "/path").to_owned()),
                s(r, "/name").to_owned(),
                format!("{id} · {} · {}", tilde(s(r, "/path")), s(r, "/remote")),
            ));
        }
        if let Some(p) = m.get("problem") {
            out.info(&format!("{id}: {}", s(p, "/message")));
        }
    }
    let github = found.get("github").cloned().unwrap_or_default();
    for r in github
        .get("repos")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if r.get("checkouts")
            .and_then(Value::as_array)
            .is_some_and(|c| !c.is_empty())
        {
            continue;
        }
        let private = if r.get("private") == Some(&Value::Bool(true)) {
            "private · "
        } else {
            ""
        };
        items.push((
            Item::Clone(s(r, "/url").to_owned()),
            s(r, "/repo").to_owned(),
            format!("clone · {private}gh on {}", s(&github, "/ghOn")),
        ));
    }
    if let Some(p) = github.get("problem") {
        out.info(&format!("{} ({})", s(p, "/message"), s(p, "/fix")));
    }
    items.push((
        Item::Paste,
        "Paste a GitHub URL".into(),
        "or owner/repo".into(),
    ));
    let choice = cliclack::select("Which repo?")
        .items(&items)
        .filter_mode()
        .interact()
        .map_err(|_| Stop(1, "stopped".into(), None))?;
    Ok(match choice {
        Item::Path(machine, path) => Pick::Path { machine, path },
        Item::Clone(url) => Pick::Clone { url },
        Item::Paste => {
            let url: String = cliclack::input("GitHub repo")
                .placeholder("https://github.com/owner/repo")
                .validate(|t: &String| match add_source(t) {
                    Some(AddSource::GitHub(_)) => Ok(()),
                    _ => Err("a GitHub URL or owner/repo"),
                })
                .interact()
                .map_err(|_| Stop(1, "stopped".into(), None))?;
            Pick::Clone { url }
        }
    })
}

async fn add(client: &mut McpClient, out: &Out, v: &args::Parsed, home: &Path) -> Result<(), Stop> {
    if out.tty {
        let _ = cliclack::intro("Add a project");
    }
    let given_machine = v.string("machine");
    let picked = match v.positionals.first() {
        Some(text) => match add_source(text) {
            Some(AddSource::Path(p)) => {
                let cwd = std::env::current_dir().unwrap_or_else(|_| super::home_dir());
                Pick::Path {
                    machine: given_machine.clone().unwrap_or_else(|| local_machine(home)),
                    path: resolve_path(&p, &cwd, &super::home_dir())
                        .to_string_lossy()
                        .into_owned(),
                }
            }
            Some(AddSource::GitHub(_)) => Pick::Clone { url: text.clone() },
            None => {
                return Err(Stop(
                    2,
                    format!(
                        "'{text}' is neither a path (/…, ~/…, ./…) nor a GitHub repo (https://github.com/owner/repo)"
                    ),
                    None,
                ));
            }
        },
        None if out.tty => pick(client, out, given_machine.as_deref()).await?,
        None => {
            return Err(Stop(
                2,
                "give a path or a GitHub URL (or run it in a terminal to pick one)".into(),
                None,
            ));
        }
    };
    let mut input = json!({ "title": v.str("title") });
    match &picked {
        Pick::Path { machine, path } => {
            input["machineId"] = json!(machine);
            input["path"] = json!(path);
        }
        Pick::Clone { url } => {
            input["url"] = json!(url);
            input["dest"] = json!(v.str("dest"));
            if let Some(m) = &given_machine {
                input["machineId"] = json!(m);
            }
            let preview = call(
                client,
                "project_inspect",
                json!({ "url": url, "machineId": given_machine }),
            )
            .await?;
            let target = preview.get("clone").cloned().unwrap_or_default();
            let (machine, dest) = (
                s(&target, "/machineId").to_owned(),
                s(&target, "/path").to_owned(),
            );
            if !machine.is_empty() {
                input["machineId"] = json!(machine);
            }
            if out.tty {
                out.info(&describe(&preview));
            }
            let same = target.get("sameRemote") == Some(&Value::Bool(true));
            if v.flag("use-existing") {
                input["useExisting"] = json!(true);
            } else if same && v.str("dest").is_none() {
                let use_it = !out.tty
                    || cliclack::confirm(format!(
                        "{machine} already has it at {}. Add that checkout?",
                        tilde(&dest)
                    ))
                    .initial_value(true)
                    .interact()
                    .unwrap_or(false);
                if !use_it {
                    return Err(Stop(
                        1,
                        "not added".into(),
                        Some("Clone somewhere else with --dest <dir>".into()),
                    ));
                }
                if out.tty {
                    input["useExisting"] = json!(true);
                }
            } else if out.tty && !dest.is_empty() {
                let go = cliclack::confirm(format!("Clone into {} on {machine}?", tilde(&dest)))
                    .initial_value(true)
                    .interact()
                    .unwrap_or(false);
                if !go {
                    return Ok(());
                }
            }
        }
    }
    // The cursor before the add, so no progress event is missed.
    let head = call(client, "events_wait", json!({ "timeoutSec": 0 })).await?;
    let mut cursor = head.get("cursor").cloned().unwrap_or(json!(0));
    let added = call(client, "project_add", input).await?;
    let machine = s(&added, "/machineId").to_owned();
    let path = s(&added, "/path").to_owned();
    let Some(add_id) = added
        .get("addId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        let verb = if added.get("created") == Some(&Value::Bool(true)) {
            "added"
        } else {
            "is already a project"
        };
        out.success(&format!("{} on {machine} {verb}", tilde(&path)));
        out.info(&describe(added.get("inspect").unwrap_or(&Value::Null)));
        return finish(out);
    };
    let bar = out.tty.then(|| {
        let bar = cliclack::progress_bar(100);
        bar.start(format!("Cloning into {} on {machine}", tilde(&path)));
        bar
    });
    if !out.tty {
        println!("cloning into {path} on {machine}");
    }
    let mut last_phase = String::new();
    loop {
        let page = call(
            client,
            "events_wait",
            json!({
                "cursor": cursor,
                "timeoutSec": 50,
                "machineId": machine,
                "types": ["project.clone_progress", "project.added", "project.add_failed"],
            }),
        )
        .await?;
        cursor = page.get("cursor").cloned().unwrap_or(cursor);
        for e in page
            .get("events")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if s(e, "/data/addId") != add_id {
                continue;
            }
            match s(e, "/type") {
                "project.clone_progress" => {
                    let phase = s(e, "/data/phase").replace('_', " ");
                    let pct = e.pointer("/data/percent").and_then(Value::as_u64);
                    let detail = s(e, "/data/detail");
                    match &bar {
                        Some(bar) => {
                            bar.set_position(pct.unwrap_or(0));
                            bar.set_message(format!("{phase} {detail}"));
                        }
                        None if phase != last_phase => println!("  {phase}"),
                        None => {}
                    }
                    last_phase = phase;
                }
                "project.added" => {
                    let done = format!("{} cloned and added on {machine}", tilde(&path));
                    match &bar {
                        Some(bar) => bar.stop(&done),
                        None => println!("✓ {done}"),
                    }
                    out.info(&describe(
                        e.pointer("/data/inspect").unwrap_or(&Value::Null),
                    ));
                    return finish(out);
                }
                _ => {
                    if let Some(bar) = &bar {
                        bar.error("clone failed");
                    }
                    let fix = e
                        .pointer("/data/fix")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    return Err(Stop(1, s(e, "/data/message").to_owned(), fix));
                }
            }
        }
    }
}

fn finish(out: &Out) -> Result<(), Stop> {
    let next = "Give it an order in the app's composer, or from any agent with intake_submit; its lead starts with the first one.";
    if out.tty {
        let _ = cliclack::outro(next);
    } else {
        println!("{next}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_resolve_like_a_shell() {
        let (cwd, home) = (Path::new("/home/me/work"), Path::new("/home/me"));
        let r = |t: &str| resolve_path(t, cwd, home).to_string_lossy().into_owned();
        assert_eq!(r("~/src/storefront"), "/home/me/src/storefront");
        assert_eq!(r("~"), "/home/me");
        assert_eq!(r("./storefront/"), "/home/me/work/storefront");
        assert_eq!(r("../src/storefront"), "/home/me/src/storefront");
        assert_eq!(r("/srv/storefront"), "/srv/storefront");
    }
}
