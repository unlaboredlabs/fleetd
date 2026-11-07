//! The hub admin's setup: one list of steps that `fleetd init`, the app's first run and
//! Settings › Hub › Setup all render. Each step's guide (why, the values to paste computed for this hub, the
//! provider's pages) is here; its status is read from the doctor's checks, never from how far a wizard got. The only
//! state kept is which steps the admin put off for later, so setup resumes anywhere.
pub mod tools;

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;

use fleetd_contracts::doctor::DoctorFix;
use fleetd_contracts::setup::{
    HubSetupStep, SetupGroup, SetupLink, SetupNeed, SetupPart, SetupStatus, SetupStepId,
    SetupValue, SetupWay, matches_check,
};

use crate::hub::doctor::checks::{DoctorCheck, DoctorStatus};

fn link(label: &str, url: impl Into<String>) -> SetupLink {
    SetupLink {
        label: label.into(),
        url: url.into(),
    }
}

fn value(label: &str, value: impl Into<String>) -> SetupValue {
    SetupValue {
        label: label.into(),
        value: value.into(),
        ..SetupValue::default()
    }
}

fn noted(label: &str, v: impl Into<String>, note: impl Into<String>) -> SetupValue {
    SetupValue {
        note: Some(note.into()),
        ..value(label, v)
    }
}

/// Words to follow, not a value to paste.
fn plain(label: &str, words: &str) -> SetupValue {
    SetupValue {
        plain: Some(true),
        ..value(label, words)
    }
}

/// A command to run, with where.
fn command(label: &str, cmd: impl Into<String>, note: Option<&str>) -> SetupValue {
    SetupValue {
        command: Some(true),
        note: note.map(str::to_owned),
        ..value(label, cmd)
    }
}

fn part(
    title: &str,
    note: Option<&str>,
    links: Vec<SetupLink>,
    values: Vec<SetupValue>,
) -> SetupPart {
    SetupPart {
        title: title.into(),
        optional: None,
        note: note.map(str::to_owned),
        links,
        values,
    }
}

fn way(label: Option<&str>, checks: &[&str]) -> SetupWay {
    SetupWay {
        label: label.map(str::to_owned),
        checks: checks.iter().map(|c| (*c).to_owned()).collect(),
    }
}

/// The host's first label, which names this hub at each provider: `fleetd on devbox`.
pub(crate) fn host_of(hub: &str) -> String {
    let rest = hub.split_once("://").map_or(hub, |(_, r)| r);
    let authority = rest.split('/').next().unwrap_or_default();
    let host = match authority.rsplit_once(':') {
        Some((h, port)) if port.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => authority,
    };
    let host = host.trim_matches(['[', ']']);
    // An address names no machine: say "hub".
    if host.parse::<std::net::IpAddr>().is_ok() || host.is_empty() {
        return "hub".into();
    }
    host.split('.').next().unwrap_or("hub").to_owned()
}

/// What the person pastes in their own (admin) account on the agents' Mac: each line commented with why.
pub const MAC_ADMIN_BLOCK: &str = "\
# A standard (non-admin) user of its own for agents. You choose its password and keep it.
sudo sysadminctl -addUser agents -fullName \"fleetd agents\" -password -
# Simulators and debugging for that user, with no admin prompt.
sudo dseditgroup -o edit -a agents -t user _developer
sudo DevToolsSecurity -enable
# Xcode's licence and its system components, which only an admin can accept and install.
sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
# Your own home closed to every other user, agents included.
chmod 700 ~";

/// The actions the hub's boat.dev key needs, and no more: `ssh` lets the hub's own SSH key in on each machine it wakes,
/// for the tunnel its node reaches the hub through; it never runs a command there (`exec`, `file.*`).
pub const BOAT_KEY_ACTIONS: &str = "sandbox.create sandbox.read sandbox.update sandbox.stop sandbox.resume sandbox.delete ssh account.read";

