//! subscription_set, subscription_list and subscription_delete. TS spec: apps/hub/src/api/FleetApi.ts.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    ErrorCode, McpToolError, SubscriptionDeleteInput, SubscriptionDeleteOutput,
    SubscriptionListInput, SubscriptionListOutput, SubscriptionSetInput, SubscriptionSetOutput,
};
use fleetd_contracts::prim::{NonEmpty, True};
use fleetd_contracts::subscriptions::SubscriptionMachines;

use super::CreateInput;
use crate::hub::api::{Caller, Hub, Registry, ToolError, require};

pub fn register(tools: &mut Registry) {
    tools.add("subscription_set", subscription_set);
    tools.add("subscription_list", subscription_list);
    tools.add("subscription_delete", subscription_delete);
}

async fn subscription_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: SubscriptionSetInput,
) -> Result<SubscriptionSetOutput, ToolError> {
    if let SubscriptionMachines::Only(machines) = &input.machines {
        for m in machines {
            require(&caller, Role::Read, Some(m))?;
        }
    }
    let created = hub.webhooks.create(
        &caller,
        CreateInput {
            url: input.url,
            types: input.types,
            machines: input.machines,
            client_request_id: input.client_request_id.into_inner(),
        },
    );
    Ok(SubscriptionSetOutput {
        subscription_id: NonEmpty::unchecked(created.subscription_id),
        secret: NonEmpty::unchecked(created.secret),
        next: Some(
            "Store the secret now; it is never shown again. Verify each POST's webhook-signature header with it (Standard Webhooks)."
                .into(),
        ),
        truncated: None,
    })
}

async fn subscription_list(
    hub: Arc<Hub>,
    caller: Caller,
    _: SubscriptionListInput,
) -> Result<SubscriptionListOutput, ToolError> {
    Ok(SubscriptionListOutput {
        subscriptions: hub.webhooks.list(&caller),
        next: None,
        truncated: None,
    })
}

async fn subscription_delete(
    hub: Arc<Hub>,
    caller: Caller,
    input: SubscriptionDeleteInput,
) -> Result<SubscriptionDeleteOutput, ToolError> {
    if !hub.webhooks.remove(&caller, &input.subscription_id) {
        return Err(McpToolError::new(
            ErrorCode::NotFound,
            format!("No subscription {} for this key.", input.subscription_id),
        )
        .with_fix("Call subscription_list to see this key's subscriptions."));
    }
    Ok(SubscriptionDeleteOutput {
        ok: True,
        next: None,
        truncated: None,
    })
}
