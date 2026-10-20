//! Finish-all: the project's finish-all lead inventories open work (`fleetd inventory`) and starts a child workstream
//! per item with a value source (`fleetd workstream spawn`), at most the policy's `finishAll.maxChildren` open at once.
//! When it has no open child and nothing it could start, its workstream goes idle: that is the finish line.
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::{
    IntakeChannel, PlaybookName, PlaybookRef, Workstream, WorkstreamId, WorkstreamParent,
    WorkstreamState,
};
use fleetd_contracts::verification::{CheckOutcome, ClaimOutcome};
use serde::Deserialize;

use super::finish_all_rules::{
    DEFAULT_MAX_CHILDREN, FINISH_ALL_IDLE, InventoryInput, InventoryItem, InventoryParent,
    ItemKind, TODO_GREP, github_repo_of, is_finish_all, is_spawnable, render_inventory,
    should_idle, spawn_refusal, todo_count,
};
use crate::hub::leads::digest::{describe_check, one_line, serde_plain};
use crate::hub::leads::error::LeadError;
use crate::hub::leads::records::{LeadRecords, WorkstreamFilter};
use crate::hub::leads::workstreams::{IntakeInput, Workstreams};
use crate::hub::leads::{Ctx, now_iso};
use crate::hub::store::NewEvent;

const ISSUES_LIMIT: usize = 50;

pub struct Caller {
    pub project_ref: ProjectRef,
    pub by: String,
    /// Where a spawned child's intent came from; None means the project's lead.
    pub channel: Option<IntakeChannel>,
}

#[derive(Debug, Clone)]
pub struct Spawned {
    pub workstream_id: WorkstreamId,
    pub parent: WorkstreamId,
    pub playbook: Option<PlaybookRef>,
    pub next: String,
}

#[derive(Debug, Clone)]
pub struct Inventory {
    pub text: String,
    pub spawnable: usize,
    pub idle: bool,
}

#[derive(Deserialize)]
struct Issue {
    number: i64,
    title: String,
    html_url: String,
    pull_request: Option<serde_json::Value>,
}

pub struct FinishAll {
    ctx: Arc<Ctx>,
    records: Arc<LeadRecords>,
    workstreams: Arc<Workstreams>,
}

impl FinishAll {
    pub fn new(
        ctx: Arc<Ctx>,
        records: Arc<LeadRecords>,
        workstreams: Arc<Workstreams>,
    ) -> Arc<Self> {
        Arc::new(Self {
            ctx,
            records,
            workstreams,
        })
    }

    fn open_in(&self, r: &ProjectRef) -> Result<Vec<Workstream>, LeadError> {
        Ok(self.records.workstreams_list(&WorkstreamFilter {
            project_ref: Some(r.clone()),
            open: true,
            limit: 200,
            ..Default::default()
        })?)
    }

    async fn max_children(&self, r: &ProjectRef) -> Result<u32, LeadError> {
        Ok(match self.ctx.hooks.policy.get() {
            Some(policy) => policy
                .max_children(r)
                .await?
                .unwrap_or(DEFAULT_MAX_CHILDREN),
            None => DEFAULT_MAX_CHILDREN,
        })
    }

    fn set_state(
        &self,
        w: &Workstream,
        state: WorkstreamState,
        why: &str,
    ) -> Result<(), LeadError> {
        let Some(mut stored) = self.records.workstream_get(&w.workstream_id)? else {
            return Ok(());
        };
        if stored.workstream.state == state {
            return Ok(());
        }
        let at = now_iso(&self.ctx);
        stored.workstream.state = state;
        stored.workstream.updated_at = at.clone().into();
        self.records.workstream_put(&stored)?;
        self.ctx.events.append(NewEvent {
            at: at.into(),
            r#type: HubEventType::WorkstreamState,
            machine_id: Some(w.project_ref.machine_id.clone()),
            project_id: Some(w.project_ref.project_id.clone()),
            thread_id: None,
            summary: format!("{} is {}: {why}", w.workstream_id, serde_plain(&state)),
            data: Some(serde_json::json!({ "workstreamId": w.workstream_id, "state": state })),
            attention: None,
        })?;
        Ok(())
    }