/// Every step in order, its values computed for `hub` (the URL devices reach it at), status still to read.
pub fn guides(hub: &str) -> Vec<HubSetupStep> {
    let base = hub.trim_end_matches('/');
    let host = host_of(base);
    let name = format!("fleetd on {host}");
    let step = |id, group, title: &str, why: &str, need| HubSetupStep {
        id,
        group,
        title: title.into(),
        why: why.into(),
        need,
        status: SetupStatus::Todo,
        said: None,
        way: None,
        fix: None,
        failing: None,
        parts: Vec::new(),
        fields: Vec::new(),
        fields_note: None,
        place: None,
        test: None,
        ways: Vec::new(),
    };
    vec![
        HubSetupStep {
            parts: vec![part(
                "Pick the address",
                Some(
                    "Your tailnet keeps it private, and plain HTTP is fine there. HTTPS (Tailscale Serve) is optional.",
                ),
                vec![link(
                    "Tailscale admin",
                    "https://login.tailscale.com/admin/machines",
                )],
                vec![noted(
                    "Hub address",
                    base,
                    "Another address: run fleetd init again on the hub and pick it.",
                )],
            )],
            test: Some("Reach the hub at its address".into()),
            ways: vec![way(None, &["hub/reachable", "hub/https"])],
            ..step(
                SetupStepId::Address,
                SetupGroup::Hub,
                "Where the hub listens",
                "Your devices and machines reach the hub at this address; a tailnet keeps it off the internet.",
                SetupNeed::Required,
            )
        },
        HubSetupStep {
            parts: vec![
                part(
                    "Add a machine",
                    Some(
                        "The hub's own machine can run agents too: fleetd init on the hub offers it. In the app, \
                     Settings › Hub › Machines › Add machine does the same.",
                    ),
                    vec![],
                    vec![
                        command(
                            "On the hub, for a code",
                            "fleetd pair --worker <name>",
                            None,
                        ),
                        command(
                            "On the machine",
                            format!("fleetd init --join {base} --code <code>"),
                            Some("Or, from the hub, over SSH: fleetd machine add <ssh host>."),
                        ),
                    ],
                ),
                part(
                    "Turn on iOS or Android screens (optional)",
                    Some(
                        "A browser and a Linux desktop are on wherever they can run. iOS simulators (a Mac with Xcode) and \
                     Android emulators (Linux with KVM) install once a machine is opted in: its switch in Settings › \
                     Hub › Machines › Screens.",
                    ),
                    vec![],
                    vec![],
                ),
            ],
            place: Some("machines".into()),
            ways: vec![way(None, &["*/online"])],
            ..step(
                SetupStepId::Machines,
                SetupGroup::Hub,
                "Machines that run agents",
                "Agents run on machines; the hub's own machine can be one.",
                SetupNeed::Required,
            )
        },
        // Any one way is enough (D200): the hub's API key, the owner's subscription, or every machine's own login.
        HubSetupStep {
            parts: vec![
                part(
                    "Give the hub an API key",
                    Some(
                        "Projects' leads and work nobody started run on it, and so does anyone who picks the hub's \
                         API in Settings › Your accounts › Claude. Machines need no login of their own.",
                    ),
                    vec![link(
                        "Claude Console › API keys",
                        "https://console.anthropic.com/settings/keys",
                    )],
                    vec![
                        value("Key name", &name),
                        plain(
                            "Where",
                            "Paste it on Settings › Hub accounts › Claude, with an endpoint if you use a gateway; the app \
                             seals it on your device.",
                        ),
                    ],
                ),
                part(
                    "Or connect your own subscription",
                    Some(
                        "Without a hub key, leads and work nobody started run on the owner's subscription. Paste the \
                         token in Settings › Your accounts › Claude; the app seals it on your device.",
                    ),
                    vec![],
                    vec![command(
                        "On any computer with claude",
                        "claude setup-token",
                        None,
                    )],
                ),
                part(
                    "Or log Claude in on each machine",
                    Some("Each machine's agents run on the Claude account logged in there."),
                    vec![],
                    vec![command("On each machine", "claude auth login", None)],
                ),
            ],
            place: Some("claude".into()),
            test: Some("Read the account's last Test and each machine's login".into()),
            ways: vec![
                way(Some("the hub's API key"), &["hub/claude_key"]),
                way(Some("the owner's subscription"), &["hub/claude_owner"]),
                way(Some("each machine's own login"), &["*/claude_login"]),
            ],
            ..step(
                SetupStepId::Claude,
                SetupGroup::Accounts,
                "Claude",
                "Agents think with Claude: the hub's API key, your subscription, or each machine's login.",
                SetupNeed::Required,
            )
        },
        // The hub's own GitHub App (D190) first; gh logged in on the hub still works without one.
        HubSetupStep {
            parts: vec![
                part(
                    "Create the hub's GitHub App",
                    Some(
                        "On Settings › Hub accounts › GitHub: one button, nothing to paste. GitHub hands the App's keys straight to the hub.",
                    ),
                    vec![],
                    vec![command(
                        "Or on the hub, from a terminal",
                        "fleetd github-app create",
                        None,
                    )],
                ),
                part(
                    "Install it on the repositories fleetd works on",
                    Some(
                        "Then each person connects their own GitHub in Settings › Your accounts › GitHub, so the PRs of their orders open as them.",
                    ),
                    vec![],
                    vec![],
                ),
            ],
            place: Some("github".into()),
            test: Some(
                "Mint a token for each installation, or ask gh who it is logged in as".into(),
            ),
            ways: vec![
                way(Some("the hub's GitHub App"), &["hub/github_app"]),
                way(Some("gh on the hub"), &["hub/gh_auth"]),
            ],
            ..step(
                SetupStepId::Github,
                SetupGroup::Accounts,
                "GitHub",
                "The hub opens PRs, reads their CI and merges them.",
                SetupNeed::Before {
                    what: "the first PR".into(),
                },
            )
        },
        HubSetupStep {
            parts: vec![part(
                "Invite someone",
                Some(
                    "The invite is a link and a code, for one person, good for 7 days. Send it to them yourself.",
                ),
                vec![],
                vec![command(
                    "On the hub",
                    "fleetd invite --name <name>",
                    Some("--role admin for another admin."),
                )],
            )],
            place: Some("invites".into()),
            ways: vec![way(None, &["hub/people"])],
            ..step(
                SetupStepId::People,
                SetupGroup::People,
                "Invite people",
                "Each person gets their own sign-in, chats and Navi; you choose who is an admin.",
                SetupNeed::Optional,
            )
        },
        // A Mac for agents (D298, docs: agents-mac.md): optional. The admin steps happen in the person's own account; the rest
        // in the agents user, which the node then checks as itself.
        HubSetupStep {
            parts: vec![
                part(
                    "In your own account: make the agents' user",
                    Some(
                        "On the Mac, in your own (admin) account's Terminal: the only step that needs an admin. Paste it \
                         as it is; sysadminctl asks for the new user's password, which you keep (agents never get it). \
                         A Mac nobody else uses is best: then there's no Apple ID or browser login on it at all.",
                    ),
                    vec![],
                    vec![command(
                        "In your own account's Terminal",
                        MAC_ADMIN_BLOCK,
                        Some(
                            "Each line says why. It never pipes anything from the network into sudo.",
                        ),
                    )],
                ),
                part(
                    "Log in as fleetd agents and join",
                    Some(
                        "Log out (or switch user) and log in as fleetd agents, then paste the join line in its Terminal. \
                         It refuses an admin user, installs fleetd for that user only, and joins as the agents' Mac: a \
                         tool every project's agents use, which runs no claude and no Navi and takes no secret. \
                         Settings › Hub › Machines › Add machine › A Mac for agents makes the line with its one-time code.",
                    ),
                    vec![],
                    vec![command(
                        "In fleetd agents' Terminal",
                        format!(
                            "curl -fsSL https://fleetd.sh | sh -s -- --join {base} --code <code> --machine-id mac --mac"
                        ),
                        Some(
                            "Or on the hub: fleetd pair --worker mac, then add --mac to the line it prints.",
                        ),
                    )],
                ),
                part(
                    "Two clicks at the Mac",
                    Some(
                        "Still logged in as fleetd agents: turn on fleetd in Accessibility and in Screen Recording, so \
                         agents can drive the Mac's apps and you can watch them. macOS may ask for an administrator's \
                         name and password: type yours in that System Settings dialog at the Mac itself, never through \
                         fleetd's view of its screen. Then restart its node (launchctl kickstart -k \
                         gui/$(id -u)/sh.fleetd.node): macOS gives a running process a new grant only once it starts \
                         again. It asks again from time to time; the check says when.",
                    ),
                    vec![],
                    vec![
                        command(
                            "Accessibility, at the Mac",
                            "open \"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility\"",
                            Some(
                                "In fleetd agents' Terminal: it opens the pane. Turn on fleetd there.",
                            ),
                        ),
                        command(
                            "Screen Recording, at the Mac",
                            "open \"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture\"",
                            Some("The same for Screen Recording."),
                        ),
                    ],
                ),
                part(
                    "Moving a Mac that runs fleetd in your account",
                    Some(
                        "First let the agents running on it finish (or stop them), and push any work they left: \
                         removing the old node deletes its worktrees. Join it again from fleetd agents with the same \
                         name and --rejoin (Add machine offers the line), so its history stays. Then, in your own \
                         account, stop and remove its old node: \
                         your account runs no fleetd node after. The rejoin gave the Mac a new key, so the old node \
                         would be refused anyway.",
                    ),
                    vec![],
                    vec![command(
                        "Then, in your own account's Terminal",
                        "launchctl bootout gui/$(id -u)/sh.fleetd.node; rm -rf ~/.fleetd/node",
                        Some("The fleetd app can stay: it is a client, not a node."),
                    )],
                ),
            ],
            place: Some("machines".into()),
            test: Some(
                "Read the Mac's checks, which its node runs as fleetd agents every 30 seconds"
                    .into(),
            ),
            ways: vec![SetupWay {
                label: None,
                checks: fleetd_contracts::node_link::MacCheckId::ALL
                    .iter()
                    .map(|id| format!("*/mac_{}", id.as_str()))
                    .collect(),
            }],
            ..step(
                SetupStepId::Mac,
                SetupGroup::Hub,
                "A Mac for agents",
                "Agents on every machine build, test and drive iOS simulators on one Mac, in a standard user of its \
                 own that holds none of your accounts or keys.",
                SetupNeed::Optional,
            )
        },
        // Cloud machines on boat.dev (D306, docs: cloud-machines.md): optional, on the owner's own boat account.
        HubSetupStep {
            parts: vec![
                part(
                    "Make a boat.dev organization with one seat",
                    Some(
                        "It costs the same as a personal plan, and its owner can cap their own seat, so boat.dev itself \
                         stops everything at your cap whatever fleetd does. Leave auto top-up and extra starts off: \
                         past the plan, starts are refused rather than billed.",
                    ),
                    vec![
                        link("boat.dev", "https://boat.dev"),
                        link(
                            "Seats and limits",
                            "https://docs.boat.dev/organizations/seats-and-limits",
                        ),
                        link(
                            "Control your spend",
                            "https://docs.boat.dev/billing#control-your-spend",
                        ),
                    ],
                    vec![
                        plain(
                            "Plan",
                            "$20 a month: it includes $20 of machine time and 200 starts a day",
                        ),
                        plain("Billing › Auto top-up", "Off"),
                        plain("Billing › Extra starts on invoice", "Off"),
                        noted(
                            "Members › you › Machine time cap",
                            "300 hours a month",
                            "Recommended: boat.dev stops your machines within a minute of it.",
                        ),
                        noted(
                            "Members › you › Machines at once",
                            "3",
                            "Your pool size: 3 unless you change it below.",
                        ),
                    ],
                ),
                part(
                    "Make an environment for fleetd",
                    Some(
                        "Cloud machines are made in it, with none of your account's secrets, AI logins or in-machine \
                         boat.dev key.",
                    ),
                    vec![link("Environments", "https://docs.boat.dev/environments")],
                    vec![
                        value("Name", format!("fleetd-{host}")),
                        plain("Safe for third parties", "On"),
                    ],
                ),
                part(
                    "Sign in with boat, for the hub's API key",
                    Some(
                        "In the app, press Sign in with boat: you open boat.dev, sign in and type the code fleetd \
                         shows, then the hub makes this key on your account itself, keeps only it, and revokes the \
                         sign-in's own full-access key. Or make it in boat.dev › API keys and paste it there. Only \
                         what the hub needs to make, wake, stop and delete its machines, and ssh for its tunnel: the \
                         hub dials each machine it wakes and holds an SSH tunnel its node reaches the hub through, so \
                         the hub needs no public address. No exec, file or snapshot actions: the hub never runs \
                         anything on a cloud machine.",
                    ),
                    vec![link("API key scopes", "https://docs.boat.dev/api-keys/scopes")],
                    vec![
                        value("Name", format!("fleetd-{host}")),
                        noted(
                            "Actions",
                            BOAT_KEY_ACTIONS,
                            "Not the presets: ci and admin give far more.",
                        ),
                        value("Scope: environment", format!("fleetd-{host}")),
                        noted(
                            "Expires",
                            "364 days",
                            "Signing in makes it so: boat makes no key that outlives the sign-in's own year.",
                        ),
                    ],
                ),
                part(
                    "Choose the pool, the budgets and the projects",
                    Some(
                        "Once the key is saved and Test passes, pick these and turn cloud machines on. Before you do, \
                         fleetd shows the most the pool can cost a day and a typical day. Work goes to a cloud machine \
                         only when every machine of yours is at its agent limit.",
                    ),
                    vec![],
                    vec![
                        noted(
                            "boat.dev environment",
                            format!("fleetd-{host}"),
                            "The one you made in part 2: machines are made in it, where the key reaches.",
                        ),
                        plain("Machines", "3 × large (8 vCPUs, 16 GB, $0.072 an hour each)"),
                        plain("Day budget", "$3"),
                        plain("Month budget", "your plan's included dollars ($20)"),
                        plain(
                            "Projects",
                            "the ones you tick: their code, transcripts and the secrets sealed there go to boat.dev",
                        ),
                    ],
                ),
            ],
            fields_note: Some(
                "Cloud machines run on boat.dev: boat.dev can see what runs on them, as any host can. Sign in with \
                 boat (or paste a key), set the pool and turn it on in Settings › Hub › Machines › Cloud machines."
                    .into(),
            ),
            place: Some("cloud".into()),
            test: Some(
                "Ask boat.dev what the key may read, then wake (or make) a cloud machine and check the hub's tunnel to \
                 it and its node's hello"
                    .into(),
            ),
            ways: vec![way(
                None,
                &[
                    "hub/cloud_key",
                    "hub/cloud_network",
                    "hub/cloud_machines",
                    "hub/cloud_budget",
                ],
            )],
            ..step(
                SetupStepId::Cloud,
                SetupGroup::Hub,
                "Cloud machines (boat.dev)",
                "When every machine of yours is at its agent limit, work runs on a few sleeping boat.dev machines of \
                 your own account, within budgets you set.",
                SetupNeed::Optional,
            )
        },
    ]
}

