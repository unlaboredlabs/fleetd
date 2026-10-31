//! A Navi's secure input as a request (fleetd-contracts' secure_input.rs): something only the person may give, which
//! the Navi never sees. Typed, it is a secret request whose `fill:<machine>:<browser session>` sink the person's app
//! seals to, and the Navi's node types it into the field (`submit_secret` relays it). From 1Password, it is an
//! approval; approved, the Navi's node claims it once, within its window, and fills the field from the item. Either
//! way only a person answers it ([`super::purchases::person_only`]).
use fleetd_contracts::chat::ChatRequestId;
use fleetd_contracts::ledger::{HumanRequest, RequestKind, RequestState, SecretRequest};
use fleetd_contracts::secure_input::{
    FILL_WINDOW_MINUTES, SecureInput, SecureInputClaimed, SecureInputFilledCall,
    SecureInputOpenCall,
};

use super::store::NewRequest;
use super::{ApprovalRefused, Approvals, contract_project, project_of, refuse};
use crate::hub::store::{iso_ms, parse_ms, system_ms};
use crate::hub::usage::ports::ProjectRef;
use crate::hub::usage::time::clip;

/// The key a secure input's secret request goes by: never a variable, only a name for the request.
const KEY: &str = "navi.secure_input";

impl Approvals {
    /// A Navi's `request_secure_input`, from its node: a sealed field for the person to type in, or an approval to fill
    /// it from 1Password.
    pub async fn open_secure_input(
        &self,
        project: &ProjectRef,
        call: SecureInputOpenCall,
    ) -> Result<HumanRequest, ApprovalRefused> {
        let SecureInputOpenCall { session_id, input } = call;
        let now = system_ms(self.deps.clock.now());
        let from_1password = input.reference.is_some();
        let text = if from_1password {
            format!(
                "Fill {} on {} ({}) from 1Password: {}",
                input.label, input.site.name, input.site.domain, input.why
            )
        } else {
            format!(
                "Enter {} for {} ({}): {}",
                input.label, input.site.name, input.site.domain, input.why
            )
        };
        let secret = (!from_1password).then(|| SecretRequest {
            key: fleetd_contracts::ledger::DecisionKey::unchecked(KEY),
            sink: fleetd_contracts::secrets::SecretSink::unchecked(format!(
                "fill:{}:{session_id}",
                project.machine_id
            )),
            env_name: None,
            fingerprint: None,
        });
        self.create(NewRequest {
            project_ref: contract_project(project),
            workstream_id: None,
            kind: if from_1password {
                RequestKind::Approval
            } else {
                RequestKind::Secret
            },
            text: clip(&text, 500),
            secret,
            gated: None,
            permission: None,
            purchase: None,
            secure_input: Some(SecureInput {
                site: input.site,
                target: input.target,
                label: input.label,
                why: input.why,
                reference: input.reference,
                session_id,
                filled_at: None,
            }),
            at: fleetd_contracts::ids::Timestamp(iso_ms(now)),
            at_ms: now,
        })
        .await
    }

