---
title: Builds & rollout
description: How every build of fleetd is numbered, tested on fleetd's own hub and cloud, and rolled out in stages, with self-checks and automatic rollback.
---

fleetd has no versioned releases. Every change to fleetd that passes its tests becomes a build, and builds reach hubs
in stages.

## Build numbers {#numbers}

Each build gets a number from its day (UTC) and its place that day: `2026.11.23.4` is the fourth build of November 23.
The apps show it under Settings › General › Version, and `fleetd version` prints it. Give this number when you ask
for support.

Each build has its own page on [GitHub Releases](https://github.com/unlaboredlabs/fleetd/releases), named
`build-<number>`, with what's new in plain words. The **Edge** release lists the latest builds and how far each one has
rolled out.

## How a build reaches your hub {#rings}

1. **fleetd's own hub and the cloud.** A new build runs there first. It moves on only once fleetd's own hub has
   updated to it and passed its self-check, and the cloud runs it.
2. **Everyone, in stages.** Then it reaches 10% of hubs, 50% an hour later, and every hub after 3 hours.

Each hub is in a fixed stage, worked out from a random id it creates for itself and keeps. Hubs never report which
build they run, and nothing is sent from your hub. The desktop app follows the same stages with its own id. The phone
gets a new over-the-air bundle once its build has reached every hub.

A machine still on a fleetd from before numbered builds can only take the newest build. While your hub runs an older
one, Settings › Hub › Machines › Updates says that machine is waiting. It updates once the hub runs the newest build,
or right away if you run `fleetd update` on it.

## Update speed {#speed}

Settings › Hub › Machines › Updates › **Update speed**:

- **Fast** (default): each build once its stage reaches your hub, within hours of passing fleetd's own checks.
- **Steady**: only builds that have been out for 2 days and were never halted. For teams that want fewer, older
  updates.

From a terminal: `fleetd update --speed steady`. A hub that was set to the old stable channel moves to Steady. One on
Edge moves to Fast.

## Self-check and rollback {#self-check}

After the hub restarts on a new build, it checks itself before its machines update:

1. The hub comes up healthy within 90 seconds.
2. Every machine that was online before the update reconnects within 3 minutes.
3. Lead turns still work: two turns cut off because their machine lost its link to the hub, with none finishing
   normally, fail the check. A turn that Claude or its provider ended, such as for an expired sign-in or an outage,
   doesn't count, because a new build can't cause it.

If any step fails, the hub puts the previous build back by itself and restarts on it. Settings › Hub › Machines ›
Updates then says which step failed. Automatic updates skip that build until a newer one is out. **Update** still
installs it if you ask.

## Halting or pulling a build {#halt}

fleetd's maintainers can stop a build with one command:

```sh
gh workflow run rollout.yml -R unlaboredlabs/fleetd -f action=halt -f build=2026.11.23.4
```

- `halt`: no new hub takes the build. Hubs already on it keep it.
- `pull`: every hub on the build goes back to the newest earlier build that has reached it. Its machines go back too.
- `resume`: undoes a halt or a pull. Hubs on Steady still never take a build that was halted once.

Hubs see the change at their next check, within 2 minutes.
