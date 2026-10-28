//! `fleetd github-app`: the hub's own GitHub App (D190) from a terminal on the hub machine, for a hub with no desktop
//! app at hand. Like `fleetd invite`, it opens the hub home's database directly, so the running hub picks the App up at
//! its next GitHub call. `create` serves the manifest page on a loopback port, as the desktop app does, and trades
//! GitHub's code for the App's keys, which go straight into the hub's sealed row.
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Query, State};
use axum::response::Html;
use axum::routing::get;
use fleetd_contracts::github_app::GithubApp;
use tokio::sync::mpsc;

use super::args::{self, Kind, Spec};
use super::hub_key::resolve_home;
use super::setup::machine::{local_host_name, machine_id_from_host};
use super::setup::state::read_setup;
use crate::clock::SystemClock;
use crate::hub::github_app::{GithubApps, manifest, new_app_page};
use crate::hub::store::HubDb;

pub const GITHUB_APP_USAGE: &str = r#"  github-app [--home <dir>]
             the hub's own GitHub App: where it is installed and its last test
  github-app create [--org <org>] [--name <name>] [--port <port>] [--home <dir>]
             make it on GitHub with nothing to paste: opens a page on this machine
             (127.0.0.1) that sends GitHub the App's manifest; press Create on GitHub and
             the hub keeps its keys, sealed. From another computer, forward the port first:
             ssh -L <port>:127.0.0.1:<port> <this machine>
  github-app test [--home <dir>]
             mint a token for each installation and say where the App reaches
  github-app remove [--home <dir>]
             forget it; the hub's gh goes back to this machine's own login
"#;

/// How long GitHub's form may take: reading it, renaming the App, signing in.
const WAIT: Duration = Duration::from_secs(15 * 60);

fn usage(message: &str) -> u8 {
    eprint!("fleetd: {message}\n\nusage:\n{GITHUB_APP_USAGE}");
    2
}

fn open(home: Option<&str>) -> Result<(Arc<GithubApps>, std::path::PathBuf), String> {
    let home = resolve_home(home)?;
    let db = HubDb::open(&home).map_err(|e| e.to_string())?;
    Ok((
        GithubApps::new(db, home.clone(), Arc::new(SystemClock)),
        home,
    ))
}

pub async fn github_app_command(argv: &[String]) -> u8 {
    let spec = Spec {
        options: &[
            ("home", Kind::Str),
            ("org", Kind::Str),
            ("name", Kind::Str),
            ("port", Kind::Str),
        ],
        positionals: true,
    };
    let v = match args::parse(argv, &spec) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    let (apps, home) = match open(v.str("home")) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("fleetd: {e}");
            return 1;
        }
    };
    let result = match v.positionals.first().map(String::as_str) {
        None => show(&apps).map(|()| 0),
        Some("create") => {
            if let Some(org) = v.str("org")
                && fleetd_contracts::github_app::GithubLogin::new(org).is_err()
            {
                return usage("--org takes an organization's login, as in github.com/<login>");
            }
            let port = match v.str("port").map(str::parse::<u16>).transpose() {
                Ok(p) => p.unwrap_or(0),
                Err(_) => return usage("--port takes a port number"),
            };
            create(&apps, &home, v.str("org"), v.str("name"), port).await
        }
        Some("test") => test(&apps).await,
        Some("remove") => remove(&apps).await,
        Some(other) => return usage(&format!("unknown github-app command '{other}'")),
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("fleetd: {e}");
            1
        }
    }
}

fn describe(app: &GithubApp) {
    println!(
        "{} ({}), owned by {}",
        app.name, app.settings_url, app.owner
    );
    if app.installations.is_empty() {
        println!("  not installed yet: {}", install_link(app));
    }
    for i in &app.installations {
        let reach = if i.all_repositories {
            format!("all {} repositories", i.repository_count)
        } else {
            format!("{} chosen repositories", i.repository_count)
        };
        println!("  installed on {}: {reach}", i.account);
    }
    if let Some(t) = &app.last_test {
        println!("  last test {}: {}", t.at.0, t.said);
    }
}

fn install_link(app: &GithubApp) -> String {
    format!("https://github.com/apps/{}/installations/new", app.slug)
}

fn show(apps: &GithubApps) -> Result<(), String> {
    match apps_get(apps)? {
        Some(app) => describe(&app),
        None => println!(
            "This hub has no GitHub App yet: `fleetd github-app create`, or Administration › Connections › GitHub in the app.\n\
             Until then the hub's gh uses this machine's own login."
        ),
    }
    Ok(())
}

fn apps_get(apps: &GithubApps) -> Result<Option<GithubApp>, String> {
    apps.get().map_err(|e| e.to_string())
}

async fn test(apps: &GithubApps) -> Result<u8, String> {
    let app = apps
        .test()
        .await?
        .ok_or("this hub has no GitHub App yet: `fleetd github-app create`")?;
    describe(&app);
    Ok(if app.last_test.is_some_and(|t| t.ok) {
        0
    } else {
        1
    })
}

