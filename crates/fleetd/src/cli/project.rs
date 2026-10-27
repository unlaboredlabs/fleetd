//! `fleetd project add|list|stop|remove|set|profiles|repo`: the hub's add-a-project service (project_discover and
//! project_add) from a terminal, one question at a time like `fleetd init`, or flags only without one, a project's or
//! the fleet's settings, and a project's repos. Also `fleetd machine set`, the machine's max agents, beside the
//! project's.
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::Duration;

use fleetd_contracts::projects::{AddSource, add_source};
use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::hub_key::resolve_home;
use super::mcp_client::McpClient;
use super::setup::doctor::{connect_to, connect_with};
use super::setup::machine::{local_host_name, machine_id_from_host};
use super::setup::state::read_setup;

pub const PROJECT_USAGE: &str =
    "  project add [<path|github-url>] [--machine <id>] [--title <t>] [--dest <dir>]
         [--use-existing] [--yes] [--home <dir>] [--hub <url>]
             add a project: a checkout on a machine (this one by default), or a GitHub
             repo cloned onto one (the least busy worker by default), with progress;
             then its CI, merge rules and what the lead will need. No argument: pick one
  project list [--machine <id>] [--home <dir>] [--hub <url>]
  project stop <machine>/<project> --key-file <human key> [--yes] [--home <dir>] [--hub <url>]
             stop its lead's turn and its agents, as you; the lead and its chat stay,
             and the chat says what stopped
  project remove <machine>/<project> [--yes] [--home <dir>] [--hub <url>]
             stop its agents and forget it; its files, branches and worktrees stay
  project repo list <machine>/<project> [--home <dir>] [--hub <url>]
  project repo add <machine>/<project> <path|github-url> [--name <n>] [--dest <dir>]
         [--use-existing] [--home <dir>] [--hub <url>]
             add a repo to the project: a checkout on its machine, or a GitHub repo
             cloned there, with progress. A checkout that is a project of its own is
             archived: its chat stays, its lead stops running
  project repo remove <machine>/<project> <name> [--yes] [--home <dir>] [--hub <url>]
             take the repo out of the project and end its agents; its files stay
  project set <machine>/<project> --max-agents <n>|default [--pause-extras] [--home <dir>] [--hub <url>]
  project set --fleet-cap <n> [--home <dir>] [--hub <url>]
             the most agents the project runs at once (its lead not counted), or the
             fleet's cap on running agents (admin key); more wait queued and start as
             slots free. default: its machine's cap within the fleet cap, following
             both. Lowering stops nothing; --pause-extras has the newest agents above
             the new max push their work and wait
  project set <machine>/<project> --medium on|off [--home <dir>] [--hub <url>]
             whether the lead may run mechanical tasks on the medium profile (on by
             default); off runs every task on high
  project set [<machine>/<project>] [--high-model <model>|default]
         [--high-effort low|medium|high|max|default] [--medium-model <model>|default]
         [--medium-effort low|medium|high|max|default] [--home <dir>] [--hub <url>]
             the model and effort behind a task profile, fleet-wide (admin key) or as
             the project's override. default unsets it: a project's follows the
             fleet's, the fleet's the profile's own (claude-opus-5-5 at high or
             medium). The lead, every review and helper calls run high. New agents
             follow it; if claude refuses the model they run on the profile's own
             and `project profiles` says so
  project profiles [<machine>/<project>] [--home <dir>] [--hub <url>]
             what each profile's agents run on, and the settings behind it
  project set <machine>/<project> [--fast-check <check>]... [--after-merge <check>]...
         [--home <dir>] [--hub <url>]
             how the merge train treats the repo's checks. It waits only for its fast
             set: the checks the base branch requires, plus each --fast-check, each
             until it reports. Each --after-merge never stops a merge, even once
             failed. A check outside the fast set that fails after the merge opens a
             fix order. Each option replaces its list; none empties it
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
        ("max-agents", Kind::Str),
        ("pause-extras", Kind::Bool),
        ("fleet-cap", Kind::Str),
        ("key-file", Kind::Str),
        ("medium", Kind::Str),
        ("high-model", Kind::Str),
        ("high-effort", Kind::Str),
        ("medium-model", Kind::Str),
        ("medium-effort", Kind::Str),
        ("fast-check", Kind::Multi),
        ("after-merge", Kind::Multi),
        ("name", Kind::Str),
    ],
    positionals: true,
};

