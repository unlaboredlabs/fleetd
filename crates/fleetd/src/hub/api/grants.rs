//! The grant checks, standard refusals and output limits, shared by every area's tool handlers.
use super::registry::{Caller, ToolError};
use crate::hub::auth;
use fleetd_contracts::auth::{GrantMachines, KeyKind, Role};
use fleetd_contracts::events::HubEvent;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef};
use fleetd_contracts::mcp::ErrorCode;

/// How much one tool result may carry.
pub mod limits {
    pub const PROJECTS: usize = 50;
    pub const ATTENTION: usize = 10;
    pub const OUTCOME_THREADS: usize = 20;
    pub const OUTCOME_WORKSTREAMS: usize = 20;
    pub const TAIL_TEXT: usize = 2000;
    pub const WAKES: usize = 200;
    pub const WORKSTREAM_ASKS: usize = 50;
    pub const BATCHES: usize = 20;
    pub const ASKS: usize = 100;
    pub const OUTCOME_TASKS: usize = 20;
    /// Threads read to fill `OUTCOME_THREADS` once task threads are left out.
    pub const OUTCOME_THREAD_SCAN: usize = 200;
    pub const WORKSTREAM_CLAIMS: usize = 20;
    pub const TRAINS: usize = 10;
}

/// Whether some grant gives at least `role` on `machine_id`. Without a machine (fleet-wide reads), any grant of that
/// role is enough; the handler then filters results per machine with [`readable`].
pub fn allows(caller: &Caller, role: Role, machine_id: Option<&MachineId>) -> bool {
    auth::allows(caller, role, machine_id)
}

/// `Ok` when the key holds `role` (on `machine_id`, when given), else the `forbidden` refusal.
pub fn require(
    caller: &Caller,
    role: Role,
    machine_id: Option<&MachineId>,
) -> Result<(), ToolError> {
    if allows(caller, role, machine_id) {
        Ok(())
    } else {
        Err(forbidden(role, machine_id))
    }
}

/// Whether the key may read `machine_id`: the per-item filter for fleet-wide lists.
pub fn readable(caller: &Caller, machine_id: &MachineId) -> bool {
    allows(caller, Role::Read, Some(machine_id))
}

/// Events without a machine are fleet-wide and visible to every key.
pub fn can_read(caller: &Caller, event: &HubEvent) -> bool {
    event
        .machine_id
        .as_ref()
        .is_none_or(|m| readable(caller, m))
}

/// A grant over every machine, as global decisions need: they apply to all of them.
pub fn allows_everywhere(caller: &Caller, role: Role) -> bool {
    caller.grants.iter().any(|grant| {
        matches!(grant.machines, GrantMachines::All(_))
            && allows(
                &Caller {
                    grants: vec![grant.clone()],
                    ..caller.clone()
                },
                role,
                None,
            )
    })
}

pub fn is_human(caller: &Caller) -> bool {
    caller.kind == Some(KeyKind::Human)
}

fn error(code: ErrorCode, message: impl Into<String>, fix: impl Into<String>) -> ToolError {
    ToolError::new(code, message).with_fix(fix)
}

pub fn forbidden(role: Role, machine_id: Option<&MachineId>) -> ToolError {
    let role = role_name(role);
    let message = match machine_id {
        None => format!("This key lacks the {role} role."),
        Some(m) => format!("This key has no {role} grant on machine {m}."),
    };
    error(
        ErrorCode::Forbidden,
        message,
        "Ask the hub admin for a key with that grant (fleetd hub key create --role … --machines …).",
    )
}

pub fn offline(machine_id: &MachineId) -> ToolError {
    error(
        ErrorCode::MachineOffline,
        format!("Machine {machine_id} is offline."),
        format!("Start the node on {machine_id} or check its network, then retry."),
    )
}

pub fn unknown_machine(machine_id: &MachineId) -> ToolError {
    error(
        ErrorCode::NotFound,
        format!("No machine {machine_id}."),
        "Call fleetd_status to list machines.",
    )
}

