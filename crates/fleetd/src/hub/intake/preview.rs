//! intake_preview: where intake_submit would send a text (`@project`, or the only project) without creating anything.
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::playbooks::IntakeEcho;

use super::prefix::ref_of;
use super::{Intake, pick_project};
use crate::hub::leads::error::LeadError;

impl Intake {
    /// None where intake_submit would refuse: no `@project` that names one project, and more than one to pick from.
    pub fn preview(
        &self,
        text: &str,
        allows: &(dyn Fn(&MachineId) -> bool + Send + Sync),
    ) -> Result<Option<IntakeEcho>, LeadError> {
        let allowed: Vec<_> = self
            .ctx
            .store
            .projects_list(None, None)?
            .into_iter()
            .filter(|p| allows(&p.machine_id))
            .collect();
        match pick_project(text, &allowed) {
            Ok((project, why)) => Ok(Some(Self::echo(ref_of(project), None, why)?)),
            Err(_) => Ok(None),
        }
    }
}
