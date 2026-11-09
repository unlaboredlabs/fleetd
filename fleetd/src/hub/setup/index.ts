// The hub admin's setup: one list of steps that `fleetd init`, the app's first
// run and Settings › Hub › Setup all render. Each step's guide (why, the values to paste computed for this hub, the
// provider's pages) is here; its status is read from the doctor's checks, never from how far a wizard got.
import { isIP } from "node:net";
import type {
  DoctorCheck,
  DoctorStatus,
  HubSetupStep,
  SetupGroup,
  SetupLink,
  SetupNeed,
  SetupPart,
  SetupStatus,
  SetupStepId,
  SetupValue,
  SetupWay,
} from "../../shared/contracts.ts";
import { VERSION } from "../../shared/version.ts";
import { phoneUrl, workerReachNote } from "../pair/urls.ts";

const link = (label: string, url: string): SetupLink => ({ label, url });
const value = (label: string, v: string): SetupValue => ({ label, value: v });
const noted = (label: string, v: string, note: string): SetupValue => ({ label, note, value: v });
/** Words to follow, not a value to paste. */
const plain = (label: string, words: string): SetupValue => ({ label, plain: true, value: words });
/** A command to run, with where. */
const command = (label: string, cmd: string, note?: string): SetupValue => ({
  command: true,
  label,
  ...(note === undefined ? {} : { note }),
  value: cmd,
});

function part(title: string, note: string | undefined, links: SetupLink[], values: SetupValue[]): SetupPart {
  return { links, ...(note === undefined ? {} : { note }), title, values };
}

const way = (label: string | undefined, checks: string[]): SetupWay => ({ checks, ...(label === undefined ? {} : { label }) });

/** The host's first label, which names this hub at each provider: `fleetd on devbox`. */
export function hostOf(hub: string): string {
  const scheme = hub.indexOf("://");
  const rest = scheme < 0 ? hub : hub.slice(scheme + 3);
  const authority = rest.split("/")[0] ?? "";
  const colon = authority.lastIndexOf(":");
  let host = colon >= 0 && /^[0-9]*$/.test(authority.slice(colon + 1)) ? authority.slice(0, colon) : authority;
  host = host.replace(/^\[+|\]+$/g, "");
  // An address names no machine: say "hub".
  if (host === "" || isIP(host) !== 0) return "hub";
  return host.split(".")[0] ?? "hub";
}