const CALL: Duration = Duration::from_secs(120);
/// A clone reports each phase and every 5 percent; this long without a word, it is not coming.
const QUIET_LIMIT: Duration = Duration::from_secs(20 * 60);

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
    // A stop speaks for the person, so it goes with their human key.
    let connected = match (verb, v.str("key-file").filter(|f| !f.is_empty())) {
        ("stop", None) => return usage(&super::steer::human_key_required("a stop")),
        ("stop", Some(file)) => match std::fs::read_to_string(file) {
            Ok(key) => connect_with(&home, v.str("hub"), "fleetd-project", key.trim()).await,
            Err(error) => {
                return out.fail(&Stop(3, format!("cannot read --key-file: {error}"), None));
            }
        },
        (_, Some(_)) => return usage("--key-file is for project stop"),
        (_, None) => connect_to(&home, v.str("hub"), "fleetd-project").await,
    };
    let mut client = match connected {
        Ok(c) => c,
        Err(f) => return out.fail(&Stop(4, f.message, Some(f.fix))),
    };
    let result = match verb {
        "add" => add(&mut client, &out, &v, &home).await,
        "list" => list(&mut client, &v).await,
        "remove" => remove(&mut client, &out, &v).await,
        "stop" => stop(&mut client, &out, &v).await,
        "set" => set(&mut client, &out, &v).await,
        "profiles" => profiles(&mut client, &v).await,
        "repo" => repo(&mut client, &out, &v).await,
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
        "project_get",
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

/// `fleetd project stop <machine>/<project>`: the chat's Stop (chat_stop, as the app sends it), as the machine's owner.
async fn stop(client: &mut McpClient, out: &Out, v: &args::Parsed) -> Result<(), Stop> {
    let (machine, project) = find(client, v).await?;
    let title = s(&project, "/title").to_owned();
    if out.tty {
        let sure = cliclack::confirm(format!(
            "Stop everything in {title} on {machine}? The lead's turn and its agents stop; the lead stays."
        ))
        .initial_value(false)
        .interact()
        .unwrap_or(false);
        if !sure {
            return Ok(());
        }
    }
    let body = call(
        client,
        "chat_stop",
        json!({
            "projectRef": { "machineId": machine, "projectId": s(&project, "/projectId") },
            "clientRequestId": super::steer::client_request_id(),
        }),
    )
    .await?;
    out.success(&format!("{title}: {}", s(&body, "/message/text")));
    Ok(())
}

/// The project a `<machine>/<project id or title>` argument names.
async fn find(client: &mut McpClient, v: &args::Parsed) -> Result<(String, Value), Stop> {
    find_target(client, v.positionals.first()).await
}

async fn find_target(
    client: &mut McpClient,
    target: Option<&String>,
) -> Result<(String, Value), Stop> {
    let Some(target) = target else {
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
    let body = call(client, "project_get", json!({ "machineId": machine })).await?;
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
    Ok((machine.to_owned(), project.clone()))
}

async fn remove(client: &mut McpClient, out: &Out, v: &args::Parsed) -> Result<(), Stop> {
    let (machine, project) = find(client, v).await?;
    let project = &project;
    let machine = machine.as_str();
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

/// `fleetd project repo add|list|remove <machine>/<project> …`: project_repo_add, project_repo_list and
/// project_repo_remove.
async fn repo(client: &mut McpClient, out: &Out, v: &args::Parsed) -> Result<(), Stop> {
    let sub = v.positionals.first().map(String::as_str);
    let (machine, project) = match sub {
        Some("add" | "list" | "remove") => find_target(client, v.positionals.get(1)).await?,
        _ => {
            return Err(Stop(
                2,
                "give project repo add, list or remove".into(),
                None,
            ));
        }
    };
    let title = s(&project, "/title").to_owned();
    let at = json!({ "machineId": machine, "projectId": s(&project, "/projectId") });
    let arg = v.positionals.get(2);
    match sub {
        Some("list") => {
            let body = call(client, "project_repo_list", at).await?;
            let repos = body
                .get("repos")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if repos.is_empty() {
                println!(
                    "{title} holds no repo, a plain folder: fleetd project repo add {machine}/{title} <path|github-url>"
                );
            }
            for r in &repos {
                let lands = match (s(r, "/repoKey"), s(r, "/base")) {
                    ("", _) => "no remote".to_owned(),
                    (key, "") => key.to_owned(),
                    (key, base) => format!("{key} on {base}"),
                };
                println!("{}  {}  {lands}", s(r, "/name"), tilde(s(r, "/path")));
            }
            Ok(())
        }
        Some("add") => {
            let Some(text) = arg else {
                return Err(Stop(
                    2,
                    "give the repo as a path or a GitHub URL".into(),
                    None,
                ));
            };
            let mut input = at;
            input["name"] = json!(v.str("name"));
            match add_source(text) {
                Some(AddSource::Path(p)) => {
                    let cwd = std::env::current_dir().unwrap_or_else(|_| super::home_dir());
                    let path = resolve_path(&p, &cwd, &super::home_dir());
                    input["path"] = json!(path.to_string_lossy());
                }
                Some(AddSource::GitHub(_)) => {
                    input["url"] = json!(text);
                    input["dest"] = json!(v.str("dest"));
                    if v.flag("use-existing") {
                        input["useExisting"] = json!(true);
                    }
                }
                None => {
                    return Err(Stop(
                        2,
                        format!(
                            "'{text}' is neither a path (/…, ~/…, ./…) nor a GitHub repo (https://github.com/owner/repo)"
                        ),
                        None,
                    ));
                }
            }
            // The cursor before the add, so no progress event is missed.
            let head = call(client, "events_wait", json!({ "timeoutSec": 0 })).await?;
            let cursor = head.get("cursor").cloned().unwrap_or(json!(0));
            let added = call(client, "project_repo_add", input).await?;
            if let Some(add_id) = added.get("addId").and_then(Value::as_str) {
                let path = s(&added, "/path").to_owned();
                follow_clone(client, out, &machine, &path, add_id, cursor).await?;
                out.success(&format!("added to {title}"));
                return Ok(());
            }
            out.success(&format!("{} added to {title}", s(&added, "/repo/name")));
            if added.get("archived").is_some() {
                out.info(s(&added, "/next"));
            }
            Ok(())
        }
        _ => {
            let Some(name) = arg else {
                return Err(Stop(
                    2,
                    "give the repo's name (fleetd project repo list shows them)".into(),
                    None,
                ));
            };
            if out.tty {
                let sure = cliclack::confirm(format!(
                    "Remove {name} from {title}? Its agents stop; its files stay."
                ))
                .initial_value(false)
                .interact()
                .unwrap_or(false);
                if !sure {
                    return Ok(());
                }
            }
            let mut input = at;
            input["name"] = json!(name);
            let body = call(client, "project_repo_remove", input).await?;
            out.success(&format!("{name} removed from {title}"));
            out.info(s(&body, "/next"));
            Ok(())
        }
    }
}

fn count_of(v: &args::Parsed, name: &str) -> Result<Option<u32>, Stop> {
    v.str(name)
        .map(|n| {
            n.parse::<u32>()
                .ok()
                .filter(|n| (1..=1000).contains(n))
                .ok_or_else(|| {
                    let or = if name == "max-agents" {
                        " or default"
                    } else {
                        ""
                    };
                    Stop(
                        2,
                        format!("--{name} takes a number from 1 to 1000{or}"),
                        None,
                    )
                })
        })
        .transpose()
}

/// The flags that set a profile: `--high-model`, `--high-effort`, `--medium-model`, `--medium-effort`.
const PROFILE_FLAGS: [(&str, &str, &str); 4] = [
    ("high-model", "high", "model"),
    ("high-effort", "high", "effort"),
    ("medium-model", "medium", "model"),
    ("medium-effort", "medium", "effort"),
];

/// profiles_set's input: the scope's current settings (`current`, as profiles_get reads them) with the flags given
/// applied, `default` unsetting a field. A profile's refusal is passed back as read, so the hub keeps it, unless its
/// model flag is given: setting the model again (or unsetting it) clears it. None when no flag is given.
pub fn profiles_input(
    current: &Value,
    flags: &[(&str, &str)],
    project_ref: Option<Value>,
) -> Result<Option<Value>, String> {
    if flags.is_empty() {
        return Ok(None);
    }
    let mut input = json!({});
    if let Some(r) = project_ref {
        input["projectRef"] = r;
    }
    for (flag, value) in flags {
        let Some((_, profile, field)) = PROFILE_FLAGS.iter().find(|(f, _, _)| f == flag) else {
            continue;
        };
        if input.get(profile).is_none() {
            input[profile] = current.get(profile).cloned().unwrap_or_else(|| json!({}));
        }
        if *field == "model"
            && let Some(o) = input[profile].as_object_mut()
        {
            o.remove("refused");
        }
        if *value == "default" {
            if let Some(o) = input[profile].as_object_mut() {
                o.remove(*field);
            }
            continue;
        }
        if *field == "effort" && !matches!(*value, "low" | "medium" | "high" | "max") {
            return Err(format!(
                "--{flag} takes low, medium, high, max or default, got '{value}'"
            ));
        }
        input[profile][field] = json!(value);
    }
    Ok(Some(input))
}

/// What each profile runs on, and the settings behind it, for a person.
pub fn profiles_lines(view: &Value, project: bool) -> Vec<String> {
    let run = |v: &Value| format!("{} at {}", s(v, "/model"), s(v, "/effort"));
    let setting = |v: &Value| match (v.get("model"), v.get("effort")) {
        (None, None) => "unset".to_owned(),
        (Some(m), None) => m.as_str().unwrap_or_default().to_owned(),
        (None, Some(e)) => format!("effort {}", e.as_str().unwrap_or_default()),
        (Some(m), Some(e)) => format!(
            "{} at {}",
            m.as_str().unwrap_or_default(),
            e.as_str().unwrap_or_default()
        ),
    };
    let mut lines = Vec::new();
    for profile in ["high", "medium"] {
        let at = |scope: &str| {
            view.pointer(&format!("/{scope}/{profile}"))
                .cloned()
                .unwrap_or(json!({}))
        };
        lines.push(format!("{profile:<7} {}", run(&view["runs"][profile])));
        let mut from = vec![format!("fleet: {}", setting(&at("fleet")))];
        if project {
            from.push(format!("this project: {}", setting(&at("project"))));
        }
        from.push(format!("own: {}", run(&view["defaults"][profile])));
        lines.push(format!("        {}", from.join(" · ")));
        for scope in ["fleet", "project"] {
            if let Some(why) = at(scope).get("refused").and_then(Value::as_str) {
                lines.push(format!("        ! {why}"));
            }
        }
    }
    lines
}

/// `fleetd project profiles [<machine>/<project>]`.
async fn profiles(client: &mut McpClient, v: &args::Parsed) -> Result<(), Stop> {
    let project_ref = match v.positionals.first() {
        Some(_) => {
            let (machine, project) = find(client, v).await?;
            Some(json!({ "machineId": machine, "projectId": s(&project, "/projectId") }))
        }
        None => None,
    };
    let project = project_ref.is_some();
    let mut input = json!({});
    if let Some(r) = project_ref {
        input["projectRef"] = r;
    }
    let view = call(client, "profiles_get", input).await?;
    for line in profiles_lines(&view, project) {
        println!("{line}");
    }
    Ok(())
}

/// `--high-model` and the like: profiles_set at the fleet, or the project given. Whether any was given.
async fn set_profiles(client: &mut McpClient, out: &Out, v: &args::Parsed) -> Result<bool, Stop> {
    let flags: Vec<(&str, &str)> = PROFILE_FLAGS
        .iter()
        .filter_map(|(f, _, _)| v.str(f).map(|value| (*f, value)))
        .collect();
    if flags.is_empty() {
        return Ok(false);
    }
    let project_ref = match v.positionals.first() {
        Some(_) => {
            let (machine, project) = find(client, v).await?;
            Some(json!({ "machineId": machine, "projectId": s(&project, "/projectId") }))
        }
        None => None,
    };
    let mut get = json!({});
    if let Some(r) = &project_ref {
        get["projectRef"] = r.clone();
    }
    let current = call(client, "profiles_get", get).await?;
    let scope = if project_ref.is_some() {
        "project"
    } else {
        "fleet"
    };
    let project = project_ref.is_some();
    let input = profiles_input(&current[scope], &flags, project_ref)
        .map_err(|m| Stop(2, m, None))?
        .unwrap_or_default();
    let body = call(client, "profiles_set", input).await?;
    out.success(body.get("next").and_then(Value::as_str).unwrap_or("Set."));
    for line in profiles_lines(&body, project) {
        println!("{line}");
    }
    Ok(true)
}

async fn set(client: &mut McpClient, out: &Out, v: &args::Parsed) -> Result<(), Stop> {
    if set_profiles(client, out, v).await? {
        let others = [
            "medium",
            "max-agents",
            "fleet-cap",
            "fast-check",
            "after-merge",
        ];
        if !others.iter().any(|o| v.has(o)) {
            return Ok(());
        }
    }
    let medium = match v.str("medium") {
        None => None,
        Some("on") => Some(true),
        Some("off") => Some(false),
        Some(other) => {
            return Err(Stop(
                2,
                format!("--medium takes on or off, got '{other}'"),
                None,
            ));
        }
    };
    // "default": back to its machine's cap within the fleet cap.
    let max_agents = match v.str("max-agents") {
        Some("default") => Some(None),
        _ => count_of(v, "max-agents")?.map(Some),
    };
    let fleet_cap = count_of(v, "fleet-cap")?;
    let train = v.has("fast-check") || v.has("after-merge");
    if train {
        let (machine, project) = find(client, v).await?;
        let at = json!({ "machineId": machine, "projectId": s(&project, "/projectId") });
        let current = call(client, "project_settings_get", at.clone()).await?;
        let mut settings = current["settings"]["train"].clone();
        // `none` alone empties the list.
        for (option, key) in [("fast-check", "fastChecks"), ("after-merge", "afterMerge")] {
            if v.has(option) {
                let names = v.multi(option);
                settings[key] = if names == ["none"] {
                    json!([])
                } else {
                    json!(names)
                };
            }
        }
        let mut input = at;
        input["train"] = settings;
        let body = call(client, "project_settings_set", input).await?;
        out.success(body.get("next").and_then(Value::as_str).unwrap_or("Set."));
        if medium.is_none() && max_agents.is_none() && fleet_cap.is_none() {
            return Ok(());
        }
    }
    if let Some(allowed) = medium {
        let (machine, project) = find(client, v).await?;
        let body = call(
            client,
            "project_set",
            json!({ "machineId": machine, "projectId": s(&project, "/projectId"), "mediumAllowed": allowed }),
        )
        .await?;
        out.success(body.get("next").and_then(Value::as_str).unwrap_or("Set."));
        if max_agents.is_none() && fleet_cap.is_none() {
            return Ok(());
        }
    }
    let mut input = json!({});
    if let Some(cap) = fleet_cap {
        input["cap"] = json!(cap);
    }
    match (v.positionals.first(), max_agents) {
        (Some(_), Some(n)) => {
            let (machine, project) = find(client, v).await?;
            input["project"] = json!({
                "projectRef": { "machineId": machine, "projectId": s(&project, "/projectId") },
                "pauseExtras": v.flag("pause-extras"),
            });
            match n {
                Some(n) => input["project"]["maxAgents"] = json!(n),
                None => input["project"]["followDefault"] = json!(true),
            }
        }
        (Some(_), None) if medium.is_none() && !train => {
            return Err(Stop(
                2,
                "give --max-agents <n>, --medium on|off, --fast-check or --after-merge for the project".into(),
                None,
            ));
        }
        (Some(_), None) => {}
        (None, Some(_)) => {
            return Err(Stop(
                2,
                "--max-agents needs the project as <machine>/<project>".into(),
                None,
            ));
        }
        (None, None) if fleet_cap.is_none() => {
            return Err(Stop(
                2,
                "give --max-agents <n> or --medium on|off with a project, or --fleet-cap <n>"
                    .into(),
                None,
            ));
        }
        (None, None) => {}
    }
    let body = call(client, "cap_set", input).await?;
    out.success(body.get("next").and_then(Value::as_str).unwrap_or("Set."));
    Ok(())
}

pub const MACHINE_SET_USAGE: &str =
    "  machine set <id> --max-agents <n>|auto [--home <dir>] [--hub <url>]
             the most agents the machine runs at once (admin key), up to the fleet cap,
             in place of what it is measured to fit; auto: what it fits again. Raising
             starts queued agents at once; lowering stops nothing
  machine set <id> --roles agents,sessions [--max-sessions <n>|auto] [--home <dir>] [--hub <url>]
             what the machine is for (admin key): agents, sessions (screens: browsers and
             devices) or both, and the most screens it hosts at once (1 to 64; auto: what it
             fits). A screen an agent starts runs on its own machine when it can, else on
             another that can, through the hub. Without agents, running agents finish and new ones
             wait
";

const MACHINE_SET_SPEC: Spec = Spec {
    options: &[
        ("max-agents", Kind::Str),
        ("roles", Kind::Str),
        ("max-sessions", Kind::Str),
        ("home", Kind::Str),
        ("hub", Kind::Str),
    ],
    positionals: true,
};

fn machine_usage(message: &str) -> u8 {
    eprint!("fleetd: {message}\n\nusage:\n{MACHINE_SET_USAGE}");
    2
}

/// `machine_roles_set`'s input from `--roles` and `--max-sessions`; None when neither is given.
pub fn roles_input(
    machine: &str,
    roles: Option<&str>,
    max_sessions: Option<&str>,
) -> Result<Option<Value>, String> {
    if roles.is_none() && max_sessions.is_none() {
        return Ok(None);
    }
    let mut input = json!({ "machineId": machine });
    if let Some(roles) = roles {
        let mut list: Vec<&str> = Vec::new();
        for role in roles.split(',').map(str::trim).filter(|r| !r.is_empty()) {
            if !matches!(role, "agents" | "sessions") {
                return Err(format!(
                    "--roles takes agents, sessions or both (agents,sessions), not {role}"
                ));
            }
            if !list.contains(&role) {
                list.push(role);
            }
        }
        if list.is_empty() {
            return Err("--roles takes agents, sessions or both (agents,sessions)".into());
        }
        input["roles"] = json!(list);
    }
    match max_sessions {
        None => {}
        Some("auto") => input["autoSessions"] = json!(true),
        Some(n) => match n.parse::<i64>() {
            Ok(n) if (1..=64).contains(&n) => input["maxSessions"] = json!(n),
            _ => return Err("--max-sessions takes a number from 1 to 64 or auto".into()),
        },
    }
    Ok(Some(input))
}

/// "devbox: agents and screens, 2 of 4 screens (auto: 8 CPUs, 16 GB)."
fn roles_line(machine: &Value) -> String {
    let roles: Vec<&str> = machine
        .get("roles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        // The sessions role, as a person reads it.
        .map(|r| if r == "sessions" { "screens" } else { r })
        .collect();
    let n = |k: &str| machine.get(k).and_then(Value::as_i64).unwrap_or(0);
    format!(
        "{}: {}, {} of {} screens ({}).",
        s(machine, "/machineId"),
        roles.join(" and "),
        n("sessionsLive"),
        n("maxSessions"),
        s(machine, "/maxSessionsWhy")
    )
}

/// `fleetd machine set <id> --max-agents <n>|auto` (cap_set with the machine) and `--roles`, `--max-sessions`
/// (machine_roles_set).
pub async fn machine_set_command(argv: &[String]) -> u8 {
    let v = match args::parse(argv, &MACHINE_SET_SPEC) {
        Ok(v) => v,
        Err(message) => return machine_usage(&message),
    };
    let [machine] = v.positionals.as_slice() else {
        return machine_usage(
            "give the machine's id: fleetd machine set <id> --max-agents <n>|auto or --roles agents,sessions",
        );
    };
    let roles = match roles_input(machine, v.str("roles"), v.str("max-sessions")) {
        Ok(roles) => roles,
        Err(message) => return machine_usage(&message),
    };
    let mut input = json!({ "machine": { "machineId": machine } });
    match v.str("max-agents") {
        None if roles.is_some() => input = Value::Null,
        None => return machine_usage("give --max-agents <n>|auto, --roles or --max-sessions"),
        Some("auto") => input["machine"]["auto"] = json!(true),
        Some(_) => match count_of(&v, "max-agents") {
            Ok(n) => input["machine"]["maxAgents"] = json!(n),
            Err(_) => return machine_usage("--max-agents takes a number from 1 to 1000 or auto"),
        },
    }
    let home = match resolve_home(v.str("home")) {
        Ok(h) => h,
        Err(message) => return machine_usage(&message),
    };
    let out = Out {
        tty: std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
    };
    let mut client = match connect_to(&home, v.str("hub"), "fleetd-machine").await {
        Ok(c) => c,
        Err(f) => return out.fail(&Stop(4, f.message, Some(f.fix))),
    };
    if !input.is_null() {
        match call(&mut client, "cap_set", input).await {
            Ok(body) => out.success(body.get("next").and_then(Value::as_str).unwrap_or("Set.")),
            Err(stop) => return out.fail(&stop),
        }
    }
    if let Some(roles) = roles {
        match call(&mut client, "machine_roles_set", roles).await {
            Ok(body) => {
                let line = body.get("machine").map(roles_line).unwrap_or_default();
                match body.get("next").and_then(Value::as_str) {
                    Some(next) => out.success(&format!("{line} {next}")),
                    None => out.success(&line),
                }
            }
            Err(stop) => return out.fail(&stop),
        }
    }
    0
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
            let mut dry = input.clone();
            dry["dryRun"] = json!(true);
            let preview = call(client, "project_add", dry).await?;
            let target = preview.get("clone").cloned().unwrap_or_default();
            let (machine, dest) = (
                s(&target, "/machineId").to_owned(),
                s(&target, "/path").to_owned(),
            );
            if !machine.is_empty() {
                input["machineId"] = json!(machine);
            }
            if out.tty {
                out.info(&describe(preview.get("inspect").unwrap_or(&Value::Null)));
            }
            let same = target.get("sameRemote") == Some(&Value::Bool(true));
            if v.flag("use-existing") {
                input["useExisting"] = json!(true);
            } else if same && v.str("dest").is_none() {
                if !out.tty {
                    return Err(Stop(
                        3,
                        format!("{machine} already has it at {dest}"),
                        Some("Pass --use-existing to add that checkout, or --dest <dir> to clone elsewhere".into()),
                    ));
                }
                let use_it = cliclack::confirm(format!(
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
                input["useExisting"] = json!(true);
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
    let cursor = head.get("cursor").cloned().unwrap_or(json!(0));
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
    let added = follow_clone(client, out, &machine, &path, &add_id, cursor).await?;
    out.info(&describe(
        added.pointer("/data/inspect").unwrap_or(&Value::Null),
    ));
    finish(out)
}

/// Follows a clone's events to its `project.added`, with a progress bar in a terminal; its `project.add_failed` stops.
async fn follow_clone(
    client: &mut McpClient,
    out: &Out,
    machine: &str,
    path: &str,
    add_id: &str,
    mut cursor: Value,
) -> Result<Value, Stop> {
    let bar = out.tty.then(|| {
        let bar = cliclack::progress_bar(100);
        bar.start(format!("Cloning into {} on {machine}", tilde(path)));
        bar
    });
    if !out.tty {
        println!("cloning into {path} on {machine}");
    }
    let mut last_phase = String::new();
    let mut heard = std::time::Instant::now();
    loop {
        if heard.elapsed() > QUIET_LIMIT {
            if let Some(bar) = &bar {
                bar.error("no word from the clone");
            }
            return Err(Stop(
                1,
                format!(
                    "no progress from the clone on {machine} for {} minutes",
                    QUIET_LIMIT.as_secs() / 60
                ),
                Some(format!(
                    "fleetd project list --machine {machine} shows whether it was added; else add it again"
                )),
            ));
        }
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
            heard = std::time::Instant::now();
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
                    let done = format!("{} cloned and added on {machine}", tilde(path));
                    match &bar {
                        Some(bar) => bar.stop(&done),
                        None => println!("✓ {done}"),
                    }
                    return Ok(e.clone());
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
    let next = "Write to its lead in the app's chat, or from any agent with chat_send; the lead starts with the first message.";
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
    fn profile_flags_change_only_their_field() {
        let current = json!({
            "high": { "model": "claude-sonnet-5-5", "effort": "max", "refused": "claude on devbox refused it" },
            "medium": {},
        });
        assert_eq!(profiles_input(&current, &[], None), Ok(None));
        // Setting the model clears its refusal; the effort stays.
        assert_eq!(
            profiles_input(&current, &[("high-model", "claude-fable-5-1")], None),
            Ok(Some(
                json!({ "high": { "model": "claude-fable-5-1", "effort": "max" } })
            ))
        );
        // Changing only the effort passes the refusal back as read, so the hub keeps it.
        let r = json!({ "machineId": "devbox", "projectId": "p1" });
        assert_eq!(
            profiles_input(
                &current,
                &[("high-effort", "default"), ("medium-effort", "low")],
                Some(r.clone())
            ),
            Ok(Some(json!({
                "projectRef": r,
                "high": { "model": "claude-sonnet-5-5", "refused": "claude on devbox refused it" },
                "medium": { "effort": "low" },
            })))
        );
        // Unsetting the model clears it too, whatever order the flags come in.
        assert_eq!(
            profiles_input(
                &current,
                &[("high-effort", "low"), ("high-model", "default")],
                None
            ),
            Ok(Some(json!({ "high": { "effort": "low" } })))
        );
        assert!(profiles_input(&current, &[("medium-effort", "xhigh")], None).is_err());
    }

    #[test]
    fn profiles_read_as_what_runs_and_why() {
        let view = json!({
            "fleet": { "high": { "model": "claude-nope", "effort": "max", "refused": "claude on devbox refused claude-nope" }, "medium": {} },
            "project": { "high": {}, "medium": { "effort": "low" } },
            "runs": { "high": { "model": "claude-opus-5-5", "effort": "max" }, "medium": { "model": "claude-opus-5-5", "effort": "low" } },
            "defaults": { "high": { "model": "claude-opus-5-5", "effort": "high" }, "medium": { "model": "claude-opus-5-5", "effort": "medium" } },
        });
        assert_eq!(
            profiles_lines(&view, true),
            [
                "high    claude-opus-5-5 at max",
                "        fleet: claude-nope at max · this project: unset · own: claude-opus-5-5 at high",
                "        ! claude on devbox refused claude-nope",
                "medium  claude-opus-5-5 at low",
                "        fleet: unset · this project: effort low · own: claude-opus-5-5 at medium",
            ]
        );
    }

    #[test]
    fn machine_roles_read_from_the_command_line() {
        assert_eq!(roles_input("devbox", None, None), Ok(None));
        assert_eq!(
            roles_input("devbox", Some("agents, sessions,agents"), Some("4")),
            Ok(Some(
                json!({ "machineId": "devbox", "roles": ["agents", "sessions"], "maxSessions": 4 })
            ))
        );
        assert_eq!(
            roles_input("mac1", Some("sessions"), Some("auto")),
            Ok(Some(
                json!({ "machineId": "mac1", "roles": ["sessions"], "autoSessions": true })
            ))
        );
        assert!(
            roles_input("devbox", Some("browsers"), None)
                .unwrap_err()
                .contains("not browsers")
        );
        assert!(roles_input("devbox", Some(","), None).is_err());
        assert!(roles_input("devbox", None, Some("65")).is_err());
        assert!(roles_input("devbox", None, Some("0")).is_err());
    }

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
