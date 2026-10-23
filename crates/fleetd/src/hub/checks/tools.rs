//! The lead call `review_verdict`.
use super::ports::Refusal;
use crate::hub::api::Hub;
use crate::hub::reviews::verdicts::Caller as LeadCaller;
use fleetd_contracts::lead_calls::ReviewVerdictResult;
use fleetd_contracts::verification::ReviewVerdict;

/// Lead call `review_verdict`: records it and says how the reviewer ends.
pub async fn lead_review_verdict(
    hub: &Hub,
    caller: &LeadCaller,
    verdict: ReviewVerdict,
) -> Result<ReviewVerdictResult, Refusal> {
    let recorded = hub.verdicts.record(caller, verdict).await?;
    let stop = if recorded.verdict.blocking.get() == 0 {
        "end with your one-paragraph result and stop; this commit will not be reviewed again."
    } else {
        "end with your one-paragraph result listing each blocking finding, then stop; the lead gets it."
    };
    let next = match &recorded.research {
        Some(research) => format!("{research} {stop}"),
        None => stop.to_owned(),
    };
    Ok(ReviewVerdictResult {
        verdict: recorded.verdict,
        next: Some(next),
    })
}