/** cli/setup/units.rs `q`: a value quoted for the shell when it needs it. */
export function q(v: string): string {
  return v !== "" && /^[A-Za-z0-9_/.,:@%+=-]+$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`;
}

/** cli/pair.rs `mac_flags`: what a join line for the agents' Mac adds. */
export const macFlags = (version: string) => (version === "0.0.0" ? " --mac" : ` --mac --version ${q(version)}`);

/** What an admin pastes once on the agents' Mac, in the account it joins from: each line commented with why. */
export const MAC_ADMIN_BLOCK = `# Xcode's licence and its system components, which only an admin can accept and install. Skipped while no Xcode is
# selected yet: setup's Xcode check then says the one command that installs or selects it.
d="$(xcode-select -p 2>/dev/null)" && test -x "$d/usr/bin/xcodebuild" && sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
# Simulators and debugging with no password prompt, for this account.
sudo DevToolsSecurity -enable
sudo dseditgroup -o edit -a "$(id -un)" -t user _developer`;

/** Optional (D309): a standard user of its own for agents, made from an admin's account. */
export const MAC_USER_BLOCK = `# A standard user of its own for agents. You choose its password and keep it.
sudo sysadminctl -addUser agents -fullName "fleetd agents" -password -
sudo dseditgroup -o edit -a agents -t user _developer
# Your own home closed to other users, agents included.
chmod 700 ~`;

/** The actions the hub's boat.dev key needs, and no more. */
export const BOAT_KEY_ACTIONS =
  "sandbox.create sandbox.read sandbox.update sandbox.stop sandbox.resume sandbox.delete ssh account.read";

/** 1Password's page that makes a service account, and the one listing them. */
export const ONEPASSWORD_NEW = "https://start.1password.com/developer-tools/infrastructure-secrets/serviceaccount/";
export const ONEPASSWORD_ACCOUNTS = "https://start.1password.com/developer-tools/active";

/** The Mac's own checks (node_link.rs `MacCheckId::ALL`). */
export const MAC_CHECKS = ["developer", "xcode", "ios_runtime", "accessibility", "screen_recording", "gui_session", "tools", "keep_awake"];

/** Every step in order, its values computed for `hub` (the URL devices reach it at), status still to read. */
export function guides(hub: string, version = VERSION): HubSetupStep[] {
  const base = hub.replace(/\/+$/, "");
  const host = hostOf(base);
  const name = `fleetd on ${host}`;
  const step = (id: SetupStepId, group: SetupGroup, title: string, why: string, need: SetupNeed, rest: Partial<HubSetupStep>): HubSetupStep => ({
    fields: [],
    group,
    id,
    need,
    parts: [],
    status: "todo",
    title,
    ways: [],
    why,
    ...rest,
  });
  return [
    step("address", "hub", "Where the hub listens", "Your devices and machines reach the hub at this address; a tailnet keeps it off the internet.", { kind: "required" }, {
      parts: [
        part(
          "Pick the address",
          "Your tailnet keeps it private, and plain HTTP is fine there. HTTPS (Tailscale Serve) is optional.",
          [link("Tailscale admin", "https://login.tailscale.com/admin/machines")],
          [
            noted(
              "Hub address",
              base,
              // "This machine only" is a fine choice, so the step stays done; it just says what it rules out.
              phoneUrl([base]) === undefined
                ? "Only this machine can reach the hub: phones and other machines can't join. To change that, on " +
                    "the hub, run fleetd init --listen <ip>:<port> --url http://<name>:<port>."
                : "Another address: on the hub, run fleetd init --listen <ip>:<port> --url http://<name>:<port>.",
            ),
          ],
        ),
      ],
      test: "Reach the hub at its address",
      ways: [way(undefined, ["hub/reachable", "hub/https"])],
    }),
    step("machines", "hub", "Machines that run agents", "Agents run on machines; the hub's own machine can be one.", { kind: "required" }, {
      parts: [
        part(
          "Add a machine",
          "The hub's own machine can run agents too. In the app, Settings › Hub › Machines › Add machine does each of these.",
          [],
          [
            command("The hub's own machine, on it", "fleetd machine add --local"),
            command(
              "Another machine, on the hub",
              "fleetd pair --worker <name>",
              workerReachNote(base) ??
                "It prints one line to run on that machine, which installs fleetd and joins. Or, over SSH from the hub: fleetd machine add <ssh host>.",
            ),
          ],
        ),
        part(
          "Android screens (optional)",
          "Android emulators need Linux with KVM. Turn them on on the machine's page in Settings › Hub › Machines. " +
            "iOS simulators are the agents' Mac's: A Mac for agents sets it up.",
          [],
          [],
        ),
      ],
      place: "machines",
      ways: [way(undefined, ["*/online"])],
    }),
    // Any one way is enough (D200): the hub's API key, the owner's subscription, or every machine's own login.
    step("claude", "accounts", "Claude", "Agents think with Claude: the hub's API key, your subscription, or each machine's login.", { kind: "required" }, {
      parts: [
        part(
          "Give the hub an API key",
          "Projects' leads and work nobody started run on it, and so does anyone who picks the hub's API in Settings › " +
            "Your accounts › Claude. Machines need no login of their own.",
          [link("Claude Console › API keys", "https://console.anthropic.com/settings/keys")],
          [
            value("Key name", name),
            plain(
              "Where",
              "Paste it on Settings › Hub accounts › Claude, with an endpoint if you use a gateway; the app seals it on your device.",
            ),
          ],
        ),
        part(
          "Or connect your own subscription",
          "Without a hub key, leads and work nobody started run on the owner's subscription. Paste the token in " +
            "Settings › Your accounts › Claude; the app seals it on your device.",
          [],
          [command("On any computer with claude", "claude setup-token")],
        ),
        part(
          "Or log Claude in on each machine",
          "Each machine's agents run on the Claude account logged in there.",
          [],
          [command("On each machine", "claude auth login")],
        ),
      ],
      place: "claude",
      test: "Read the account's last Test and each machine's login",
      ways: [
        way("the hub's API key", ["hub/claude_key"]),
        way("the owner's subscription", ["hub/claude_owner"]),
        way("each machine's own login", ["*/claude_login"]),
      ],
    }),
    // The hub's own GitHub App (D190) first; gh logged in on the hub still works without one.
    step("github", "accounts", "GitHub", "The hub opens PRs, reads their CI and merges them.", { kind: "before", what: "the first PR" }, {
      parts: [
        part(
          "Create the hub's GitHub App",
          "On Settings › Hub accounts › GitHub: one button, nothing to paste. GitHub hands the App's keys straight to the hub.",
          [],
          [command("Or on the hub, from a terminal", "fleetd github-app create")],
        ),
        part(
          "Install it on the repositories fleetd works on",
          "Then each person connects their own GitHub in Settings › Your accounts › GitHub, so the PRs of their orders open as them.",
          [],
          [],
        ),
      ],
      place: "github",
      test: "Mint a token for each installation, or ask gh who it is logged in as",
      ways: [way("the hub's GitHub App", ["hub/github_app"]), way("gh on the hub", ["hub/gh_auth"])],
    }),
    // 1Password (D235, D313): one vault of its own, holding only what fleetd needs.
    step(
      "onepassword",
      "accounts",
      "1Password",
      "Agents sign in and buy with the logins and card fleetd's service account reads: keep it to one vault of its own.",
      { kind: "before", what: "the first login" },
      {
        parts: [
          part(
            "Make a vault for fleetd",
            "Agents run as you on their machine: they reach your files, gh and ssh, and could read what fleetd's " +
              "1Password service account reads. Keep only the logins agents sign in with and the card a Navi buys with " +
              "in this vault, and nothing else of yours.",
            [],
            [value("Vault name", "fleetd"), plain("In it", "Each login agents sign in with, with its website, and the card a project buys with")],
          ),
          part(
            "Use a low-limit or virtual card",
            "A card in the vault is one an agent on a machine could read. A virtual card with a monthly limit, or a " +
              "card with a low limit, caps what that could cost.",
            [],
            [plain("Card", "A virtual card with a monthly limit, or a low-limit card: never your main card")],
          ),
          part(
            "Make a service account that reads only that vault",
            "1Password can't change a service account's vaults once it's made: for one that reads more, make a new " +
              "one, paste its token, and revoke the old one on Your service accounts.",
            [link("Make a service account", ONEPASSWORD_NEW), link("Your service accounts", ONEPASSWORD_ACCOUNTS)],
            [value("Name", name), plain("Vaults", "Only fleetd's vault, with read access")],
          ),
        ],
        fieldsNote:
          "Each person pastes their own token (it starts with ops_) in Settings › Your accounts › 1Password; the app seals " +
          "it on their device to every machine. Test there lists the vaults it reads.",
        place: "onepassword",
        test:
          "Test your own token on a machine holding it, then read each person's last Test: one vault each. The first " +
          "Test on a machine can take up to 4 minutes while its node installs the 1Password SDK",
        ways: [way(undefined, ["hub/onepassword_vault"])],
      },
    ),
    step(
      "people",
      "people",
      "Invite people",
      "Each person gets their own sign-in, chats and projects; you choose who is an admin.",
      { kind: "optional" },
      {
        parts: [
          part(
            "Invite someone",
            "The invite is a link and a code, for one person, good for 7 days. Send it to them yourself.",
            [],
            [command("On the hub", "fleetd invite --name <name>", "--role admin for another admin.")],
          ),
        ],
        place: "invites",
        ways: [way(undefined, ["hub/people"])],
      },
    ),
    // A Mac for agents (D298, D309): optional. It joins from the account logged in at its screen.
    step(
      "mac",
      "hub",
      "A Mac for agents",
      "Agents on every machine build, test and drive iOS simulators on one Mac: a tool, never a runner, joined from " +
        "the account at its screen.",
      { kind: "optional" },
      {
        parts: [
          part(
            "Xcode, once",
            "In Terminal on the Mac, in the account it joins from (yours is fine). Xcode itself comes from the App " +
              "Store, and an iOS simulator runtime with xcodebuild -downloadPlatform iOS. Without Xcode yet, the Mac " +
              "still joins: only iOS simulators wait, and its Xcode check says what to do. CocoaPods (for pod install " +
              "and expo prebuild) comes from Homebrew: brew install cocoapods; its tools check gives the exact line, " +
              "Homebrew's own install first where there is none.",
            [],
            [command("In Terminal on the Mac", MAC_ADMIN_BLOCK, "Each line says why. It never pipes anything from the network into sudo.")],
          ),
          part(
            "Join, at the Mac's screen",
            "Paste the join line in Terminal on the Mac, logged in at its screen: launchd runs the node only inside " +
              "that login, so su and ssh won't do. It installs fleetd for that account and joins as the agents' Mac: a " +
              "tool every project's agents use, which runs no claude and no Navi and takes no secret. Settings › Hub › " +
              "Machines › Add machine › A Mac for agents makes the line with its one-time code; if this Mac runs fleetd " +
              "already, give it that machine's name, and the line replaces it. After a restart, log that account in " +
              "again: with FileVault on, macOS logs no one in by itself.",
            [],
            [
              command(
                "In Terminal, logged in at the Mac's screen",
                `curl -fsSL https://fleetd.sh | sh -s -- --join ${base} --code <code> --machine-id mac${macFlags(version)}`,
                `Or on the hub: fleetd pair --worker mac, then add${macFlags(version)} to the line it prints.`,
              ),
            ],
          ),
          part(
            "Two clicks at the Mac",
            "Turn on fleetd in Accessibility and in Screen Recording, so agents can drive the Mac's apps and you can " +
              "watch them. The join opens each pane and waits for it, and the node restarts itself within seconds to " +
              "take up each grant. macOS may ask for an administrator's name and password: type it in that System " +
              "Settings dialog at the Mac itself, never through fleetd's view of its screen. macOS asks again from time " +
              "to time; the check says when.",
            [],
            [
              command(
                "Accessibility, at the Mac",
                'open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"',
                "In Terminal there: it opens the pane. Turn on fleetd there.",
              ),
              command(
                "Screen Recording, at the Mac",
                'open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"',
                "The same for Screen Recording.",
              ),
            ],
          ),
          part(
            "A Mac that runs fleetd already",
            "Give the join line the name it has, in the same account, and it becomes the agents' Mac in place, keeping " +
              "its history. Let the agents running there finish (or stop them) first. Joined under another name or from " +
              "another account, the old machine stays until you remove it: the Mac's checks say so, and how.",
            [],
            [
              command(
                "On the hub, for an old machine of another name",
                "fleetd machine remove <old name>",
                "Where it ran in another account on the Mac, stop it there too: launchctl bootout gui/$(id -u)/sh.fleetd.node",
              ),
            ],
          ),
          part(
            "Optional: a user of its own for agents",
            "Agents act as the account the node runs in, so they can read what it can. To keep them out of yours, make " +
              "a standard user for them, log in as it at the Mac's screen, and join from there instead.",
            [],
            [
              command(
                "In your own (admin) account's Terminal",
                MAC_USER_BLOCK,
                "sysadminctl asks for the new user's password, which you keep; agents never get it.",
              ),
            ],
          ),
        ],
        place: "machines",
        test: "Read the Mac's checks, which its node runs every 30 seconds (its grants every 2 while one is off)",
        // The hub's own too: no other node on the same computer (doctor/checks.rs).
        ways: [{ checks: [...MAC_CHECKS.map((id) => `*/mac_${id}`), "*/mac_one_node"] }],
      },
    ),
    // Cloud machines on boat.dev (D306): optional, on the owner's own boat account.
    step(
      "cloud",
      "hub",
      "Cloud machines (boat.dev)",
      "When every machine of yours is at its agent limit, work runs on a few sleeping boat.dev machines of your own " +
        "account, within budgets you set.",
      { kind: "optional" },
      {
        parts: [
          part(
            "Make a boat.dev organization with one seat",
            "It costs the same as a personal plan, and its owner can cap their own seat, so boat.dev itself stops " +
              "everything at your cap whatever fleetd does. Leave auto top-up and extra starts off: past the plan, " +
              "starts are refused rather than billed.",
            [
              link("boat.dev", "https://boat.dev"),
              link("Seats and limits", "https://docs.boat.dev/organizations/seats-and-limits"),
              link("Control your spend", "https://docs.boat.dev/billing#control-your-spend"),
            ],
            [
              plain("Plan", "$20 a month: it includes $20 of machine time and 200 starts a day"),
              plain("Billing › Auto top-up", "Off"),
              plain("Billing › Extra starts on invoice", "Off"),
              noted("Members › you › Machine time cap", "300 hours a month", "Recommended: boat.dev stops your machines within a minute of it."),
              noted("Members › you › Machines at once", "3", "Your pool size: 3 unless you change it below."),
            ],
          ),
          part(
            "Make an environment for fleetd",
            "Cloud machines are made in it, with none of your account's secrets, AI logins or in-machine boat.dev key.",
            [link("Environments", "https://docs.boat.dev/environments")],
            [value("Name", `fleetd-${host}`), plain("Safe for third parties", "On")],
          ),
          part(
            "Make the hub's API key",
            "Only what the hub needs to make, wake, stop and delete its machines, and ssh for its tunnel: the hub dials " +
              "each machine it wakes and holds an SSH tunnel its node reaches the hub through, so the hub needs no public " +
              "address. No exec, file or snapshot actions: the hub never runs anything on a cloud machine.",
            [link("API key scopes", "https://docs.boat.dev/api-keys/scopes")],
            [
              value("Name", `fleetd-${host}`),
              noted("Actions", BOAT_KEY_ACTIONS, "Not the presets: ci and admin give far more."),
              value("Scope: environment", `fleetd-${host}`),
              plain("Expires", "365 days"),
            ],
          ),
          part(
            "Choose the pool, the budgets and the projects",
            "Paste the key, Test it, then pick these and turn cloud machines on. Before you do, fleetd shows the most the " +
              "pool can cost a day and a typical day. Work goes to a cloud machine only when every machine of yours is at " +
              "its agent limit.",
            [],
            [
              noted("boat.dev environment", `fleetd-${host}`, "The one you made in part 2: machines are made in it, where the key reaches."),
              plain("Machines", "3 × large (8 vCPUs, 16 GB, $0.072 an hour each)"),
              plain("Day budget", "$3"),
              plain("Month budget", "your plan's included dollars ($20)"),
              plain("Projects", "the ones you tick: their code, transcripts and the secrets sealed there go to boat.dev"),
            ],
          ),
        ],
        fieldsNote:
          "Cloud machines run on boat.dev: boat.dev can see what runs on them, as any host can. Paste the key, set the " +
          "pool and turn it on in Settings › Hub › Machines › Cloud machines.",
        place: "cloud",
        test:
          "Ask boat.dev what the key may read, then wake (or make) a cloud machine and check the hub's tunnel to it and " +
          "its node's hello",
        ways: [way(undefined, ["hub/cloud_key", "hub/cloud_network", "hub/cloud_machines", "hub/cloud_budget"])],
      },
    ),
  ];
}

