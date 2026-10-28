//! The MCP servers fleetd configures for its agents, on the node: their secrets (`mcp_secrets`), kept as a project's
//! secret variables are (project_env.rs) in `<node home>/mcp-secrets/global.json` and
//! `<node home>/mcp-secrets/projects/<project>.json`; each session's servers as its launch or a later send gave them,
//! in `<session dir>/mcp-servers.json`; and the `--mcp-config` the node writes for each start of a session's claude,
//! fleetd's own tools server always in it and last, so nothing replaces it. A secret is opened with the node's box key,
//! files are written atomically at mode 0600 in 0700 directories, plaintext buffers are wiped, and errors name a
//! value, never show it.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::mcp_servers::{
    McpAgentRole, McpField, McpSecretKey, McpSecretSaved, McpSecretScope, McpSecretSet,
    McpServerName, McpSessionConfig, McpSessionServer, McpSessionValue, McpTransport,
};
use fleetd_contracts::project_settings::ENV_VALUE_MAX_BYTES;
use fleetd_contracts::secrets::SecretFingerprint;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use zeroize::{Zeroize, Zeroizing};

use super::identity::NodeBoxKey;
use super::secrets::{fingerprint_of, write_atomic};

const DIR: &str = "mcp-secrets";

/// One `apply` at a time: each reads its file, changes it and writes it back.
static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Each server's secrets, by `env/NAME` or `header/NAME`.
#[derive(Default, Serialize, Deserialize)]
struct SecretsFile {
    servers: BTreeMap<String, BTreeMap<String, Secret>>,
}

#[derive(Serialize, Deserialize)]
struct Secret {
    value: String,
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

fn key(field: McpField, name: &str) -> String {
    match field {
        McpField::Env => format!("env/{name}"),
        McpField::Header => format!("header/{name}"),
    }
}

fn relative(scope: &McpSecretScope) -> PathBuf {
    match scope {
        McpSecretScope::Global => PathBuf::from(DIR).join("global.json"),
        McpSecretScope::Project { project_id } => PathBuf::from(DIR)
            .join("projects")
            .join(format!("{project_id}.json")),
    }
}

fn read_file(home: &Path, scope: &McpSecretScope) -> std::io::Result<SecretsFile> {
    let text = match std::fs::read(home.join(relative(scope))) {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(SecretsFile::default()),
        Err(e) => return Err(e),
    };
    serde_json::from_slice(&text).map_err(|_| std::io::Error::other("the file does not parse"))
}

fn io_why(error: &std::io::Error) -> String {
    super::util::errno_name(error).unwrap_or_else(|| error.to_string())
}

/// Applies one `mcp_secrets`: afterwards the server's secrets are those in `set` and those in `keep` it had, all or
/// nothing. Returns the fingerprint of each it holds.
pub fn apply(
    home: &Path,
    scope: &McpSecretScope,
    server: &McpServerName,
    set: &[McpSecretSet],
    keep: &[McpSecretKey],
    box_key: Option<&NodeBoxKey>,
) -> Result<Vec<McpSecretSaved>, String> {
    let shown = relative(scope).display().to_string();
    let _writing = WRITING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut file =
        read_file(home, scope).map_err(|e| format!("cannot read {shown}: {}", io_why(&e)))?;
    let mut had = file.servers.remove(server.as_str()).unwrap_or_default();
    let mut now: BTreeMap<String, Secret> = BTreeMap::new();
    let mut saved = Vec::new();
    for k in keep {
        if let Some(secret) = had.remove(&key(k.field, &k.name)) {
            saved.push(McpSecretSaved {
                field: k.field,
                name: k.name.clone(),
                fingerprint: SecretFingerprint::unchecked(fingerprint_of(secret.value.as_bytes())),
            });
            now.insert(key(k.field, &k.name), secret);
        }
    }
    for change in set {
        let name = &change.name;
        let Some(box_key) = box_key else {
            return Err("this node takes no secrets: it has no box key".to_owned());
        };
        let boxed = Zeroizing::new(B64.decode(change.sealed.as_str()).unwrap_or_default());
        let Some(plain) = box_key.open(&boxed) else {
            return Err(format!(
                "{server}'s {name} was not sealed to this machine's current box key: seal it to its boxPubKey again"
            ));
        };
        if plain.is_empty() {
            return Err(format!("{server}'s {name} is empty"));
        }
        if plain.len() > ENV_VALUE_MAX_BYTES {
            return Err(format!("{server}'s {name} is over 64 KiB"));
        }
        if plain.contains(&0) {
            return Err(format!("{server}'s {name} holds a NUL character"));
        }
        // A header can't hold a line break.
        if change.field == McpField::Header && plain.iter().any(|b| *b == b'\r' || *b == b'\n') {
            return Err(format!("{server}'s header {name} holds a line break"));
        }
        let Ok(value) = std::str::from_utf8(&plain) else {
            return Err(format!("{server}'s {name} is not UTF-8 text"));
        };
        saved.push(McpSecretSaved {
            field: change.field,
            name: name.clone(),
            fingerprint: SecretFingerprint::unchecked(fingerprint_of(&plain)),
        });
        now.insert(
            key(change.field, name),
            Secret {
                value: value.to_owned(),
            },
        );
    }
    if !now.is_empty() {
        file.servers.insert(server.to_string(), now);
    }
    let path = home.join(relative(scope));
    if let Some(dir) = path.parent() {
        super::config::mkdir_private(dir)
            .map_err(|e| format!("cannot make {}: {}", dir.display(), io_why(&e)))?;
    }
    if file.servers.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("cannot remove {shown}: {}", io_why(&e)))
            }
            _ => Ok(saved),
        };
    }
    let bytes = Zeroizing::new(serde_json::to_vec(&file).map_err(|e| e.to_string())?);
    write_atomic(&path, &bytes).map_err(|e| format!("cannot write {shown}: {}", io_why(&e)))?;
    Ok(saved)
}

