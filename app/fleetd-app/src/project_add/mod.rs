//! "Add project…": one sheet that clones a GitHub repo onto a worker or adds a folder already on one, opened from
//! the sidebar, the composer's project picker, the palette, the empty board, the File menu, or a folder or link
//! dropped on the window. The hub does the work (`project_discover`, `project_add`, then `project.clone_progress`
//! and `project.added` or `project.add_failed` events); this module turns its answers into what the sheet shows.

pub mod fixture;
pub mod open;
pub mod sheet;

use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ids::EventSeq;
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::mcp::{
    EventsWaitInput, EventsWaitOutput, ProjectAddInput, ProjectAddOutput, ProjectDiscoverInput, ProjectDiscoverOutput, ProjectInspectInput,
    ProjectInspectOutput, WorkspacePath,
};
use fleetd_contracts::prim::{Int, IntOr, Text};
use fleetd_contracts::projects::{
    ClonePhase, CloneProgressData, CloneTarget, ProjectAddFailedData, ProjectAddedData, ProjectInspect, ProjectProblemCode,
};

use crate::state::{Out, ProjectKey, Purpose, State, parse};

/// A machine that can take the project.
#[derive(Clone, Debug, PartialEq)]
pub struct Worker {
    pub machine_id: String,
    pub name: String,
    pub online: bool,
    /// Where a clone lands on it (absolute); None when the hub doesn't say.
    pub clone_root: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum FoundKind {
    /// A git checkout already on a worker.
    Checkout { machine_id: String, path: String },
    /// A repo `gh repo list` can see, "owner/repo".
    GitHub,
}

/// One repo the discovery found.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    /// The folder's name for a checkout, "owner/repo" for GitHub.
    pub name: String,
    pub kind: FoundKind,
    /// The quiet text on the right: a checkout's remote, where a GitHub repo is already checked out.
    pub detail: String,
    pub private: bool,
    /// Already a project: picking it opens that project.
    pub project: Option<ProjectKey>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Discovery {
    pub workers: Vec<Worker>,
    pub found: Vec<Found>,
    /// The hub's pick for a clone: online, runner ready, fewest running threads.
    pub best: Option<String>,
    /// Where `gh repo list` ran, said plainly ("the hub", "devbox"); None when gh is logged in nowhere.
    pub gh_on: Option<String>,
    /// Machines that could not be scanned and why, gh's trouble: (message, fix).
    pub problems: Vec<(String, Option<String>)>,
}

/// What the sheet asks the hub to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    /// "owner/repo" onto a machine. `use_existing` adds the destination when it already holds this repo.
    Clone { repo: String, machine_id: String, use_existing: bool },
    /// A folder already on the machine, absolute.
    Folder { machine_id: String, path: String },
}

