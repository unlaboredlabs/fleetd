# Contributing

## Layout

fleetd is TypeScript on Bun, and the desktop and phone apps. The shipped `fleetd` is one file from
`bun build --compile`: the hub, the node and the CLI.

- `fleetd/`: fleetd itself; its README says how to build, test and run it. `src/hub/` holds the MCP endpoint, app
  socket, leads, merge train, ledger and the rest; `src/node/` is the per-machine sidecar that runs the agents;
  `src/cli/` is setup, `update`, the human commands and `agent-mcp`, the agents' tools.
- `fleetd/src/node/runner`: drives the `claude` CLI over stream-json; each session runs under a host of its own
  (`fleetd session-host`, `runner/host/`) that outlives the node. Claude's stream-json output is not a stable public
  API, so the runner accepts a pinned `claude` version range, and fixture tests
  (`fleetd/test/fixtures/runner/claude-<version>-*.jsonl`) hold it to recorded output. Widening the range may mean
  re-recording the fixtures in the same PR.
- `app/desktop/src/shared/contracts/`: the wire contract, everything that crosses a wire between fleetd's parts and the
  apps: the TypeScript types (`contracts.ts`), which the hub, the node and both apps import, and the JSON Schemas
  (`schema/`), which the hub decodes calls with and the app's fixtures are checked against. Both are kept by hand: a
  change edits both, and `fleetd/test/contracts.test.ts` fails while they disagree. An enum a newer hub may extend is
  `"x-open": true` in its schema and `Known<Name> | (string & {})` in TypeScript, so an app also admits values it
  doesn't know yet.
- `app/desktop`: the desktop app, Electron + React (see below). Its own pnpm workspace.
- `app/mobile`: the phone app (Expo); its README says how to try it on the agents' Mac's simulator, and
  `scripts/phone-lab.sh up` gives it a seeded throwaway hub to pair with.
- `tests/lab`: the factory lab (`factory/`, offline, in CI), and the tools that record claude's fixtures, the site's
  captures and the demo. `tests/compare`: black-box tests and benchmarks of two builds side by side.
- `site/` and `.github/release/`: the `fleetd.sh` installer and site, and the release pipeline. `docs/site/` is
  the docs' Starlight site, built into `site/docs/` by the Vercel build; `fleetd/scripts/docs.ts` writes its generated
  pages.

## The desktop app

`app/desktop` needs Node 24 and pnpm (the version in its `package.json`). In that directory: `pnpm install`, then
`pnpm dev` (hot reload), `pnpm build` and `pnpm start` (the built app), and `pnpm typecheck`, `pnpm lint` and
`pnpm test`, which CI's `desktop` job runs. Electron downloads its binary on first launch.

`FLEETD_HUB_URL` + `FLEETD_AGENT_KEY` connect for one run without saving anything; `FLEETD_HOME` moves every file the
app keeps (the saved key, the migration marker) and keeps it off the OS keychain; `FLEETD_FIXTURE=<name>` replaces the
hub with `fixtures/<name>.json` (or an absolute path; `FLEETD_FIXTURE_DIR` moves the directory) and shows a
"Sample data" banner; a release build ignores it.

`pnpm build` makes the release build, which refuses to start with `--remote-debugging-*` or `--inspect*`.
`pnpm build:test` (and `pnpm qa:build`) set `MAIN_VITE_FLEETD_TEST_BUILD=1`, which is inlined at build time, for
DevTools-driven tests; never ship one. `pnpm debug-guard-check` checks both.

- `src/main`: the Electron main process. It holds the one hub connection and the saved key; the renderer has no
  network (its CSP has `connect-src 'none'`).
- `src/preload`: `window.fleetd`, the only bridge. `src/preload/api.d.ts` is its type.
- `src/shared`: the IPC channels (`channels.ts`) and the schema main checks every renderer request against
  (`ipc.ts`). A new channel goes in both, then in `src/main/ipc.ts` and the preload.
- `src/renderer`: the React app.
- Releases: `electron-builder.yml` packs the built app (a universal, Developer ID-signed `fleetd.app`, an AppImage and
  a deb) in `build-release.yml`'s `desktop-*` jobs. The app updates itself from `latest-mac.yml` / `latest-linux.yml`
  on the release (`src/main/updater.ts`), and `fleetd update` reads the same feed.

## Checks

Before every push, run `scripts/check.sh`; its header says what each check runs, and `ci.yml`'s comments say what
CI runs. Run it after your last commit and rebase: it checks the worktree against `origin/main` as it fetches it then,
so a migration main gained since, a stale generated file, a fixture with no answer for a screen's new call, or the
host name in a new file fails there instead of in CI.

