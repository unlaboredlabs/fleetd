//! `fleetd invite` and `fleetd people`: the hub's people, from the hub machine. Like `hub key`, they open the hub
//! home's database directly, so the hub need not be running; whoever runs them acts as the hub machine's owner.

use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::people::{HubRole, InviteId, PeopleChange, PeopleChangedData, PersonId};

use super::CliResult;
use super::args::{self, Kind, Spec};
use crate::clock::{Clock, SystemClock};
use crate::hub::auth::Auth;
use crate::hub::pair::PairCodes;
use crate::hub::people::People;
use crate::hub::people::tools::{announce, change};
use crate::hub::store::{EventLog, HubDb};

pub const PEOPLE_USAGE: &str = r#"  invite --name <name> [--role <member|admin|owner>] [--home <dir>]
  invite --person <personId> [--home <dir>]
             invite someone to this hub: prints a link and a code (single use, 7 days) that pair
             their app as a device of a new person, a member unless --role; with --person, one
             more device of someone already here
  invite list [--home <dir>]
  invite revoke <inviteId> [--home <dir>]
             takes back an open invite; someone it invited who never joined goes with it
  people [--home <dir>]
             the hub's people, with their role and devices
  people role <personId> <owner|admin|member> [--home <dir>]
  people remove <personId> [--home <dir>]
             signs out all their devices; one device: fleetd hub key revoke <keyId>. The hub
             always keeps an owner
"#;

struct Open {
    db: Arc<HubDb>,
    clock: Arc<dyn Clock>,
    home: std::path::PathBuf,
}

impl Open {
    fn people(&self) -> People {
        People::new(self.db.clone(), self.clock.clone())
    }
    fn codes(&self) -> PairCodes {
        PairCodes::new(self.db.clone(), self.clock.clone())
    }
    fn announce(&self, data: PeopleChangedData, summary: String) {
        match EventLog::new(self.db.clone(), self.clock.clone()) {
            Ok(events) => announce(&events, self.clock.as_ref(), data, summary),
            Err(error) => tracing::warn!("people.changed event not recorded: {error}"),
        }
    }
}

fn open(home: Option<&str>) -> Result<Open, String> {
    let home = super::hub_key::resolve_home(home)?;
    let db = HubDb::open(&home).map_err(|e| e.to_string())?;
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let open = Open { db, clock, home };
    // A hub not started since people came: its owner, now.
    open.people().ensure_owner().map_err(|e| e.to_string())?;
    Ok(open)
}

fn ok(stdout: String) -> CliResult {
    CliResult {
        code: 0,
        stdout,
        stderr: String::new(),
    }
}

fn fail(message: &str) -> CliResult {
    CliResult::err(1, format!("fleetd: {message}\n"))
}

fn usage(message: &str) -> CliResult {
    CliResult::err(2, format!("fleetd: {message}\n\nusage:\n{PEOPLE_USAGE}"))
}

fn parse_hub_role(text: &str) -> Option<HubRole> {
    serde_json::from_value(serde_json::Value::String(text.to_owned())).ok()
}

fn parsed(argv: &[String], options: &[(&str, Kind)]) -> Result<args::Parsed, CliResult> {
    args::parse(
        argv,
        &Spec {
            options,
            positionals: true,
        },
    )
    .map_err(|message| usage(&message))
}

/// `fleetd invite …`.
pub fn invite_command(argv: &[String]) -> CliResult {
    let v = match parsed(
        argv,
        &[
            ("home", Kind::Str),
            ("name", Kind::Str),
            ("role", Kind::Str),
            ("person", Kind::Str),
        ],
    ) {
        Ok(v) => v,
        Err(out) => return out,
    };
    let result = match v.positionals.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        [] => invite(&v),
        ["list"] => open(v.str("home")).and_then(|o| list_invites(&o)),
        ["revoke", id] => open(v.str("home")).and_then(|o| revoke_invite(&o, id)),
        _ => return usage("expected invite, invite list or invite revoke <inviteId>"),
    };
    result.map_or_else(|e| fail(&e), ok)
}

