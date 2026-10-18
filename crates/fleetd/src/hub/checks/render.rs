//! The claim lines a lead reads in its wake. Pure.
use super::{units, utf16_prefix};
use fleetd_contracts::ledger::{CheckSpec, WorkstreamId};
use fleetd_contracts::verification::{CheckOutcome, CheckResult, ClaimId};

/// One line per done-when check, as digests and wakes show it. Same text as `leads::digest::describe_check`.
pub fn describe_check(check: &CheckSpec) -> String {
    match check {
        CheckSpec::PrMerged { repo, pr } => format!(
            "PR {}merged in {repo}",
            pr.map(|p| format!("#{p} ")).unwrap_or_default()
        ),
        CheckSpec::CiGreen { repo, r#ref } => format!(
            "CI green on {repo}{}",
            r#ref.as_ref().map(|r| format!("@{r}")).unwrap_or_default()
        ),
        CheckSpec::Http {
            url,
            status,
            contains,
        } => {
            format!(
                "GET {url} → {status}{}",
                contains
                    .as_ref()
                    .map(|c| format!(" containing \"{c}\""))
                    .unwrap_or_default()
            )
        }
        CheckSpec::Cmd {
            machine_id,
            argv,
            expect_exit,
        } => format!("on {machine_id}: `{}` exits {expect_exit}", argv.join(" ")),
        CheckSpec::Test { repo, test_id } => format!("test {test_id} passes in {repo}"),
        CheckSpec::Judge { criteria } => format!("judge: {criteria}"),
        CheckSpec::Human { question } => format!("human confirms: {question}"),
    }
}

pub(crate) fn outcome_name(o: CheckOutcome) -> &'static str {
    match o {
        CheckOutcome::Pass => "pass",
        CheckOutcome::Fail => "fail",
        CheckOutcome::Error => "error",
    }
}

/// Whitespace runs folded to one space, trimmed, and cut to `max` with "…".
pub(crate) fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if units(&flat) > max {
        format!("{}…", utf16_prefix(&flat, max - 1))
    } else {
        flat
    }
}

/// `done:<i>` matches CheckResult.checkIndex and `--serves done:<i>`.
pub fn check_label(index: i64, spec: &CheckSpec) -> String {
    format!("done:{index} ({})", one_line(&describe_check(spec), 120))
}

fn exit_part(r: &CheckResult, with: &str) -> String {
    r.exit_code
        .map(|c| format!("{with}{c}"))
        .unwrap_or_default()
}

fn failure_lines(r: &CheckResult) -> Vec<String> {
    let mut lines = vec![format!(
        "  {}: {}{}",
        check_label(r.check_index.get(), &r.spec),
        outcome_name(r.result),
        exit_part(r, ", exit ")
    )];
    lines.extend(
        r.evidence
            .trim()
            .split('\n')
            .map(|l| format!("    > {l}").trim_end().to_owned()),
    );
    lines
}

pub fn claim_failed_lines(
    claim_id: &ClaimId,
    workstream_id: &WorkstreamId,
    failures: &[CheckResult],
) -> String {
    let first = failures.first().map_or(0, |r| r.check_index.get());
    let mut lines = vec![format!(
        "- Claim {claim_id} on {workstream_id} failed; {workstream_id} stays verifying. Checks that did not pass:"
    )];
    lines.extend(failures.iter().flat_map(failure_lines));
    lines.push(format!(
        "  next: fix what failed (e.g. a task with --serves done:{first}), then `fleetd claim done --workstream {workstream_id}` again."
    ));
    lines.join("\n")
}

pub fn claim_passed_line(claim_id: &ClaimId, workstream_id: &WorkstreamId) -> String {
    format!(
        "- Claim {claim_id} on {workstream_id} passed: every done-when check passed, so {workstream_id} is done."
    )
}

/// One evidence line per failed claim, for the false-claim incident.
pub fn failed_claim_evidence(claim_id: &ClaimId, results: &[CheckResult]) -> String {
    let parts: Vec<String> = results
        .iter()
        .filter(|r| r.result != CheckOutcome::Pass)
        .map(|r| {
            let exit = r
                .exit_code
                .map(|c| format!(" (exit {c})"))
                .unwrap_or_default();
            format!(
                "done:{} {}{exit}: {}",
                r.check_index.get(),
                outcome_name(r.result),
                one_line(&r.evidence, 200)
            )
        })
        .collect();
    utf16_prefix(&format!("{claim_id} failed: {}", parts.join("; ")), 2000).to_owned()
}