A fleetd writer can't push a tree it hasn't passed on (`.fleetd/pre-push.json`): a pass records the tree it checked,
so commit exactly that. Its last line says how it went: `check.sh: pushable <tree>`, or `check.sh: failed <checks>`.
Too long for one command: start `scripts/check.sh --background`, then wait with Claude's Monitor tool running
`scripts/check.sh --wait`, which prints that last line once the run ends (never a sleep loop). The tree passes once
every check its changes touch has passed on it, in one run or several, so after a failure rerun only that check
(`scripts/check.sh fleetd`). A check's pass holds for any tree with the same inputs for it (`scripts/check.sh
--keys` prints each one's hash), so a desktop fix on a branch whose fleetd check passed doesn't run it again.

## The site

`site/` is fleetd.sh and its docs: `site/README.md` says how to build, capture and check them.

## The merge train's checks

The train waits for the checks `main` requires and the jobs `.fleetd/train.json` lists; `ci.yml`'s and `mac.yml`'s
comments say which run where.

## Hub migrations

Each change to the hub's database is one new SQL file in `fleetd/src/hub/store/migrations/`, named for the
current UTC time: `YYYYMMDDHHMM_snake_case_name.sql` (`date -u +%Y%m%d%H%M`), opening with `--` comment lines on
what it does. `bun run gen` lists them in prefix order in `src/gen/migrations.ts`, and fails on two with one prefix. A hub records each one it ran by
name with its file's SHA-256 (`migrations_applied`) and runs every one it hasn't, so a file that sorts before one a hub
already ran still runs there; one that changed after it ran never runs again, and the hub warns at its start. Never
edit, rename or remove a file that is on main: CI checks that a PR only adds files, each sorting after every one on
main, so every hub runs them in the order a fresh one does; `scripts/check.sh` runs the same check on your worktree merged
onto a fresh `origin/main`. After a rebase onto a newer migration, rename yours to a later time (the merge train does it
for you).

## The package

Another Bun and TypeScript repository, such as the private one for fleetd hosted, can import parts of this one at a
commit it pins. The repo's root `package.json` is that package, and its `exports` is the whole list: each entry is a
TypeScript source Bun runs as it is, so nothing is published or built, and a file `exports` doesn't name can't be
imported.

| Entry | What |
|---|---|
| `fleetd/contracts`, `fleetd/contracts/schema/<Name>.json` | the wire contract: `contracts.ts` and its JSON Schemas |
| `fleetd/apps/pairing`, `fleetd/apps/pair_link` | the apps' own reading of a pairing or invite code (`normalizeCode`, `hubOrigin`: `app/desktop/src/shared/pairing.ts`) and of a `fleetd://pair` link (`parsePairLink`, `pastedPair`: `app/mobile/src/hub/pairLink.ts`) |
| `fleetd/apps/accounts` | the apps' own reading of fleetd cloud's accounts answers (`app/desktop/src/shared/accounts.ts`): the sign-in's (`readSignIn`: teams, and invitations apart) and the accept's (`readAccepted`), whether the person made a team (`madeTeam`), and which team addresses they connect to (`teamOrigin`, `cloudDomain`, `inCloud`) |
| `fleetd/apps/billing` | the apps' own reading of a cloud team's billing (`app/desktop/src/shared/billing.ts`): `GET /billing/v1`'s answer (`BillingState`, `readBilling`), checkout's and the portal's page (`readPage`), the cap (`readCap`), and the page's words in each state (`topLine`, `money`, `hours`), so the cloud tests its answers through them |
| `fleetd/apps/artifact_page` | an HTML report's page as its frame gets it (`app/desktop/src/shared/artifactPage.ts`): the CSP it is served with (`ARTIFACT_CSP`), its fence (`first`) and the page with the fence put first (`framedPage`) |
| `fleetd/apps/push` | the phone's own reading of a notification (`app/mobile/src/pushPayload.ts`): a sealed payload opened with a given `open` (`openPayload`; `fleetd/shared/sealed_box_core`'s `openSealed` opens it outside the phone), what shows for it (`shownOf`: title, channel, buttons) and where tapping it goes (`routeOf`), the `devices` route among them |
| `fleetd/shared/<module>` | `src/shared`'s pure modules: the node link's frames (`node_link`) and tags (`wire_tags`), `ToolError` (`errors`), the rest |
| `fleetd/tools` | the MCP tools (`src/pkg/tools.ts`): `TOOL_LIST`, each with its description, role and schemas in tools/list's order, `SCHEMAS` (McpTools.json, parsed) and `decodeInput` |
| `fleetd/fakes/app`, `fleetd/fakes/node` | the stand-in app and node the hub's tests drive (`test/fake-app.ts`, `test/fake-node.ts`) |
| `fleetd/fakes/accounts` | a stand-in for fleetd cloud's accounts service and WorkOS's sign-in page, with a `/pair` and the invites by email per team: the apps' Sign in and People tests (`test/fake-accounts.ts`, its calls in `schema/Accounts.json`) |
| `fleetd/gen/migrations` | the hub's migrations in order, each with its SQL |
| `fleetd/hub/<area>/<module>` | the hub's pure modules, each at its own path under `src/hub` |
| `fleetd/node/<area>/<module>` | a node module the service shares, pure as the hub's are (`screens/settings`) |
| `fleetd/box/mux`, `fleetd/box/host_link`, `fleetd/box/box` | box side: the link to a box's guest (`Mux`, its frames, `GUEST_PROTOCOL`: `src/node/sandbox/mux.ts`), the lines to its session host (`HostLink.open`, `nextWithSeq`, `PROTOCOL`, `RunnerEvent`, `SessionCommand`: `src/node/runner/host_link.ts`) and a whole box over that link (`Box`: `src/node/sandbox/box.ts`, with its node.sock and build-slot connections answered by the `lead` and `slots` it's given) |
| `fleetd/box/providers` | box side: the hosted providers' clients (`provider`, `ProviderError`, `GUEST_PORT`, `SECRET_HEADER`: `src/sandbox/providers`) and the template's recipe (`hostedDockerfile`, `templateName`, `CLAUDE_TESTED`) |
| `fleetd/box/bootstrap`, `fleetd/box/files` | box side: fleetd handed to a fresh box (`bootArgv`, `firstWord`, `deliver`: `src/node/sandbox/remote/bootstrap.ts`) and what runs in a box for its files (`BoxFs`, `sh`, `prepare`, `unpack`: `src/node/sandbox/remote/box_files.ts`) |
| `fleetd/box/lead`, `fleetd/box/mask`, `fleetd/box/claude`, `fleetd/box/session_state` | box side: a box's node.sock calls answered (`leadChannel`, `answerLine`, `LeadRelay`, `LeadSocketHooks`: `src/node/lead/channel.ts`) with its session's secrets masked (`Masker`: `src/node/mask.ts`), its claude's launch (`SessionSpec`, `args`, `spawnEnv`, the role's tools: `src/node/runner/claude_spec.ts`) and how its session's runs settle (`settle`, `closeOut`, `runEnd`, `bounded`: `src/node/sessions/state.ts`) |
| `fleetd/box/hook_scripts`, `fleetd/box/setup_words` | box side: a writer's git hooks as the files to write (`trailerFiles`, `gateFiles`, the scripts and names: `src/node/worktree/hook_scripts.ts`, which the node's `hooks.ts` writes) and the words an agent hears about its worktree's setup (`note`, `how`, `timeoutOf`, `SETUP_TIMEOUT_SEC`: `src/node/worktree/setup_words.ts`) |
| `fleetd/box/file_rules`, `fleetd/box/chat_file` | box side: a bot's files judged without its disk: the @-mention's ranking (`score`, `rank`, `MAX_FILES`), where an attachment may go (`ATTACHMENTS_DIR`, `attachmentPathOk`) and whether a resolved path stays in its folder (`within`: `src/node/sessions/file_rules.ts`), and what a chat file or image is by its name and first bytes (`ofImage`, `ofName`, `ofFile`, `chatMime`, `IMAGES`, `HEAD_BYTES`) with the person's words for one the chat doesn't take (`refused`: `src/node/actions/chat_file.ts`) |
| `fleetd/browser/broker`, `fleetd/browser/box_chrome`, `fleetd/browser/proxy`, `fleetd/browser/recording` | box side: an agent's browser in its box, driven from outside it (`BrowserBroker`: sessions, the vault and 1Password fills, cards, addresses, secure input, live view and takeover; its `BrokerHost` gives the hub calls, the recording store, the proxy's key and the box; `snapshot`, `adopt` and `letGo` hand a session to another holder). Chrome in the box, outliving a dropped connection for `GRACE_MS` (`boxChrome`, `reattachChrome`: `src/node/place/box_chrome.ts`), the agent's CDP proxy and its token check (`Proxy`: `src/node/browser/cdp_proxy.ts`), and the recording's seam and video stream (`RecordingStore`, `MkvVideo`, `report`) |
| `fleetd/browser/cdp`, `fleetd/browser/session`, `fleetd/browser/guard`, `fleetd/browser/logins`, `fleetd/browser/agent_browser_policy`, `fleetd/browser/agent_browser`, `fleetd/browser/secret_sink` | box side: the DevTools connection (`Cdp`), one browser session (`Session`, `SessionState`), the proxy's allowlist of agent-browser's commands (`refusal`, `SEALED_METHODS`), 1Password's values (`Vault`, `VaultFor`, `Cache`), agent-browser's pin and policy (`VERSION`, `policy`, `sessionEnv`), its skill as a Claude Code plugin (`pluginFiles`: `src/node/browser/agent_browser_plugin.ts`) and a `secret_deliver` sink (`parseSecretSink`) |
| `fleetd/desktop/desktops`, `fleetd/desktop/box_display` | box side: an agent's Linux desktop in its box, driven from outside it (`DesktopSessions`: the session calls, the `desktop` actions, live view and takeover, recording; its `DesktopHost` gives the hub calls, the secrets, the box and the recording store; `snapshot`, `adopt` and `letGo` hand a session to another holder, a person's takeover with it). Xvfb, openbox and socat in the box, outliving a dropped connection (`BoxDisplay.start`, `BoxDisplay.reattach`: `src/node/place/box_screens.ts`) |