/// Deletes a project's secrets file, when its project goes.
pub fn forget(home: &Path, project_id: &str) {
    let scope = McpSecretScope::Project {
        project_id: fleetd_contracts::ids::ProjectId::unchecked(project_id),
    };
    if let Err(e) = std::fs::remove_file(home.join(relative(&scope)))
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(project_id, "MCP secrets not removed: {}", io_why(&e));
    }
}

/// A session's servers as the node keeps them between its starts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    pub role: McpAgentRole,
    pub config: McpSessionConfig,
}

const KEPT: &str = "mcp-servers.json";

/// Keeps a session's servers in its directory for its next start.
pub fn keep(dir: &Path, kept: &Kept) -> std::io::Result<()> {
    super::config::mkdir_private(dir)?;
    let bytes = serde_json::to_vec(kept).map_err(std::io::Error::other)?;
    write_atomic(&dir.join(KEPT), &bytes)
}

/// The servers a session was given; none for a plain thread or a session from before MCP servers.
pub fn kept(dir: &Path) -> Option<Kept> {
    let bytes = std::fs::read(dir.join(KEPT)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// A server with its secrets resolved: what claude gets.
pub struct Resolved {
    pub name: String,
    pub transport: McpTransport,
    /// Env (stdio) or headers (HTTP, SSE), `(name, value)`.
    pub values: Vec<(String, String)>,
    /// Its secrets, `(<server>.<NAME>, value)`, for masking.
    pub secrets: Vec<(String, String)>,
}

impl Drop for Resolved {
    fn drop(&mut self) {
        for (_, v) in self.values.iter_mut().chain(self.secrets.iter_mut()) {
            v.zeroize();
        }
    }
}

impl Resolved {
    /// The server's entry in claude's `mcpServers`.
    pub fn entry(&self) -> Value {
        let values: Map<String, Value> = self
            .values
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        match &self.transport {
            McpTransport::Stdio { command, args } => json!({
                "type": "stdio",
                "command": command.as_str(),
                "args": args.iter().map(|a| a.as_str()).collect::<Vec<_>>(),
                "env": values,
            }),
            McpTransport::Http { url } => {
                json!({ "type": "http", "url": url.as_str(), "headers": values })
            }
            McpTransport::Sse { url } => {
                json!({ "type": "sse", "url": url.as_str(), "headers": values })
            }
        }
    }
}

/// `server` with each secret's value from the node's files, or the names of those it doesn't hold.
pub fn resolve(home: &Path, server: &McpSessionServer) -> Result<Resolved, Vec<String>> {
    let file = match read_file(home, &server.secrets) {
        Ok(file) => file,
        Err(e) => {
            tracing::warn!(server = %server.name, "MCP secrets not read: {}", io_why(&e));
            SecretsFile::default()
        }
    };
    let held = file.servers.get(server.name.as_str());
    let field = if server.transport.is_stdio() {
        McpField::Env
    } else {
        McpField::Header
    };
    let list = match field {
        McpField::Env => &server.env,
        McpField::Header => &server.headers,
    };
    let mut resolved = Resolved {
        name: server.name.to_string(),
        transport: server.transport.clone(),
        values: Vec::new(),
        secrets: Vec::new(),
    };
    let mut missing = Vec::new();
    for v in list {
        match v {
            McpSessionValue::Plain { name, value } => {
                resolved.values.push((name.to_string(), value.to_string()));
            }
            McpSessionValue::Secret { name } => match held.and_then(|h| h.get(&key(field, name))) {
                Some(secret) => {
                    resolved
                        .values
                        .push((name.to_string(), secret.value.clone()));
                    resolved
                        .secrets
                        .push((format!("{}.{name}", server.name), secret.value.clone()));
                }
                None => missing.push(name.to_string()),
            },
        }
    }
    if missing.is_empty() {
        Ok(resolved)
    } else {
        Err(missing)
    }
}

/// The secrets of a session's servers as the node holds them now, for masking what it reports.
pub fn secrets(home: &Path, dir: &Path) -> Vec<(String, String)> {
    let Some(kept) = kept(dir) else {
        return Vec::new();
    };
    kept.config
        .servers
        .iter()
        .filter(|s| s.roles.has(kept.role))
        .filter_map(|s| resolve(home, s).ok())
        .flat_map(|r| r.secrets.clone())
        .collect()
}

/// The entry for fleetd's own Google server (`fleetd google-mcp`, as the hub gives it for a Navi with an account):
/// this node's binary, told where its home is, whose tokens to read and the folder its email attaches files from;
/// `Some(None)` when the node holds no tokens for the project. None for any other server.
fn native_google(
    home: &Path,
    folder: Option<&Path>,
    server: &McpSessionServer,
) -> Option<Option<Value>> {
    use fleetd_contracts::google::{GOOGLE_MCP_ARG, GOOGLE_SERVER};
    let McpTransport::Stdio { command, args } = &server.transport else {
        return None;
    };
    let McpSecretScope::Project { project_id } = &server.secrets else {
        return None;
    };
    let native = server.name.as_str() == GOOGLE_SERVER
        && command.as_str() == "fleetd"
        && args.len() == 1
        && args[0].as_str() == GOOGLE_MCP_ARG;
    if !native {
        return None;
    }
    if !super::google::connected(home, project_id.as_str()) {
        return Some(None);
    }
    let mut args = vec![
        GOOGLE_MCP_ARG.to_owned(),
        "--home".into(),
        home.to_string_lossy().into_owned(),
        "--project".into(),
        project_id.to_string(),
    ];
    if let Some(folder) = folder {
        args.extend(["--folder".into(), folder.to_string_lossy().into_owned()]);
    }
    Some(Some(json!({
        "type": "stdio",
        "command": super::sessions::self_command(),
        "args": args,
        "env": {},
    })))
}

/// What a session's claude starts with: its `--mcp-config`, the secrets in it, and whether `--strict-mcp-config`
/// keeps the person's own servers out.
pub struct SessionMcp {
    pub json: Zeroizing<String>,
    pub secrets: Vec<(String, String)>,
    pub strict: bool,
}

/// The session's `--mcp-config`: the configured servers of its role (one whose secrets the node doesn't all hold is
/// left out, with a warning naming them), then fleetd's own server (`fleetd`), which no configured one can replace.
pub fn session_config(
    home: &Path,
    folder: Option<&Path>,
    kept: Option<&Kept>,
    fleetd: Option<Value>,
    session_id: &str,
) -> SessionMcp {
    let mut servers = Map::new();
    let mut secrets = Vec::new();
    if let Some(kept) = kept {
        for server in kept
            .config
            .servers
            .iter()
            .filter(|s| s.roles.has(kept.role))
            .filter(|s| !fleetd_contracts::mcp_servers::mcp_name_reserved(s.name.as_str()))
        {
            if let Some(entry) = native_google(home, folder, server) {
                // Left out when this node holds no tokens for it: it would start only to fail every call.
                if let Some(entry) = entry {
                    servers.insert(server.name.to_string(), entry);
                }
                continue;
            }
            match resolve(home, server) {
                Ok(resolved) => {
                    servers.insert(resolved.name.clone(), resolved.entry());
                    secrets.extend(resolved.secrets.iter().cloned());
                }
                Err(missing) => tracing::warn!(
                    session = session_id,
                    server = %server.name,
                    "MCP server left out: this node doesn't hold its {}",
                    missing.join(", ")
                ),
            }
        }
    }
    if let Some(fleetd) = fleetd {
        servers.insert(crate::cli::agent_mcp::SERVER_NAME.to_owned(), fleetd);
    }
    SessionMcp {
        json: Zeroizing::new(format!("{}\n", json!({ "mcpServers": servers }))),
        secrets,
        strict: kept.is_some_and(|k| !k.config.user_servers),
    }
}

#[cfg(test)]
mod tests;