    /// An idle finish-all with work again goes back to where it was before.
    fn reopen(&self, parent: &Workstream, why: &str) -> Result<(), LeadError> {
        if parent.state != WorkstreamState::Idle {
            return Ok(());
        }
        self.set_state(
            parent,
            if parent.brief.is_none() {
                WorkstreamState::Draft
            } else {
                WorkstreamState::Running
            },
            why,
        )
    }

    /// `fleetd workstream spawn`: a child of the project's open finish-all workstream, for one value source.
    pub async fn spawn(
        &self,
        caller: &Caller,
        text: &str,
        serves: &str,
        template: Option<PlaybookName>,
    ) -> Result<Spawned, LeadError> {
        let r = &caller.project_ref;
        let open = self.open_in(r)?;
        let Some(parent) = open.iter().find(|w| is_finish_all(w)) else {
            return Err(LeadError::invalid(
                "Your project has no open finish-all workstream; only one spawns child workstreams.",
                "Work on the intents you have. A finish-all run starts from an intent like 'finish: everything open'.",
            ));
        };
        if template == Some(PlaybookName::FinishAll) {
            return Err(LeadError::invalid(
                "A child of a finish-all workstream cannot be another finish-all.",
                "Pass --template bugfix, feature or research.",
            ));
        }
        let children: Vec<&Workstream> = open
            .iter()
            .filter(|w| {
                w.parent
                    .as_ref()
                    .is_some_and(|p| p.workstream_id == parent.workstream_id)
            })
            .collect();
        if let Some(refusal) = spawn_refusal(serves, parent, &children, self.max_children(r).await?)
        {
            return Err(LeadError::invalid(refusal.message, refusal.fix));
        }
        let template = template.unwrap_or(if serves.starts_with("defect:") {
            PlaybookName::Bugfix
        } else {
            PlaybookName::Feature
        });
        let created = self.workstreams.intake(IntakeInput {
            project_ref: r.clone(),
            text: text.to_string(),
            client_request_id: random_uuid(),
            channel: caller.channel.unwrap_or(IntakeChannel::Lead),
            by: caller.by.clone(),
            template: Some(template),
            parent: Some(WorkstreamParent {
                workstream_id: parent.workstream_id.clone(),
                serves: serde_json::from_value(serde_json::Value::String(serves.into())).map_err(
                    |e| {
                        LeadError::invalid(
                            format!("'{serves}' is not a value source: {e}"),
                            "Pass a serves value from inventory.",
                        )
                    },
                )?,
            }),
        })?;
        self.reopen(
            parent,
            &format!("child {} serves {serves}", created.workstream_id),
        )?;
        Ok(Spawned {
            next: format!(
                "{} ({}) serves {serves} for {}; register its brief when its intent wake arrives.",
                created.workstream_id,
                template.as_str(),
                parent.workstream_id
            ),
            workstream_id: created.workstream_id,
            parent: parent.workstream_id.clone(),
            playbook: created.playbook,
        })
    }

