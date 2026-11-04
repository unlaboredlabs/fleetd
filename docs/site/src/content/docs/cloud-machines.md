---
title: Cloud machines
description: A few sleeping boat.dev machines of your own account that take work when your machines are full, within budgets you set.
---

When every machine of yours is at its agent limit, fleetd can run work on a few machines at
[boat.dev](https://boat.dev), on **your own boat.dev account**. fleetd runs no service and shares no key: each hub
uses its owner's boat.dev key, sealed to the hub.

The hub keeps a small fixed pool (3 `large` machines by default, `boat-1`…`boat-3`). Each one is made once, joins as
an ordinary [machine](/docs/machines), and then sleeps. Work wakes it, and it goes back to sleep 15 minutes after it
is idle. Asleep, it costs nothing and keeps its disk: worktrees, caches, transcripts and the secrets sealed to it. A
follow-up turn wakes the machine its task ran on. Which work goes to the cloud, and when, is in
[When work goes to a cloud machine](/docs/machines#cloud).

Cloud machines are off until an admin sets them up and turns them on.

## What it costs {#cost}

boat.dev bills machine time by the second, only while a machine runs:

| Size | vCPUs, memory, disk | An hour | Awake 24 h |
|---|---|---|---|
| `small` | 2, 4 GB, 51 GB | $0.018 | $0.43 |
| `default` | 4, 8 GB, 51 GB | $0.036 | $0.86 |
| `large` (the default) | 8, 16 GB, 111 GB | $0.072 | $1.73 |
| `xlarge` (boat.dev's $100 plan) | 16, 32 GB, 251 GB | $0.200 | $4.80 |

boat.dev's $20 plan includes $20 of machine time and 200 starts a day. Past the plan, with auto top-up off, starts
are refused rather than billed.

- **The ceiling.** 3 `large` machines awake around the clock would cost $5.18 a day. The pool's size caps it there,
  and the budgets stop it sooner.
- **A typical busy day.** With your own machines taking most of the work and the cloud taking the peaks, expect about
  5.5–10 machine-hours: $0.40–$0.72 a day on `large`. This is an estimate, not measured on your hub. Setup shows the
  ceiling and the typical day for the pool you pick before you turn it on.
- **Budgets.** A day budget ($3 by default) and a month budget (by default the dollars your plan includes), in the
  hub's time zone. When one is spent, no machine wakes, and awake ones stop within 30 minutes. Your own machines go
  on.
- **Starts.** Every create and wake is a boat.dev start. fleetd uses at most half of the starts your plan includes in
  each minute, hour and day, asks boat.dev before each one, and never buys an extra start.

What stops a machine, so a bill can't run on:

| Fence | What it does |
|---|---|
| Lease | Every awake machine carries boat.dev's own auto-stop deadline, at most 30 minutes ahead, which the hub renews while it needs the machine. If the hub dies, boat.dev stops every machine within 30 minutes. |
| Idle stop | A machine nothing runs on for 15 minutes is stopped. |
| Budget | The lease never reaches past what the budget has left. |
| Node gone | A machine whose node goes silent for 10 minutes is stopped. |
| Sweep | At hub start and every 10 minutes, the hub lists every boat.dev machine with its label and stops any it doesn't know. |
| Keepalive | A machine asleep 12 days is woken briefly, so boat.dev keeps its disk (it keeps a stopped disk 14 days). |

Today's spend shows on [Status](/docs/status) and in Settings › Hub › Machines: "Cloud today: $0.41 of $3.00 · 2
awake".

## What boat.dev can see {#what-boat-sees}

Cloud machines run on boat.dev: boat.dev can see what runs on them, as any host can. It keeps a stopped machine's
disk, and snapshots of it that may be stored outside the EU.

| A cloud machine holds | It never holds |
|---|---|
| Its node's keys | The hub's box key |
| The secrets sealed to it: the hub's Claude configuration, an order's `GH_TOKEN` while the order runs there, project secrets sealed there | Your boat.dev key |
| The worktrees, transcripts and caches of the projects you opted in | The GitHub App's private key |
| Recordings waiting to upload | Navis, leads or their integrations |

- **Only the projects you tick.** Their code, transcripts and the secrets sealed there go to boat.dev; other projects
  never run there.
- **No account secrets.** Machines are made in an environment marked safe for third parties: none of your boat.dev
  account's secrets, AI logins or in-machine boat.dev key.
- **No sudo for agents.** The node and its agents run as a user of their own with no sudo.
- **Your key stays on the hub.** The boat.dev key is sealed in the app to the hub's own key, and scoped to fleetd's
  environment with only the actions below. It has no `exec`, `ssh`, `file` or `snapshot` actions: the hub never runs
  anything on a cloud machine. The machine's node dials in.
- **Reset is the wipe.** Stopping keeps the disk; [Reset](#reset) deletes it, with every key on it.

## Set it up {#setup}

Setup is the optional **Cloud machines (boat.dev)** step: in `fleetd init`, the app's first run, and Settings › Hub
› Setup. Its parts:

1. **A boat.dev organization with one seat.** It costs the same as a personal plan, and its owner can cap their own
   seat, so boat.dev itself stops everything at the cap whatever fleetd does. In Billing, turn **auto top-up off** and
   leave **extra starts on invoice off**. In Members, set your own seat's caps: machine time **300 hours a month**,
   and machines at once **equal to your pool size** (3).
2. **An environment** named `fleetd-<hub>` (for example `fleetd-devbox`), with **Safe for third parties** on.
3. **The hub's API key**, named `fleetd-<hub>`, scoped to that environment, expiring in 365 days, with exactly these
   actions:

   ```
   sandbox.create sandbox.read sandbox.update sandbox.stop sandbox.resume sandbox.delete account.read
   ```

   Not a preset: `ci` and `admin` give far more.
4. **A public HTTPS address for the hub.** Cloud machines run on the internet, outside your tailnet, so they reach the
   hub over HTTPS. With Tailscale Funnel, on the hub (with the address your devices use now):

   ```sh
   tailscale funnel --bg http://devbox:4790
   fleetd init --url https://<the address it prints>
   ```

   Or put any HTTPS reverse proxy in front of the hub, such as Caddy's
   `fleetd.example.com { reverse_proxy devbox:4790 }`, and save that address the same way. Only the hub's port is
   published, and every call to it needs a key.
5. **In the app**, in the step itself or in Settings › Hub › Machines › Cloud machines: paste the key and press
   **Save and test**. Test asks boat.dev for the key's plan and limits and this hub's machines, and says, for example,
   "Key works · $20 plan · 200 starts a day (12 a minute) · 0 of 100 machines running · large allowed". It starts
   nothing. Then pick the pool, the budgets and the projects, and keep the boat.dev environment from part 2 (it starts
   as `fleetd-<hub>`; Create waits until one is saved, since the key reaches only that environment). Check what it can
   cost, turn it on and press **Create cloud machines** (one start each). Each machine sets itself up and joins in a few minutes, then sleeps.

Claude needs nothing more: each cloud machine gets the hub's Claude configuration (its API key or the owner's
subscription) sealed to it when it joins, and again whenever it changes. Nobody pastes it.

The step is done when the doctor's cloud checks pass:

| Check | Passes when |
|---|---|
| `hub/cloud_key` | boat.dev answered the key at the last Test or sweep. |
| `hub/cloud_network` | The hub has a public HTTPS address. |
| `hub/cloud_machines` | Every machine of the pool is made, none is broken, and cloud machines are on. |
| `hub/cloud_budget` | No budget is spent and boat.dev wants no billing attention. |

## The machines list {#list}

Settings › Hub › Machines lists cloud machines as a **boat.dev** group under your own: each one's state, what runs
there, and its spend today.

| State | Meaning |
|---|---|
| Setting up | Made, joining for the first time. |
| Waking | Woken for work; its node hasn't said hello yet. |
| Awake | Running, with its agents and screens. |
| Going to sleep | A stop was sent. |
| Asleep | Stopped; it costs nothing and keeps its disk. |
| Broken | Two wakes in a row brought no hello, so the hub won't wake it again. [Reset](#reset) it. |
| Not made | Its create failed, with boat.dev's reason; Create cloud machines tries again. |

An asleep cloud machine shows offline elsewhere, but never counts as a machine down. Members see the day's line on
[Status](/docs/status), with who to ask.

## The kill switch {#kill}

**Stop all cloud machines** in Settings › Hub › Machines, or on the hub:

```sh
fleetd cloud stop
```

It turns cloud machines off, then asks boat.dev itself for every machine with the hub's label, whether the hub's
records know it or not, and stops each one still running. Each sweep stops them again while cloud machines stay off.
Work that was running there picks up at the next wake. If boat.dev can't be reached, their leases stop them within
30 minutes. Turn cloud machines on again in Settings › Hub › Machines.

## Reset a machine {#reset}

**Reset** on a broken (or failed) machine deletes it at boat.dev, with its disk, caches and the secrets sealed there,
then makes it again with one start. Work pushed to GitHub is safe. An awake machine can't be reset.

## Limits {#limits}

- boat.dev runs in the EU only. From elsewhere, live views of screens on a cloud machine feel slower.
- Every cloud machine is x86_64 Ubuntu: no macOS and no iOS simulators. Those stay on [the agents' Mac](/docs/agents-mac).
- A pool holds 1 to 10 machines of one size. Grow it with more `large` machines rather than `xlarge`, which costs more
  per vCPU.
- Reviews and readers of the projects you opt in may go to cloud machines; writers only once an admin turns on
  **Writers too** in Settings › Hub › Machines › Cloud machines.
- Cloud machines reach the hub only over public HTTPS; there is no Tailscale path for them.
- One boat.dev account can serve several hubs: each touches only machines with its own label, and they share the
  account's starts.
