# fleetd.sh

The static site behind `curl -fsSL https://fleetd.sh | sh`. `vercel.json` serves `install.sh` at `/` to curl, Wget and
fetch user agents and `home.html` to everyone else. `install.sh` is also at `/install.sh` for reading first. `home.html` is the landing page; its app screenshots
(`chat-*.png`) and transcripts are real fleetd output, `fleetd.txt` is its plain-text twin (not `index.txt`: Vercel would serve that at `/` and break the curl rewrite) for agents, and `fonts/`
holds the self-hosted IBM Plex Sans and Lilex (both SIL OFL, licences alongside).

There is deliberately no `index.html` at the root: Vercel serves files before applying rewrites, so an `index.html`
would win over the user-agent rewrite at `/`. `docs/index.html` is `/docs` and fine. `cleanUrls` serves
`docs/<page>.html` at `/docs/<page>`.

## Refreshing the captures

The app screenshots (`chat-hero.png` at the top of the page, `chat-approve.png` and `chat-secret.png` in Fig. 1 and 2)
and the app shots in the docs (`docs/site/public/img/`) are the app's screens on E3b's fixtures, which are sanitized
lab hub traffic (`app/desktop/fixtures`), at 1400x900@2x in the light theme, without the sample-data banner.
`app/desktop/qa/site.ts` lists them; `pnpm fixtures && pnpm qa:build && pnpm site:shots` in `app/desktop` writes them in
place. Re-shoot them when what those screens show changes, keep the captions and alt texts true to the picture, and
re-aim the figures' callouts (`--x`, `--y` in `home.html`) if the layout moved.

The `<!-- capture:NAME -->` blocks in `home.html` and the same blocks in `fleetd.txt` (found there by the shape of
fleetd's output, so the twin carries no markers) come from one command, run from the repo root:

```sh
cargo build --release --locked -p fleetd && npm ci --prefix tests/lab
node tests/lab/site-capture.ts
```

It runs the `fleetd init --yes --no-service` wizard and `fleetd machine add builder-1 --dry-run` in a throwaway HOME
with your claude and gh logins copied in, and reads the merge train from the newest lab m7 run, if there is one: the
whole path of its first two merged changes and the first of each refusal, freeze, red CI and conflict, at most 16
lines. This machine's tailnet name and addresses become `hub.your-tailnet.ts.net` and `<tailnet-ip>`, the gh login
`demo`, and it refuses to write text that still names this machine, its home or lab paths, a non-loopback address or
a key. Review the result with `git diff site/`.

## Docs (fleetd.sh/docs)

The docs are an [Astro Starlight](https://starlight.astro.build) site in `docs/site/`. Its build, `site/docs/`, is
committed, because the Vercel project has no build step. After editing a page, rebuild and commit both:

```sh
cargo run -q -p docsgen                  # only when the CLI or the prompt registry changed
npm ci --prefix docs/site
npm run build --prefix docs/site
```

CI fails while the generated pages or `site/docs/` are out of date. To read the docs locally with clean URLs, run
`node .github/docs-serve.mjs` and open http://127.0.0.1:4791/docs, or `npm run dev --prefix docs/site` while
writing.

### Where

- One file per page: `docs/site/src/content/docs/<slug>.md`, or `.mdx` when the page uses tabs. Lowercase,
  `-` separated. The page lives at `/docs/<slug>`.
- The sidebar is the `sidebar` list in `docs/site/astro.config.mjs`. A new page needs an entry there.
- Generated, don't edit: `reference/cli.md` (from `fleetd help`), `reference/agent-tools.md` (from the agent tools),
  and the prompt table between `<!-- prompt-table -->` markers in `what-agents-are-told.md`. `cargo run -q -p docsgen`
  writes them; `crates/docsgen/src/main.rs` lists them.
- Images: `docs/site/public/img/<name>.png`, referenced as `/docs/img/<name>.png`.

### Frontmatter

```markdown
---
title: Quick start
description: Install fleetd, open a project and chat with its lead.
---
```

`title` is the page's `<h1>` and sidebar label: short, "Machines", not "Managing your machines". `description` is one
plain sentence for search and link previews; quote it when it contains `: `.

### Writing

- Start with one sentence on what the reader will do, or what the page is.
- Example first, then explanation. Numbered steps with the exact command, then its expected output in a ` ```text `
  block.
- Options, fields and states as tables. Troubleshooting as symptom, cause, fix.
- Short sentences, plain words, no paragraph over about three lines.
- Link a fleetd term to the [Glossary](https://fleetd.sh/docs/glossary) the first time a page uses it.
- No time estimates in text or examples: measured durations only.
- Links between pages are absolute: `[Machines](/docs/machines#remove)`. CI checks every link and anchor.
- Pin an anchor that other pages or fleetd's output use: `## Remove a machine {#remove}`.
- Inline `code` for machine text only (commands, paths, ids, keys). A `fleetd <cmd>` written as code must be a
  command in `fleetd help` (CI checks it, like the landing page).
- Callouts: `:::note`, `:::tip`, `:::caution`. Tabs (`.mdx` only): `<Tabs syncKey="os">` with `macOS` and `Linux`
  items, as in `install.mdx`.

### Code blocks

| fence | for |
|---|---|
| ` ```sh ` | commands to run, one per line, no `$ ` |
| ` ```text ` | output, or file content without a language |
| ` ```console capture=<name> ` | a transcript the capture script fills from the real binary (below) |
| ` ```yaml `, ` ```ini `, ` ```json ` | file content |

Every block gets a copy button and syntax highlighting.

### Captured output (real output, recaptured by script)

Mark a `console` block whose output must come from the real binary with `capture=<name>` in the info string. It may
be indented as a step of a numbered list:

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
  a final `[exit N]` line, and rebuilds `site/docs`. It refuses to write a hostname, a real `/home` path, a
  non-loopback IP or a key.
- Output that needs a live hub, a node or claude can't be captured that way. Paste real output from a lab run into a
  ` ```text ` block instead.
- Never invent or edit output by hand inside a capture block.

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
serving `SHA256SUMS`, `fleetd-linux-x64` and `fleetd-desktop-linux-x86_64.AppImage`:

```sh
FLEETD_BASE_URL=http://127.0.0.1:8000 HOME=/tmp/fleetd-home sh site/install.sh
```
