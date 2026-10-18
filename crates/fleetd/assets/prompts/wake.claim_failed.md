- Claim {{claimId}} on {{workstreamId}} failed; {{workstreamId}} stays verifying. Checks that did not pass:
{{failures}}
  next: fix what failed (e.g. a task with --serves done:{{firstCheck}}), then `fleetd claim done --workstream {{workstreamId}}` again.
