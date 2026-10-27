//! The hub's people: who is behind each human key. A person has a hub role and owns devices (human keys); an invite
//! is a pairing code bound to a person, which a device redeems at `POST /pair` like any pairing code. A hub has at
//! least one owner; an older hub's keys all belong to it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::Timestamp;
use crate::prim::Line;

brand!(
    /// "p_" plus 8 lowercase base32 characters, unique per hub.
    PersonId, name = "PersonId", pattern = r"^p_[a-z2-7]{8}$"
);
brand!(
    /// "inv_" plus 8 lowercase base32 characters, unique per hub.
    InviteId, name = "InviteId", pattern = r"^inv_[a-z2-7]{8}$"
);

/// The most people a hub lists.
pub const PEOPLE_MAX: usize = 500;
/// The most devices a hub lists.
pub const DEVICES_MAX: usize = 2000;

/// What a person may do on the hub. Owners and admins invite people, change roles and change hub-wide settings;
/// members work in projects. Each device is still capped by its own grants.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "lowercase")]
#[schemars(extend("x-open" = true))]
pub enum HubRole {
    Owner,
    Admin,
    Member,
}

impl HubRole {
    pub fn as_str(self) -> &'static str {
        match self {
            HubRole::Owner => "owner",
            HubRole::Admin => "admin",
            HubRole::Member => "member",
        }
    }

    /// Owners and admins administer the hub.
    pub fn administers(self) -> bool {
        matches!(self, HubRole::Owner | HubRole::Admin)
    }
}

/// A person's name as the hub shows it and the lead reads it ("Alice writes in your chat").
pub type PersonName = Line<1, 80>;

/// Who did something, with their name at the time: on chat messages, approvals, secrets, decisions and checklist
/// changes.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PersonRef {
    pub person_id: PersonId,
    pub name: PersonName,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub person_id: PersonId,
    pub name: PersonName,
    pub role: HubRole,
    pub created_at: Timestamp,
    /// Removed people keep their id and name, so what they did still names them; their devices are revoked.
    pub removed_at: Option<Timestamp>,
}

impl Person {
    pub fn as_ref(&self) -> PersonRef {
        PersonRef {
            person_id: self.person_id.clone(),
            name: self.name.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(extend("x-open" = true))]
pub enum InviteState {
    /// Not redeemed yet, and not expired.
    Open,
    /// A device redeemed it.
    Used,
    Expired,
    Revoked,
}

/// A single-use pairing code bound to a person, valid for 7 days. The code itself is shown once, at creation.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub invite_id: InviteId,
    /// Whom the device that redeems it belongs to.
    pub person: PersonRef,
    pub state: InviteState,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
    /// Who created it; absent for `fleetd invite` on the hub machine.
    pub created_by: Option<PersonRef>,
    pub used_at: Option<Timestamp>,
    pub revoked_at: Option<Timestamp>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum PeopleChange {
    Invited,
    Joined,
    InviteRevoked,
    Renamed,
    RoleChanged,
    Removed,
    DeviceRevoked,
}

/// `people.changed`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PeopleChangedData {
    pub change: PeopleChange,
    /// Whom it is about.
    pub person: PersonRef,
    /// Who made the change; absent for the hub machine's own CLI and for a device joining.
    pub by: Option<PersonRef>,
    pub invite_id: Option<InviteId>,
    pub key_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_and_roles_read_as_the_hub_writes_them() {
        assert!(PersonId::new("p_abcd2345").is_ok());
        assert!(PersonId::new("p_ABCD2345").is_err());
        assert!(InviteId::new("inv_abcd2345").is_ok());
        assert!(InviteId::new("inv_abc").is_err());
        let role: HubRole = serde_json::from_value(json!("admin")).unwrap();
        assert_eq!(role, HubRole::Admin);
        assert!(HubRole::Owner.administers() && !HubRole::Member.administers());
        assert_eq!(
            serde_json::to_value(HubRole::Member).unwrap(),
            json!("member")
        );
    }
}
