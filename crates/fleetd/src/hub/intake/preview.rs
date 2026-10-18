//! intake_preview: where intake_submit would send a text (`@project`, then the router) without creating anything.
use std::collections::HashMap;
use std::sync::Mutex;

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::playbooks::IntakeEcho;

use super::prefix::{ProjectMatch, match_project, parse_intent, ref_of};
use super::router::RouterProject;
use super::{DEFAULT_TEMPLATE, Intake, RECENT_INTENTS, ROUTER_PROJECTS};
use crate::hub::leads::brief::sha256_hex;
use crate::hub::leads::error::LeadError;
use crate::hub::leads::records::WorkstreamFilter;
use crate::hub::store::now_ms;

const TTL_MS: i64 = 10 * 60 * 1000;
const MAX_ENTRIES: usize = 256;

#[derive(Default)]
pub struct PreviewCache(Mutex<HashMap<String, (i64, Option<IntakeEcho>)>>);

impl Intake {
    pub async fn preview(
        &self,
        text: &str,
        allows: &(dyn Fn(&MachineId) -> bool + Send + Sync),
    ) -> Result<Option<IntakeEcho>, LeadError> {
        let parsed = parse_intent(text);
        let template = parsed.template.unwrap_or(DEFAULT_TEMPLATE);
        let allowed: Vec<_> = self
            .ctx
            .store
            .projects_list(None, None)?
            .into_iter()
            .filter(|p| allows(&p.machine_id))
            .collect();
        if let Some(name) = &parsed.project {
            return Ok(match match_project(name, &allowed) {
                ProjectMatch::One(p) => Some(Self::echo(
                    ref_of(p),
                    template,
                    format!("@{name} names {}", p.title),
                )?),
                _ => None,
            });
        }
        let candidates: Vec<_> = allowed.into_iter().take(ROUTER_PROJECTS).collect();
        if candidates.is_empty() {
            return Ok(None);
        }
        let ids: Vec<String> = candidates
            .iter()
            .map(|p| format!("{}/{}", p.machine_id, p.project_id))
            .collect();
        let key = sha256_hex(format!("{text}\n{}", ids.join(",")).as_bytes());
        let now = now_ms(self.ctx.clock.as_ref());
        if let Some((at, echo)) = self.previews.0.lock().unwrap().get(&key)
            && now - at < TTL_MS
        {
            return Ok(echo.clone());
        }
        let mut projects = Vec::new();
        for p in &candidates {
            let recent = self.workstreams.list(&WorkstreamFilter {
                project_ref: Some(ref_of(p)),
                limit: RECENT_INTENTS,
                ..Default::default()
            })?;
            projects.push(RouterProject {
                project_ref: ref_of(p),
                title: p.title.clone(),
                root: p.workspace_root.clone(),
                recent_intents: recent.into_iter().map(|w| w.title.to_string()).collect(),
            });
        }
        let outcome = self.router.route(text, &projects).await;
        let echo = match outcome.result {
            Some(r) => Some(Self::echo(
                r.project_ref.clone(),
                parsed.template.unwrap_or(r.template),
                r.reason.to_string(),
            )?),
            None => None,
        };
        let mut cache = self.previews.0.lock().unwrap();
        cache.retain(|_, (at, _)| now - *at < TTL_MS);
        if cache.len() >= MAX_ENTRIES {
            cache.clear();
        }
        cache.insert(key, (now, echo.clone()));
        Ok(echo)
    }
}
