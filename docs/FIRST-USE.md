# Your first order

This picks up after `fleetd init` (the README's [Quick start](../README.md#quick-start)) and covers your first order,
from the project to "done".

## Add a project

Run `fleetd init` again and pick a repo: a checkout it finds on this machine, or a GitHub URL, which it clones. It
leaves the rest of your setup as it is. From an MCP client, `project_add {machineId, path, title}` adds one, and
`project_remove {machineId, projectId}` takes it off.

Each project has one lead. Until it has one, orders for it wait as drafts. Start it with
`lead_start {machineId, projectId}`.

## Send an order

In the app, choose File → New Order and type one line, such as `fix the typo in the README`. From any MCP client,
call `intake_submit {text}`. The hub works out which project the order is for.

## Watch it

The lead turns the order into a brief and runs writer and reviewer tasks on your machines. Every PR it opens names
its source, and the merge train merges it after CI passes. The lead reports "done" only after fleetd has checked the
work itself. Follow along on the app's Projects screen, or with `workstream_list` and `workstream_get`.

## Answer an ask

The lead asks you only about product calls, money, credentials and irreversible steps. Its asks land in the app's
inbox:
- **Decisions:** pick an option or reply in your own words.
- **Commands:** approve or reject the exact command that will run.
- **Secrets:** type the value; the app seals it to the machine that needs it.

Asks that block work also raise a desktop notification.

## When something is wrong

Run `fleetd doctor`, or look at the app's Machines screen. Each problem comes with its fix, and
`fleetd doctor --fix` applies the ones fleetd can make by itself. The logs are in `~/.fleetd/hub/hub.log` and `~/.fleetd/logs/node.log`.