An exported module is pure: neither it nor anything it imports, a type included, touches the database, the
filesystem, a process, the network, the machine's environment, the `Hub` or an npm package (the fakes open sockets,
nothing else). Pure isn't stateless: `Board` or `Breakers` keep state in the object, and a second server holds one per
process as the hub does. In `fleetd/`, `bun test/pkg/purity.ts` prints where every module of `src/hub`, `src/shared`
and `src/gen` stands: exported, pure and left out with why (`LEFT_OUT`), pure but for a type it imports, impure only
through an import.

A box-side module (`fleetd/box/…`, `fleetd/browser/…`, `fleetd/desktop/…`) is the second kind: box side, sockets and fetch only, no fs,
process or env. It
drives a sandbox box, and a service with no node (fleetd hosted) runs it just as the node does, so the code is shared,
never forked. It may open sockets and WebSockets and call `fetch`, and otherwise holds to the same rule: no
filesystem, process, environment, database or `Hub`. So what it needs of the node (the answer to a node.sock call, a
build slot) comes in as an option, and the node passes its own.

- **Peer dependencies.** The browser's guard checks the agent's scripts with acorn, the one npm package an entry may
  import: the root `package.json` names it in `peerDependencies` (optional, so an install that doesn't take the
  browser fetches nothing), and an importer of `fleetd/browser/…` adds it at that version to its own dependencies.
