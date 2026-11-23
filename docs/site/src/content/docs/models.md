---
title: Models and agent limits
description: Choose which models agents run on and how many run at once.
---

Each bot runs as many agents at once as you allow, each on a model you choose. This page covers both.

## How many agents at once {#max-agents}

1. Open **Settings › Bots** and pick the bot.
2. Open **Agents**.
3. Drag **Max agents**. It applies when you let go, with Undo.

**Use the default** goes back to the machine's limit. The lead never counts toward it.

Each machine has its own limit too. By default it's what the machine fits: about one agent per CPU and 2 GB of memory each, at most 64. Owners and admins change it under **Settings › Hub › Machines** › the machine › **At once**.

When the limit is reached:

- New agents wait in line and start as soon as a slot frees. Nothing fails.
- Lowering the limit stops nothing. Running agents finish; new ones wait.
- Reviews that hold up a merge go first, so merging never stalls.

From a terminal:

```sh
fleetd project set devbox/storefront --max-agents 3
fleetd project set devbox/storefront --max-agents default
```

## Profiles {#profiles}

A profile is a model, an effort level and a short note on what it's for. Every agent runs on one. A new hub has two:

| Profile | Model | For |
|---|---|---|
| high (default) | Opus 5.5, high effort | Most work, every review |
| medium | Opus 5.5, medium effort | Mechanical work: renames, moves, doc fixes |

The lead reads each profile's note and picks one per piece of work. Work that fails review twice on another profile is redone on the default.

### Change profiles {#change-profiles}

- **Which profiles a bot may use:** Settings › Bots › *your bot* › Agents › **Allowed profiles**.
- **Add or edit a profile:** Settings › Hub › **Providers** (owners and admins). Each provider lists its profiles under
  it: click one to edit it, or **+** on the provider's row to add one. Pick its model (that provider's), effort (low to
  max), fast mode and note. On the phone: Settings › Providers › **Add Profile**.
- **The default profile:** Settings › Hub › Bot defaults › Agents › **Default profile**. Reviews and work that names
  no profile run on it.

A profile whose provider isn't connected stays listed under it, marked unusable until you connect the provider.

A change applies to agents started after it. Running agents keep the model they started on.

If an account can't use a model, the agent carries on with Opus 5.5 and the profile is flagged.

## The lead's model {#lead-model}

- **For every bot:** Settings › Hub › Bot defaults › Agents › **Lead runs on**.
- **For one bot:** Settings › Bots › *your bot* › Agents › **Lead model**.

A bot's own pick wins over the one for every bot. The lead switches by itself at its next idle moment: at once if it's
idle, or when its current turn ends. It keeps its chat, memory and orders.

To switch now, click **Restart lead**. It stops a turn under way, as **Stop** does. It's also how you restart a stuck
lead on the same model.

## Gemini models {#gemini}

A profile can run on Google's Gemini models through Antigravity, Google's coding agent.

1. Open **Settings › Hub › Providers** and find **Google**.
2. Click **Sign in with Google** to sign in a machine, or add a **Gemini API key** for the whole hub.
3. Under Google, click **+** to add a profile on a Gemini model, or pick one in a bot's **Lead model**.

A bot can use its own key: add `GEMINI_API_KEY` to its [Vault](/docs/vault). Agents on Gemini run on your own machines.

Antigravity shows its model only about 60 KB of MCP tools. When a bot's own servers would go past that, its lead
starts without the biggest of them, and the chat says which. A server that doesn't list its tools within 10 seconds
is left out the same way, and the next start tries it again. fleetd's own tools always fit, and its agents keep every
server.
