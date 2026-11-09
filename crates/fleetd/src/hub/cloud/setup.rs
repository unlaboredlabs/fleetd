//! The script a new cloud machine runs once to become a fleetd machine (design §2.3, with review S1, S2, S8, S9, S14
//! and B2): `setup.sh`, rendered here for one slot. hub/pool creates the VM with it as boat's `setupScript`, and with
//! the slot's pool enroll token (`Auth::create_pool_enroll_token`) as a 0600 file at [`TOKEN_FILE`]: under `/tmp`,
//! which boat never snapshots, read once and deleted. The script:
//! - makes a fresh `/etc/machine-id`, so a VM copied from boat's image enrolls as a computer of its own (boat makes
//!   another at every wake, which no hello compares);
//! - makes the agents' user ([`AGENT_USER`], no sudo), whose node and agents never get root, lingering through a system
//!   unit that sets it again at every wake: boat boots a wake before it attaches the VM's disk, so logind misses it;
//! - installs pinned `gh` and sccache (checked against their release checksums), Xvfb, the Claude Code this fleetd was
//!   tested with in the agents' home (first on the node's PATH, before boat's own, which floats), and Rust with its
//!   `RUSTUP_HOME` and `CARGO_HOME` in the agents' home (boat's point at a directory the agents can't write);
//! - has sshd drop a client silent for 45 s, again at every wake through a system unit, which then ends the sessions
//!   opened under the old config (the hub's first tunnel), so an unclean drop of the hub's tunnel frees its port for
//!   the hub's redial;
//! - waits for the hub's tunnel (hub/pool/tunnel: the hub dials the machine and forwards its loopback port to itself),
//!   then joins the hub through it with the ordinary join line, on the hub's release channel (a stable hub pins its
//!   exact release; an edge machine starts on the newest edge build, never older than the hub, and its catch-up evens
//!   it out);
//! - sizes the node for builds (`warmBuilds`, desktops in Xvfb; the hub sizes its cap at [`MEM_PER_AGENT_GB`]), puts
//!   sccache on the disk that survives a stop, has git ask `gh` for GitHub's credentials so `git push` uses the order's
//!   `GH_TOKEN` (nobody logs `gh` in on the machine), and writes boat's pre-stop hook (`fleetd node flush`).
//!
//! What the steps print goes to `~/fleetd-setup.log` on the VM. A failing step exits with one line on stderr naming it
//! and its last line, which boat shows as the sandbox's `setupError` and [`failure`] makes the slot's note.
use fleetd_contracts::ids::MachineId;

use crate::cli::setup::units::q;
use crate::hub::api::Hub;
use crate::hub::pool::tunnel::machine_hub_url;
use crate::update::Channel;

const TEMPLATE: &str = include_str!("setup.sh");
/// How `setup.sh` starts the one line it prints when a step fails.
const FAILED_AT: &str = "fleetd cloud setup failed at: ";

/// Where hub/pool puts the slot's pool enroll token: boat's `files` takes `/tmp`, and never snapshots it.
pub const TOKEN_FILE: &str = "/tmp/fleetd-enroll-token";
/// The user the node and its agents run as on a cloud machine, with no sudo.
pub const AGENT_USER: &str = "fleetd";
/// Memory per agent on a cloud machine, as the hub sizes its cap (`hub/slots/sizing`): on `large` (8 vCPUs, 16 GB)
/// that is 3 agents with 2 build jobs each. Measured
/// on `large`: one build of fleetd peaks at 7.3 GB, so 3 agents and a build fit, and 2, 4 and 8 jobs build it equally
/// fast.
pub const MEM_PER_AGENT_GB: u64 = 4;
/// Warm builds per checkout on a cloud machine: one, so its `target/`s and the sccache fit its disk (review S8).
pub const WARM_BUILDS: u64 = 1;
/// `gh`, pinned with its release's checksum (linux amd64: boat machines are x86_64 Ubuntu).
const GH: (&str, &str) = (
    "2.103.3",
    "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d",
);
/// sccache, pinned with its release's checksum (x86_64 musl).
const SCCACHE: (&str, &str) = (
    "0.19.0",
    "aa73c7270c997894038c0d8f0d297865f57569e1687883322bc431713d4bb9dd",
);
const REPO: &str = "unlaboredlabs/fleetd";

/// One slot's script, as [`render`] fills it in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetupScript {
    /// The hub as the machine reaches it: its own loopback, through the hub's tunnel ([`machine_hub_url`]).
    pub hub_url: String,
    pub machine_id: MachineId,
    /// The hub's own build: its channel, and for a stable hub its exact release.
    pub version: String,
    /// A build from a release (`FLEETD_VERSION` set at build time); one built by hand pins nothing.
    pub release_build: bool,
    /// The hub's git identity, `Name <email>`, as the join line takes it.
    pub git_identity: Option<String>,
    /// The Claude Code version to install.
    pub claude: String,
}

/// The script for one slot of this hub: the tunnel's address, the hub's build and its git identity.
pub fn for_slot(hub: &Hub, machine_id: &MachineId) -> Result<String, String> {
    let git_identity = crate::cli::setup::state::read_setup(&hub.config.home)?
        .and_then(|s| s.git_identity)
        .map(|id| format!("{} <{}>", id.name, id.email));
    Ok(render(&SetupScript {
        hub_url: machine_hub_url(),
        machine_id: machine_id.clone(),
        version: crate::version().to_owned(),
        release_build: option_env!("FLEETD_VERSION").is_some(),
        git_identity,
        claude: crate::node::runner::claude::install::target().to_owned(),
    }))
}

/// `setup.sh` with the slot's values, each quoted for the shell.
pub fn render(s: &SetupScript) -> String {
    let channel = Channel::of(&s.version, s.release_build);
    let base_url = match channel {
        Channel::Stable if s.release_build => {
            let tag = format!("v{}", s.version.trim_start_matches('v'));
            format!("https://github.com/{REPO}/releases/download/{tag}")
        }
        _ => String::new(),
    };
    let values = [
        ("@HUB@", s.hub_url.clone()),
        ("@MACHINE@", s.machine_id.to_string()),
        ("@CHANNEL@", channel.as_str().to_owned()),
        ("@FLAVOUR@", crate::update::FLAVOUR.as_str().to_owned()),
        ("@BASE_URL@", base_url),
        ("@CLAUDE@", s.claude.clone()),
        ("@IDENTITY@", s.git_identity.clone().unwrap_or_default()),
        ("@TOKEN_FILE@", TOKEN_FILE.to_owned()),
        ("@AGENT@", AGENT_USER.to_owned()),
        ("@WARM_BUILDS@", WARM_BUILDS.to_string()),
        ("@GH_VERSION@", GH.0.to_owned()),
        ("@GH_SHA256@", GH.1.to_owned()),
        ("@SCCACHE_VERSION@", SCCACHE.0.to_owned()),
        ("@SCCACHE_SHA256@", SCCACHE.1.to_owned()),
    ];
    values
        .iter()
        .fold(TEMPLATE.to_owned(), |script, (at, value)| {
            script.replace(at, &q(value))
        })
}

/// A slot's note for boat's `setupError`: the script's failing step and its last line, or for a script from before it
/// printed one, the error's last line, never the whole log boat keeps.
pub fn failure(setup_error: &str) -> String {
    let lines = || setup_error.lines().map(str::trim).filter(|l| !l.is_empty());
    match lines().filter_map(|l| l.split_once(FAILED_AT)).next_back() {
        Some((_, at)) => format!("its setup failed at {at}"),
        None => format!("its setup failed: {}", lines().next_back().unwrap_or("")),
    }
}