/** How bad a check's status is: ok, then unknown ("not set up"), warn, fail. */
export const rank = (s: DoctorStatus): number => ({ ok: 0, unknown: 1, warn: 2, fail: 3 })[s as string] ?? 1;

/** Whether a way's check pattern (`hub/<name>`, or `*` then `/<name>` for every machine) names this check id (setup.rs `matches_check`). */
export function matchesCheck(pattern: string, id: string): boolean {
  if (!pattern.startsWith("*/")) return pattern === id;
  const name = pattern.slice(2);
  const slash = id.indexOf("/");
  return !id.startsWith("hub/") && slash >= 0 && id.slice(slash + 1) === name;
}

/** One way's status, and the check that decides it: the worst of its checks. */
function readWay(w: SetupWay, checks: DoctorCheck[]): [SetupStatus, DoctorCheck | undefined] {
  let worst: DoctorCheck | undefined;
  for (const c of checks) {
    if (!w.checks.some((p) => matchesCheck(p, c.id))) continue;
    if (worst === undefined || rank(worst.status) < rank(c.status)) worst = c;
  }
  const status: SetupStatus =
    worst === undefined || worst.status === "unknown" ? "todo" : worst.status === "ok" ? "done" : "look";
  return [status, worst];
}

/** Each step's status is its best way's: one way done is enough, else one set up but failing wants a look, else to do. */
export function read(steps: HubSetupStep[], checks: DoctorCheck[]): HubSetupStep[] {
  return steps.map((step) => {
    const reads = step.ways.map((w) => [w, ...readWay(w, checks)] as const);
    let best: (typeof reads)[number] | undefined;
    for (const s of ["done", "look", "todo"] as const) {
      best = reads.find(([, status]) => status === s);
      if (best) break;
    }
    const check = best?.[2] ?? reads.find(([, , c]) => c !== undefined)?.[2];
    const status = best?.[1] ?? "todo";
    const out: HubSetupStep = { ...step, status };
    if (step.ways.length > 1 && best && best[1] !== "todo" && best[0].label !== undefined) out.way = best[0].label;
    if (check) out.said = check.message;
    if (status === "look") out.failing = check?.status === "fail";
    if (check?.fix && status !== "done") out.fix = check.fix;
    return out;
  });
}

/**
 * GitHub is needed only before the first PR: on a hub with no project of code yet no PR can open, so gh logged out
 * there is GitHub not set up yet, "todo", not failing. Once a project exists, it fails as the doctor says.
 */
export function beforeFirstUse(checks: DoctorCheck[], codeProjects: number): DoctorCheck[] {
  if (codeProjects > 0) return checks;
  return checks.map((c) => (c.id === "hub/gh_auth" && c.status === "fail" ? { ...c, status: "unknown" } : c));
}

/** setup.rs `HubSetupStep::required_left`. */
export const requiredLeft = (s: HubSetupStep) =>
  s.need.kind === "required" && (s.status === "todo" || (s.status === "look" && s.failing === true));
