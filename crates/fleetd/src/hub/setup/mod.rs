//! The hub admin's setup (docs/design/setup.md): one list of steps that `fleetd init`, the app's first run and
//! Administration › Setup all render. Each step's guide (why, the values to paste computed for this hub, the
//! provider's pages) is here; its status is read from the doctor's checks, never from how far a wizard got. The only
//! state kept is which steps the admin put off for later, so setup resumes anywhere.
pub mod tools;

#[cfg(test)]
mod tests;

use std::collections::BTreeSet;

use fleetd_contracts::doctor::DoctorFix;
use fleetd_contracts::google::{GOOGLE_REDIRECT, GOOGLE_SCOPES};
use fleetd_contracts::setup::{
    HubSetupStep, SetupGroup, SetupLink, SetupNeed, SetupPart, SetupStatus, SetupStepId,
    SetupValue, SetupWay, matches_check,
};
use rusqlite::params;

use crate::hub::doctor::checks::{DoctorCheck, DoctorStatus};
use crate::hub::store::{HubDb, StoreError};

/// Gmail in real time (D195): Gmail publishes to this topic as its push account, and one machine reads the
/// subscription as this service account.
const GMAIL_TOPIC: &str = "fleetd-gmail";
const GMAIL_SUBSCRIPTION: &str = "fleetd-gmail-hub";
const GMAIL_PUSH: &str = "gmail-api-push@system.gserviceaccount.com";
const GMAIL_READER: &str = "fleetd-gmail-reader";

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
fn host_of(hub: &str) -> String {
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

/// The Cloud project id the guide proposes, `fleetd-<host>`, within Google's rules: up to 30 lowercase letters,
/// digits and dashes, starting with a letter and not ending with a dash.
fn cloud_project(host: &str) -> String {
    let id: String = format!("fleetd-{host}")
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(30)
        .collect();
    id.trim_end_matches('-').to_owned()
}

/// Each scope in words where it is pasted, and what it is for (the app's google/model.ts).
fn scope_words(scope: &str) -> (&str, &str) {
    match scope {
        "openid" => ("Account", "Which account is connected."),
        "email" => ("Address", "Which account is connected."),
        "https://www.googleapis.com/auth/gmail.readonly" => {
            ("Read mail", "Searching and reading mail.")
        }
        "https://www.googleapis.com/auth/gmail.compose" => (
            "Draft and send",
            "Drafts, sends and replies. It can't delete mail or change labels.",
        ),
        "https://www.googleapis.com/auth/calendar.events" => {
            ("Calendar", "Reading, making and changing events.")
        }
        "https://www.googleapis.com/auth/drive" => {
            ("Drive", "Searching, reading, uploading and sharing files.")
        }
        other => (
            other.trim_start_matches("https://www.googleapis.com/auth/"),
            "",
        ),
    }
}

/// The Google step's parts for this hub: the Cloud project, the APIs, the sign-in screen with the scopes the hub asks
/// for, a Desktop app client with the loopback redirect (so a plain-HTTP tailnet hub works), and Gmail in real time.
fn google_parts(host: &str) -> Vec<SetupPart> {
    let name = format!("fleetd on {host}");
    let project = cloud_project(host);
    let reader = format!("{GMAIL_READER}@{project}.iam.gserviceaccount.com");
    let shell = [
        format!("gcloud config set project {project}"),
        format!("SA={reader}"),
        [
            "gcloud services enable pubsub.googleapis.com".to_owned(),
            format!("gcloud pubsub topics create {GMAIL_TOPIC}"),
            format!(
                "gcloud pubsub topics add-iam-policy-binding {GMAIL_TOPIC} --member=serviceAccount:{GMAIL_PUSH} --role=roles/pubsub.publisher"
            ),
            format!("gcloud pubsub subscriptions create {GMAIL_SUBSCRIPTION} --topic={GMAIL_TOPIC}"),
            format!("gcloud iam service-accounts create {GMAIL_READER}"),
            "sleep 30".to_owned(),
            format!(
                "gcloud pubsub subscriptions add-iam-policy-binding {GMAIL_SUBSCRIPTION} --member=serviceAccount:$SA --role=roles/pubsub.subscriber"
            ),
            "gcloud iam service-accounts keys create key.json --iam-account=$SA".to_owned(),
            "cat key.json && rm key.json".to_owned(),
        ]
        .join(" &&\n"),
    ]
    .join("\n");
    vec![
        part(
            "Create a Google Cloud project",
            None,
            vec![link(
                "New project",
                "https://console.cloud.google.com/projectcreate",
            )],
            vec![noted(
                "Project name",
                &project,
                format!(
                    "Keep the project ID the same as the name. IDs are global across Google Cloud: if {project} is \
                     taken, take the ID Google offers and use it wherever {project} appears below."
                ),
            )],
        ),
        part(
            "Turn on Gmail, Calendar and Drive",
            None,
            vec![link(
                "Enable the three APIs",
                "https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com",
            )],
            vec![],
        ),
        part(
            "Set up the sign-in screen",
            None,
            vec![
                link("Branding", "https://console.cloud.google.com/auth/branding"),
                link("Audience", "https://console.cloud.google.com/auth/audience"),
            ],
            vec![
                value("App name", &name),
                plain(
                    "Audience",
                    "Internal if everyone is in your Google Workspace; otherwise External.",
                ),
                plain(
                    "Publishing status",
                    "External: press Publish app, so it is In production. In Testing, Google ends each connection after 7 days.",
                ),
            ],
        ),
        part(
            "Add the scopes",
            Some(
                "Gmail and Drive are restricted scopes: until Google verifies the app, people see a warning when they \
                 connect and press Advanced, then Go to the app. An unverified app takes up to 100 people.",
            ),
            vec![link(
                "Data access",
                "https://console.cloud.google.com/auth/scopes",
            )],
            GOOGLE_SCOPES
                .iter()
                .map(|s| {
                    let (label, why) = scope_words(s);
                    SetupValue {
                        note: (!why.is_empty()).then(|| why.to_owned()),
                        ..value(label, *s)
                    }
                })
                .collect(),
        ),
        part(
            "Create the OAuth client",
            None,
            vec![link(
                "Create client",
                "https://console.cloud.google.com/auth/clients/create",
            )],
            vec![
                plain("Application type", "Desktop app"),
                value("Name", &name),
                noted(
                    "Redirect URI",
                    GOOGLE_REDIRECT,
                    "Nothing to register: a Desktop app client takes it on any port. When someone connects, the fleetd \
                     app listens on a free port on their own computer, and Google sends them back there.",
                ),
            ],
        ),
        SetupPart {
            optional: Some(true),
            ..part(
                "Gmail in real time",
                Some(
                    "New mail reaches Navi in seconds. Gmail publishes to a Pub/Sub topic and fleetd pulls from it, so \
                     no public address is needed. Without it, Navi checks Gmail about every minute.",
                ),
                vec![
                    link(
                        "Enable Pub/Sub",
                        "https://console.cloud.google.com/flows/enableapi?apiid=pubsub.googleapis.com",
                    ),
                    link(
                        "Create the topic",
                        "https://console.cloud.google.com/cloudpubsub/topic/create",
                    ),
                    link(
                        "Create the subscription",
                        "https://console.cloud.google.com/cloudpubsub/subscription/create",
                    ),
                ],
                vec![
                    noted(
                        "Topic ID",
                        GMAIL_TOPIC,
                        format!(
                            "Untick \"Add a default subscription\". Its full name is \
                             projects/{project}/topics/{GMAIL_TOPIC}."
                        ),
                    ),
                    noted(
                        "Publisher on the topic",
                        GMAIL_PUSH,
                        "Topic › Permissions › Add principal, role Pub/Sub Publisher. Gmail publishes as this account.",
                    ),
                    noted(
                        "Subscription ID",
                        GMAIL_SUBSCRIPTION,
                        format!(
                            "Topic {GMAIL_TOPIC}, delivery type Pull. Its full name is \
                             projects/{project}/subscriptions/{GMAIL_SUBSCRIPTION}."
                        ),
                    ),
                ],
            )
        },
        SetupPart {
            optional: Some(true),
            ..part(
                "A key to read it",
                Some(
                    "A service account that may only read the subscription. Its key goes to one machine, which pulls \
                     new-mail notices and passes them to the hub.",
                ),
                vec![
                    link(
                        "Create the service account",
                        "https://console.cloud.google.com/iam-admin/serviceaccounts/create",
                    ),
                    link(
                        "Subscriptions",
                        "https://console.cloud.google.com/cloudpubsub/subscription/list",
                    ),
                    link(
                        "Service accounts",
                        "https://console.cloud.google.com/iam-admin/serviceaccounts",
                    ),
                ],
                vec![
                    noted(
                        "Service account ID",
                        GMAIL_READER,
                        "No project roles: skip the optional steps and press Done.",
                    ),
                    noted(
                        "Subscriber on the subscription",
                        &reader,
                        "Subscriptions › the subscription above › Permissions › Add principal, role Pub/Sub Subscriber.",
                    ),
                    plain(
                        "Key",
                        "Service accounts › the account above › Keys › Add key › Create new key › JSON. Paste the \
                         downloaded file on Administration › Google, then delete it.",
                    ),
                    SetupValue {
                        command: Some(true),
                        ..noted(
                            "Or in Cloud Shell",
                            shell,
                            format!(
                                "Both parts in one go, in project {project}: it prints the key once, to paste. A new \
                                 account can take a minute to show up; if the Subscriber grant says it doesn't exist, \
                                 run the last three lines again. If your organization refuses the key \
                                 (iam.disableServiceAccountKeyCreation), an organization admin lifts that policy for \
                                 this project; or leave real-time mail off, and Navi checks mail about every minute."
                            ),
                        )
                    },
                ],
            )
        },
    ]
}

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
                vec![link("Tailscale admin", "https://login.tailscale.com/admin/machines")],
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
            parts: vec![part(
                "Add a machine",
                Some(
                    "The hub's own machine can run agents too: fleetd init on the hub offers it. In the app, \
                     Administration › Machines › Add machine does the same.",
                ),
                vec![],
                vec![
                    command("On the hub, for a code", "fleetd pair --worker <name>", None),
                    command(
                        "On the machine",
                        format!("fleetd init --join {base} --code <code>"),
                        Some("Or, from the hub, over SSH: fleetd machine add <ssh host>."),
                    ),
                ],
            )],
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
                         API in Settings › Claude. Machines need no login of their own.",
                    ),
                    vec![link(
                        "Claude Console › API keys",
                        "https://console.anthropic.com/settings/keys",
                    )],
                    vec![
                        value("Key name", &name),
                        plain(
                            "Where",
                            "Paste it on Administration › Claude, with an endpoint if you use a gateway; the app \
                             seals it on your device.",
                        ),
                    ],
                ),
                part(
                    "Or connect your own subscription",
                    Some(
                        "Without a hub key, leads and work nobody started run on the owner's subscription. Paste the \
                         token in Settings › Claude; the app seals it on your device.",
                    ),
                    vec![],
                    vec![command("On any computer with claude", "claude setup-token", None)],
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
        // The GitHub App (D190) takes this step over: its manifest link as the part, `hub/github_app` as the way.
        HubSetupStep {
            parts: vec![part(
                "Log gh in on the hub",
                Some("The merge train merges, reads CI and opens PRs with it."),
                vec![link("GitHub CLI", "https://cli.github.com")],
                vec![command("On the hub", "gh auth login", None)],
            )],
            test: Some("Ask gh who it is logged in as".into()),
            ways: vec![way(None, &["hub/gh_auth"])],
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
                Some("The invite is a link and a code, for one person, good for 7 days. Send it to them yourself."),
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
        HubSetupStep {
            parts: google_parts(&host),
            fields_note: Some(
                "Save the client ID and secret, and the Gmail subscription and key if you set them up, on \
                 Administration › Google: the app seals the secrets on your device. Then each person connects their \
                 own Google account from their Navi; if a sign-in lapses, Navi offers Reconnect."
                    .into(),
            ),
            place: Some("google".into()),
            test: Some("Ask Google whether it knows this client".into()),
            ways: vec![way(None, &["hub/google"])],
            ..step(
                SetupStepId::Google,
                SetupGroup::Integrations,
                "Google",
                "Each person's Navi reads and drafts their mail, calendar and Drive, through a Google client you own.",
                SetupNeed::Optional,
            )
        },
        HubSetupStep {
            parts: vec![part(
                "Each person makes their own integration",
                Some(
                    "Nothing to set up for the hub: each person connects Notion on their Navi's Integrations, with an \
                     internal integration of their own, and shares with it only the pages Navi may use.",
                ),
                vec![link("Notion › Integrations", "https://www.notion.so/profile/integrations")],
                vec![
                    value("Integration name", &name),
                    plain("Type", "Internal, in the workspace Navi should use."),
                ],
            )],
            ways: vec![way(None, &["hub/notion"])],
            ..step(
                SetupStepId::Notion,
                SetupGroup::Integrations,
                "Notion",
                "Navis read and write the Notion pages each person shares with them.",
                SetupNeed::Optional,
            )
        },
    ]
}

