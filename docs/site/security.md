---
title: Security model
section: Reference
order: 95
description: What fleetd trusts, how keys and secrets move, and how to report a vulnerability.
---

fleetd is built for one person or a small team running their own fleet.

## Network

- **The hub is never public by default.** `fleetd init` listens on your tailnet address, or on `127.0.0.1` without
  Tailscale. Plain HTTP is accepted only there (Tailscale's tunnel is encrypted); anywhere else, put HTTPS in front
  ([the https check](troubleshooting.md#hub-https)).
- **Nodes dial out.** A worker's node connects to the hub and proves itself with its own key pair, so no worker
  opens a port. Enrollment tokens and pairing codes work once and expire after 15 minutes.

## Keys

- **Agent keys are hashed.** A `fld_` key is shown once; the hub stores only its hash and prefix. Each key has read,
  operate or admin rights on every machine or a named list. A revoked key stops on its next request.
- **A person's device holds a human key**: in the OS keychain on Linux and in a Developer ID signed Mac app; in a
  file only you can read (0600) in an unsigned or ad-hoc signed Mac build, whose keychain trust would reset with
  every update. Only human keys answer secret, approve and checklist asks, so no agent can approve itself.
- **The node socket trusts the node's OS user.** Lead-side commands reach the hub through `~/.fleetd/node/node.sock`
  (mode 0600), and the hub attributes each call to the project whose workspace contains the caller's working
  directory. Any process running as that user can act as any project's lead on that machine. Run agents you don't
  trust as a different user. Each call also names the fleetd session it comes from (every session and its tools set
  it), which is how the hub refuses a task's spawns; a process that drops the name is treated as you.

## Secrets and commands

- **Secrets never reach the hub in plain text.** The app seals each value to the target node's key (a libsodium
  sealed box) and wipes what was typed. The hub relays the ciphertext without storing it and keeps only the
  fingerprint the node reports. Notifications carry a one-line summary, never a secret.
- **An approved command runs exactly as stored**, and only after a person approves it.
- **Webhooks are signed** with a Standard Webhooks signature; each subscription's secret is shown once and stored
  encrypted.

## Software

- **Installs are checksummed.** The installer and `fleetd update` refuse any release file whose SHA-256 doesn't match
  the release's `SHA256SUMS`. `fleetd machine add` copies the hub's own binary to a worker over SSH.
- **Models only through the `claude` CLI**, with the machine user's own claude setup (their login, settings and MCP
  servers), so agents get the same Claude access as that user. fleetd never calls a model or usage API itself.

## Report a vulnerability

Privately, through GitHub's security advisories for
[unlaboredlabs/fleetd](https://github.com/unlaboredlabs/fleetd/security/advisories/new).