async fn remove(apps: &GithubApps) -> Result<u8, String> {
    let app = apps.remove().await?.ok_or("this hub has no GitHub App")?;
    println!(
        "Forgot {}. GitHub keeps it until you delete it there: {}/advanced",
        app.name, app.settings_url
    );
    Ok(0)
}

/// The page the browser opens first: it posts the manifest to GitHub at once, with a button in case scripts are off.
pub fn post_page(post_to: &str, state: &str, manifest: &str) -> String {
    let escape = |t: &str| {
        t.replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>fleetd</title>\
         <body style=\"font:14px/1.5 system-ui,sans-serif;color:#444;margin:3rem\">\
         <form id=\"f\" method=\"post\" action=\"{}?state={}\">\
         <input type=\"hidden\" name=\"manifest\" value=\"{}\">\
         <p>Taking you to GitHub to create the hub's App…</p><button>Continue to GitHub</button></form>\
         <script>document.getElementById('f').submit()</script></body>",
        escape(post_to),
        escape(state),
        escape(manifest)
    )
}

/// The page the browser lands on after GitHub.
fn landing(title: &str, line: &str) -> Html<String> {
    Html(format!(
        "<!doctype html><meta charset=\"utf-8\"><title>fleetd</title>\
         <body style=\"font:14px/1.5 system-ui,sans-serif;color:#444;margin:3rem\">\
         <p style=\"font-weight:600;color:#111\">{title}</p><p>{line}</p></body>"
    ))
}

#[derive(Clone)]
struct Page {
    html: Arc<String>,
    state: Arc<String>,
    code: mpsc::Sender<String>,
    taken: Arc<Mutex<bool>>,
}

#[derive(serde::Deserialize)]
struct Back {
    code: Option<String>,
    state: Option<String>,
}

async fn start(State(p): State<Page>) -> Html<String> {
    Html(p.html.to_string())
}

async fn created(State(p): State<Page>, Query(back): Query<Back>) -> Html<String> {
    if back.state.as_deref() != Some(p.state.as_str()) {
        return landing(
            "This isn't fleetd's page",
            "Go back to the terminal and run it again.",
        );
    }
    // The same check github_app_create's input makes.
    let Some(code) = back
        .code
        .filter(|c| fleetd_contracts::github_app::GithubManifestCode::new(c.as_str()).is_ok())
    else {
        return landing(
            "No App was created",
            "GitHub sent no code. Go back to the terminal.",
        );
    };
    {
        let mut taken = p.taken.lock().unwrap_or_else(|e| e.into_inner());
        if *taken {
            return landing("Already done", "Go back to the terminal.");
        }
        *taken = true;
    }
    let _ = p.code.send(code).await;
    landing(
        "The App is created",
        "fleetd keeps its keys on the hub. You can close this tab and go back to the terminal.",
    )
}

async fn create(
    apps: &GithubApps,
    home: &Path,
    org: Option<&str>,
    name: Option<&str>,
    port: u16,
) -> Result<u8, String> {
    let setup = read_setup(home).ok().flatten();
    let hub_url = setup
        .as_ref()
        .map(|s| s.url.clone())
        .unwrap_or_else(|| "http://127.0.0.1:4790".into());
    let name = match name {
        Some(n) => n.to_owned(),
        None => format!(
            "fleetd on {}",
            setup
                .and_then(|s| s
                    .machines
                    .into_iter()
                    .find(|(_, m)| m.local)
                    .map(|(id, _)| id))
                .unwrap_or_else(|| machine_id_from_host(&local_host_name()))
        ),
    };
    let name: String = name.chars().take(34).collect();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("can't listen on 127.0.0.1:{port}: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/created");
    let state = crate::hub::auth::secret("s_");
    let post_to = new_app_page(&apps.endpoints().web, org);
    let page = post_page(
        &post_to,
        &state,
        &manifest(&name, &hub_url, &redirect).to_string(),
    );
    let (tx, mut rx) = mpsc::channel(1);
    let router = Router::new()
        .route("/", get(start))
        .route("/created", get(created))
        .with_state(Page {
            html: Arc::new(page),
            state: Arc::new(state),
            code: tx,
            taken: Arc::default(),
        });
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let link = format!("http://127.0.0.1:{port}/");
    println!(
        "Creating \"{name}\" on GitHub{}.",
        org.map(|o| format!(" in {o}")).unwrap_or_default()
    );
    println!("Open {link} in a browser on this machine, then press Create on GitHub's page.");
    println!(
        "From another computer: ssh -L {port}:127.0.0.1:{port} <this machine>, then open it there."
    );
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(opener)
        .arg(&link)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let code = tokio::time::timeout(WAIT, rx.recv()).await;
    // The landing page is sent before the server goes.
    tokio::time::sleep(Duration::from_millis(200)).await;
    server.abort();
    let code = match code {
        Ok(Some(c)) => c,
        _ => return Err("GitHub didn't send the App back within 15 minutes; run it again".into()),
    };
    let app = apps.create(&code).await?;
    println!(
        "✓ The hub has its GitHub App: {} ({})",
        app.name, app.html_url
    );
    println!(
        "Next: install it on the repositories fleetd works on, {}\nthen run `fleetd github-app test`.",
        install_link(&app)
    );
    Ok(0)
}
