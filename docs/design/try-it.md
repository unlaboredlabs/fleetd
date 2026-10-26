# Try it yourself

Status: design (W58). The design preview PR shows the app side on fixtures. Nothing here is built yet.

Today fleetd assumes the person never needs to use what an order or PR built. They read a summary, CI is green, and the
train merges. For most PRs that's right. For a checkout flow, a screen layout or an Android build, though, the only real
test is a person using it. This design lets the person run the real thing a PR built and use it from the app or their
own device. What they find goes straight back to the agents as a fix. Where they ask for it, their "works for me" is
part of what lets the PR merge.

## The rule: only when the person asks

Most PRs need no human test, so try it yourself never runs on every PR. It costs nothing until someone asks.

- **Nothing is built or started by default.** No preview runs for a PR or order unless the person starts one.
- **It starts only when the person asks:** with **Try it** on a PR or an order, or by asking the lead in chat ("let me
  try #14 on Android"). The lead's `preview_start` is accepted only in a turn that answers a message of the person's,
  and the app says so: "Starting #14 on the web, because you asked at 09:02."
- **Agents may suggest it, never start it.** A writer or lead may call `preview_suggest` on a PR where a human test
  clearly matters (a UI change, copy in two languages, a mobile build). It shows as one plain line with a Try it button,
  in the PR's overview and in the chat: "#14's writer suggests trying it: the checkout's buttons read differently in
  German and Dutch." Once per PR, and no run starts from it.
- **Sign-off is off by default, and per project.** Even when a project turns it on, it applies only to PRs the person
  marked "I want to try this", or to orders whose brief says the person tries it first. It never applies to all PRs.
- **Previews are thrown away.** A preview ends when the person presses End, after 30 minutes without use, when the PR
  merges or closes, or after 4 hours at most. Its processes, port, emulator copy and worktree go with it. Only the build
  cache stays.

## 1. Web

**Where it runs.** On a machine that can host it: the PR's own machine if it can, else one T534's routing picks (a
machine with the `sessions` role and the project's repo). The node checks out the PR's head (or the order's branch) into
a preview worktree of its own, never an agent's. Then it runs the project's preview commands.

**How a project says how to run it.** A `preview` block in the project's settings (Settings › Projects › Try it, or
`project_settings_set {preview}`):

```json
{
  "web": {
    "setup": ["pnpm install --frozen-lockfile"],
    "build": "pnpm build",
    "start": "pnpm preview --port $PORT --host 127.0.0.1",
    "ready": "/",
    "inputs": ["pnpm-lock.yaml"]
  },
  "android": { "build": "./gradlew assembleDebug", "apk": "app/build/outputs/apk/debug/app-debug.apk", "open": "acme://checkout" },
  "idleMinutes": 30,
  "signoff": "off"
}
```

- **Setup, env and secrets are #501's.** The setup list runs as worktree setup commands do: the project's and the
  order's variables, `$TMPDIR`, a time limit per command, and **Skip when unchanged** keyed on `inputs`. Secrets are
  masked in everything the run reports.
- **`$PORT`** is a free port on 127.0.0.1. The start command must listen there. `ready` is the path the node polls
  until it answers (2xx or 3xx), with a 2 minute limit.
- **Agents can propose it.** A writer that sees how the app runs calls `preview_config_propose` with the block. The
  proposal shows in the chat as an approval card (the commands, in code), and nothing is saved until the person
  approves it. A lead may propose one when an order's brief asks for try it yourself and the project has none.

**How the person opens it.**

- **In the app**, as a session they drive. The node opens a browser session (W46's broker: a fresh Chrome with an empty
  profile) on `http://127.0.0.1:$PORT`, already handed to the person. The Try it tab shows its live frames, and the
  person's clicks and keys go to the page through `browser_input` (#532's live view and takeover messages). Pop-out
  works as for any session (D156). The agent never holds this session, so ⌘⇧↩ has nothing to hand back to. The session
  is recorded like every other session, which is what the feedback's clip comes from.
- **In their own browser, over the tailnet.** The node gives the preview its own port on its tailnet address (from
  8400–8499) and proxies it to `127.0.0.1:$PORT`: `http://devbox:8414`. In v1 that is plain HTTP; the tailnet
  already encrypts the traffic. HTTPS (for apps that need secure cookies or a service worker) comes later through
  `tailscale serve`, with its own identity check (see Security). Wildcard names (`pr-14.devbox.ts.net`) aren't
  possible: MagicDNS has none.

## 2. Mobile

**Android, on a pool emulator (realistic now).** T533 brings a pool of emulators booted from a Quick Boot snapshot as
read-only copies on a machine with KVM. Try it on Android:

1. The node builds the APK with the project's `android.build` (Gradle's cache kept per project and node).
2. It takes a fresh emulator from the pool, `adb install`s the APK and opens `android.open`.
3. The app shows the emulator's screen through scrcpy's stream, as frames on the same live view messages as a browser
   session. Taps, swipes and keys go back as input. Under it are Back, Home and Rotate.

