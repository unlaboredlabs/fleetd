use std::os::unix::fs::PermissionsExt;

use fleetd_contracts::ids::ProjectId;
use fleetd_contracts::mcp_servers::McpRoles;
use serde_json::json;

use super::*;
use crate::node::identity::load_or_create_box_key;
use crate::node::project_env::seal;

const TOKEN: &str = "ghp_node_only_token";
const DB_PASSWORD: &str = "pg-node-only-password";

fn name(n: &str) -> McpServerName {
    McpServerName::new(n).unwrap()
}

fn value_name(n: &str) -> fleetd_contracts::mcp_servers::McpValueName {
    fleetd_contracts::mcp_servers::McpValueName::new(n).unwrap()
}

fn project() -> McpSecretScope {
    McpSecretScope::Project {
        project_id: ProjectId::unchecked("p1"),
    }
}

/// A hub-wide HTTP server for leads and writers with a secret header, and a project's stdio server for reviewers with
/// a secret env variable: what a launch carries, no secret's value in it.
fn config(user_servers: bool) -> McpSessionConfig {
    serde_json::from_value(json!({
        "userServers": user_servers,
        "servers": [
            { "name": "github", "secrets": { "kind": "global" },
              "roles": { "lead": true, "writers": true, "reviewers": false },
              "transport": { "type": "http", "url": "https://api.example.com/mcp" },
              "headers": [
                  { "kind": "secret", "name": "Authorization" },
                  { "kind": "plain", "name": "X-Team", "value": "core" }
              ] },
            { "name": "db", "secrets": { "kind": "project", "projectId": "p1" },
              "roles": { "lead": false, "writers": false, "reviewers": true },
              "transport": { "type": "stdio", "command": "db-mcp", "args": ["--read-only"] },
              "env": [
                  { "kind": "secret", "name": "DB_PASSWORD" },
                  { "kind": "plain", "name": "DB_HOST", "value": "localhost" }
              ] }
        ]
    }))
    .unwrap()
}

fn sealed_both(home: &Path) {
    let key = load_or_create_box_key(home).unwrap();
    apply(
        home,
        &McpSecretScope::Global,
        &name("github"),
        &[McpSecretSet {
            field: McpField::Header,
            name: value_name("Authorization"),
            sealed: seal(home, &format!("Bearer {TOKEN}")),
        }],
        &[],
        Some(&key),
    )
    .unwrap();
    apply(
        home,
        &project(),
        &name("db"),
        &[McpSecretSet {
            field: McpField::Env,
            name: value_name("DB_PASSWORD"),
            sealed: seal(home, DB_PASSWORD),
        }],
        &[],
        Some(&key),
    )
    .unwrap();
}

fn fleetd() -> Value {
    json!({ "type": "stdio", "command": "/usr/local/bin/fleetd", "args": ["agent-mcp", "--role", "worker"] })
}

fn written(home: &Path, role: McpAgentRole, user_servers: bool) -> (Value, SessionMcp) {
    let kept = Kept {
        role,
        config: config(user_servers),
    };
    let mcp = session_config(home, None, Some(&kept), Some(fleetd()), "s1");
    (serde_json::from_str(&mcp.json).unwrap(), mcp)
}

