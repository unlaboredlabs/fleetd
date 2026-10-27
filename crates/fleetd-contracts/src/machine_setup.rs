//! Adding and removing machines from the app (W105): the hub runs `fleetd machine add` and `machine remove` for an
//! owner or admin, step by step, the same code the CLI runs. `machine_add` answers at once with its run; each step it
//! starts or ends sends a `machine_add.step` event ([`MachineAddStepData`]), and `machine_add_status` reads the run,
//! with each step's output.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{MachineId, Timestamp};

brand!(
    /// What `ssh` connects to: a name in ~/.ssh/config, a tailnet name or an address, optionally `user@`. Never an
    /// option (a leading `-`).
    SshHost,
    name = "SshHost",
    check = |s| {
        !s.is_empty()
            && s.len() <= 253
            && !s.starts_with('-')
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@'))
    },
    expected = "a host name, at most 253 letters, digits, '.', '-', '_' and '@', not starting with '-'"
);

brand!(
    /// "M" plus 32 hex digits, minted by the hub for each machine_add.
    MachineAddRunId, name = "MachineAddRunId", pattern = r"^M[0-9a-f]{32}$"
);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SetupStepState {
    /// Not started yet.
    Planned,
    Running,
    Done,
    Failed,
}

/// One step of adding or removing a machine.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetupStep {
    /// "install fleetd 0.4.0", "wait until builder-1 is online".
    pub title: String,
    /// The command as you would run it yourself (over ssh for another machine); absent for the hub's own wait.
    pub command: Option<String>,
    /// What goes to the command's stdin, described: "the fleetd binary (31 MB)", never the one-time token.
    pub stdin: Option<String>,
    pub state: SetupStepState,
    /// The last lines it printed: a short answer when done, its output and the fix when failed.
    pub output: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MachineAddState {
    Running,
    Done,
    Failed,
}

/// A machine_add, as far as it got.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineAddRun {
    pub run_id: MachineAddRunId,
    pub machine_id: MachineId,
    /// The SSH host; absent for the hub's own machine.
    pub host: Option<String>,
    pub state: MachineAddState,
    /// Every step: first reading the machine, then the plan's (planned until they start), then the wait for the node.
    pub steps: Vec<SetupStep>,
    /// What to know or do by hand: linger, an untested claude, claude not logged in.
    pub notes: Vec<String>,
    /// Failed: what went wrong.
    pub message: Option<String>,
    /// Failed: what to do, then Retry.
    pub fix: Option<String>,
    /// Done: claude on the machine is logged in.
    pub logged_in: Option<bool>,
    pub started_at: Timestamp,
    pub finished_at: Option<Timestamp>,
}

/// A host the hub can reach to add as a machine.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineHost {
    /// The SSH host; absent for the hub's own machine.
    pub host: Option<SshHost>,
    /// The machine id it gets.
    pub machine_id: MachineId,
    /// Where the hub found it.
    pub source: MachineHostSource,
    /// Already a machine of this hub (it may be offline).
    pub joined: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum MachineHostSource {
    /// The hub's own machine.
    Hub,
    /// Set up from this hub before (`machine add`).
    SetUp,
    /// A `Host` in the hub user's ~/.ssh/config.
    SshConfig,
    /// An online Linux or macOS peer on the hub's tailnet.
    Tailnet,
}

/// `machine_add.step`'s data: a run started, moved a step or ended. machine_add_status reads the rest.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineAddStepData {
    pub run_id: MachineAddRunId,
    pub machine_id: MachineId,
    pub state: MachineAddState,
}
