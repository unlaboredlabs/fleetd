use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{MachineId, ThreadId, Timestamp};
use crate::prim::{Int, MAX_SAFE_INT, NonEmpty, Text};

/// An IANA zone name as `Intl` knows it (case-insensitive). Intl also takes UTC offsets such as "+01:00", which are
/// not zone names, so a leading sign is refused.
pub fn is_iana_time_zone(tz: &str) -> bool {
    !tz.starts_with(['+', '-']) && chrono_tz::Tz::from_str_insensitive(tz).is_ok()
}

brand!(
    /// IANA time zone name, e.g. "Europe/London" or "UTC".
    TimeZone,
    name = "TimeZone",
    check = is_iana_time_zone,
    expected = "an IANA time zone name such as Europe/London"
);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WakeTarget {
    pub machine_id: MachineId,
    pub thread_id: ThreadId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WakeAt {
    pub at: Timestamp,
    pub tz: TimeZone,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WakeEvery {
    pub every_sec: Int<60, MAX_SAFE_INT>,
}

/// Standard 5-field cron; the hub parses it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WakeCron {
    pub cron: NonEmpty,
    pub tz: TimeZone,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WakeSchedule {
    At(WakeAt),
    Every(WakeEvery),
    Cron(WakeCron),
}

pub type WakeMessage = Text<1, 4000>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WakeCatchUp {
    #[default]
    FireOnce,
    Skip,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WakeState {
    Active,
    Done,
    Cancelled,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Wake {
    pub wake_id: NonEmpty,
    pub target: WakeTarget,
    pub schedule: WakeSchedule,
    pub message: WakeMessage,
    pub once: bool,
    /// What to do with a firing missed while the hub was down.
    pub catch_up: WakeCatchUp,
    /// Absent once the wake is done or cancelled.
    pub next_run_at: Option<Timestamp>,
    pub last_fired_at: Option<Timestamp>,
    /// keyId of the agent key that set it.
    pub created_by: String,
    pub state: WakeState,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iana_zones_only() {
        for tz in [
            "UTC",
            "Europe/London",
            "America/New_York",
            "Etc/GMT+5",
            "europe/london",
        ] {
            assert!(TimeZone::new(tz).is_ok(), "{tz}");
        }
        for tz in ["", "+01:00", "-05:00", "Mars/Olympus", "GMT+25"] {
            assert!(TimeZone::new(tz).is_err(), "{tz}");
        }
        assert!(serde_json::from_str::<TimeZone>("3").is_err());
    }

    #[test]
    fn every_schedules_are_at_least_a_minute() {
        let decode = |v: serde_json::Value| serde_json::from_value::<WakeSchedule>(v);
        assert!(decode(serde_json::json!({ "kind": "every", "everySec": 60 })).is_ok());
        assert!(decode(serde_json::json!({ "kind": "every", "everySec": 59 })).is_err());
        assert!(decode(serde_json::json!({ "kind": "every", "everySec": 60.5 })).is_err());
        assert!(
            decode(
                serde_json::json!({ "kind": "cron", "cron": "0 9 * * 1-5", "tz": "Nope/Nowhere" })
            )
            .is_err()
        );
    }
}