fn invite(v: &args::Parsed) -> Result<String, String> {
    let o = open(v.str("home"))?;
    let people = o.people();
    let person = match v.str("person") {
        Some(id) => {
            if v.has("name") || v.has("role") {
                return Err(
                    "--person pairs another device of someone: it takes no --name or --role".into(),
                );
            }
            let id = PersonId::new(id).map_err(|_| format!("'{id}' is not a person id (p_…)"))?;
            people
                .get(&id)
                .map_err(|e| e.to_string())?
                .filter(|p| p.removed_at.is_none())
                .ok_or_else(|| format!("no person {id}; `fleetd people` lists them"))?
        }
        None => {
            let role = match v.str("role") {
                None => HubRole::Member,
                Some(text) => {
                    parse_hub_role(text).ok_or("--role must be member, admin or owner")?
                }
            };
            let name = v
                .str("name")
                .and_then(crate::hub::people::clean_name)
                .ok_or("a new person needs a name: fleetd invite --name <name>")?;
            people.create(&name, role).map_err(|e| e.to_string())?
        }
    };
    let (minted, invite) = o
        .codes()
        .create_invite(&person, None)
        .map_err(|e| e.to_string())?;
    o.announce(
        PeopleChangedData {
            invite_id: Some(invite.invite_id.clone()),
            ..change(PeopleChange::Invited, &person.as_ref(), None)
        },
        format!("{} was invited as {}", person.name, person.role.as_str()),
    );
    let urls = super::pair::local_hub_urls(&o.home)?;
    let link = super::pair::deep_link(&urls[0], &minted.code);
    let mut out = format!(
        "Invited {} ({}) as {}.\nInvite link:  {link}\nCode:         {}  (single use, valid until {})\nHub address:  {}\n",
        person.name,
        person.person_id,
        person.role.as_str(),
        minted.code,
        minted.expires_at,
        urls[0]
    );
    if urls.len() > 1 {
        out += &format!("  or:         {}\n", urls[1..].join(", "));
    }
    out += &format!(
        "\nSend {} the link, or the code and hub address to enter in the fleetd app. The device it pairs is theirs.\nTake it back with `fleetd invite revoke {}`.\n",
        person.name, invite.invite_id
    );
    Ok(out)
}

fn list_invites(o: &Open) -> Result<String, String> {
    let invites = o.codes().invites(false).map_err(|e| e.to_string())?;
    if invites.is_empty() {
        return Ok("No open invites. `fleetd invite` makes one.\n".into());
    }
    let mut out = String::new();
    for invite in invites {
        out += &format!(
            "{}  {}  until {}\n",
            invite.invite_id,
            invite.person.name,
            invite.expires_at.as_str()
        );
    }
    Ok(out)
}

fn revoke_invite(o: &Open, id: &str) -> Result<String, String> {
    let id = InviteId::new(id).map_err(|_| format!("'{id}' is not an invite id (inv_…)"))?;
    let (invite, revoked) = o
        .codes()
        .revoke_invite(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no invite {id}; `fleetd invite list` lists the open ones"))?;
    if !revoked {
        return Ok(format!(
            "Invite {id} is {}: nothing to revoke.\n",
            serde_json::to_value(invite.state)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default()
        ));
    }
    let auth = Auth::new(o.db.clone(), o.clock.clone());
    let joined = auth
        .list()
        .map_err(|e| e.to_string())?
        .iter()
        .any(|k| k.person.as_ref().map(|p| &p.person_id) == Some(&invite.person.person_id));
    let people = o.people();
    let invited = people
        .get(&invite.person.person_id)
        .map_err(|e| e.to_string())?;
    if !joined && invited.is_some_and(|p| p.removed_at.is_none() && p.role != HubRole::Owner) {
        people
            .remove(&invite.person.person_id)
            .map_err(|e| e.to_string())?;
    }
    o.announce(
        PeopleChangedData {
            invite_id: Some(id.clone()),
            ..change(PeopleChange::InviteRevoked, &invite.person, None)
        },
        format!("The invite for {} was revoked", invite.person.name),
    );
    Ok(format!("Revoked the invite for {}.\n", invite.person.name))
}

/// `fleetd people …`.
pub fn people_command(argv: &[String]) -> CliResult {
    let v = match parsed(argv, &[("home", Kind::Str)]) {
        Ok(v) => v,
        Err(out) => return out,
    };
    let o = match open(v.str("home")) {
        Ok(o) => o,
        Err(e) => return fail(&e),
    };
    let result = match v.positionals.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        [] => list_people(&o),
        ["role", id, role] => match parse_hub_role(role) {
            Some(role) => set_role(&o, id, role),
            None => return usage("the role must be owner, admin or member"),
        },
        ["remove", id] => remove(&o, id),
        _ => {
            return usage(
                "expected people, people role <personId> <role> or people remove <personId>",
            );
        }
    };
    result.map_or_else(|e| fail(&e), ok)
}

