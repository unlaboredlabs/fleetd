# fleetd.sh

The static site behind `curl -fsSL https://fleetd.sh | sh`. `vercel.json` serves `install.sh` at `/` to curl, Wget and
fetch user agents and `home.html` to everyone else. `install.sh` is also at `/install.sh` for reading first. `home.html` is the landing page: a hero
with the install line, the philosophy (three lines set big and a paragraph), then four short sections, each with its own clip of the app (`showcase-*`). It is dark until
the reader picks Light in the header; the choice is kept under the docs' `starlight-theme` key, where anything but
`light` (the docs' Auto included) reads as dark. `fleetd.txt` is its plain-text twin (not `index.txt`: Vercel would serve that at `/` and break the curl rewrite) for agents, and `fonts/`
holds the self-hosted IBM Plex Sans and Lilex (both SIL OFL, licences alongside).

There is deliberately no `index.html` at the root: Vercel serves files before applying rewrites, so an `index.html`
would win over the user-agent rewrite at `/`. `docs/index.html` is `/docs` and fine. `cleanUrls` serves
`docs/<page>.html` at `/docs/<page>`.

## Refreshing the clips

Each section of `home.html` has its own clip, a few seconds of the app on the `showcase-order` fixture
(`app/desktop/fixtures/showcase`), its takes cut together tight and its end fading into its start, so it loops without
a cut:

| clip | section | shows |
|---|---|---|
| `lead` | Ask the lead; it lands the PRs | you ask storefront's lead, it splits the request between three writers and #231 opens; then the merge line as four PRs merge as one batch |
| `team` | Your team in one chat | checkout's chat: Bob's earlier request, Sam's ask, Alice's beside it under her name, and the lead answering both |
| `screens` | Watch an agent's screen, and take over | a writer's live browser; then the iPhone simulator's sign-in asking for you, Take over, the code, Hand back |
| `navi` | Navi, your own assistant | Ada, with Marta's lease renewal that waits on you; Send it, and it went |

Each is `showcase-<clip>-<theme>.webm` (VP9, 2800x1800, 60 fps) with an H.264 `.mp4` twin for browsers without VP9
(1792x1152 at 60 fps, level 4.2 at most, which older iPhones and iPads decode; encoded frame by frame by the app's WebCodecs,
so nothing is dropped), its poster `showcase-<clip>-<theme>.jpg`, and a half-size `-small` twin of each for small
screens, in `light` and `dark`. `pnpm fixtures && pnpm qa:build && pnpm site:showcase` in `app/desktop` records them in
place (`app/desktop/qa/showcase.spec.ts`, one test per clip and theme, `-g "showcase team"` for one; it needs
Playwright's ffmpeg, `pnpm exec playwright install ffmpeg` in `app/desktop`); the screens' pages are
`fixtures/showcase/media/`, drawn by `node fixtures/showcase/media.ts`. The page shows each poster first and plays its
clip once the frame is near the screen, the half-size one on a small screen; with reduced motion it keeps the poster
until Play. Record a clip again when what it shows changes, and keep its section's words and alt text true to it.

### Cursor and camera

A clip's cursor and camera come from what its scene does, not from keyframes. The scene in `showcase.spec.ts` clicks
with `press(page, target)`, types with `ask(...)`, and can `look(page, from, until, target)` at a part of the window
while the app moves on its own; each notes a step (when, and where on the page) in the recording's timeline.
`app/desktop/qa/camera.ts` works out, for every frame at 60 fps, a macOS-style cursor that heads for each click along a
gentle arc on a spring and dips as it clicks, and a camera on a critically damped spring that sets off as the cursor
does and pushes in on the typing, on each click together with what it changed (found by comparing the frames before
and after), and on each look, then eases back out to the whole window. Steps close together share one move in.
`press(page, target, { zoom: false })` keeps the camera still for a step; `{ zoom: 1.3 }` sets its zoom. The window is
recorded at 3x (4200x2700) and the clip is the window at 2x (2800x1800), so the camera's most zoom (1.5) still has a
recorded pixel for each pixel of the clip. Each take opens and ends on the whole window, and the clip ends with the
cursor where it starts, so cuts and the loop join up. The run logs each clip's frame pacing.

### Quality

The full-size clips are VP9 at CRF 22 in two passes, the `-small` ones CRF 30; the `.mp4` is H.264 at a variable rate
of up to 12 Mbps (5 for `-small`). Only the clip near the screen loads (`preload="none"`, then an
IntersectionObserver).

The app shots in the docs (`docs/site/public/img/`) are the app's screens on E3b's fixtures, which are sanitized lab
hub traffic (`app/desktop/fixtures`), at 1400x900@2x, without the sample-data banner. `app/desktop/qa/site.ts` lists
them; `pnpm fixtures && pnpm qa:build && pnpm site:shots` in `app/desktop` writes them in place. Re-shoot them when what
those screens show changes, and keep the captions and alt texts true to the picture.

The docs' setup transcripts, a `console` block named `capture=init` or `capture=machine-add`, come from one command,
run from the repo root:

```sh
cargo build --release --locked -p fleetd && npm ci --prefix tests/lab
node tests/lab/site-capture.ts
```

It runs the `fleetd init --yes --no-service` wizard and `fleetd machine add builder-1 --dry-run` in a throwaway HOME
with your claude and gh logins copied in. This machine's tailnet name and addresses become `hub.your-tailnet.ts.net` and `<tailnet-ip>`, the gh login
`demo`, and it refuses to write text that still names this machine, its home or lab paths, a non-loopback address or
a key. Review the result with `git diff docs/site`.

## Docs (fleetd.sh/docs)

The docs are an [Astro Starlight](https://starlight.astro.build) site in `docs/site/`. Its build, `site/docs/`, and
its search index, `site/docs/pagefind`, are not committed: git ignores them, and the Vercel build of `site/` makes both
(`buildCommand` in `vercel.json`, a pinned Pagefind). After editing a page, commit only the sources; to build them
locally:

```sh
cargo run -q -p docsgen                  # only when the CLI or the prompt registry changed
npm ci --prefix docs/site
npm run build --prefix docs/site
```

Before opening a PR that touches `docs/site/` or `site/`, run the `site` job's checks too: the merge train waits for
that job (`.fleetd/train.json`), so a red one sends the PR back.

```sh
cargo run -q -p fleetd -- help > "$TMPDIR/fleetd-help.txt"
node .github/site-check.mjs "$TMPDIR/fleetd-help.txt"   # stale terms, commands fleetd help doesn't list
node .github/personal-check.mjs                          # no maintainer's host, login or home directory
node .github/docs-links.mjs                              # every internal link and anchor resolves
```

CI fails while the generated pages are out of date. To read the docs locally with clean URLs, run `node .github/docs-serve.mjs` and open http://127.0.0.1:4791/docs (search
works once a build has written the ignored index), or `npm run dev --prefix docs/site` while writing.

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
  a final `[exit N]` line. It refuses to write a hostname, a real `/home` path, a
  non-loopback IP or a key.
- Output that needs a live hub, a node or claude can't be captured that way. Paste real output from a lab run into a
  ` ```text ` block instead.
- Never invent or edit output by hand inside a capture block.

## Vercel project settings

- **Import** the GitHub repo `unlaboredlabs/fleetd`.
- **Root Directory:** `site`
- **Framework Preset:** Other
- **Build Command:** Override on, left empty; `buildCommand` in `vercel.json` takes precedence. It unpacks the phone
  app's over-the-air updates from the releases into `updates/` (`mobile-updates.sh fetch`, below), points the landing
  page's clips and posters at R2 (`media.mjs build`, Media below), then runs Pagefind
  1.5.2 on `docs/`, writing the docs' search index. Bump that version with the `pagefind` in
  `docs/site/package-lock.json`, so the deployed index matches a local build.
- **Output Directory:** leave the default; `outputDirectory` in `vercel.json` is `.`, the root directory as is (with a
  build command, Vercel would otherwise look for a `public/` folder and fail)
- **Install Command:** Override on, left empty
- **Production Branch:** `main`
- **Ignored Build Step** (Settings → Git): leave it; `ignoreCommand` in `vercel.json` takes precedence. It runs
  `mobile-updates.sh unchanged`, which skips a build (exit code 0) when the commit doesn't touch `site/` and, for
  production, fleetd.sh already serves each channel's current updates, and then `media.mjs unchanged`, which builds
  when production still serves a clip from Vercel that R2 now has. Vercel runs them from the root directory.
- **Deploy Hook** (Settings → Git): one for `main`, saved as the repository's `SITE_DEPLOY_HOOK` Actions secret. A
  release calls it once it has published new phone app updates; without it they go live with the next deploy.
- **Domains:** `fleetd.sh` (production), and `www.fleetd.sh` redirecting to `fleetd.sh`.

## Media on R2

The clips and posters (`showcase-*`) are served from Cloudflare R2 (the `fleetd-media` bucket at
`https://media.unlabored.net`, `BASE` in `media.mjs`), not from Vercel, whose bandwidth would cost far more. Each file
is the object `<name>.<16 hex of its sha256>.<ext>`, with `Cache-Control: public, max-age=31536000, immutable`, so a
new recording gets new names and no cache serves a stale clip. `home.html` itself names the repo's files, which a local
preview loads; the Vercel build (`media.mjs build`) rewrites its poster paths, and fills `fleetdMedia`, the clips' map,
with the R2 URL of each file that `BASE` already answers for, and leaves the rest on Vercel.

On a push to main that changes them, the Site media workflow (`.github/workflows/site-media.yml`, `media.mjs upload`)
puts each file the bucket doesn't hold yet, over R2's S3 API with the runner's `aws`, then, while fleetd.sh/home still
serves any of them from Vercel, calls the deploy hook (`SITE_DEPLOY_HOOK`, Vercel project settings above). Vercel's own
deploy of that push usually runs before the upload ends: it keeps the new files on Vercel, and the hook's deploy
switches them. So the page never names an object that isn't there. Without the hook, they switch with the next
production deploy, which the Ignored Build Step lets through for it. The workflow skips, and passes, until the
repository has:

| name | kind | value |
|---|---|---|
| `R2_ACCOUNT_ID` | Actions variable | the Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | Actions secret | an R2 API token's access key ID, Object Read & Write on `fleetd-media` |
| `R2_SECRET_ACCESS_KEY` | Actions secret | that token's secret access key |

The bucket needs `media.unlabored.net` as its custom domain (R2 › the bucket › Settings › Custom Domains). The page
loads the media without `crossorigin`, so the bucket needs no CORS rule. Run the workflow by hand (Actions › Site media
› Run workflow) after setting them or the hook, or after emptying the bucket. `.github/site-check.mjs` (CI's `site` job) runs `node
site/media.mjs check`: it fails when the page names a media file that isn't in `site/`, so it wouldn't be uploaded, or
one a build would leave on Vercel. To check the live page:

```sh
curl -fsS https://fleetd.sh/home | grep -o 'https://media.unlabored.net/showcase-[^" ]*' | sort -u   # every file, on R2
curl -fsSI "$(curl -fsS https://fleetd.sh/home | grep -o 'https://media.unlabored.net/showcase-[^" ]*webm' | head -1)"
# 200, content-type: video/webm, cache-control: public, max-age=31536000, immutable
```

## Phone app updates

`/updates` serves the phone app's over-the-air update manifests (fleetd.sh/docs/mobile#updates). Each release puts
its channel's on its GitHub release as `mobile-updates.tar.gz` (`build-release.yml`); `mobile-updates.sh fetch`
unpacks edge's and the latest stable's into `updates/edge/` and `updates/stable/`, which git never holds. A
`vercel.json` rewrite sends a request with the `expo-channel-name`, `expo-runtime-version` and `expo-platform`
headers to `updates/<channel>/<runtime version>/<platform>`, a signed multipart body, and the `/updates` headers rule
names its boundary and the expo-updates protocol version. A runtime version without a manifest gets a 404, and the app
keeps the bundle it has. `app/mobile/scripts/updates.test.ts` checks the route against the files a release writes.

```sh
curl -sD - -o /dev/null https://<deployment>/updates -H 'expo-channel-name: edge' -H 'expo-platform: ios' \
  -H "expo-runtime-version: $(curl -fsS https://<deployment>/updates/edge/updates.txt | awk '$1 == "ios" { print $2 }')"
```

## Check a deployment

The header rewrite does not run under `vercel dev`, so check a preview deployment:

```sh
curl -fsSL https://<deployment>/ | head -3     # the installer: "#!/bin/sh" ...
curl -fsSI https://<deployment>/install.sh      # content-type: text/plain
```

A browser at the same URL should show the landing page, and a search on `https://<deployment>/docs` should list
results. The deployment's build log shows Pagefind's `Indexed <n> pages`.

## Testing the installer without a release

`FLEETD_BASE_URL` points the installer at any directory of release assets, e.g. a local `python3 -m http.server`
serving `SHA256SUMS`, `fleetd-linux-x64` and `fleetd-desktop-linux-x86_64.AppImage`:

```sh
FLEETD_BASE_URL=http://127.0.0.1:8000 HOME=/tmp/fleetd-home sh site/install.sh
```
