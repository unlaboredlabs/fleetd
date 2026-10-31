//! `fleetd navi create|list|rename|archive|unarchive`: Navis, personal assistants, from a terminal (navi_create,
//! navi_list, navi_rename and navi_archive). `fleetd chat <machine>/<id> "…"` talks to one.
use std::io::IsTerminal;

use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::hub_key::resolve_home;
use super::mcp_client::McpClient;
use super::project::{Out, Stop, call, s, tilde};
use super::setup::doctor::connect_to;

pub const NAVI_USAGE: &str = "  navi create <name> [--machine <id>] [--hub <url>]
             make a Navi: a personal assistant with its own chat, memory and folder
             (navi/<name> under the machine's fleetd home; the least busy worker by default)
  navi list [--archived] [--machine <id>] [--hub <url>]
  navi rename <machine>/<navi> <name> [--hub <url>]
  navi archive|unarchive <machine>/<navi> [--hub <url>]
             archived, its lead stops and its chat, memory and folder stay; <navi> is
             its id or its name
";

const SPEC: Spec = Spec {
    options: &[
        ("machine", Kind::Str),
        ("archived", Kind::Bool),
        ("hub", Kind::Str),
    ],
    positionals: true,
};

fn usage(message: &str) -> u8 {
    eprint!("fleetd: {message}\n\nusage:\n{NAVI_USAGE}");
    2
}

pub async fn navi_command(argv: &[String]) -> u8 {
    let Some(verb) = argv.first().map(String::as_str) else {
        return usage("missing navi command");
    };
    let v = match args::parse(&argv[1..], &SPEC) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    let home = match resolve_home(None) {
        Ok(h) => h,
        Err(message) => return usage(&message),
    };
    let out = Out {
        tty: std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
    };
    let mut client = match connect_to(&home, v.str("hub"), "fleetd-navi").await {
        Ok(c) => c,
        Err(f) => return out.fail(&Stop(4, f.message, Some(f.fix))),
    };
    let result = match verb {
        "create" => create(&mut client, &out, &v).await,
        "list" => list(&mut client, &v).await,
        "rename" => rename(&mut client, &out, &v).await,
        "archive" => archive(&mut client, &out, &v, true).await,
        "unarchive" => archive(&mut client, &out, &v, false).await,
        other => return usage(&format!("unknown navi command '{other}'")),
    };
    match result {
        Ok(()) => 0,
        Err(stop) if stop.0 == 2 => usage(&stop.1),
        Err(stop) => out.fail(&stop),
    }
}

/// `<machine>/<id>`, as `fleetd chat` names a project.
fn at(navi: &Value) -> String {
    format!("{}/{}", s(navi, "/machineId"), s(navi, "/projectId"))
}

async fn create(client: &mut McpClient, out: &Out, v: &args::Parsed) -> Result<(), Stop> {
    let name = v.positionals.join(" ");
    if name.trim().is_empty() {
        return Err(Stop(
            2,
            "give the Navi a name: fleetd navi create Ada".into(),
            None,
        ));
    }
    let body = call(
        client,
        "navi_create",
        json!({ "name": name.trim(), "machineId": v.str("machine") }),
    )
    .await?;
    let navi = &body["navi"];
    out.success(&format!(
        "{} is ready on {}, in {}",
        s(navi, "/title"),
        s(navi, "/machineId"),
        tilde(s(navi, "/workspaceRoot"))
    ));
    out.info(&format!(
        "Say hello in the app, or: fleetd chat {} \"hello\" --key-file <your human key>",
        at(navi)
    ));
    Ok(())
}

async fn list(client: &mut McpClient, v: &args::Parsed) -> Result<(), Stop> {
    let body = call(
        client,
        "navi_list",
        json!({ "machineId": v.str("machine"), "archived": v.flag("archived") }),
    )
    .await?;
    let navis = body["navis"].as_array().cloned().unwrap_or_default();
    if navis.is_empty() {
        println!("No Navis yet: fleetd navi create <name>");
    }
    for n in &navis {
        let archived = if n.get("archivedAt").is_some() {
            "  (archived)"
        } else {
            ""
        };
        println!(
            "{}  {}  {}{archived}",
            at(n),
            s(n, "/title"),
            tilde(s(n, "/workspaceRoot"))
        );
    }
    Ok(())
}

/// The Navi a `<machine>/<id or name>` argument names.
async fn find(client: &mut McpClient, target: Option<&String>) -> Result<Value, Stop> {
    let Some(target) = target else {
        return Err(Stop(
            2,
            "give the Navi as <machine>/<id or name>".into(),
            None,
        ));
    };
    let Some((machine, which)) = target.split_once('/') else {
        return Err(Stop(2, format!("'{target}' is not <machine>/<navi>"), None));
    };
    let body = call(
        client,
        "navi_list",
        json!({ "machineId": machine, "archived": true }),
    )
    .await?;
    let navis = body["navis"].as_array().cloned().unwrap_or_default();
    let by_name: Vec<&Value> = navis.iter().filter(|n| s(n, "/title") == which).collect();
    navis
        .iter()
        .find(|n| s(n, "/projectId") == which)
        .or_else(|| (by_name.len() == 1).then(|| by_name[0]))
        .cloned()
        .ok_or_else(|| {
            Stop(
                3,
                format!("no single Navi '{which}' on {machine}"),
                Some(format!(
                    "fleetd navi list --archived --machine {machine} shows their ids"
                )),
            )
        })
}

fn key(navi: &Value) -> Value {
    json!({ "machineId": s(navi, "/machineId"), "projectId": s(navi, "/projectId") })
}

async fn rename(client: &mut McpClient, out: &Out, v: &args::Parsed) -> Result<(), Stop> {
    let navi = find(client, v.positionals.first()).await?;
    let name = v.positionals[1..].join(" ");
    if name.trim().is_empty() {
        return Err(Stop(
            2,
            "give its new name: fleetd navi rename <machine>/<navi> <name>".into(),
            None,
        ));
    }
    let mut input = key(&navi);
    input["name"] = json!(name.trim());
    call(client, "navi_rename", input).await?;
    out.success(&format!("{} is now {}", s(&navi, "/title"), name.trim()));
    Ok(())
}

async fn archive(
    client: &mut McpClient,
    out: &Out,
    v: &args::Parsed,
    archived: bool,
) -> Result<(), Stop> {
    let navi = find(client, v.positionals.first()).await?;
    let mut input = key(&navi);
    input["archived"] = json!(archived);
    call(client, "navi_archive", input).await?;
    let title = s(&navi, "/title");
    out.success(&if archived {
        format!("{title} is archived; its chat, memory and folder stay")
    } else {
        format!("{title} is back; its lead starts with your next message")
    });
    Ok(())
}
