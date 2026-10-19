- Claim {{claimId}} on {{workstreamId}}: every done-when check passed, but review fixes are still open: {{fixes}}. {{workstreamId}} stays open so they ship.
  next: say so in chat in one line. Let them land (their PRs go through the train), then `claim_done` {workstreamId: "{{workstreamId}}"} again. Cancel one only if it truly isn't needed, and say why in chat.