The emulator copy is thrown away at the end, and the pool refills in the background.

**Android, on the person's own phone (realistic now).** "Install on Android" shows a code to scan. The link serves the
APK from the node's preview port, works for 1 hour, and opens only from the person's devices on the tailnet (the phone
runs Tailscale). The debug build installs beside the store's when its application id has a `.debug` suffix, which most
projects already set. Otherwise the doc tells the person it replaces the installed app.

**iOS, on a simulator (realistic once there is a Mac machine).** It needs macOS with Xcode, so T534 routes it to a Mac
with the `sessions` role. The node builds for the simulator (`xcodebuild -sdk iphonesimulator`), installs it with
`xcrun simctl install` on a cloned simulator, and streams its screen. For input it uses agent-device, which drives iOS
simulators too (D155). Streaming the simulator is the least proven part: `simctl io` gives screenshots and recordings,
not a live stream, so the first version reads the window with ScreenCaptureKit at 10–15 fps. Without a Mac, Try it
offers no iOS.

**iOS, on the person's own iPhone (later, opt in).** TestFlight is the only workable path. It needs the project's
Apple developer account, signing, and an App Store Connect API key as a project secret. A build per PR then uploads
and waits for Apple's processing (often 10–30 minutes) before internal testers can install it. That's a project
setting, never a default. Ad-hoc builds with registered devices are left out: too much upkeep. For Expo and React
Native projects, a dev server on the preview port plus Expo Go's code gets the person's own phone working much sooner,
with no Apple step.

## 3. Desktop apps

- **Linux (next after Android).** An isolated X display per session (Xvfb with a small window manager, D154's
  isolation), the app started by the project's `desktop.start`. The screen is streamed as frames (x11grab to JPEG), and
  input goes back through XTest. Electron and GTK apps work as they are.
- **macOS (later).** A macOS VM on a Mac machine (Virtualization.framework, through Tart), cloned per session from a
  prepared image. Builds and installs run inside it. It is heavy (8 GB of memory per VM), and Apple's license allows two
  VMs per Mac, so it is one or two sessions per Mac at most.
- Windows is out of scope.

## 4. Feedback

While a preview runs, **Mark up** turns the frame's bar over (as a taken-over session's does), and the page takes pins
rather than clicks. For each pin, the person says what's wrong in their own words. Attached:

- **a screenshot** of the page or screen with its pins drawn;
- **the last 30 seconds** of the session's recording (on by default; a checkbox), cut from the recording the session
  already makes, so there's no record button;
- **what's under each pin**, named from the page: web from the DOM snapshot (`the button "Bestelling plaatsen en
  betalen"`), Android from the accessibility tree that agent-device reads;
- **where**: the URL or screen, the language, and the commit the preview runs.

**Send to #14's writer** sends it as a fix request in plain words. Where it goes:

- The PR's writer is running: it arrives as a steer, read at its next step, like the lead's steers.
- The writer has ended: it goes to the order's lead, who starts a fix task on the same branch (or asks the person if
  it reads as a new order).