    /// Failing done-when checks from each workstream's latest claim; open workstreams other than the parent own theirs.
    fn failing_checks(
        &self,
        r: &ProjectRef,
        open: &[Workstream],
        parent: Option<&Workstream>,
        served_by: &dyn Fn(&str) -> Option<WorkstreamId>,
    ) -> Result<Vec<InventoryItem>, LeadError> {
        let Some(claims) = self.ctx.hooks.claims.get() else {
            return Ok(Vec::new());
        };
        let mut closed = Vec::new();
        for state in [WorkstreamState::Failed, WorkstreamState::Stopped] {
            closed.extend(self.records.workstreams_list(&WorkstreamFilter {
                project_ref: Some(r.clone()),
                state: Some(state),
                limit: 20,
                open: false,
            })?);
        }
        let mut items = Vec::new();
        for (w, is_open) in open
            .iter()
            .map(|w| (w, true))
            .chain(closed.iter().map(|w| (w, false)))
        {
            let Some(latest) = claims.latest(&w.workstream_id) else {
                continue;
            };
            if latest.outcome != ClaimOutcome::Fail {
                continue;
            }
            for result in latest
                .results
                .iter()
                .filter(|r| r.result != CheckOutcome::Pass)
            {
                let index = result.check_index.get();
                let what = format!(
                    "{} done:{index} ({}) {} in {}",
                    w.workstream_id,
                    one_line(&describe_check(&result.spec), 80),
                    serde_plain(&result.result),
                    latest.claim_id
                );
                if Some(&w.workstream_id) == parent.map(|p| &p.workstream_id) {
                    let serves = format!("done:{index}");
                    items.push(InventoryItem {
                        kind: ItemKind::FailingCheck,
                        text: what,
                        served_by: served_by(&serves),
                        serves: Some(serves),
                    });
                } else if is_open {
                    items.push(InventoryItem {
                        kind: ItemKind::FailingCheck,
                        text: what,
                        serves: Some(format!("defect:{} done:{index} fails", w.workstream_id)),
                        served_by: Some(w.workstream_id.clone()),
                    });
                } else {
                    let serves = format!("defect:{} done:{index} fails", w.workstream_id);
                    items.push(InventoryItem {
                        kind: ItemKind::FailingCheck,
                        text: format!("{what}; {} is {}", w.workstream_id, serde_plain(&w.state)),
                        served_by: served_by(&serves),
                        serves: Some(serves),
                    });
                }
            }
        }
        Ok(items)
    }

    /// The project's running finish-all order with room for more children: its id, open children and the cap.
    /// None when there is none, it is idle or verifying, or it is full.
    pub async fn room(
        &self,
        r: &ProjectRef,
    ) -> Result<Option<(WorkstreamId, usize, u32)>, LeadError> {
        let open = self.open_in(r)?;
        let Some(parent) = open
            .iter()
            .find(|w| is_finish_all(w) && w.state == WorkstreamState::Running)
        else {
            return Ok(None);
        };
        let children = open
            .iter()
            .filter(|w| {
                w.parent
                    .as_ref()
                    .is_some_and(|p| p.workstream_id == parent.workstream_id)
            })
            .count();
        let max = self.max_children(r).await?;
        Ok((children < max as usize).then(|| (parent.workstream_id.clone(), children, max)))
    }

