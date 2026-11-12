---
title: Moving a hub
description: Take a hub's data to another hub as one file with fleetd export and fleetd import, and see what the file carries and what it leaves behind.
---

`fleetd export` writes everything a [hub](/docs/glossary#hub) knows into one file, and `fleetd import` loads that file
into a fresh hub, on another machine or after a reinstall. Both commands run on the hub machine and work on the hub's
home (`~/.fleetd/hub`, or `FLEETD_HOME`).

## Export {#export}

```sh
fleetd export --out shop-hub.tar
```

The hub keeps running. The file is one consistent snapshot of its database as of the moment the command started,
followed by the files of its home. Without `--out` it is `fleetd-export-<time>.tar` in the current folder. It is
written as `<file>.part` and renamed when it is whole, readable only by you (mode `0600`), and a file that is already
there is never overwritten.

Export asks for a passphrase, twice, of 12 characters or more. The hub's secrets go into the file sealed under it:
without the passphrase the file opens none of them, and nobody can recover a lost one, so keep it with the file. The
passphrase is never a command-line argument and is never printed. For a script:

| From | How |
|---|---|
| A file | `--passphrase-file <file>`: its first line |
| Standard input | `--passphrase-file -` |
| The environment | `FLEETD_EXPORT_PASSPHRASE` |

`--no-secrets` writes the file without the secrets and asks for nothing.

When the vault's key is itself kept under a passphrase (`fleetd vault key --store passphrase`), export asks for that
one too, or reads it from `FLEETD_VAULT_PASSPHRASE`.

## Import {#import}

Import loads into a **fresh hub only**: one that was set up (`fleetd init`) and has no project, chat, order, task,
decision, vault item or second person yet. Machines may already have joined it, as long as none brought a project. A
hub that has data is refused with a line that names what it found, and nothing is changed.

1. On the new hub machine, install fleetd and run `fleetd init`. Add no project.
2. Stop the hub: `systemctl --user stop fleetd-hub`, or on a Mac `launchctl bootout gui/$(id -u)/sh.fleetd.hub`.
   Import refuses while a hub has the database open.
3. Load the file. It asks for the export's passphrase, or takes it as export does.

   ```sh
   fleetd import shop-hub.tar
   ```

4. Start the hub: `systemctl --user start fleetd-hub`, or on a Mac
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.fleetd.hub.plist`.
5. Join the machines and sign people in again, with the commands import printed (see [what isn't carried](#not-carried)).

Import reads the whole file and checks every part against the checksum the file lists for it before it touches the
hub. Then it loads all or nothing: the rows go into the hub's database in one transaction, and the files move into
place with it. A damaged file, a wrong passphrase or a full disk leaves the hub exactly as it was. At the end it
prints what it loaded and what it skipped.

`--no-secrets` loads a file without its secrets, for when you don't have the passphrase: everything else arrives,
and the vault, the GitHub App and the connected accounts are set up again by hand.

An export written by a newer fleetd than the one importing is refused with a line that says to update fleetd
(`fleetd update`), then import again. An export from an older fleetd loads: import runs the migrations its rows
hadn't seen.

## What is carried {#carried}

Everything the hub keeps across its own restart:

| | |
|---|---|
| Projects | Each project with its settings, picture, repos, instructions, MCP servers and plain variables. |
| Chats | Every message, pin and section, with attachments. |
| Work | Orders, tasks and their results, agents' sessions as records, checklists, reviews, the merge train's state. |
| Knowledge | Decisions, memory, skills and their versions, artifacts and their versions, prompts you changed. |
| Automations | Each with its schedule, runs and webhook. A webhook keeps its secret: its URL is the new hub's address with the same path. |
| People | Everyone with their role and picture. |
| Settings | The hub's settings, profiles, agent limits, approvals. |
| Recordings | Browser and screen sessions that were recorded, with their files. |
| History | The event log, time and metrics. |
| Secrets | Vault items (logins, cards, addresses, variables) with their log, the GitHub App's keys, connected GitHub accounts, MCP sign-ins, links to other hubs, your own push relay's key. |

Secrets never leave in the clear. Export opens each with the hub's own keys and seals it under a key made for that
file, which is in the file only wrapped under your passphrase (scrypt, then AES-256-GCM). Import seals each again to
the new hub's own keys. The hub's own keys are never in the file.

## What isn't carried {#not-carried}

| Left behind | Why | Afterwards |
|---|---|---|
| Machines' keys | A machine's enrolment is with one hub. | Each machine is carried as an offline placeholder under its id, so its projects keep their place. Join it again: on the hub, `fleetd pair --worker <machine-id>`, then the command it prints on that machine. Add `--rejoin` to it when the new hub answers at the old hub's address. |
| Keys and device sign-ins | A key signs a device in to one hub. | The owner pairs again with `fleetd pair`. Everyone else gets `fleetd invite --person <personId>`, which makes a device of the person they already are. Agents' keys are made again as agents start. |
| Phones' push tokens | They belong to the sign-ins. | Each phone registers again when it signs in. |
| Open pairing, invite and join codes | They are single use and short lived. | Print new ones. |
| The hub's own keys | The box key and the vault's root key never leave the hub. | The new hub has its own; secrets are sealed to them on import. Save the new [recovery code](/docs/vault). |
| Keys given to other hubs | They were this hub's to give. | Link the hubs again. |
| Agent slots, session places, waits for a screen | They describe processes on the old hub's machines at that moment. | Agents claim slots again as they run. |
| Unfinished uploads, recordings still being made | Half a file. | Send or record again. |
| Builds, update downloads, the log, `setup.json` | Made again, or about this install's address. | `fleetd init` writes the new install's. |

Agents that were running when the export was taken aren't moved: their sessions live on the machines. Let them finish
or stop them first, export, and start work again on the new hub once its machines have joined.

Projects find their folders by machine id and path. A machine that joins the new hub under the id it had, with its
checkouts where they were, picks its projects up as they were.

## The file {#file}

The file is an uncompressed tar, so `tar tf` lists it, written and read front to back without holding it in memory:

| Entry | What |
|---|---|
| `fleetd-export.json` | The header: the format's version, the fleetd version that wrote it, when, and how the secrets' key is wrapped. |
| `tables/<table>/<n>.jsonl.gz` | A table's rows, one JSON object a line, gzipped, a new part every 8 MB of rows. |
| `files/<n>` | A file of the hub's home, as it is. |
| `manifest.json` | What is inside: every table with its columns and row count, every file with its place, and the size and SHA-256 of every part. |
| `manifest.sha256` | The manifest's own SHA-256. |

The format is versioned, 1 today, and its schema is `HubExport.json` beside the repo's other contracts.