- Either way, the attachments are hub attachments the agent can open, and the agent can start its own browser session on
  the preview to reproduce it while the preview runs.

How it arrives for the agent:

```text
S512 · the person steers you (T14 (write) for W12): Fix request from the person, who tried #14 on the web at 3f2a91c:

1. In Dutch the button wraps onto two lines. Keep it on one, as in German.
   Pin 1: the button "Bestelling plaatsen en betalen", on /checkout?lang=nl, 76% across, 76% down.

Attached: screenshot-1.png (the page with its pin), clip.webm (the last 30 s of the session).
When it's fixed, push to the PR: the person tries it again from there.
```

After the fix is pushed, the Try it tab says "Running 3f2a91c; #14 is now at 9b1c0de" with **Rebuild**. Following the
rule above, it never rebuilds on its own.

## 5. Optional sign-off

- **Per project, off by default:** `preview.signoff` is `off` or `when-asked`.
- **Per PR, by the person:** with `when-asked`, a PR waits only when the person marked it **I want to try this**, from
  the PR's Try it or its overview, or when the order's brief says the person tries it first. In that case the lead marks
  the order's PRs, and the person can unmark any of them.
- **In the train:** a marked PR's Change gets a `signoff` hold. Reviews and CI go on as usual, but the train treats it
  as not ready. The merge line shows it under **Waiting on you** ("waiting on your sign-off"), with Try it and **Works
  for me**. The PR's state reads "Reviewed and green. It waits for you to try it and say it works." The project joins
  waiting on you in the sidebar and the chat's waiting line, and a notification says so once.
- **Works for me** records the sign-off against the head commit and lifts the hold; the PR goes into line. **Don't wait
  for me** unmarks it. A push after sign-off asks again (see the open questions).
- A sign-off is a person's act, and the person's minutes count toward the factory metrics (D33).

## 6. Architecture

**Reused.**