#[test]
fn each_role_gets_its_servers_with_secrets_resolved_here_and_fleetds_own_last() {
    let home = tempfile::tempdir().unwrap();
    sealed_both(home.path());

    // A writer: the global HTTP server with its header resolved, and fleetd's own; not the reviewers' db.
    let (writer, mcp) = written(home.path(), McpAgentRole::Writer, true);
    assert_eq!(
        writer,
        json!({ "mcpServers": {
            "github": { "type": "http", "url": "https://api.example.com/mcp",
                        "headers": { "Authorization": format!("Bearer {TOKEN}"), "X-Team": "core" } },
            "fleetd": fleetd(),
        }})
    );
    assert!(!mcp.strict);
    assert_eq!(
        mcp.secrets,
        [("github.Authorization".to_owned(), format!("Bearer {TOKEN}"))]
    );

    // A reviewer: the project's stdio server with its env, and fleetd's own.
    let (reviewer, _) = written(home.path(), McpAgentRole::Reviewer, true);
    assert_eq!(
        reviewer,
        json!({ "mcpServers": {
            "db": { "type": "stdio", "command": "db-mcp", "args": ["--read-only"],
                    "env": { "DB_PASSWORD": DB_PASSWORD, "DB_HOST": "localhost" } },
            "fleetd": fleetd(),
        }})
    );

    // The lead gets github only.
    let (lead, _) = written(home.path(), McpAgentRole::Lead, true);
    let names: Vec<&String> = lead["mcpServers"].as_object().unwrap().keys().collect();
    assert_eq!(names.len(), 2);
    assert!(lead["mcpServers"]["github"].is_object() && lead["mcpServers"]["db"].is_null());
}

#[test]
fn with_the_persons_own_servers_off_fleetds_tools_are_still_there() {
    let home = tempfile::tempdir().unwrap();
    sealed_both(home.path());
    let (config, mcp) = written(home.path(), McpAgentRole::Writer, false);
    assert!(mcp.strict, "--strict-mcp-config");
    assert_eq!(config["mcpServers"]["fleetd"], fleetd());
    assert!(config["mcpServers"]["github"].is_object());
}

#[test]
fn a_server_called_fleetd_never_replaces_fleetds_own() {
    let home = tempfile::tempdir().unwrap();
    let mut config = config(true);
    // An older hub, or a hand-edited file: the name is refused on save, and left out here too.
    config.servers[0].name = McpServerName::unchecked("fleetd");
    config.servers[0].headers.clear();
    let kept = Kept {
        role: McpAgentRole::Writer,
        config,
    };
    let mcp = session_config(home.path(), None, Some(&kept), Some(fleetd()), "s1");
    let written: Value = serde_json::from_str(&mcp.json).unwrap();
    assert_eq!(written, json!({ "mcpServers": { "fleetd": fleetd() } }));
}

#[test]
fn a_server_whose_secret_isnt_here_is_left_out_and_a_plain_thread_gets_none() {
    let home = tempfile::tempdir().unwrap();
    let (writer, mcp) = written(home.path(), McpAgentRole::Writer, true);
    assert_eq!(writer, json!({ "mcpServers": { "fleetd": fleetd() } }));
    assert!(mcp.secrets.is_empty());
    // A plain thread: no kept servers, no fleetd tools, the person's own servers as before.
    let plain = session_config(home.path(), None, None, None, "s1");
    assert_eq!(&*plain.json, "{\"mcpServers\":{}}\n");
    assert!(!plain.strict);
}