    /// The Navi's node claims an approved 1Password secure input for one fill, within its window and from the browser
    /// session that asked.
    pub async fn claim_secure_input(
        &self,
        project: &ProjectRef,
        request_id: &ChatRequestId,
        session_id: &fleetd_contracts::browser::BrowserSessionId,
    ) -> Result<SecureInputClaimed, ApprovalRefused> {
        let (r, input) = self.own_secure_input(project, request_id.as_str())?;
        let Some(reference) = input.reference.clone() else {
            return Err(refuse(
                "invalid",
                format!("{request_id} is for the person to type: fleetd fills it as they do."),
                Some("End your turn: you are woken once it is filled."),
            ));
        };
        match r.state {
            RequestState::Approved => {}
            RequestState::Open => {
                return Err(refuse(
                    "invalid",
                    format!("The person hasn't answered {request_id} yet."),
                    Some("End your turn: you are woken with their answer."),
                ));
            }
            RequestState::Ran => {
                return Err(refuse(
                    "forbidden",
                    format!("{request_id} was filled already: a secure input fills once."),
                    Some("Ask again with request_secure_input if the page needs it again."),
                ));
            }
            other => {
                return Err(refuse(
                    "forbidden",
                    format!("{request_id} is {}: it isn't filled.", other.as_str()),
                    Some("Don't get it another way; say so in the chat."),
                ));
            }
        }
        if input.session_id != *session_id {
            return Err(refuse(
                "forbidden",
                format!("{request_id} was asked for in another browser session."),
                Some("Ask again with request_secure_input from this page."),
            ));
        }
        let now = system_ms(self.deps.clock.now());
        let approved = r
            .answered_at
            .as_ref()
            .and_then(|a| parse_ms(a.as_str()))
            .unwrap_or_default();
        if now - approved > FILL_WINDOW_MINUTES * 60_000 {
            let why = format!(
                "expired: it wasn't filled within {FILL_WINDOW_MINUTES} minutes of the approval"
            );
            let _ = self
                .change_from(&r.request_id, RequestState::Approved, |r| {
                    r.state = RequestState::Failed;
                    r.evidence = Some(fleetd_contracts::prim::Text::unchecked(why.clone()));
                    r.finished_at = Some(fleetd_contracts::ids::Timestamp(iso_ms(now)));
                })
                .await;
            return Err(refuse(
                "forbidden",
                format!("{request_id} {why}."),
                Some("Ask again with request_secure_input if the page still needs it."),
            ));
        }
        let at = iso_ms(now);
        let claimed = self
            .change_from(&r.request_id, RequestState::Approved, |r| {
                r.state = RequestState::Ran;
                r.evidence = Some(fleetd_contracts::prim::Text::unchecked(
                    "filling it in".to_owned(),
                ));
                r.finished_at = Some(fleetd_contracts::ids::Timestamp(at.clone()));
                if let Some(i) = r.secure_input.as_mut() {
                    i.filled_at = Some(fleetd_contracts::ids::Timestamp(at));
                }
            })
            .await?;
        Ok(SecureInputClaimed {
            request_id: claimed.request_id,
            domain: input.site.domain,
            target: input.target,
            reference,
        })
    }

    /// How a claimed fill went; one that typed nothing goes back to approved.
    pub async fn secure_input_filled(
        &self,
        project: &ProjectRef,
        call: SecureInputFilledCall,
    ) -> Result<HumanRequest, ApprovalRefused> {
        let (r, _) = self.own_secure_input(project, call.request_id.as_str())?;
        let said = clip(call.message.as_str(), 300);
        if call.ok || call.typed {
            let evidence = if call.ok {
                format!("filled: {said}")
            } else {
                format!("partly filled, then: {said}")
            };
            return self
                .change_from(&r.request_id, RequestState::Ran, |r| {
                    r.evidence = Some(fleetd_contracts::prim::Text::unchecked(evidence));
                })
                .await;
        }
        let evidence = format!("not filled: {said}; it may be filled again within its window");
        self.change_from(&r.request_id, RequestState::Ran, |r| {
            r.state = RequestState::Approved;
            r.evidence = Some(fleetd_contracts::prim::Text::unchecked(evidence));
            r.finished_at = None;
            if let Some(i) = r.secure_input.as_mut() {
                i.filled_at = None;
            }
        })
        .await
    }

    fn own_secure_input(
        &self,
        project: &ProjectRef,
        request_id: &str,
    ) -> Result<(HumanRequest, SecureInput), ApprovalRefused> {
        let unknown = || {
            refuse(
                "not_found",
                format!("{request_id} is none of your secure inputs."),
                Some("Use the requestId request_secure_input returned."),
            )
        };
        let r = self
            .get(request_id)
            .filter(|r| project_of(r) == *project)
            .ok_or_else(unknown)?;
        let input = r.secure_input.clone().ok_or_else(unknown)?;
        Ok((r, input))
    }
}