- **Adding one.** One line in `exports`, the module at its own path. `test/pkg/purity.test.ts` fails while it or
  anything it imports isn't pure (a box-side one: does more than the network); `test/pkg/outside.test.ts` installs the package in a throwaway project outside the
  repo, imports every entry and typechecks it. Don't export a module by copying it: split what is pure into its own
  file, which the hub then imports too.
- **Changing one.** An exported module that needs the database or the `Hub` loses its line, and one that moves gets
  its new path; say so in the PR. The other repository meets either at its next bump, where its typecheck fails.
- **Pinning.** The other repository's `package.json` has `"fleetd": "github:unlaboredlabs/fleetd#<full commit sha>"`
  and its `bun.lock` records it; a bump changes the sha and runs `bun install`. Bun fetches the whole repo at that
  commit, about 190 MB in `node_modules`, most of it the site's media. Its tsconfig takes `fleetd/tsconfig.json`'s
  compiler options, since the package's sources are checked under the importer's, and it typechecks with tsc-rs, which
  types a `with { type: "text" }` import by itself. It reads `McpTools.json` and `LeadCall.json` as text too, as the
  package's modules do (a bundle keeps one loader per file), or takes `SCHEMAS` from `fleetd/tools`.

## Conventions

- TypeScript on Bun, checked with tsc-rs (`bun run typecheck`).
- fleetd never calls a model or usage API directly; Claude runs only through the `claude` CLI.
- Tests cover real logic and observable behaviour, not wiring, and don't sleep or poll.
- Conventional commit titles in plain language (`feat(hub): ...`, `fix(node): ...`), one branch per PR.
- No secrets in commits, logs or PR text.