fn rank(s: DoctorStatus) -> u8 {
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
/// to do, or later when the admin skipped it.
pub fn read(
    guides: Vec<HubSetupStep>,
    checks: &[DoctorCheck],
    skipped: &BTreeSet<SetupStepId>,
) -> Vec<HubSetupStep> {
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
            step.status = match status {
                SetupStatus::Todo if skipped.contains(&step.id) => SetupStatus::Skipped,
                s => s,
            };
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

/// The steps the admin put off for later.
pub fn skipped(db: &HubDb) -> Result<BTreeSet<SetupStepId>, StoreError> {
    db.with(|c| {
        let mut stmt = c.prepare("SELECT step FROM setup_skips")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids.iter().filter_map(|s| SetupStepId::parse(s)).collect())
    })
}

pub fn set_skipped(
    db: &HubDb,
    step: SetupStepId,
    skipped: bool,
    now_ms: i64,
) -> Result<(), StoreError> {
    db.with(|c| {
        if skipped {
            c.execute(
                "INSERT INTO setup_skips (step, at_ms) VALUES (?, ?) ON CONFLICT (step) DO NOTHING",
                params![step.as_str(), now_ms],
            )?;
        } else {
            c.execute(
                "DELETE FROM setup_skips WHERE step = ?",
                params![step.as_str()],
            )?;
        }
        Ok(())
    })
}
