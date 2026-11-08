//! The agents' Mac (D298): one Mac whose node runs as a standard `agents` user, which agents on any machine use for its
//! shell, builds and iOS simulators. An agent runs `fleetd mac` (the `mac` on its PATH), which asks its own node
//! ([`MacCall`], a lead call the node answers itself, never sent on as it is). That node seals each step to the Mac's
//! node and sends it through the hub ([`MacWhereCall`], [`MacSendCall`]): the hub sees who calls and sealed bytes, never
//! a command, a file or an output.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{MachineId, ProjectId, ThreadId};
use crate::mcp::McpToolError;
use crate::prim::NonEmpty;
use crate::secrets::BoxPublicKey;
use crate::tasks::TaskId;

/// What `fleetd mac` asks of its own node, for the agent session its process runs in.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum MacCall {
    /// `mac push`: the agent's worktree as it is now (commits, uncommitted changes and new files git doesn't ignore)
    /// becomes the agent's folder on the Mac.
    Push,
    /// `mac run`: a command line in the agent's folder on the Mac, run by its shell as ssh would. It starts and answers
    /// with its job; `logs` follows it.
    #[serde(rename_all = "camelCase")]
    Run {
        args: Vec<String>,
        /// The variables the agent named (`--env NAME`), with their values: nothing else of the agent's crosses.
        #[serde(default)]
        env: Vec<MacEnv>,
        /// `--bg`: it runs on after the CLI stops following it. A run in the foreground ends once nobody follows it.
        #[serde(default)]
        background: bool,
    },
    /// The job's output from `offset` on (its stdout and stderr in one), waiting a little for more while it runs.
    Logs { job: u32, offset: u64 },
    /// `mac ps`: the agent's jobs.
    Ps,
    /// `mac kill <job>`.
    Kill { job: u32 },
    /// `mac pull <path> [to]`: a file or folder from the agent's folder on the Mac into its worktree here.
    Pull { path: String, to: Option<String> },
    /// `mac sim start [--device <type>]`: an iOS simulator of the agent's own on the Mac, booted, which `agent-device`
    /// drives from then on. One per agent; the same one again while it holds it. `device` names a device type
    /// ("iPad Pro 13-inch (M5)"); absent, the Mac's plain iPhone. `wait`: while none is free, the agent joins the
    /// Mac's line of agents waiting for one and hears its place ([`MacDone::SimQueued`]); asking again keeps it, and
    /// the agents ahead get theirs first. Without it (`--no-wait`, an older `mac`) the Mac says why there is none.
    SimStart {
        #[serde(default)]
        device: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        wait: bool,
    },
    /// `mac sim end`: the simulator goes. Nothing touched for 30 minutes, it goes on its own.
    SimEnd,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MacEnv {
    pub name: String,
    pub value: String,
}

/// The answer to a [`MacCall`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum MacDone {
    /// Where the worktree landed on the Mac, and how much went across for it.
    #[serde(rename_all = "camelCase")]
    Push {
        folder: String,
        sent_bytes: u64,
    },
    Run {
        job: u32,
    },
    /// Output from the call's offset to `offset`; `exitCode` once the job has ended and all of it was read.
    #[serde(rename_all = "camelCase")]
    Logs {
        data_b64: String,
        offset: u64,
        done: bool,
        exit_code: Option<i32>,
    },
    Ps {
        jobs: Vec<MacJob>,
    },
    Kill {
        job: u32,
        killed: bool,
    },
    /// Where it landed in the worktree.
    Pull {
        path: String,
        bytes: u64,
    },
    SimStart {
        udid: String,
        /// Its device and iOS version.
        device: String,
    },
    /// No simulator for the agent yet: its place in the Mac's line (1 is next), about how long until its simulator
    /// is ready while one can be (none while every one the Mac allows is in use), and why it waits.
    SimQueued {
        place: u32,
        secs: Option<u64>,
        why: String,
    },
    SimEnd {
        ended: bool,
    },
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MacJob {
    pub job: u32,
    pub command: String,
    pub background: bool,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub started_ms: i64,
}

/// Made by the agent's node: which machine is the agents' Mac, and the key to seal to it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MacWhereCall {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MacWhereResult {
    pub machine_id: MachineId,
    pub box_pub_key: BoxPublicKey,
}

/// Made by the agent's node: one step sealed to the Mac's node (`mac_where`'s key), for the hub to pass on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MacSendCall {
    pub machine_id: MachineId,
    /// The agent's session the node made it for.
    pub thread_id: ThreadId,
    pub sealed: NonEmpty,
}

/// The Mac's answer, sealed back to the agent's node.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MacSendResult {
    pub sealed: NonEmpty,
}

/// Who a step comes from, as the hub knows the caller: the Mac keeps each agent's folder by it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MacCaller {
    pub machine_id: MachineId,
    pub project_id: ProjectId,
    pub task_id: Option<TaskId>,
    pub thread_id: ThreadId,
}

/// Hub -> the Mac's node: one sealed step of an agent's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MacCallFrame {
    pub id: NonEmpty,
    pub caller: MacCaller,
    pub sealed: NonEmpty,
}

/// The Mac's node -> hub: the step's answer, sealed to the agent's node; an error only when it couldn't open the step.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MacResultFrame {
    pub id: NonEmpty,
    pub sealed: Option<NonEmpty>,
    pub error: Option<McpToolError>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_mac_call_reads_as_its_step() {
        let call: MacCall = serde_json::from_value(json!({
            "step": "run", "args": ["xcodebuild", "-version"], "env": [{ "name": "GH_TOKEN", "value": "v" }],
        }))
        .unwrap();
        assert_eq!(
            call,
            MacCall::Run {
                args: vec!["xcodebuild".into(), "-version".into()],
                env: vec![MacEnv {
                    name: "GH_TOKEN".into(),
                    value: "v".into()
                }],
                background: false,
            }
        );
        let done = serde_json::to_value(MacDone::Logs {
            data_b64: String::new(),
            offset: 3,
            done: true,
            exit_code: Some(0),
        })
        .unwrap();
        assert_eq!(
            done,
            json!({ "step": "logs", "dataB64": "", "offset": 3, "done": true, "exitCode": 0 })
        );
        // An older `mac` sends sim_start without a device: the golden's.
        for (sent, device) in [
            (json!({ "step": "sim_start" }), None),
            (json!({ "step": "sim_start", "device": null }), None),
            (
                json!({ "step": "sim_start", "device": "iPad Air 11-inch" }),
                Some("iPad Air 11-inch".to_owned()),
            ),
        ] {
            assert_eq!(
                serde_json::from_value::<MacCall>(sent).unwrap(),
                MacCall::SimStart {
                    device,
                    wait: false
                }
            );
        }
        // An older `mac` waits for nothing; this one waits its turn in the Mac's line.
        assert_eq!(
            serde_json::from_value::<MacCall>(json!({ "step": "sim_start", "wait": true }))
                .unwrap(),
            MacCall::SimStart {
                device: None,
                wait: true
            }
        );
    }
}
