# fleetd.sh

The static site behind `curl -fsSL https://fleetd.sh | sh`. `vercel.json` serves `install.sh` at `/` to curl, Wget and
fetch user agents and `home.html` to everyone else. `install.sh` is also at `/install.sh` for reading first. `home.html` is the landing page; its app captures
(`capture-*.png`) and transcripts are real fleetd output, `fleetd.txt` is its plain-text twin (not `index.txt`: Vercel would serve that at `/` and break the curl rewrite) for agents, and `fonts/`
holds the self-hosted IBM Plex Sans and Lilex (both SIL OFL, licences alongside).

There is deliberately no `index.html` at the root: Vercel serves files before applying rewrites, so an `index.html`
would win over the user-agent rewrite at `/`. `docs/index.html` is `/docs` and fine. `cleanUrls` serves
`docs/<page>.html` at `/docs/<page>`.

## Refreshing the captures

The screenshots, the `<!-- capture:NAME -->` blocks in `home.html` and the same blocks in `fleetd.txt` (found there by
the shape of fleetd's output, so the twin carries no markers) come from one command, run from the repo root on a Linux
machine with the lab set up (see "Lab suite" in `docs/CONTRIBUTING.md`) and the headless display sysroot
(`app/bench/linux-sysroot.sh`):

```sh
cargo build --release --locked -p fleetd -p fleetd-app -p fleetd-bench && npm ci --prefix tests/lab
FLEETD_LAB_SLOT=8 node tests/lab/site-capture.ts
```

It stands up a hub and a node on that lab slot, has a haiku lead file three numbered asks (three tiny turns), runs the
desktop app under a private Xvfb at the page's image size, shoots the inbox, types the reply, shoots the inbox again
and then the lead's view (it publishes the shots `home.html` shows); then it runs the `fleetd init --yes --no-service`
wizard and `fleetd machine add builder-1 --dry-run` in a throwaway HOME that has the lab's claude and gh logins, and
reads the merge train from the newest lab m7 run, if there is one: the whole path of its first two merged changes and
the first of each refusal, freeze, red CI and conflict, at most 16 lines. This machine's tailnet name and addresses
become `hub.your-tailnet.ts.net` and `<tailnet-ip>`, the gh login `demo`, and it refuses to write text that still
names this machine, its home or lab paths, a non-loopback address or a key. Review the result with `git diff site/`.
The callout positions (`--x`, `--y`) and the hand-written callout text are not generated: the script lists quotes and
ids on the page that its run didn't produce, and you re-aim the callouts if the app's layout moved.

## Docs (fleetd.sh/docs)

`site/docs/` is generated from `docs/site/*.md` by `crates/docsgen` and committed (Vercel has no build step). After
editing a page, regenerate and commit both:

```sh
cargo run -q -p docsgen
```

CI fails while `site/docs/` is out of date (`cargo run -q -p docsgen -- --check`). To read the result locally with
clean URLs, run `node .github/docs-serve.mjs` and open http://127.0.0.1:4791/docs.

### Where

- One file per page: `docs/site/<slug>.md`. Lowercase, `-` separated (`quick-start.md`, `projects-and-orders.md`).
- `docs/site/cli.md` holds only the CLI reference's frontmatter and intro; the reference itself is generated from
  `fleetd help`.
- Images, if any: `site/docs/img/<name>.png` (committed by hand, not generated), referenced as `/docs/img/<name>.png`.

### Frontmatter (all keys, nothing else is accepted)

```markdown
---
title: Quick start
section: Get started
order: 20
description: Install, set up the hub and send a first order in three steps.
---
```

| key | required | meaning |
|---|---|---|
| `title` | yes | Page `<h1>`, nav label, `<title>`, search. Short: "Machines", not "Managing your machines". |
| `section` | yes | Nav group label. Pages with the same section are one group. |
| `order` | yes | Integer, unique across all pages. Sorts the nav and prev/next. Sections sort by their lowest page order, so keep a section's pages contiguous. Use steps of 10. |
| `description` | yes | One sentence, plain text. `<meta description>`, the /docs index list and search results. |
| `slug` | no | URL segment; defaults to the filename stem. The page lives at `/docs/<slug>`. |

`/docs` itself is generated: a compact list of every section and page with its description. No intro page.

### Body

- CommonMark plus GFM tables, strikethrough and task lists. No raw HTML (it's escaped). No `#` h1 (the title is the h1).
- `##` and `###` get an id (lowercased words joined by `-`: `## Remove a machine` -> `#remove-a-machine`), a hover `#`
  link, and `##` headings make the "On this page" list. Pin an id with `## Remove a machine {#remove}`.
- Links between pages: `[Machines](machines.md)`, `[doctor](troubleshooting.md#claude_login)`, the CLI reference:
  `[machine add](cli.md#machine-add)`. Rendered as `/docs/<slug>#anchor`. Missing pages/anchors fail the build.
- A blockquote renders as a short note (rule on the left). Use sparingly.
- Inline `code` for machine text only (commands, paths, ids, keys). `fleetd <cmd>` written as code must be a command in
  `fleetd help` (CI checks it, like the landing page).

### Code blocks

| fence | rendered | copy button copies |
|---|---|---|
| ` ```sh ` | commands to run, one per line, no `$ ` | the whole block |
| ` ```console ` | a transcript: lines starting `$ ` are commands (bold), the rest is output (grey) | only the `$ ` lines, without `$ ` |
| ` ```text ` | plain output or file content | nothing (no button) |
| ` ```yaml `, ` ```toml `, ` ```json `, ` ```ini ` | file content | the whole block |

Every block except `text` gets a copy button. No syntax highlighting.

### Captured output (real output, recaptured by script)

Mark a `console` block whose output must come from the real binary with `capture=<name>` in the info string:

````markdown
```console capture=doctor-fresh
$ fleetd doctor
(output goes here; the capture script rewrites it)
```
````

- `<name>`: `[a-z0-9-]+`, unique across all pages.
- `node tests/lab/site-capture.ts --docs` (no lab, no claude turns; needs the release build or `FLEETD_BIN`) runs
  each marked block's `$ ` lines in order, in a fresh throwaway HOME (user `demo`, shown as `~`) where `fleetd init
  --listen 127.0.0.1:4778 --git-identity "Demo <demo@users.noreply.github.com>" --no-service` has already run (unless
  the block's first command is `fleetd init` itself), writes each command's output under it, keeps a nonzero exit as
  a final `[exit N]` line, and regenerates `site/docs`. It refuses to write a hostname, a real `/home` path, a
  non-loopback IP or a key.
- Blocks named `init` and `machine-add` get exactly the landing page's transcripts (the `fleetd init --yes
  --no-service …` wizard and `fleetd machine add builder-1 --dry-run` as the plan only, each ending in `[exit 0]`).
- Output that needs a live hub, a node or claude can't be captured that way. A block named `digest` is filled from
  the full lab run (`FLEETD_LAB_SLOT=8 node tests/lab/site-capture.ts`, which also does everything `--docs` does).
  For anything else that needs a live fleet, paste real output from a lab run into an unmarked `console` block.
- Never invent or edit output by hand inside a capture block.

### Doctor findings (Troubleshooting)

Use the check id as the heading id so `fleetd doctor` output can be matched to the page: `## claude is not logged in
{#claude_login}`. One `##` per finding, fix first.

## Vercel project settings

- **Import** the GitHub repo `unlaboredlabs/fleetd`.
- **Root Directory:** `site`
- **Framework Preset:** Other
- **Build Command:** Override on, left empty (nothing to build)
- **Output Directory:** leave the default; with no `public/` folder, Vercel serves the root directory as is
- **Install Command:** Override on, left empty
- **Production Branch:** `main`
- **Ignored Build Step** (Settings → Git): `git diff --quiet HEAD^ HEAD -- .`, so commits that don't touch `site/`
  don't deploy. (Vercel runs it from the root directory; exit code 0 skips the build.)
- **Domains:** `fleetd.sh` (production), and `www.fleetd.sh` redirecting to `fleetd.sh`.

## Check a deployment

The header rewrite does not run under `vercel dev`, so check a preview deployment:

```sh
curl -fsSL https://<deployment>/ | head -3     # the installer: "#!/bin/sh" ...
curl -fsSI https://<deployment>/install.sh      # content-type: text/plain
```

A browser at the same URL should show the landing page.

## Testing the installer without a release

`FLEETD_BASE_URL` points the installer at any directory of release assets, e.g. a local `python3 -m http.server`
serving `SHA256SUMS`, `fleetd-linux-x64` and `fleetd-app-linux-x64.tar.gz`:

```sh
FLEETD_BASE_URL=http://127.0.0.1:8000 HOME=/tmp/fleetd-home sh site/install.sh
```