/// How bad a check's status is: ok, then unknown ("not set up"), warn, fail.
pub(super) fn rank(s: DoctorStatus) -> u8 {
    match s {
        DoctorStatus::Ok => 0,
        DoctorStatus::Unknown => 1,
        DoctorStatus::Warn => 2,
        DoctorStatus::Fail => 3,
    }
}

/// One way's status, and the check that decides it: none yet, or the worst unknown ("not set up"), is to do; the
/// worst failing or warning wants a look; all passing is done.
fn read_way<'a>(
    way: &SetupWay,
    checks: &'a [DoctorCheck],
) -> (SetupStatus, Option<&'a DoctorCheck>) {
    let worst = checks
        .iter()
        .filter(|c| way.checks.iter().any(|p| matches_check(p, &c.id)))
        .fold(None::<&DoctorCheck>, |w, c| match w {
            Some(w) if rank(w.status) >= rank(c.status) => Some(w),
            _ => Some(c),
        });
    let status = match worst.map(|c| c.status) {
        None | Some(DoctorStatus::Unknown) => SetupStatus::Todo,
        Some(DoctorStatus::Ok) => SetupStatus::Done,
        Some(_) => SetupStatus::Look,
    };
    (status, worst)
}

/// Each step's status is its best way's: one way done is enough, else one set up but failing wants a look, else it is
/// to do.
pub fn read(guides: Vec<HubSetupStep>, checks: &[DoctorCheck]) -> Vec<HubSetupStep> {
    guides
        .into_iter()
        .map(|mut step| {
            let reads: Vec<_> = step.ways.iter().map(|w| (w, read_way(w, checks))).collect();
            let best = [SetupStatus::Done, SetupStatus::Look, SetupStatus::Todo]
                .into_iter()
                .find_map(|s| reads.iter().find(|(_, (status, _))| *status == s));
            let check = best
                .and_then(|(_, (_, c))| *c)
                .or_else(|| reads.iter().find_map(|(_, (_, c))| *c));
            let status = best.map_or(SetupStatus::Todo, |(_, (s, _))| *s);
            step.status = status;
            if step.ways.len() > 1
                && let Some((w, (s, _))) = best
                && *s != SetupStatus::Todo
            {
                step.way = w.label.clone();
            }
            step.said = check.map(|c| c.message.clone());
            step.failing = (status == SetupStatus::Look)
                .then(|| check.is_some_and(|c| c.status == DoctorStatus::Fail));
            step.fix = check
                .filter(|_| status != SetupStatus::Done)
                .and_then(|c| c.fix.as_ref())
                .and_then(crate::hub::usage::wire::convert::<_, DoctorFix>);
            step
        })
        .collect()
}

/// GitHub is needed only before the first PR: on a hub with no project of code yet no PR can open, so gh logged out
/// (or missing) there is GitHub not set up yet, "todo", not failing. Once a project exists, it fails as the doctor says.
pub fn before_first_use(mut checks: Vec<DoctorCheck>, code_projects: usize) -> Vec<DoctorCheck> {
    if code_projects == 0 {
        for c in checks
            .iter_mut()
            .filter(|c| c.id == "hub/gh_auth" && c.status == DoctorStatus::Fail)
        {
            c.status = DoctorStatus::Unknown;
        }
    }
    checks
}