    /// `fleetd inventory`: the ranked list, and the idle rule applied to the project's finish-all workstream.
    pub async fn inventory(&self, caller: &Caller) -> Result<Inventory, LeadError> {
        let r = &caller.project_ref;
        let Some(project) = self.ctx.store.project_get(r)? else {
            return Err(LeadError::bare(
                fleetd_contracts::mcp::ErrorCode::NotFound,
                format!("The hub has no record of project {}.", r.project_id),
            ));
        };
        let open = self.open_in(r)?;
        let parent = open.iter().find(|w| is_finish_all(w)).cloned();
        let children: Vec<Workstream> = parent
            .as_ref()
            .map(|p| {
                open.iter()
                    .filter(|w| {
                        w.parent
                            .as_ref()
                            .is_some_and(|x| x.workstream_id == p.workstream_id)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let served_by = |serves: &str| {
            children
                .iter()
                .find(|c| {
                    c.parent
                        .as_ref()
                        .is_some_and(|p| p.serves.as_str() == serves)
                })
                .map(|c| c.workstream_id.clone())
        };
        let mut items = self.failing_checks(r, &open, parent.as_ref(), &served_by)?;
        let mut unread = Vec::new();
        let mut notes = Vec::new();
        let run = |argv: &[&str]| {
            self.ctx.ports().run_command(
                &r.machine_id,
                project.workspace_root.clone(),
                argv.iter().map(|s| s.to_string()).collect(),
                60,
            )
        };

        // Open issues of the checkout's GitHub repo; a checkout without one has none, which is not a read failure.
        match run(&["git", "remote", "get-url", "origin"]).await {
            Err(e) => unread.push(format!("open issues: {e}")),
            Ok(remote) => {
                let repo = if remote.exit_code == Some(0) {
                    github_repo_of(&remote.output_tail)
                } else {
                    None
                };
                match repo {
                    None => notes.push(
                        "No open issues to read: the checkout's origin is not a GitHub repository."
                            .to_string(),
                    ),
                    Some(repo) => {
                        let path = format!(
                            "repos/{repo}/issues?state=open&per_page={ISSUES_LIMIT}&sort=created&direction=asc"
                        );
                        let listed = match self.ctx.hooks.github.get() {
                            Some(github) => github.api(&path).await,
                            None => Err("GitHub is not available on this hub".into()),
                        };
                        match listed {
                            Err(e) => unread.push(format!("open issues of {repo}: {e}")),
                            Ok(value) => match serde_json::from_value::<Vec<Issue>>(value) {
                                Err(_) => unread.push(format!(
                                    "open issues of {repo}: GitHub returned an unexpected shape"
                                )),
                                Ok(issues) => {
                                    for issue in issues.iter().filter(|i| i.pull_request.is_none())
                                    {
                                        let serves = format!("issue:#{}", issue.number);
                                        items.push(InventoryItem {
                                            kind: ItemKind::Issue,
                                            text: format!(
                                                "{repo}#{} {}",
                                                issue.number,
                                                one_line(&issue.title, 120)
                                            ),
                                            served_by: served_by(&serves).or_else(|| {
                                                served_by(&format!("issue:{}", issue.html_url))
                                            }),
                                            serves: Some(serves),
                                        });
                                    }
                                    if issues.len() == ISSUES_LIMIT {
                                        notes.push(format!("Only the oldest {ISSUES_LIMIT} open issues of {repo} are listed."));
                                    }
                                }
                            },
                        }
                    }
                }
            }
        }

        let requests = self.ctx.ports().open_requests(Some(r), 20)?;
        for request in requests {
            items.push(InventoryItem {
                kind: ItemKind::Request,
                text: format!(
                    "{}: {} (the person answers it in chat)",
                    request.request_id,
                    one_line(request.text.as_ref(), 120)
                ),
                serves: None,
                served_by: None,
            });
        }

        let grep_text = format!("`{}`", TODO_GREP.join(" "));
        match run(&TODO_GREP).await {
            Err(e) => notes.push(format!("TODO/FIXME markers not counted: {e}")),
            Ok(grep) => {
                let code = grep.exit_code;
                if code != Some(0) && code != Some(1) {
                    notes.push(format!(
                        "TODO/FIXME markers not counted: {}",
                        one_line(grep.output_tail.as_str(), 200)
                    ));
                } else {
                    let tail = grep.output_tail.as_str();
                    let (count, at_least) = todo_count(
                        if code == Some(0) { tail } else { "" },
                        tail.chars().count() >= 1990,
                    );
                    if count > 0 {
                        items.push(InventoryItem {
                            kind: ItemKind::Todo,
                            text: format!("{}{count} TODO/FIXME markers ({grep_text}): file an issue for one worth doing", if at_least { "at least " } else { "" }),
                            serves: None,
                            served_by: None,
                        });
                    } else {
                        notes.push(format!("No TODO/FIXME markers ({grep_text})."));
                    }
                }
            }
        }

        let input = InventoryInput {
            project: format!("{} ({}/{})", project.title, r.machine_id, r.project_id),
            parent: match &parent {
                Some(p) => Some(InventoryParent {
                    workstream_id: p.workstream_id.clone(),
                    open_children: children.len(),
                    max_children: self.max_children(r).await?,
                }),
                None => None,
            },
            items,
            unread,
        };
        let idle = should_idle(&input);
        let spawnable = input.items.iter().filter(|i| is_spawnable(i)).count();
        if let Some(parent) = &parent {
            // Not while a claim on it runs its checks; that claim decides.
            if idle && parent.state != WorkstreamState::Verifying {
                self.set_state(parent, WorkstreamState::Idle, FINISH_ALL_IDLE)?;
            }
            if spawnable > 0 {
                self.reopen(
                    parent,
                    &format!(
                        "{spawnable} item{} with a value source",
                        if spawnable == 1 { "" } else { "s" }
                    ),
                )?;
            }
        }
        let mut text = vec![render_inventory(&input)];
        text.extend(notes);
        Ok(Inventory {
            text: text.join("\n"),
            spawnable,
            idle,
        })
    }
}

/// A random v4 UUID string, as `crypto.randomUUID()` gives.
fn random_uuid() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = crate::hub::leads::brief::hex(&b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}