| From | What |
|---|---|
| Sessions (#532, W46) | The broker's lifecycle (start, idle end, teardown), the CDP proxy, recording and upload, retention on the hub, the app's live view, takeover input and pop-out. A preview's in-app view is a browser session the person holds from the start. |
| Device sessions (T533) | The Android emulator pool, agent-device, scrcpy stream and recording. Later, the iOS simulator and the Linux display as session kinds. |
| Machine roles (T534) | Which machines can host what (Chrome, SDK with KVM, Xcode, a desktop), routing a preview to one, and session slots counted apart from agent slots. |
| Env and setup (#501) | Setup commands with Skip when unchanged, project and order variables, masking. |
| Worktrees | A worktree from the PR's head, as reviewers get one. |
| The train | Changes and holds, Waiting on you in the merge line, the ready check. Sign-off is one more hold. |
| Steers and attachments | How feedback reaches a running agent, and the screenshot and clip as files. |
| Approvals | An agent's proposed preview config is an approval card. |

**New.**

- **Preview runner** (node, `node/preview/**`): checkout, setup, build, start with `$PORT`, a ready check, the idle
  timer (no input in the app session and no request through the proxy), and teardown. It reports steps as a session's
  items, so the app's step list is the same data the agent sees.
- **Build cache**: per project and node, kept across previews and reused by the next one: the package manager's
  store, Gradle's cache, a build output cache where the tool has one. Plus the last 3 builds by commit, so Try it again
  on an unchanged head starts without building. Capped per project (default 10 GB, oldest first).
- **Port routing on the tailnet**: a small proxy in the node, bound to the node's tailnet address only, one port per
  preview from a range. Plain HTTP in v1; HTTPS through `tailscale serve` later (see Security).
- **Hub**: `preview_start`, `preview_end`, `preview_suggest`, `preview_config_propose`, `previews_list`, a
  `preview.state` event, the `signoff` hold and `signoff_give`. The app gets the Try it tab, the suggestion line, Mark
  up, and the merge line's Waiting on you.

**Security.**

- **Reachable only from the person's devices.** The proxy listens on the tailnet address, never `0.0.0.0`. For each
  connection it asks the local tailscaled who the peer is (`tailscale whois`) and accepts only devices of the tailnet
  user who owns the hub. Anyone else on a shared tailnet gets nothing. The in-app session reaches the preview on
  127.0.0.1 and never leaves the machine.
- **HTTPS through `tailscale serve` (later, not v1)** can't use that check: serve terminates TLS and forwards from
  127.0.0.1, so `whois` would only ever see the machine itself. That path gets a listener of its own on loopback,
  which only serve forwards to. On it, the proxy reads the `Tailscale-User-Login` header that serve sets on every
  request from a tailnet device (serve overwrites any value the client sent) and accepts only the hub owner's login.
  A request without the header (from a tagged device, or through Funnel) is refused, and Funnel is never turned on
  for a preview. The header names the user, not the device, which is the same set of devices `whois` lets in. A
  process on the machine could reach that listener and send the header, but it could already reach
  `127.0.0.1:$PORT` directly, so nothing new is exposed.
- **Install links** are per preview, signed, valid for 1 hour, and checked the same way.
- **Secrets**: a preview gets the project's variables, like an agent. Whatever the app under test shows on its pages
  is in the recording (as for any session); the text it reports is masked.
- **Not sandboxed**: preview commands run as the node's user, like agents and setup commands. A container option
  (docker, with the worktree mounted) is a later setting for projects that want it.

**Cost per preview** (on the person's own machines, so no cloud bill; what it takes from them):

| | Memory | CPU | Disk | Ready in |
|---|---|---|---|---|
| Web | 0.5–2 GB while it runs | 1–2 cores to build, near 0 idle | the worktree, plus the shared cache | about 1 min warm, 3–5 min cold |
| Android emulator | 2–3 GB | 2 cores while used | 4 GB per copy, gone at the end | 1–2 min warm build, the emulator in seconds from the pool |
| iOS simulator (Mac) | 1.5–2 GB | 2 cores | 2–6 GB per clone | 2–5 min |
| macOS VM | 8 GB | 4 cores | 30+ GB image, cloned copy-on-write | minutes |

No model tokens are spent to run a preview. Feedback costs one agent turn. An idle preview ends after 30 minutes, so a
forgotten one costs at most that.

**Phases.**

1. **Web**: preview config (with agents' proposals), the runner, the tailnet port over plain HTTP, Try it in the app
   as a held browser session and in the person's own browser, idle end, and feedback (pins, words, screenshot, clip)
   to the writer.
2. **Sign-off**: the project setting, "I want to try this", the train's hold, Waiting on you, Works for me. With it,
   HTTPS through `tailscale serve` and its header check.
3. **Android**: APK build, a T533 pool emulator driven from the app, the install link for the person's own phone.
4. **Linux desktop**: an isolated display per session, streamed and driven like the others.
5. **iOS**: a simulator on a Mac machine through T534's routing; TestFlight as a project's opt-in.
6. **macOS desktop**: a VM per session on a Mac machine.

## 7. Open questions for the human

1. **Who may ask?** Only you, or also anyone you pair the app with (the read and operate roles)? Recommendation: admin
   and operate keys can start previews; read keys can only open one that is running.
2. **A push after Works for me:** does your sign-off carry to the new commits, or does the PR wait on you again?
   Recommendation: it waits again, unless the push only rebases or touches files outside the app (docs, tests).
3. **Idle time:** is 30 minutes without use right, with the 4 hour cap?
4. **Who gets feedback when the writer has ended:** the lead decides (a fix on the same branch, or a new order), or
   always a fix on the same branch?
5. **iOS on your own iPhone:** worth setting up TestFlight for some project now, or simulator-only until there's a
   need?
6. **Previews of an order** with several PRs: one preview of the order's newest branch, or of all its PRs merged
   together on a scratch branch?
7. **A Mac for iOS and macOS:** is there one to add as a session machine, or does iOS wait?
