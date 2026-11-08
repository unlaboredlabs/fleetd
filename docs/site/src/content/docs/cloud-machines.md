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

The hub stays private: it needs no public address, domain, port or proxy, so a hub only your tailnet or LAN reaches
works. The hub dials each machine it wakes and holds an SSH tunnel to it, and the machine's node reaches the hub
through that tunnel ([how](#tunnel)).

Cloud machines are off until an admin sets them up and turns them on.

## What it costs {#cost}

boat.dev bills machine time by the second, only while a machine runs:

| Size | vCPUs, memory, disk | An hour | Awake 24 h |
|---|---|---|---|
| `small` | 2, 4 GB, 51 GB | $0.018 | $0.43 |
| `default` | 4, 8 GB, 51 GB | $0.036 | $0.86 |
| `large` (the default) | 8, 16 GB, 111 GB | $0.072 | $1.73 |
| `xlarge` (boat.dev's $100 plan) | 16, 32 GB, 251 GB | $0.200 | $4.80 |

Measured on a real `large`: $0.072 for each hour awake, and nothing while asleep.

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

## Waking up {#wake}

Measured on `large` machines:

- **A wake takes seconds.** A sleeping machine runs again 2–3 seconds after the hub wakes it, and its node says hello
  3–6 seconds after that.
- **The first builds after a wake are slower.** The machine's disk loads in the background after a wake: about
  5 minutes for 30 GB in use, 13 minutes for 47 GB. Until it's done, builds run up to 5 times slower (a 70-second
  rebuild took 6 minutes). This is why a machine stays awake 15 minutes after its work ends.
- **3 agents a machine.** A `large` machine runs 3 agents with 2 build jobs each: more jobs didn't build any faster.
- **Keep tailnet routes off 10.77.0.0/16.** boat.dev reaches each machine on its own network there, so a subnet route
  your tailnet advertises must not cover it.

## What boat.dev can see {#what-boat-sees}

Cloud machines run on boat.dev: boat.dev can see what runs on them, as any host can. It keeps a stopped machine's
disk, and snapshots of it that may be stored outside the EU.

| A cloud machine holds | It never holds |
|---|---|
| Its node's keys | The hub's box key |
| The secrets sealed to it: the hub's Claude configuration, an order's `GH_TOKEN` while the order runs there, project secrets sealed there | Your boat.dev key |
| The worktrees, transcripts and caches of the projects you opted in | The GitHub App's private key |
| Recordings waiting to upload | Leads or their integrations |

- **Only the projects you tick.** Their code, transcripts and the secrets sealed there go to boat.dev; other projects
  never run there.
- **No account secrets.** Machines are made in an environment marked safe for third parties: none of your boat.dev
  account's secrets, AI logins or in-machine boat.dev key.
- **No sudo for agents.** The node and its agents run as a user of their own with no sudo.
- **Your key stays on the hub.** The boat.dev key is sealed in the app to the hub's own key, and scoped to fleetd's
  environment with only the actions below. It has no `exec`, `file` or `snapshot` actions: the hub never runs
  anything on a cloud machine. Its `ssh` action only lets the hub's own SSH key in, for the tunnel.
- **The hub's SSH key.** The hub makes its own SSH key for the tunnels and keeps it sealed to its box key; nobody
  pastes it, and its private half never leaves the hub. boat.dev puts the public half on each machine the hub wakes.
  Settings › Hub › Machines › Cloud machines shows it.
- **Your network stays closed.** boat.dev never gets an address of your hub, your tailnet or your LAN. A tunnel
  carries only the node's connections to the hub, and every call through it needs the node's key, as on any machine.
- **Reset is the wipe.** Stopping keeps the disk; [Reset](#reset) deletes it, with every key on it.

## Set it up {#setup}

Setup is the optional **Cloud machines (boat.dev)** step: in `fleetd init`, the app's first run, and Settings › Hub
› Setup. Its parts:

1. **A boat.dev organization with one seat.** It costs the same as a personal plan, and its owner can cap their own
   seat, so boat.dev itself stops everything at the cap whatever fleetd does. In Billing, turn **auto top-up off** and
   leave **extra starts on invoice off**. In Members, set your own seat's caps: machine time **300 hours a month**,
   and machines at once **equal to your pool size** (3).
2. **An environment** named `fleetd-<hub>` (for example `fleetd-devbox`), with **Safe for third parties** on. Make it
   among your own environments, not the organization's: boat.dev lets a machine use an organization's environment
   only when that machine bills to the organization, and refuses any other name with `unknown_environment`.
3. **The hub's API key**, named `fleetd-<hub>`, scoped to that environment, expiring in 365 days, with exactly these
   actions:

   ```
   sandbox.create sandbox.read sandbox.update sandbox.stop sandbox.resume sandbox.delete ssh account.read
   ```

   Not a preset: `ci` and `admin` give far more.
4. **In the app**, in the step itself or in Settings › Hub › Machines › Cloud machines: paste the key and press
   **Save and test**. Test asks boat.dev for the key's plan and limits and this hub's machines, and says, for example,
   "Key works · $20 plan · 200 starts a day (12 a minute) · 0 of 100 machines running · large allowed". Then pick the
   pool, the budgets and the projects, and keep the boat.dev environment from part 2 (it starts as `fleetd-<hub>`;
   Create waits until one is saved, since the key reaches only that environment). Check what it can cost, turn it on
   and press **Create cloud machines** (one start each). Each machine sets itself up and joins in a few minutes, then
   sleeps. One whose node hasn't said hello 15 minutes after its create is deleted and shows as not made, with the
   setup step that failed and its last line, for example "its setup failed at packages: E: Unable to locate package
   xvfb", not the whole setup log; time the hub was down or restarting doesn't count. Nobody logs `gh` in on a cloud
   machine: git asks `gh` for GitHub's credentials, which it answers from each order's own token.

There is nothing to set up on your network. Once cloud machines are on, **Test** also tries the whole way: it wakes
an asleep machine (one start), or follows one already waking, or makes the first one, and passes once the hub's tunnel
to it is up and its node said hello through it. If a step fails, it says which and why, for example "boat-1: no hello
within 2 minutes of its wake: the hub's tunnel to it didn't come up (…: connection refused)". A wake or create that
doesn't start says why on that machine's line (or as the pool's hold), and a failed Test clears once a later start
goes through. The Test's result shows under **Use cloud machines**. A Test wake goes back to sleep after 5 idle minutes.

Claude needs nothing more: each cloud machine gets the hub's Claude configuration (its API key or the owner's
subscription) sealed to it when it joins, and again whenever it changes. Nobody pastes it.

The step is done when the doctor's cloud checks pass:

| Check | Passes when |
|---|---|
| `hub/cloud_key` | boat.dev answered the key at the last Test or sweep. |
| `hub/cloud_network` | A cloud machine reached the hub through the hub's tunnel: at the last Test, or by joining. |
| `hub/cloud_machines` | Every machine of the pool is made, none is broken, and cloud machines are on. |
| `hub/cloud_budget` | No budget is spent and boat.dev wants no billing attention. |

## How cloud machines reach the hub {#tunnel}

The hub dials out; nothing dials in to it:

1. When the hub wakes or makes a machine, it asks boat.dev to put the hub's SSH public key on it. boat.dev answers
   with the machine's SSH host key, which the hub pins: a server with another key is refused, and if boat.dev names
   none, the hub doesn't connect. The machine's SSH address comes from boat.dev too, read again at every connect.
2. The hub connects to the machine's public SSH port and asks for one reverse forward: the machine's
   `127.0.0.1:47900` goes to the hub's own listen address. It never opens a shell or runs a command there.
3. The machine's node uses `http://127.0.0.1:47900` as its hub address. A new machine's setup waits for the tunnel,
   then joins through it.
4. If the connection drops while the machine is awake, the hub redials, waiting 1 second and doubling up to 30. The
   hub sends keepalives every 15 seconds, and the machine's SSH server drops a hub silent for 45 seconds, so after
   the hub's network drops uncleanly the old session frees the tunnel's port and a redial gets it back. Setup
   configures this again at every wake, then ends the SSH sessions opened before it, so the hub redials into it at
   once. A machine whose tunnel never comes up counts as a failed wake: its node says no hello, so the hub stops it,
   and two such wakes in a row make it broken.
5. When the machine sleeps or is deleted, the hub closes the tunnel. Each wake opens a new one: every resume is a new
   machine, with a new address and host key, so nothing about it is kept across a sleep.

The hub needs outbound access to boat.dev's API and its machines' SSH ports (TCP), which any network with internet
access has.

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
| Not made | Its create failed, with when and boat.dev's reason; Create cloud machines tries again. |

A create boat.dev refuses for what it asked (an environment it doesn't know, a size the plan lacks) fails only that
machine, once: nothing asks again by itself, and the next **Create cloud machines** goes straight to boat.dev. For
`unknown_environment`, make the environment the line names (part 2 of [setup](#setup)), or save the name of the one
the key is scoped to, then Create again. A wake boat.dev refuses that way pauses cloud machines until you press
**Resume**. Changing the key or the environment clears the old refusals.

An asleep cloud machine shows offline elsewhere, but never counts as a machine down: no [notification](/docs/machines#down) says it is offline, unless the pool marks it broken. Members see the day's line on
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
- A pool holds 1 to 10 `large` machines. The app picks only how many: grow by adding machines, not size. A hub that
  saved another size keeps it, and an admin key's `cloud_set {machineType}` still changes it.
- Any agent of the projects you opt in may go to cloud machines, writers too: the project ticks and the budgets are
  the controls.
- Cloud machines reach the hub only through the hub's own tunnel; they never join your tailnet.
- One boat.dev account can serve several hubs: each touches only machines with its own label, and they share the
  account's starts.
