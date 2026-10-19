//! systemd user units and launchd agents for the hub and the node, and the shell commands that drive them.

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Linux,
    Darwin,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Linux => "linux",
            Platform::Darwin => "darwin",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Hub,
    /// Only for `--purge` where an older fleetd installed T3 Code.
    T3,
    Node,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Hub => "hub",
            Role::T3 => "t3",
            Role::Node => "node",
        }
    }
}

pub struct ServiceSpec {
    pub role: Role,
    /// Appended to the unit name, so a second copy (a lab) can run beside the real one.
    pub suffix: String,
    pub description: String,
    pub program: Vec<String>,
    /// Plain settings only: unit files are world-readable.
    pub env: Vec<(String, String)>,
    /// A 0600 file of KEY=value lines (a provider login) read at each start, so no secret sits in the unit.
    pub env_file: Option<String>,
    pub working_directory: String,
    pub log_path: String,
}

/// With a relocated fleetd dir (a second fleet), a service unit belongs to this fleet only when it names `home` (its
/// hub's or node's home). Any other unit is the first fleet's, and is never written, stopped or removed.
pub fn foreign_unit(unit_text: Option<&str>, home: &str) -> bool {
    crate::home::relocated().is_some() && unit_text.is_some_and(|unit| !unit.contains(home))
}

/// POSIX shell quoting: bare when safe, else single quotes.
pub fn q(value: &str) -> String {
    let safe = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_/.,:@%+=-".contains(c));
    if safe {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

/// `--unit-suffix lab` names units `fleetd-<role>-lab`; `None` for anything but [a-z0-9-].
pub fn unit_suffix(value: Option<&str>) -> Option<String> {
    let bare = value.unwrap_or("").trim_start_matches('-');
    if bare.is_empty() {
        return Some(String::new());
    }
    let ok = bare.len() <= 32
        && bare
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    ok.then(|| format!("-{bare}"))
}

pub fn systemd_name(role: Role, suffix: &str) -> String {
    format!("fleetd-{}{suffix}.service", role.as_str())
}

pub fn launchd_label(role: Role, suffix: &str) -> String {
    format!("sh.fleetd.{}{suffix}", role.as_str())
}

pub struct Dirs<'a> {
    pub home: &'a str,
    pub config_home: &'a str,
}

pub fn unit_path(platform: Platform, dirs: &Dirs, role: Role, suffix: &str) -> String {
    match platform {
        Platform::Linux => format!(
            "{}/systemd/user/{}",
            dirs.config_home.trim_end_matches('/'),
            systemd_name(role, suffix)
        ),
        Platform::Darwin => format!(
            "{}/Library/LaunchAgents/{}.plist",
            dirs.home.trim_end_matches('/'),
            launchd_label(role, suffix)
        ),
    }
}

/// systemd expands `%` specifiers everywhere and `$VAR` in ExecStart, and splits unquoted values on spaces.
fn systemd_value(value: &str, exec: bool) -> String {
    let escaped = if exec {
        value.replace('%', "%%").replace('$', "$$")
    } else {
        value.replace('%', "%%")
    };
    if escaped
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '\\' | ';'))
    {
        format!("\"{}\"", escaped.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        escaped
    }
}