fn list_people(o: &Open) -> Result<String, String> {
    let people = o.people().list(false).map_err(|e| e.to_string())?;
    let keys = Auth::new(o.db.clone(), o.clock.clone())
        .list()
        .map_err(|e| e.to_string())?;
    let mut out = String::new();
    for person in people {
        out += &format!(
            "{}  {}  {}\n",
            person.person_id,
            person.name,
            person.role.as_str()
        );
        let devices: Vec<_> = keys
            .iter()
            .filter(|k| {
                k.kind == Some(KeyKind::Human)
                    && k.revoked_at.is_none()
                    && k.person.as_ref().map(|p| &p.person_id) == Some(&person.person_id)
            })
            .collect();
        if devices.is_empty() {
            out += "    no devices yet\n";
        }
        for key in devices {
            out += &format!(
                "    {}  {}  last used {}\n",
                key.key_id,
                key.name,
                key.last_used_at.as_ref().map_or("never", |t| t.as_str())
            );
        }
    }
    Ok(out)
}

fn person_id(id: &str) -> Result<PersonId, String> {
    PersonId::new(id)
        .map_err(|_| format!("'{id}' is not a person id (p_…); `fleetd people` lists them"))
}

fn set_role(o: &Open, id: &str, role: HubRole) -> Result<String, String> {
    let id = person_id(id)?;
    let people = o.people();
    let person = people
        .get(&id)
        .map_err(|e| e.to_string())?
        .filter(|p| p.removed_at.is_none())
        .ok_or_else(|| format!("no person {id}"))?;
    if person.role == HubRole::Owner
        && role != HubRole::Owner
        && people.owners().map_err(|e| e.to_string())? <= 1
    {
        return Err(format!(
            "{} is the hub's only owner: make someone else an owner first",
            person.name
        ));
    }
    let after = people
        .set(&id, None, Some(role))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no person {id}"))?;
    o.announce(
        change(PeopleChange::RoleChanged, &after.as_ref(), None),
        format!("{} is now {}", after.name, role.as_str()),
    );
    Ok(format!("{} is now {}.\n", after.name, role.as_str()))
}

fn remove(o: &Open, id: &str) -> Result<String, String> {
    let id = person_id(id)?;
    let people = o.people();
    let person = people
        .get(&id)
        .map_err(|e| e.to_string())?
        .filter(|p| p.removed_at.is_none())
        .ok_or_else(|| format!("no person {id}"))?;
    if person.role == HubRole::Owner && people.owners().map_err(|e| e.to_string())? <= 1 {
        return Err(format!("{} is the hub's only owner", person.name));
    }
    let (person, revoked) = people
        .remove(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no person {id}"))?;
    o.announce(
        change(PeopleChange::Removed, &person.as_ref(), None),
        format!("{} was removed from the hub", person.name),
    );
    Ok(format!(
        "Removed {}; signed out {revoked} device(s).\n",
        person.name
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn invite_makes_a_named_person_with_a_link_and_people_lists_them() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path().to_str().unwrap();
        let nameless = invite_command(&argv(&["--home", h]));
        assert_eq!(nameless.code, 1);
        assert!(
            nameless.stderr.contains("needs a name"),
            "{}",
            nameless.stderr
        );
        assert_eq!(
            invite_command(&argv(&["--home", h, "--name", "Alice", "--role", "boss"])).code,
            1
        );

        let out = invite_command(&argv(&["--home", h, "--name", "Alice"]));
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert!(
            out.stdout.starts_with("Invited Alice (p_"),
            "{}",
            out.stdout
        );
        assert!(out.stdout.contains("as member."), "{}", out.stdout);
        assert!(
            out.stdout.contains("Invite link:  fleetd://pair?hub="),
            "{}",
            out.stdout
        );

        let open = invite_command(&argv(&["list", "--home", h]));
        assert!(open.stdout.contains("Alice"), "{}", open.stdout);

        let people = people_command(&argv(&["--home", h]));
        assert_eq!(people.code, 0, "{}", people.stderr);
        let lines: Vec<&str> = people
            .stdout
            .lines()
            .filter(|l| l.starts_with("p_"))
            .collect();
        assert_eq!(lines.len(), 2, "{}", people.stdout);
        assert!(
            lines[0].ends_with("owner") && lines[1].ends_with("Alice  member"),
            "{}",
            people.stdout
        );

        // The hub's only owner stays.
        let owner = lines[0].split_whitespace().next().unwrap();
        let out = people_command(&argv(&["remove", owner, "--home", h]));
        assert_eq!(out.code, 1);
        assert!(out.stderr.contains("only owner"), "{}", out.stderr);
    }
}
