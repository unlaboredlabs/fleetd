# Security model

fleetd is built for one person or a small team running their own fleet. This is what it trusts and why.

- **The hub binds to loopback.** `fleetd hub start` listens on `127.0.0.1:4790` by default. Reach it from other
  devices through Tailscale Serve or your own TLS proxy. Nothing is public by default.
- **Agent keys are hashed.** A `fld_` key is shown once when created; the hub stores only its hash and prefix. Each
  key carries read, operate or admin rights on all machines or a named list. Revoking a key stops it on its next
  request.
- **Nodes dial out.** A machine's `fleetd node` connects to the hub and proves itself with its own key pair, so no
  machine opens a port. Enrollment tokens are one-time and expire after 15 minutes.
- **Devices pair with one-time links.** `fleetd hub device add --name phone --url <hub url>` prints a link that
  works once within 15 minutes. The phone app keeps the human key it gets in that site's browser storage (see
  `apps/pwa/README.md` for why it is not wrapped further); `fleetd hub key revoke` ends it. Only human keys answer
  secret, approve and checklist asks, and only they get Web Push.
- **Secrets never reach the hub in plain text.** The browser seals each value to the target node's key; the hub relays
  the ciphertext without storing it and keeps only the fingerprint the node reports. An approved command runs exactly
  as stored, after a person taps approve. Push messages are one line with no secret in them, and the phone app is
  served with a same-origin Content-Security-Policy.
- **Webhooks are signed.** Every POST carries a Standard Webhooks signature made with the subscription's secret,
  which is shown once and stored encrypted.
- **The node socket trusts the node's OS user.** The `fleetd` CLI inside a lead reaches the hub through
  `~/.fleetd/node/node.sock` (mode 0600). The hub attributes each call to the project whose workspace contains the
  caller's working directory, and refuses calls from outside every project. Any process running as the node's user
  can therefore act as the lead of any project on that machine. Run agents you do not trust as a different user.
- **Models are reached only through the `claude` CLI** running inside T3. fleetd itself never calls a model or
  usage API.

Report a vulnerability privately through GitHub's security advisories for `wynn-dev/fleetd`.