pub fn render_systemd_unit(spec: &ServiceSpec) -> String {
    let mut lines = vec![
        "[Unit]".to_owned(),
        format!("Description={}", spec.description),
        "StartLimitIntervalSec=300".into(),
        "StartLimitBurst=5".into(),
        String::new(),
        "[Service]".into(),
        "Type=simple".into(),
        format!(
            "WorkingDirectory={}",
            systemd_value(&spec.working_directory, false)
        ),
    ];
    lines.extend(spec.env.iter().map(|(key, value)| {
        format!(
            "Environment={}",
            systemd_value(&format!("{key}={value}"), false)
        )
    }));
    // The leading "-" lets the service start before the file exists.
    if let Some(file) = &spec.env_file {
        lines.push(format!("EnvironmentFile=-{}", systemd_value(file, false)));
    }
    lines.push(format!(
        "ExecStart={}",
        spec.program
            .iter()
            .map(|arg| systemd_value(arg, true))
            .collect::<Vec<_>>()
            .join(" ")
    ));
    // The node's claude processes get its SIGTERM first and their own grace, rather than the whole group at once.
    if spec.role == Role::Node {
        lines.push("KillMode=mixed".into());
    }
    lines.extend([
        "Restart=always".to_owned(),
        "RestartSec=5".into(),
        format!("StandardOutput=append:{}", spec.log_path.replace('%', "%%")),
        format!("StandardError=append:{}", spec.log_path.replace('%', "%%")),
        String::new(),
        "[Install]".into(),
        "WantedBy=default.target".into(),
        String::new(),
    ]);
    lines.join("\n")
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn render_launchd_plist(spec: &ServiceSpec) -> String {
    // launchd has no EnvironmentFile: a shell sources the 0600 file, then execs the program.
    let program: Vec<String> = match &spec.env_file {
        None => spec.program.clone(),
        Some(file) => [
            "/bin/sh".to_owned(),
            "-c".into(),
            format!(
                "[ -f {f} ] && set -a && . {f} && set +a; exec \"$@\"",
                f = q(file)
            ),
            "sh".into(),
        ]
        .into_iter()
        .chain(spec.program.iter().cloned())
        .collect(),
    };
    let mut lines = vec![
        r#"<?xml version="1.0" encoding="UTF-8"?>"#.to_owned(),
        r#"<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">"#.into(),
        r#"<plist version="1.0">"#.into(),
        "<dict>".into(),
        "  <key>Label</key>".into(),
        format!("  <string>{}</string>", launchd_label(spec.role, &spec.suffix)),
        "  <key>ProgramArguments</key>".into(),
        "  <array>".into(),
    ];
    lines.extend(
        program
            .iter()
            .map(|arg| format!("    <string>{}</string>", xml(arg))),
    );
    lines.extend([
        "  </array>".to_owned(),
        "  <key>EnvironmentVariables</key>".into(),
        "  <dict>".into(),
    ]);
    for (key, value) in &spec.env {
        lines.push(format!("    <key>{}</key>", xml(key)));
        lines.push(format!("    <string>{}</string>", xml(value)));
    }
    lines.extend([
        "  </dict>".to_owned(),
        "  <key>WorkingDirectory</key>".into(),
        format!("  <string>{}</string>", xml(&spec.working_directory)),
        "  <key>RunAtLoad</key>".into(),
        "  <true/>".into(),
        "  <key>KeepAlive</key>".into(),
        "  <true/>".into(),
        "  <key>ThrottleInterval</key>".into(),
        "  <integer>5</integer>".into(),
        "  <key>ProcessType</key>".into(),
        "  <string>Interactive</string>".into(),
        "  <key>StandardOutPath</key>".into(),
        format!("  <string>{}</string>", xml(&spec.log_path)),
        "  <key>StandardErrorPath</key>".into(),
        format!("  <string>{}</string>", xml(&spec.log_path)),
        "</dict>".into(),
        "</plist>".into(),
        String::new(),
    ]);
    lines.join("\n")
}

pub fn render_unit(platform: Platform, spec: &ServiceSpec) -> String {
    match platform {
        Platform::Linux => render_systemd_unit(spec),
        Platform::Darwin => render_launchd_plist(spec),
    }
}

/// Shell commands that drive one service through the user's service manager.
pub struct ServiceManager {
    platform: Platform,
    uid: u32,
    suffix: String,
    unit_files: Vec<(Role, String)>,
}

impl ServiceManager {
    pub fn new(
        platform: Platform,
        uid: u32,
        suffix: &str,
        unit_file: impl Fn(Role) -> String,
    ) -> Self {
        let unit_files = [Role::Hub, Role::T3, Role::Node]
            .into_iter()
            .map(|role| (role, unit_file(role)))
            .collect();
        ServiceManager {
            platform,
            uid,
            suffix: suffix.to_owned(),
            unit_files,
        }
    }

    /// A non-PAM SSH session has no XDG_RUNTIME_DIR, without which `systemctl --user` cannot find the user manager.
    fn ctl(&self) -> String {
        format!("XDG_RUNTIME_DIR=/run/user/{} systemctl --user", self.uid)
    }

    fn target(&self, role: Role) -> String {
        format!("gui/{}/{}", self.uid, launchd_label(role, &self.suffix))
    }

    fn bootstrap(&self, role: Role) -> String {
        let file = &self
            .unit_files
            .iter()
            .find(|(r, _)| *r == role)
            .expect("every role has a unit")
            .1;
        format!("launchctl bootstrap gui/{} {}", self.uid, q(file))
    }

    /// Without --wait, bootout returns while the job drains and a bootstrap right after fails.
    fn bootout(&self, role: Role) -> String {
        format!(
            "launchctl bootout --wait {} 2>/dev/null || true",
            self.target(role)
        )
    }

    /// Enables the service and starts it if it is not running; leaves a running one alone.
    pub fn ensure_running(&self, role: Role) -> String {
        match self.platform {
            Platform::Linux => {
                let (ctl, name) = (self.ctl(), systemd_name(role, &self.suffix));
                format!("{ctl} enable {name} && {ctl} start {name}")
            }
            Platform::Darwin => format!(
                "launchctl print {} >/dev/null 2>&1 || {}",
                self.target(role),
                self.bootstrap(role)
            ),
        }
    }

    /// Enables and (re)starts it, reloading a changed unit file first.
    pub fn restart(&self, role: Role, unit_changed: bool) -> String {
        match self.platform {
            Platform::Linux => {
                let (ctl, name) = (self.ctl(), systemd_name(role, &self.suffix));
                format!(
                    "{}{ctl} enable {name} && {ctl} restart {name}",
                    if unit_changed {
                        format!("{ctl} daemon-reload && ")
                    } else {
                        String::new()
                    }
                )
            }
            // A loaded job keeps its old plist until it is booted out and bootstrapped again.
            Platform::Darwin if unit_changed => {
                format!("{}; {}", self.bootout(role), self.bootstrap(role))
            }
            Platform::Darwin => format!(
                "launchctl kickstart -k {} 2>/dev/null || {}",
                self.target(role),
                self.bootstrap(role)
            ),
        }
    }

    /// Stops and disables it; succeeds when it was never installed.
    pub fn remove(&self, role: Role) -> String {
        match self.platform {
            Platform::Linux => format!(
                "{} disable --now {} 2>/dev/null || true",
                self.ctl(),
                systemd_name(role, &self.suffix)
            ),
            Platform::Darwin => self.bootout(role),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ServiceSpec {
        ServiceSpec {
            role: Role::Node,
            suffix: "-fleetdlab".into(),
            description: "fleetd node".into(),
            program: [
                "/home/a b/.fleetd/bin/fleetd",
                "node",
                "run",
                "--home",
                "/home/a b/.fleetd/node",
                "100%",
                "$HOME",
            ]
            .map(String::from)
            .to_vec(),
            env: vec![
                ("HOME".into(), "/home/a b".into()),
                ("PATH".into(), "/usr/bin:/a&b".into()),
            ],
            env_file: Some("/home/a b/.fleetd/hub.env".into()),
            working_directory: "/home/a b".into(),
            log_path: "/home/a b/.fleetd/logs/node.log".into(),
        }
    }

    /// Unit files are compared byte for byte on every `machine add`, so their text must not drift.
    #[test]
    fn unit_templates_render_as_snapshotted() {
        assert_eq!(
            render_systemd_unit(&spec()),
            include_str!("snapshots/node.service")
        );
        assert_eq!(
            render_launchd_plist(&spec()),
            include_str!("snapshots/node.plist")
        );
    }

    #[test]
    fn shell_quoting_and_suffixes() {
        assert_eq!(q("/usr/bin/node"), "/usr/bin/node");
        assert_eq!(q("it's"), r"'it'\''s'");
        assert_eq!(q(""), "''");
        assert_eq!(unit_suffix(Some("lab")).as_deref(), Some("-lab"));
        assert_eq!(unit_suffix(Some("--lab")).as_deref(), Some("-lab"));
        assert_eq!(unit_suffix(None).as_deref(), Some(""));
        assert_eq!(unit_suffix(Some("Lab")), None);
    }
}