impl Request {
    pub fn machine_id(&self) -> &str {
        match self {
            Request::Clone { machine_id, .. } | Request::Folder { machine_id, .. } => machine_id,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Step {
    Clone,
    Inspect,
    Register,
}

/// What the hub reported, for the sheet.
#[derive(Clone, Debug, PartialEq)]
pub enum Update {
    Discovered(Discovery),
    Progress {
        step: Step,
        detail: String,
        fraction: Option<f32>,
    },
    /// The add's state is unknown for now (the connection dropped): say why, and show no progress as live.
    Waiting(String),
    Ready(Ready),
    Failed(Failure),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Ready {
    pub key: ProjectKey,
    pub title: String,
    pub machine: String,
    pub path: String,
    /// "Default branch" → "main", "CI" → …, "Merge rules" → ….
    pub facts: Vec<(&'static str, String)>,
    /// The hub's one line on what the lead will need.
    pub lead_line: String,
    /// The repo has CI the merge train can wait on; false shows the line as a warning.
    pub lead_ok: bool,
    /// What the hub could not read.
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub message: String,
    pub fix: Option<String>,
    pub action: Option<FailAction>,
}

/// The one thing a failure's button does.
#[derive(Clone, Debug, PartialEq)]
pub enum FailAction {
    /// The clone's folder already holds this repo (project_inspect said so): add it as it is.
    UseExisting(Request),
    /// The hub's answer was lost with the connection and it has no record of the add: send it again.
    Retry(Request),
    /// The folder is already this project.
    Open(ProjectKey),
}

/// Events that can belong to an add.
const ADD_EVENTS: [HubEventType; 3] = [HubEventType::ProjectCloneProgress, HubEventType::ProjectAdded, HubEventType::ProjectAddFailed];
/// Events held while the add call is out; the hub never sends a clone more than a few before its answer.
const EARLY_MAX: usize = 64;

/// The add in flight. The hub answers `project_add` and streams the clone's events on separate tasks, so an event
/// can come before the answer that names its addId: those wait in `early`. A dropped connection loses both the
/// answer and any events sent meanwhile, so after reconnecting the add is looked up again from `since`.
#[derive(Clone, Debug, Default)]
pub struct Feed {
    pub updates: Vec<Update>,
    request: Option<Request>,
    add_id: Option<String>,
    /// The project_add call is out.
    awaiting: bool,
    early: Vec<HubEvent>,
    /// The last event seq this app has seen, and its value when the add started.
    seen: Option<EventSeq>,
    since: Option<EventSeq>,
    /// The connection dropped while the add ran; look it up once the snapshot is back.
    pub(crate) lost: bool,
    /// A clone's failure, held while project_inspect says whether its folder can be added instead.
    held: Option<Failure>,
}

impl Feed {
    pub(crate) fn active(&self) -> bool {
        self.request.is_some() && (self.awaiting || self.add_id.is_some())
    }

    fn finish(&mut self) {
        self.request = None;
        self.add_id = None;
        self.awaiting = false;
        self.early.clear();
        self.lost = false;
    }

    /// The add's own events: by addId once known, else (looking it up after a reconnect) by repo and machine for a
    /// clone, by path and machine for a folder.
    fn owns(&self, event: &HubEvent) -> bool {
        if !ADD_EVENTS.contains(&event.r#type) {
            return false;
        }
        let data = event.data.as_ref();
        let field = |k: &str| data.and_then(|d| d.get(k)).and_then(|v| v.as_str());
        if let Some(id) = &self.add_id {
            return field("addId") == Some(id.as_str());
        }
        let machine = event.machine_id.as_ref().map(|m| m.as_str());
        match &self.request {
            Some(Request::Clone { repo, machine_id, .. }) => machine == Some(machine_id.as_str()) && field("repo") == Some(repo.as_str()),
            Some(Request::Folder { machine_id, path }) => {
                event.r#type == HubEventType::ProjectAdded && machine == Some(machine_id.as_str()) && field("path") == Some(path.as_str())
            }
            None => false,
        }
    }
}

impl State {
    pub fn add_discover(&mut self) -> Out {
        if self.conn != crate::state::Conn::Live {
            return Vec::new();
        }
        vec![self.call(Purpose::AddDiscover, &ProjectDiscoverInput { machine_id: None, github: None })]
    }

    pub fn add_project(&mut self, request: Request) -> Out {
        let input = match &request {
            Request::Clone { repo, machine_id, use_existing } => ProjectAddInput {
                machine_id: Some(MachineId::unchecked(machine_id)),
                path: None,
                url: Some(Text::unchecked(repo)),
                dest: None,
                use_existing: use_existing.then_some(true),
                title: None,
            },
            Request::Folder { machine_id, path } => {
                let Ok(path) = WorkspacePath::new(path) else {
                    self.add.updates.push(Update::Failed(Failure {
                        message: format!("{path} isn't a full path."),
                        fix: Some("Type the folder's full path on the machine, starting with /.".into()),
                        action: None,
                    }));
                    return Vec::new();
                };
                ProjectAddInput {
                    machine_id: Some(MachineId::unchecked(machine_id)),
                    path: Some(path),
                    url: None,
                    dest: None,
                    use_existing: None,
                    title: None,
                }
            }
        };
        let seen = self.add.seen;
        self.add =
            Feed { updates: std::mem::take(&mut self.add.updates), request: Some(request), awaiting: true, seen, since: seen, ..Feed::default() };
        if self.conn != crate::state::Conn::Live {
            self.add.lost = true;
            self.add.updates.push(Update::Waiting(LOST.into()));
            return Vec::new();
        }
        vec![self.call(Purpose::AddProject, &input)]
    }

    fn machine_name(&self, machine_id: &str) -> String {
        self.machine(machine_id).map_or_else(|| machine_id.to_string(), |m| m.name.clone())
    }

    /// Every event's seq, so a lookup after a reconnect knows where the add started.
    pub(crate) fn add_saw(&mut self, seq: EventSeq) {
        if self.add.seen.is_none_or(|s| s < seq) {
            self.add.seen = Some(seq);
        }
    }

    /// The connection dropped: the add's answer and its events from now on are lost until it is looked up again.
    pub(crate) fn add_disconnected(&mut self) {
        if self.add.active() && !self.add.lost {
            self.add.lost = true;
            self.add.awaiting = false;
            self.add.early.clear();
            self.add.updates.push(Update::Waiting(LOST.into()));
        }
    }

    /// After the snapshot that follows a reconnect: the add's events since it started.
    pub(crate) fn add_reconnected(&mut self) -> Out {
        if !self.add.lost {
            return Vec::new();
        }
        self.add.lost = false;
        self.add.updates.push(Update::Waiting("Reconnected; looking up where the add got to.".into()));
        let machine_id = self.add.request.as_ref().map(|r| MachineId::unchecked(r.machine_id()));
        let input = EventsWaitInput { cursor: self.add.since, types: Some(ADD_EVENTS.to_vec()), machine_id, timeout_sec: IntOr(Int::unchecked(0)) };
        vec![self.call(Purpose::AddRecover, &input)]
    }

    pub(crate) fn on_add_result(&mut self, purpose: &Purpose, output: serde_json::Value) -> Out {
        match purpose {
            Purpose::AddDiscover => {
                let update = match parse::<ProjectDiscoverOutput>(output) {
                    Ok(out) => Update::Discovered(discovery(out, &|m| self.machine_name(m))),
                    Err(e) => Update::Discovered(Discovery { problems: vec![(e, None)], ..self.bare_discovery() }),
                };
                self.add.updates.push(update);
                Vec::new()
            }
            Purpose::AddProject => {
                self.add.awaiting = false;
                let early = std::mem::take(&mut self.add.early);
                let mut out = Vec::new();
                match parse::<ProjectAddOutput>(output) {
                    Ok(o) => match (o.add_id, o.project_id, o.inspect) {
                        (Some(id), _, _) => {
                            self.add.add_id = Some(id.to_string());
                            self.add.updates.push(Update::Progress { step: Step::Clone, detail: "Starting the clone".into(), fraction: None });
                            for event in early {
                                out.extend(self.on_add_event(&event));
                            }
                        }
                        (None, Some(project_id), Some(inspect)) => {
                            let machine = o.machine_id.to_string();
                            let title = o.path.rsplit('/').next().unwrap_or(&o.path).to_string();
                            let name = self.machine_name(&machine);
                            self.add.updates.push(Update::Ready(ready((machine, project_id.to_string()), &title, &name, &o.path, &inspect)));
                            self.add.finish();
                        }
                        _ => {
                            self.add.updates.push(Update::Failed(Failure {
                                message: "The hub added it but sent no details.".into(),
                                fix: Some("Find it in the sidebar; if it isn't there, try again.".into()),
                                action: None,
                            }));
                            self.add.finish();
                        }
                    },
                    Err(e) => {
                        self.add.updates.push(Update::Failed(Failure { message: e, fix: None, action: None }));
                        self.add.finish();
                    }
                }
                out.extend(self.request_snapshot());
                out
            }
            Purpose::AddInspect => {
                let found = parse::<ProjectInspectOutput>(output).ok().and_then(|o| o.clone);
                let request = self.add.request.clone();
                if let Some(mut failure) = self.add.held.take() {
                    failure.action = found.and_then(|c| use_instead(&c, request.as_ref()));
                    self.add.updates.push(Update::Failed(failure));
                }
                self.add.finish();
                Vec::new()
            }
            Purpose::AddRecover => match parse::<EventsWaitOutput>(output) {
                Ok(page) => {
                    let mut out = Vec::new();
                    for event in page.events.iter() {
                        if self.add.request.is_none() {
                            break;
                        }
                        if self.add.add_id.is_none()
                            && self.add.owns(event)
                            && let Some(id) = event.data.as_ref().and_then(|d| d.get("addId")).and_then(|v| v.as_str())
                        {
                            self.add.add_id = Some(id.to_string());
                        }
                        out.extend(self.on_add_event(event));
                    }
                    if self.add.request.is_none() || !out.is_empty() {
                        return out;
                    }
                    if page.more {
                        self.add.since = Some(page.cursor);
                        self.add.lost = true;
                        return self.add_reconnected();
                    }
                    match (&self.add.add_id, self.add.request.clone()) {
                        (Some(_), _) => {
                            self.add.updates.push(Update::Waiting("Reconnected. The clone is still running; its next progress shows here.".into()))
                        }
                        (None, Some(request)) => {
                            self.add.updates.push(Update::Failed(Failure {
                                message: "The connection dropped before the hub answered, and it has no record of this add.".into(),
                                fix: Some("Send it again.".into()),
                                action: Some(FailAction::Retry(request)),
                            }));
                            self.add.finish();
                        }
                        (None, None) => {}
                    }
                    Vec::new()
                }
                Err(e) => {
                    self.on_add_error(purpose, e, None);
                    Vec::new()
                }
            },
            _ => Vec::new(),
        }
    }

    pub(crate) fn on_add_error(&mut self, purpose: &Purpose, message: String, fix: Option<String>) -> Out {
        let fix = fix.filter(|f| !f.trim().is_empty());
        match purpose {
            // An older hub without project_discover: the machines from the snapshot, nothing listed.
            Purpose::AddDiscover => {
                self.add.updates.push(Update::Discovered(Discovery { problems: vec![(message, fix)], ..self.bare_discovery() }));
                Vec::new()
            }
            // A clone refused before it started, e.g. its folder exists (the hub says so as a call error): ask
            // project_inspect whether that folder is this repo before offering to add it.
            Purpose::AddProject => {
                self.add.awaiting = false;
                self.add.early.clear();
                self.hold_and_inspect(Failure { message, fix, action: None })
            }
            Purpose::AddInspect => {
                if let Some(failure) = self.add.held.take() {
                    self.add.updates.push(Update::Failed(failure));
                }
                self.add.finish();
                Vec::new()
            }
            _ => {
                self.add.updates.push(Update::Failed(Failure {
                    message: format!("Lost track of the add after reconnecting: {message}"),
                    fix: Some("Look for it in the sidebar; if it isn't there, add it again.".into()),
                    action: None,
                }));
                self.add.finish();
                Vec::new()
            }
        }
    }

    fn hold_and_inspect(&mut self, failure: Failure) -> Out {
        match self.add.request.clone() {
            Some(Request::Clone { repo, machine_id, use_existing: false }) if self.conn == crate::state::Conn::Live => {
                self.add.held = Some(failure);
                let input =
                    ProjectInspectInput { machine_id: Some(MachineId::unchecked(&machine_id)), path: None, url: Some(Text::unchecked(&repo)) };
                vec![self.call(Purpose::AddInspect, &input)]
            }
            _ => {
                self.add.updates.push(Update::Failed(failure));
                self.add.finish();
                Vec::new()
            }
        }
    }

    /// `project.clone_progress`, `project.added` and `project.add_failed` for the add in flight.
    pub(crate) fn on_add_event(&mut self, event: &HubEvent) -> Out {
        if !ADD_EVENTS.contains(&event.r#type) || self.add.request.is_none() {
            return Vec::new();
        }
        if self.add.add_id.is_none() {
            if self.add.awaiting && self.add.early.len() < EARLY_MAX {
                self.add.early.push(event.clone());
            }
            return Vec::new();
        }
        if !self.add.owns(event) {
            return Vec::new();
        }
        let data = event.data.clone().unwrap_or_default();
        match event.r#type {
            HubEventType::ProjectCloneProgress => {
                if let Ok(p) = serde_json::from_value::<CloneProgressData>(data) {
                    self.add.updates.push(progress(&p));
                }
                Vec::new()
            }
            HubEventType::ProjectAdded => {
                if let (Ok(added), Some(m), Some(p)) = (serde_json::from_value::<ProjectAddedData>(data), &event.machine_id, &event.project_id) {
                    let name = self.machine_name(m);
                    self.add.updates.push(Update::Ready(ready((m.to_string(), p.to_string()), &added.title, &name, &added.path, &added.inspect)));
                    self.add.finish();
                }
                Vec::new()
            }
            _ => match serde_json::from_value::<ProjectAddFailedData>(data) {
                Ok(failed) => {
                    let p = failed.problem;
                    let failure = Failure { message: p.message, fix: p.fix.filter(|f| !f.trim().is_empty()), action: None };
                    if p.code == ProjectProblemCode::DestExists {
                        self.add.add_id = None;
                        self.hold_and_inspect(failure)
                    } else {
                        self.add.updates.push(Update::Failed(failure));
                        self.add.finish();
                        Vec::new()
                    }
                }
                Err(_) => Vec::new(),
            },
        }
    }

    fn bare_discovery(&self) -> Discovery {
        let workers = self
            .machines
            .iter()
            .map(|m| Worker {
                machine_id: m.machine_id.to_string(),
                name: m.name.clone(),
                online: m.status != fleetd_contracts::model::MachineStatus::Offline,
                clone_root: None,
            })
            .collect();
        Discovery { workers, ..Discovery::default() }
    }
}

const LOST: &str = "Lost the connection to the hub. Once it's back, this looks up where the add got to.";

/// The hub's discovery as the sheet lists it: each machine's checkouts, then GitHub. Machine ids read as names.
pub fn discovery(out: ProjectDiscoverOutput, name: &dyn Fn(&str) -> String) -> Discovery {
    let mut d = Discovery { best: out.best.map(|b| b.to_string()), ..Discovery::default() };
    for m in out.machines {
        let id = m.machine_id.to_string();
        let machine_name = name(&id);
        if let Some(p) = m.problem {
            d.problems.push((p.message, p.fix));
        }
        for r in m.repos {
            let detail = r.repo.as_ref().map(|g| g.to_string()).or(r.remote).unwrap_or_else(|| "no remote".into());
            d.found.push(Found {
                name: r.name,
                kind: FoundKind::Checkout { machine_id: id.clone(), path: r.path },
                detail,
                private: false,
                project: r.project_id.map(|p| (id.clone(), p.to_string())),
            });
        }
        d.workers.push(Worker { machine_id: id, name: machine_name, online: m.online, clone_root: m.clone_root });
    }
    let gh = out.github;
    d.gh_on = gh.gh_on.map(|on| if on == "hub" { "the hub".to_string() } else { name(&on) });
    if let Some(p) = gh.problem {
        d.problems.push((p.message, p.fix));
    }
    for c in gh.repos {
        let project = c.checkouts.iter().find_map(|k| k.project_id.as_ref().map(|p| (k.machine_id.to_string(), p.to_string())));
        let detail = match c.checkouts.first() {
            Some(k) if project.is_none() => format!("checked out on {}", name(k.machine_id.as_str())),
            _ => c.description.map(|t| t.to_string()).unwrap_or_default(),
        };
        d.found.push(Found { name: c.repo.to_string(), kind: FoundKind::GitHub, detail, private: c.private, project });
    }
    d
}

/// The ready state's facts and lead line, from what the hub inspected.
pub fn ready(key: ProjectKey, title: &str, machine: &str, path: &str, inspect: &ProjectInspect) -> Ready {
    let list = |v: &[String]| v.join(", ");
    let ci = match (inspect.ci.workflows.len(), inspect.ci.required_checks.is_empty()) {
        (0, true) => "none found".to_string(),
        (0, false) => format!("required checks {}, no workflows", list(&inspect.ci.required_checks)),
        (n, true) => format!("{n} workflow{} ({}), no required checks", if n == 1 { "" } else { "s" }, list(&inspect.ci.workflows)),
        (n, false) => {
            format!("{n} workflow{} ({}); requires {}", if n == 1 { "" } else { "s" }, list(&inspect.ci.workflows), list(&inspect.ci.required_checks))
        }
    };
    let m = &inspect.merge;
    let mut merge = Vec::new();
    match (m.protected, m.rulesets.is_empty()) {
        (false, _) => merge.push("no branch protection or ruleset".to_string()),
        (true, true) => merge.push("branch protection".to_string()),
        (true, false) => merge.push(format!("ruleset {}", list(&m.rulesets))),
    }
    if let Some(n) = m.required_reviews.map(|n| n.get()).filter(|n| *n > 0) {
        merge.push(format!("{n} review{} required", if n == 1 { "" } else { "s" }));
    }
    if m.strict == Some(true) {
        merge.push("up to date before merging".into());
    }
    merge.push(match m.squash_allowed {
        Some(true) => "squash allowed".into(),
        Some(false) => "squash not allowed".into(),
        None => "merge settings unreadable".into(),
    });
    let mut facts =
        vec![("Default branch", inspect.default_branch.clone().unwrap_or_else(|| "unknown".into())), ("CI", ci), ("Merge rules", merge.join(", "))];
    if let Some(repo) = &inspect.repo {
        facts.insert(0, ("Repo", repo.to_string()));
    }
    let line = inspect.lead_needs.to_string();
    let lead_line = match line.chars().next() {
        Some(c) => format!("{}{}", c.to_uppercase(), &line[c.len_utf8()..]),
        None => line,
    };
    Ready {
        key,
        title: title.to_string(),
        machine: machine.to_string(),
        path: path.to_string(),
        facts,
        lead_line: if lead_line.ends_with('.') { lead_line } else { format!("{lead_line}.") },
        lead_ok: !inspect.ci.workflows.is_empty() || !inspect.ci.required_checks.is_empty(),
        notes: inspect.notes.clone(),
    }
}

/// What to offer when a clone's folder already exists: add it when it is a checkout of the same repo, open it
/// when it already is the project, nothing when it holds something else.
pub fn use_instead(target: &CloneTarget, request: Option<&Request>) -> Option<FailAction> {
    if !target.exists {
        return None;
    }
    if let Some(project_id) = &target.project_id {
        return Some(FailAction::Open((target.machine_id.to_string(), project_id.to_string())));
    }
    match request {
        Some(Request::Clone { repo, machine_id, .. }) if target.same_remote => {
            Some(FailAction::UseExisting(Request::Clone { repo: repo.clone(), machine_id: machine_id.clone(), use_existing: true }))
        }
        _ => None,
    }
}

pub fn progress(p: &CloneProgressData) -> Update {
    let pct = p.percent.map(|n| n.get());
    let (step, label, fraction) = match p.phase {
        ClonePhase::Starting => (Step::Clone, "Starting the clone", None),
        // Receiving is most of a clone; resolving and checking out share the rest.
        ClonePhase::Receiving => (Step::Clone, "Receiving objects", pct.map(|n| n as f32 / 100. * 0.8)),
        ClonePhase::Resolving => (Step::Clone, "Resolving deltas", pct.map(|n| 0.8 + n as f32 / 100. * 0.1)),
        ClonePhase::CheckingOut => (Step::Clone, "Checking out files", pct.map(|n| 0.9 + n as f32 / 100. * 0.1)),
        ClonePhase::Inspecting => (Step::Inspect, "Reading the default branch, CI and merge rules", None),
    };
    let mut detail = label.to_string();
    if let Some(n) = pct.filter(|_| p.phase != ClonePhase::Inspecting) {
        detail.push_str(&format!(" {n}%"));
    }
    if let Some(d) = p.detail.as_ref().filter(|d| !d.is_empty()) {
        detail.push_str(&format!(" · {d}"));
    }
    Update::Progress { step, detail, fraction }
}

/// A URL fleetd can't clone (not GitHub), with what to do instead. None: it isn't a URL, or it is GitHub.
pub fn other_host(text: &str) -> Option<String> {
    let text = text.trim();
    let rest = ["https://", "http://", "ssh://", "git@"].iter().find_map(|p| text.strip_prefix(p))?;
    let host = rest.split(['/', ':']).next().unwrap_or_default().trim_start_matches("git@").to_ascii_lowercase();
    (host != "github.com" && host != "www.github.com")
        .then(|| format!("fleetd clones from GitHub. For a repo on {host}, clone it on a worker yourself, then type the folder's path here."))
}

/// The `origin` URL in a `.git/config`: a folder dropped on a computer that isn't a worker can still be cloned
/// from there.
pub fn origin_url(git_config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in git_config.lines().map(str::trim) {
        if line.starts_with('[') {
            in_origin = line.replace(' ', "") == "[remote\"origin\"]";
        } else if in_origin
            && let Some((key, value)) = line.split_once('=')
            && key.trim() == "url"
        {
            return Some(value.trim().to_string());
        }
    }
    None
}

/// The GitHub address in a dropped link file: a macOS `.webloc`, a Windows `.url`, a Linux `.desktop` link, or
/// text. gpui takes only files in a drop, so a link dragged out of a browser arrives as one of these.
pub fn link_url(content: &str) -> Option<String> {
    content
        .split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '='))
        .filter(|w| w.contains("github.com"))
        .find(|w| fleetd_contracts::projects::github_repo(w).is_some())
        .map(str::to_string)
}

/// `/home/me/src/x` and `/Users/me/src/x` read as `~/src/x`: home folders differ per machine, the rest is what
/// tells repos apart.
pub fn tilde(path: &str) -> String {
    for base in ["/home/", "/Users/"] {
        if let Some(rest) = path.strip_prefix(base) {
            return match rest.split_once('/') {
                Some((_, tail)) => format!("~/{tail}"),
                None => "~".into(),
            };
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn names(id: &str) -> String {
        format!("{id}-name")
    }

    #[test]
    fn discovery_lists_checkouts_by_machine_then_github_and_marks_what_is_a_project() {
        let out: ProjectDiscoverOutput = serde_json::from_value(json!({
            "machines": [
                { "machineId": "devbox", "online": true, "cloneRoot": "/home/me/src", "repos": [
                    { "path": "/home/me/src/storefront", "name": "storefront", "remote": "github.com/acme/storefront", "repo": "acme/storefront", "projectId": "p1" },
                    { "path": "/home/me/code/notes", "name": "notes" } ] },
                { "machineId": "buildbox", "online": false, "repos": [],
                  "problem": { "code": "machine_offline", "message": "buildbox is offline.", "fix": "Start its node." } } ],
            "github": { "ghOn": "hub", "owners": ["me", "acme"], "repos": [
                { "repo": "acme/storefront", "url": "https://github.com/acme/storefront", "private": false,
                  "checkouts": [{ "machineId": "devbox", "path": "/home/me/src/storefront", "projectId": "p1" }] },
                { "repo": "acme/ledger", "url": "https://github.com/acme/ledger", "private": true,
                  "checkouts": [{ "machineId": "devbox", "path": "/home/me/src/ledger" }] },
                { "repo": "acme/site", "url": "https://github.com/acme/site", "private": false, "description": "Marketing site", "checkouts": [] } ] },
            "best": "devbox"
        }))
        .unwrap();
        let d = discovery(out, &names);
        assert_eq!(d.best.as_deref(), Some("devbox"));
        assert_eq!(d.gh_on.as_deref(), Some("the hub"));
        assert_eq!(d.workers.iter().map(|w| (w.name.as_str(), w.online)).collect::<Vec<_>>(), [("devbox-name", true), ("buildbox-name", false)]);
        assert_eq!(d.problems, [("buildbox is offline.".to_string(), Some("Start its node.".to_string()))]);
        let rows: Vec<(&str, &str, bool)> = d.found.iter().map(|f| (f.name.as_str(), f.detail.as_str(), f.project.is_some())).collect();
        assert_eq!(
            rows,
            [
                ("storefront", "acme/storefront", true),
                ("notes", "no remote", false),
                ("acme/storefront", "", true),
                ("acme/ledger", "checked out on devbox-name", false),
                ("acme/site", "Marketing site", false),
            ]
        );
        assert_eq!(d.found[0].project, Some(("devbox".into(), "p1".into())));
    }

    fn inspect(v: serde_json::Value) -> ProjectInspect {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn the_ready_state_says_what_ci_and_merge_rules_the_lead_gets() {
        let none = inspect(json!({ "repo": "acme/mailer", "defaultBranch": "main", "ci": { "workflows": [], "requiredChecks": [] },
            "merge": { "protected": false, "rulesets": [], "squashAllowed": true },
            "leadNeeds": "no CI found: the merge train will only use local checks", "notes": [] }));
        let r = ready(("devbox".into(), "p9".into()), "mailer", "devbox", "/home/me/src/mailer", &none);
        assert_eq!(r.lead_line, "No CI found: the merge train will only use local checks.");
        assert!(!r.lead_ok);
        assert_eq!(r.facts[0], ("Repo", "acme/mailer".to_string()));
        assert_eq!(r.facts[2], ("CI", "none found".to_string()));
        assert_eq!(r.facts[3], ("Merge rules", "no branch protection or ruleset, squash allowed".to_string()));

        let full = inspect(json!({ "defaultBranch": "trunk", "ci": { "workflows": ["build", "test"], "requiredChecks": ["build"] },
            "merge": { "protected": true, "rulesets": ["main"], "squashAllowed": true, "requiredReviews": 1, "strict": true },
            "leadNeeds": "CI and rules found.", "notes": ["branch rules need admin access"] }));
        let r = ready(("devbox".into(), "p1".into()), "storefront", "devbox", "/p", &full);
        assert!(r.lead_ok);
        assert_eq!(r.facts[0], ("Default branch", "trunk".to_string()), "no repo row for a checkout without a GitHub remote");
        assert_eq!(r.facts[1].1, "2 workflows (build, test); requires build");
        assert_eq!(r.facts[2].1, "ruleset main, 1 review required, up to date before merging, squash allowed");
        assert_eq!(r.lead_line, "CI and rules found.");
    }

    use crate::client::Incoming;
    use fleetd_contracts::app::{AppCallId, AppClientMessage, AppError, AppServerMessage};
    use fleetd_contracts::mcp::ErrorCode;

    const AT: &str = "2026-10-18T10:00:00.000Z";

    fn snapshot(cursor: u64) -> Incoming {
        let frame = json!({ "t": "snapshot", "machines": [{ "machineId": "devbox", "name": "devbox", "tags": [], "status": "online",
            "lastSeenAt": AT, "nodeVersion": "0.0.0" }], "projects": [], "attention": [], "cursor": cursor });
        Incoming::Message(serde_json::from_value(frame).unwrap())
    }

    fn live() -> State {
        let mut s = State::default();
        s.apply(Incoming::Ready);
        s.apply(snapshot(10));
        s
    }

    /// The id and input of the one call to `tool` in `out`.
    fn call(out: &[AppClientMessage], tool: &str) -> (String, serde_json::Value) {
        let found: Vec<_> = out
            .iter()
            .filter_map(|m| match m {
                AppClientMessage::Call { id, tool: t, input } if t.as_str() == tool => Some((id.to_string(), input.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(found.len(), 1, "one {tool} call in {out:?}");
        found[0].clone()
    }

    fn result(id: &str, output: serde_json::Value) -> Incoming {
        Incoming::Message(AppServerMessage::Result { id: AppCallId::new(id).unwrap(), output })
    }

    fn error(id: &str, message: &str) -> Incoming {
        let id = Some(AppCallId::new(id).unwrap());
        Incoming::Message(AppServerMessage::Error(AppError { id, code: ErrorCode::Invalid, message: message.into(), fix: Some(String::new()) }))
    }

    fn add_event(seq: u64, kind: &str, data: serde_json::Value) -> serde_json::Value {
        json!({ "seq": seq, "at": AT, "type": kind, "machineId": "devbox", "projectId": (kind == "project.added").then_some("p7"), "summary": "", "data": data })
    }

    fn event(seq: u64, kind: &str, data: serde_json::Value) -> Incoming {
        Incoming::Message(AppServerMessage::Event(serde_json::from_value(add_event(seq, kind, data)).unwrap()))
    }

    fn added(add_id: &str) -> serde_json::Value {
        json!({ "addId": add_id, "title": "ledger", "path": "/home/me/src/ledger", "created": true,
            "inspect": { "ci": { "workflows": [], "requiredChecks": [] }, "merge": { "protected": false, "rulesets": [] }, "leadNeeds": "ok", "notes": [] } })
    }

    fn clone_req() -> Request {
        Request::Clone { repo: "acme/ledger".into(), machine_id: "devbox".into(), use_existing: false }
    }

    fn last(s: &mut State) -> Update {
        std::mem::take(&mut s.add.updates).pop().expect("an update")
    }

    #[test]
    fn a_failure_that_comes_before_the_answer_still_ends_the_add() {
        let mut s = live();
        let (id, _) = call(&s.add_project(clone_req()), "project_add");
        let failed = json!({ "addId": "a1", "repo": "acme/ledger", "path": "/p", "code": "clone_failed", "message": "git: remote hung up", "fix": "Try again." });
        s.apply(event(11, "project.add_failed", failed));
        assert!(s.add.updates.is_empty(), "held until the answer names its add");
        s.apply(result(&id, json!({ "machineId": "devbox", "path": "/p", "created": true, "addId": "a1" })));
        assert!(matches!(last(&mut s), Update::Failed(f) if f.message == "git: remote hung up"));
        assert!(!s.add.active());
        // Someone else's add before the answer is not ours.
        let (id, _) = call(&s.add_project(clone_req()), "project_add");
        s.apply(event(12, "project.added", added("other")));
        s.apply(result(&id, json!({ "machineId": "devbox", "path": "/p", "created": true, "addId": "a2" })));
        assert!(matches!(last(&mut s), Update::Progress { .. }));
        s.apply(event(13, "project.added", added("a2")));
        assert!(matches!(last(&mut s), Update::Ready(r) if r.key == ("devbox".to_string(), "p7".to_string())));
    }

    #[test]
    fn after_a_reconnect_the_add_is_looked_up_from_where_it_started() {
        let mut s = live();
        let (id, _) = call(&s.add_project(clone_req()), "project_add");
        s.apply(result(&id, json!({ "machineId": "devbox", "path": "/p", "created": true, "addId": "a1" })));
        s.apply(event(11, "project.clone_progress", json!({ "addId": "a1", "path": "/p", "phase": "receiving", "percent": 42 })));
        s.add.updates.clear();
        s.apply(Incoming::Disconnected { reason: "gone".into(), retry_in: std::time::Duration::from_secs(1) });
        assert!(matches!(last(&mut s), Update::Waiting(_)), "old progress is not shown as live");
        s.apply(Incoming::Ready);
        let out = s.apply(snapshot(20));
        let (id, input) = call(&out, "events_wait");
        assert_eq!(input["cursor"], 10, "from the last event seen when the add started");
        assert_eq!(input["timeoutSec"], 0);
        // It finished while the app was away.
        s.apply(result(
            &id,
            json!({ "events": [add_event(15, "project.clone_progress", json!({ "addId": "a1", "path": "/p", "phase": "inspecting" })),
            add_event(16, "project.added", added("a1"))], "cursor": 16, "more": false }),
        ));
        assert!(matches!(last(&mut s), Update::Ready(_)));
        assert!(!s.add.active());
        // No reconnect lookup without an add.
        s.apply(Incoming::Disconnected { reason: "gone".into(), retry_in: std::time::Duration::from_secs(1) });
        s.apply(Incoming::Ready);
        assert!(!s.apply(snapshot(21)).iter().any(|m| matches!(m, AppClientMessage::Call { tool, .. } if tool.as_str() == "events_wait")));
    }

    #[test]
    fn an_answer_lost_with_the_connection_is_found_by_repo_or_offered_again() {
        let mut s = live();
        call(&s.add_project(clone_req()), "project_add");
        s.apply(Incoming::Disconnected { reason: "gone".into(), retry_in: std::time::Duration::from_secs(1) });
        s.apply(Incoming::Ready);
        let (id, _) = call(&s.apply(snapshot(20)), "events_wait");
        // The hub took it: its events name the repo, so the add is found and carries on.
        s.apply(result(
            &id,
            json!({ "events": [add_event(12, "project.clone_progress",
            json!({ "addId": "a9", "repo": "acme/ledger", "path": "/p", "phase": "receiving", "percent": 30 }))], "cursor": 20, "more": false }),
        ));
        assert!(matches!(last(&mut s), Update::Waiting(_)), "still running, without claiming live progress");
        s.apply(event(21, "project.added", added("a9")));
        assert!(matches!(last(&mut s), Update::Ready(_)));

        // The hub never got it: nothing names it, so offer to send it again.
        call(&s.add_project(clone_req()), "project_add");
        s.apply(Incoming::Disconnected { reason: "gone".into(), retry_in: std::time::Duration::from_secs(1) });
        s.apply(Incoming::Ready);
        let (id, _) = call(&s.apply(snapshot(30)), "events_wait");
        s.apply(result(&id, json!({ "events": [], "cursor": 30, "more": false })));
        assert!(matches!(last(&mut s), Update::Failed(f) if f.action == Some(FailAction::Retry(clone_req()))));
    }

    #[test]
    fn re_pairing_mid_add_still_looks_the_add_up() {
        let mut s = live();
        let (id, _) = call(&s.add_project(clone_req()), "project_add");
        s.apply(result(&id, json!({ "machineId": "devbox", "path": "/p", "created": true, "addId": "a1" })));
        s.apply(Incoming::Unauthorized("key revoked".into()));
        assert!(s.add.lost);
        // The shell keeps the add across the fresh state a new pairing starts with.
        let mut fresh = State::default();
        fresh.add = std::mem::take(&mut s.add);
        fresh.apply(Incoming::Ready);
        call(&fresh.apply(snapshot(30)), "events_wait");
    }

    #[test]
    fn an_existing_folder_is_offered_only_when_inspect_says_it_is_the_same_repo() {
        let target = |same: bool, project: Option<&str>| {
            json!({ "ci": { "workflows": [], "requiredChecks": [] }, "merge": { "protected": false, "rulesets": [] },
            "leadNeeds": "ok", "notes": [], "clone": { "machineId": "devbox", "path": "/p", "exists": true, "sameRemote": same, "projectId": project } })
        };
        for (same, project, want) in [
            (
                true,
                None,
                Some(FailAction::UseExisting(Request::Clone { repo: "acme/ledger".into(), machine_id: "devbox".into(), use_existing: true })),
            ),
            (false, None, None),
            (true, Some("p3"), Some(FailAction::Open(("devbox".into(), "p3".into())))),
        ] {
            let mut s = live();
            let (id, _) = call(&s.add_project(clone_req()), "project_add");
            let (inspect_id, input) = call(&s.apply(error(&id, "devbox already has a checkout at /p")), "project_inspect");
            assert_eq!((input["url"].as_str(), input["machineId"].as_str()), (Some("acme/ledger"), Some("devbox")));
            assert!(s.add.updates.is_empty(), "the failure waits for the answer");
            s.apply(result(&inspect_id, target(same, project)));
            let Update::Failed(f) = last(&mut s) else { panic!() };
            assert_eq!(f.action, want, "sameRemote {same}, project {project:?}");
            assert_eq!(f.fix, None, "an empty fix is no fix");
        }
        // A folder add that fails needs no inspect.
        let mut s = live();
        let (id, _) = call(&s.add_project(Request::Folder { machine_id: "devbox".into(), path: "/srv/x".into() }), "project_add");
        assert!(s.apply(error(&id, "not a git repo")).is_empty());
        assert!(matches!(last(&mut s), Update::Failed(f) if f.action.is_none()));
    }

    #[test]
    fn clone_progress_fills_one_bar_across_its_phases() {
        let p = |phase: &str, percent: Option<i64>| -> CloneProgressData {
            serde_json::from_value(json!({ "addId": "a1", "path": "/p", "phase": phase, "percent": percent, "detail": "4.10 MiB | 2.00 MiB/s" }))
                .unwrap()
        };
        let Update::Progress { step, detail, fraction } = progress(&p("receiving", Some(50))) else { panic!() };
        assert_eq!((step, detail.as_str()), (Step::Clone, "Receiving objects 50% · 4.10 MiB | 2.00 MiB/s"));
        assert_eq!(fraction, Some(0.4));
        let Update::Progress { fraction, .. } = progress(&p("checking_out", Some(100))) else { panic!() };
        assert_eq!(fraction, Some(1.));
        let Update::Progress { step, fraction, .. } = progress(&p("inspecting", None)) else { panic!() };
        assert_eq!((step, fraction), (Step::Inspect, None));
    }

    #[test]
    fn other_hosts_are_named_and_github_is_not() {
        assert!(other_host("https://gitlab.com/acme/storefront").unwrap().contains("gitlab.com"));
        assert!(other_host("git@bitbucket.org:acme/x.git").unwrap().contains("bitbucket.org"));
        assert_eq!(other_host("https://github.com/acme/storefront"), None);
        assert_eq!(other_host("storefront"), None);
    }

    #[test]
    fn a_dropped_folder_names_its_origin() {
        let config = "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = git@github.com:other/x.git\n[remote \"origin\"]\n\turl = https://github.com/acme/storefront.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n";
        assert_eq!(origin_url(config).as_deref(), Some("https://github.com/acme/storefront.git"));
        assert_eq!(origin_url("[core]\n\tbare = false\n"), None);
    }

    #[test]
    fn link_files_yield_their_github_address() {
        let webloc = r#"<?xml version="1.0"?><plist><dict><key>URL</key><string>https://github.com/acme/storefront</string></dict></plist>"#;
        assert_eq!(link_url(webloc).as_deref(), Some("https://github.com/acme/storefront"));
        assert_eq!(link_url("[InternetShortcut]\nURL=https://github.com/acme/mailer\n").as_deref(), Some("https://github.com/acme/mailer"));
        assert_eq!(link_url("[Desktop Entry]\nType=Link\nURL=https://example.com/acme/x\n"), None);
    }

    #[test]
    fn home_folders_read_as_tilde() {
        assert_eq!(tilde("/home/me/src/x"), "~/src/x");
        assert_eq!(tilde("/Users/me/src/x"), "~/src/x");
        assert_eq!(tilde("/srv/x"), "/srv/x");
    }
}