#[test]
fn secrets_are_kept_privately_replaced_whole_and_named_never_shown() {
    let home = tempfile::tempdir().unwrap();
    let key = load_or_create_box_key(home.path()).unwrap();
    sealed_both(home.path());
    let path = home.path().join(relative(&McpSecretScope::Global));
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(&home.path().join(DIR)), 0o700);
    assert_eq!(mode(&home.path().join(DIR).join("projects")), 0o700);

    // Keeping it answers its fingerprint again; a set of nothing else drops the rest.
    let kept = apply(
        home.path(),
        &McpSecretScope::Global,
        &name("github"),
        &[],
        &[McpSecretKey {
            field: McpField::Header,
            name: value_name("Authorization"),
        }],
        Some(&key),
    )
    .unwrap();
    assert_eq!(
        kept[0].fingerprint.as_str(),
        fingerprint_of(format!("Bearer {TOKEN}").as_bytes())
    );
    assert!(!format!("{kept:?}").contains(TOKEN));

    // Sealed to another machine: refused naming the value, and nothing changes.
    let other = tempfile::tempdir().unwrap();
    let error = apply(
        home.path(),
        &McpSecretScope::Global,
        &name("github"),
        &[McpSecretSet {
            field: McpField::Header,
            name: value_name("Authorization"),
            sealed: seal(other.path(), "hunter2-other"),
        }],
        &[],
        Some(&key),
    )
    .unwrap_err();
    assert!(
        error.contains("Authorization") && !error.contains("hunter2"),
        "{error}"
    );
    assert_eq!(
        written(home.path(), McpAgentRole::Writer, true)
            .1
            .secrets
            .len(),
        1
    );

    // A header can't hold a line break.
    let error = apply(
        home.path(),
        &McpSecretScope::Global,
        &name("github"),
        &[McpSecretSet {
            field: McpField::Header,
            name: value_name("Authorization"),
            sealed: seal(home.path(), "a\r\nX-Evil: 1"),
        }],
        &[],
        Some(&key),
    )
    .unwrap_err();
    assert!(error.contains("line break"), "{error}");

    // Forgetting the server, then the project, removes the files.
    apply(
        home.path(),
        &McpSecretScope::Global,
        &name("github"),
        &[],
        &[],
        Some(&key),
    )
    .unwrap();
    assert!(!path.exists());
    forget(home.path(), "p1");
    assert!(!home.path().join(relative(&project())).exists());
}

#[test]
fn a_sessions_servers_are_kept_for_its_next_start_and_masked() {
    let home = tempfile::tempdir().unwrap();
    sealed_both(home.path());
    let dir = home.path().join("sessions").join("s1");
    assert!(kept(&dir).is_none());
    let k = Kept {
        role: McpAgentRole::Reviewer,
        config: config(true),
    };
    keep(&dir, &k).unwrap();
    assert_eq!(kept(&dir), Some(k));
    assert_eq!(
        secrets(home.path(), &dir),
        [("db.DB_PASSWORD".to_owned(), DB_PASSWORD.to_owned())]
    );
    let roles = McpRoles {
        reviewers: true,
        ..Default::default()
    };
    assert!(roles.has(McpAgentRole::Reviewer));
}

/// fleetd's own Google server, as the hub gives it to a Navi with an account: the node runs its own binary with its home,
/// the project and its folder, and the config holds no token; without tokens on the node it is left out.
#[test]
fn a_navi_lead_gets_the_native_google_server_with_no_token_in_its_config() {
    let home = tempfile::tempdir().unwrap();
    let kept = Kept {
        role: McpAgentRole::Lead,
        config: serde_json::from_value(json!({
            "userServers": false,
            "servers": [{ "name": "google", "secrets": { "kind": "project", "projectId": "p1" },
                "roles": { "lead": true, "writers": false, "reviewers": false },
                "transport": { "type": "stdio", "command": "fleetd", "args": ["google-mcp"] } }]
        }))
        .unwrap(),
    };
    let none = session_config(home.path(), None, Some(&kept), None, "s1");
    let config: Value = serde_json::from_str(&none.json).unwrap();
    assert_eq!(config["mcpServers"], json!({}));

    let tokens = crate::node::google::account_path(home.path(), "p1");
    std::fs::create_dir_all(tokens.parent().unwrap()).unwrap();
    std::fs::write(&tokens, r#"{"refreshToken":"1//never-in-config"}"#).unwrap();
    let folder = home.path().join("navi");
    let mcp = session_config(home.path(), Some(&folder), Some(&kept), None, "s1");
    assert!(!mcp.json.contains("never-in-config"));
    assert!(mcp.secrets.is_empty());
    let config: Value = serde_json::from_str(&mcp.json).unwrap();
    let google = &config["mcpServers"]["google"];
    assert_eq!(google["type"], "stdio");
    assert_ne!(google["command"], "fleetd");
    assert_eq!(
        google["args"],
        json!([
            "google-mcp",
            "--home",
            home.path().to_string_lossy(),
            "--project",
            "p1",
            "--folder",
            folder.to_string_lossy()
        ])
    );
    assert_eq!(google["env"], json!({}));
}