pub fn unknown_project(r: &ProjectRef) -> ToolError {
    error(
        ErrorCode::NotFound,
        format!("No project {} on {}.", r.project_id, r.machine_id),
        format!("Call projects_list with machineId {}.", r.machine_id),
    )
}

pub fn unknown_thread(r: &ThreadRef) -> ToolError {
    error(
        ErrorCode::NotFound,
        format!("No thread {} on {}.", r.thread_id, r.machine_id),
        "Call project_get to list the project's threads.",
    )
}

/// What a store failure or a panicking handler answers.
pub fn internal_error() -> ToolError {
    error(
        ErrorCode::Failed,
        "The hub failed to answer that request.",
        "Retry; if it keeps failing, check the hub log.",
    )
}

/// `role` as it reads on the wire: read, operate, admin.
pub fn role_name(role: Role) -> &'static str {
    match role {
        Role::Read => "read",
        Role::Operate => "operate",
        Role::Admin => "admin",
    }
}

/// A list trimmed to its limit; `truncated` is `Some(true)` only when something was dropped, so the field is on
/// the wire only then.
pub struct Capped<T> {
    pub items: Vec<T>,
    pub truncated: Option<bool>,
}

pub fn cap<T>(mut items: Vec<T>, max: usize) -> Capped<T> {
    if items.len() > max {
        items.truncate(max);
        Capped {
            items,
            truncated: Some(true),
        }
    } else {
        Capped {
            items,
            truncated: None,
        }
    }
}

/// The first `max` UTF-16 units of `text`, as JS's `text.slice(0, max)` (never splitting a surrogate pair).
pub fn clip(text: &str, max: usize) -> String {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        units += c.len_utf16();
        if units > max {
            return text[..i].to_owned();
        }
    }
    text.to_owned()
}

/// `a ?? b ?? …` over `truncated` flags: the first one that is set.
pub fn any_truncated(flags: &[Option<bool>]) -> Option<bool> {
    flags.iter().copied().find(Option::is_some).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::auth::{AgentKeyInfo, Grant};

    fn key(grants: Vec<Grant>) -> Caller {
        serde_json::from_value::<AgentKeyInfo>(serde_json::json!({
            "keyId": "key_1", "name": "k", "prefix": "fld_abcdef", "grants": grants, "createdAt": "2026-10-17T00:00:00.000Z"
        }))
        .unwrap()
    }
    fn grant(role: &str, machines: serde_json::Value) -> Grant {
        serde_json::from_value(serde_json::json!({ "role": role, "machines": machines })).unwrap()
    }
    fn m(id: &str) -> MachineId {
        serde_json::from_value(serde_json::json!(id)).unwrap()
    }

    #[test]
    fn grants_rank_roles_and_scope_machines() {
        let a_only = key(vec![grant("operate", serde_json::json!(["lab-a"]))]);
        assert!(require(&a_only, Role::Read, Some(&m("lab-a"))).is_ok());
        assert!(require(&a_only, Role::Operate, None).is_ok());
        assert_eq!(
            require(&a_only, Role::Read, Some(&m("lab-b"))).unwrap_err(),
            ToolError::new(ErrorCode::Forbidden, "This key has no read grant on machine lab-b.")
                .with_fix("Ask the hub admin for a key with that grant (fleetd hub key create --role … --machines …).")
        );
        assert_eq!(
            require(&a_only, Role::Admin, None).unwrap_err().message,
            "This key lacks the admin role."
        );
        assert!(!allows_everywhere(&a_only, Role::Operate));

        let mixed = key(vec![
            grant("read", serde_json::json!("*")),
            grant("admin", serde_json::json!(["lab-a"])),
        ]);
        assert!(allows_everywhere(&mixed, Role::Read));
        assert!(!allows_everywhere(&mixed, Role::Operate));
        assert!(readable(&mixed, &m("lab-z")));

        let mut revoked = key(vec![grant("admin", serde_json::json!("*"))]);
        revoked.revoked_at = Some("2026-10-17T00:00:01.000Z".into());
        assert!(require(&revoked, Role::Read, None).is_err());
    }
}
