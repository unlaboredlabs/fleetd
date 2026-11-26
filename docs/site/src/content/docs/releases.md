---
title: Builds & rollout
description: How every build of fleetd gets its version, is tested on fleetd's own workspace and cloud, and rolls out in stages, with self-checks and automatic rollback.
---

Every change to fleetd that passes its tests becomes a release, and releases reach workspaces in stages.

## Versions {#numbers}

Each build gets the next version, `0.MINOR.PATCH`. PATCH goes up by one with each build, so 0.9.0, 0.9.1, 0.9.2 and so
on. A build that's halted keeps its number, so you may see a gap. MINOR changes only for a bigger step (1.0 at
launch). The apps show the version with the day it was built, as `0.9.4 · Nov 23`: under Settings › General ›
Version, on the Updates page, and in the menu under your name when an update is ready. `fleetd version` prints it too.
Give this version when you ask for support.

Each build has its own page on [GitHub Releases](https://github.com/unlaboredlabs/fleetd/releases), named
`build-<version>` (for example `build-0.9.4`), with what's new in plain words. The **Edge** release lists the latest builds and how far each one has
rolled out.

## How a build reaches your workspace {#rings}

1. **fleetd's own workspace and the cloud.** A new build runs there first. It moves on only once fleetd's own workspace has
   updated to it and passed its self-check, and the cloud runs it.
2. **Everyone, in stages.** Then it reaches 10% of workspaces, 50% an hour later, and every workspace after 3 hours.

Each workspace is in a fixed stage, worked out from a random id it creates for itself and keeps. Workspaces never report which
build they run, and nothing is sent from your workspace. The desktop app follows the same stages with its own id. The phone
gets a new over-the-air bundle once its build has reached every workspace.

A machine still on a fleetd from before these versions can only take the newest build. While your workspace runs an older
one, Settings › Workspace › Machines › Updates says that machine is waiting. It updates once the workspace runs the newest build,
or right away if you run `fleetd update` on it.

## Update speed {#speed}

Settings › Workspace › Machines › Updates › **Update speed**:

- **Fast** (default): each build once its stage reaches your workspace, within hours of passing fleetd's own checks.
- **Steady**: only builds that have been out for 2 days and were never halted. For teams that want fewer, older
  updates.

From a terminal: `fleetd update --speed steady`. A workspace that was set to the old stable channel moves to Steady. One on
Edge moves to Fast.

## Self-check and rollback {#self-check}

After the workspace restarts on a new build, it checks itself before its machines update:

1. The workspace comes up healthy within 90 seconds.
2. Every machine that was online before the update reconnects within 3 minutes.
3. Lead turns still work. Two failed turns with none finishing normally fail the check. A failure counts whether
   Claude exited, hit a fatal error or stalled, or the machine lost its link. Failures whose error the provider
   reported don't count, because a new build can't cause them: a refused sign-in, a quota or rate limit, or an API
   outage. The update's record notes them instead.

If any step fails, the workspace puts the previous build back by itself and restarts on it. Settings › Workspace › Machines ›
Updates then says which step failed. Automatic updates skip that build until a newer one is out. **Update** still
installs it if you ask.

## Halting or pulling a build {#halt}

fleetd's maintainers can stop a build with one command:

```sh
gh workflow run rollout.yml -R unlaboredlabs/fleetd -f action=halt -f build=0.9.4
```

- `halt`: no new workspace takes the build. Workspaces already on it keep it.
- `pull`: every workspace on the build goes back to the newest earlier build that has reached it. Its machines go back too.
- `resume`: undoes a halt or a pull. Workspaces on Steady still never take a build that was halted once.

Workspaces see the change at their next check, within 2 minutes.
