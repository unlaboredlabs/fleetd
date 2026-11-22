// Every command's usage, in one module so `fleetd help` and `--help` load no command. test/cli/fixtures hold the whole
// texts; docs/site's CLI reference is generated from `fleetd help`.
import { settingsPath } from "../shared/settings_path.ts";

export const UPDATE_USAGE = `  update [--check] [--channel <c>] [--now]
             replace this fleetd with the latest release, then restart its hub at once and its
             node once its agents finish the step they're on (10 min at most; --now doesn't wait):
             what they were running carries on by itself. The app's Update button does this for
             the hub and every node; this is for a machine without the app. --channel edge (the
             newest build of main) or stable; default: the channel this build came from.
`;

export const SETUP_USAGE = `  init [--yes] [--listen <host:port>] [--url <url>]
       [--git-identity "Name <email>"] [--no-service]
             set up fleetd step by step in a terminal: the hub on this machine (home default
             ~/.fleetd/hub, kept running by a systemd or launchd user service), where it listens
             (your tailnet when there is one), the claude and gh logins, the machines that run
             agents, a first bot and the desktop app, then the hub's setup steps. Run it again to
             check and repair; it keeps what works. --yes takes every default. Without a
             terminal and without --yes it only sets up the hub. --url is how devices reach the
             hub (default http://<listen>); --git-identity is the commit author for every
             machine (the GitHub noreply address for public repos); --no-service prepares
             everything but leaves starting the hub to you
  init --join <hub url> --code <code> [--machine-id <id>] [--git-identity "Name <email>"] [--rejoin]
       [--claude-config-dir <dir>] [--mac] [--no-service]
             make this machine a worker of that hub, without SSH from the hub: the command
             fleetd pair --worker prints on the hub. Run again, it keeps the node's enrolment
             and repairs the rest; --rejoin enrols again with a new code; --mac joins the
             agents' Mac, from Terminal logged in at its screen (no claude there);
             --no-service enrols the node but leaves running it to you, and prints how
  init --step <address|machines|claude|github|onepassword|people|mac>
             open one of the hub's setup steps: why, the values to paste and the pages to open,
             then Test it, or put it off for later. The app's ${settingsPath()} › Setup has the same
             steps
  doctor
             run every setup check on the hub now: the setup steps first, then each other
             problem with its fix
  uninstall [--purge]
             stop and remove the hub's service; its data stays unless --purge
`;

export const PAIR_USAGE = `  pair [--name <device>] [--role <read|operate|admin>] [--no-qr]
             print a one-time code (15 min) that pairs the fleetd app with this hub, and a QR
             of its link for the phone app to scan (--no-qr leaves it out); the desktop app
             on this machine pairs by itself. The device gets --role (default admin, which
             changes the hub's settings) on every machine
  pair --worker <machine-id>
             print the one command that makes another machine a worker of this hub, with
             a one-time code (15 min): for a machine the hub can't reach over SSH. A new
             code replaces the machine's open one, so only the newest works
  pair --worker-codes
             list the worker codes that can still be used, the agents' Mac's 6-digit setup code
             among them: each one's id, machine, when it was made and until when it works, never
             the code itself
  pair --worker-revoke <id>
             take back the open worker code with that id (from --worker-codes): a machine
             that tries it is refused. Used and expired codes are dropped a day later
`;

export const PEOPLE_USAGE = `  invite --name <name> [--role <member|admin|owner>]
  invite --person <personId>
             invite someone to this hub: prints a link and a code (single use, 7 days) that pair
             their app as a device of a new person, a member unless --role; with --person, one
             more device of someone already here
  invite list
  invite revoke <inviteId>
             takes back an open invite; someone it invited who never joined goes with it
  people
             the hub's people, with their role and devices
  people role <personId> <owner|admin|member>
  people remove <personId>
             signs out all their devices; one device: fleetd hub key revoke <keyId>. The hub
             always keeps an owner
`;

export const GITHUB_APP_USAGE = `  github-app
             the hub's own GitHub App: where it is installed and its last test
  github-app create [--org <org>] [--name <name>] [--port <port>]
             make it on GitHub with nothing to paste: opens a page on this machine
             (127.0.0.1) that sends GitHub the App's manifest; press Create on GitHub and
             the hub keeps its keys, sealed. From another computer, forward the port first:
             ssh -L <port>:127.0.0.1:<port> <this machine>
  github-app test
             mint a token for each installation and say where the App reaches
  github-app remove
             forget it; the hub's gh goes back to this machine's own login
`;

export const PROJECT_USAGE = `  project add [<path|github-url>] [--machine <id>] [--title <t>] [--dest <dir>]
         [--use-existing] [--yes] [--hub <url>]
             add a bot: a checkout or a plain folder on a machine (this one by default),
             or a GitHub repo cloned onto one (the least busy worker by default), with progress;
             then its CI, merge rules and what the lead will need. No argument: pick one.
             Everyone on the hub sees and uses it, as every bot
  project add --new <name> [--machine <id>] [--dest <dir>] [--git-init] [--hub <url>]
             start a new, empty bot: the machine makes its folder (~/fleetd/projects/<name>
             by default, or --dest; one that holds files is refused). A plain folder with no
             repo, unless --git-init; add a repo later with project repo add
  project list [--archived] [--machine <id>] [--hub <url>]
  project archive <machine>/<bot> [--hub <url>]
             its lead stops and doesn't start again; its chat, memory and folder stay
  project unarchive <machine>/<bot> [--hub <url>]
             bring it back: its lead starts with your next message
  project stop <machine>/<bot> --key-file <human key> [--yes] [--hub <url>]
             stop its lead's turn and its agents, as you; the lead and its chat stay,
             and the chat says what stopped
  project remove <machine>/<bot> [--yes] [--hub <url>]
             stop its agents and erase it: its chat, memory, skills, approvals, orders,
             automations and sign-ins; its files, branches and worktrees stay
  project repo list <machine>/<bot> [--hub <url>]
  project repo add <machine>/<bot> <path|github-url> [--name <n>] [--dest <dir>]
         [--use-existing] [--hub <url>]
             add a repo to the bot: a checkout on its machine, or a GitHub repo
             cloned there, with progress. A checkout that is a bot of its own is
             archived: its chat stays, its lead stops running
  project repo remove <machine>/<bot> <name> [--yes] [--hub <url>]
             take the repo out of the bot and end its agents; its files stay
  project set <machine>/<bot> --max-agents <n>|default [--pause-extras] [--hub <url>]
  project set --fleet-cap <n> [--hub <url>]
             the most agents the bot runs at once (its lead not counted), or the
             fleet's cap on running agents (admin key); more wait queued and start as
             slots free. default: its machine's cap within the fleet cap, following
             both. Lowering stops nothing; --pause-extras has the newest agents above
             the new max push their work and wait
  project set <machine>/<bot> --profiles <name>,...|none [--hub <url>]
             the task profiles its lead may run agents on besides the hub's default,
             which every bot allows; none: the default alone
  project set <machine>/<bot> --merges you|fleetd --key-file <human key> [--hub <url>]
             who merges its PRs. you: the train reviews them and keeps them up to
             date, merges only those its merges-itself rules allow, and the lead
             says when each other one is ready; fleetd: the train merges each one
             once it is reviewed and green
  project profiles [<machine>/<bot>] [--hub <url>]
             the hub's task profiles: model, effort, fast mode and note, and which
             the bot allows
  project profile <name> [--model <model>] [--effort low|medium|high|xhigh|max]
         [--fast on|off] [--note <text>] [--rename <new>] [--default] [--lead]
         [--delete] --key-file <human key> [--hub <url>]
             create or change a task profile (owner or admin), or delete one. A new
             one needs --model and --effort. --default makes it the one every review,
             helper call and task naming no profile runs on; --lead the one leads
             start on (on the default: leads follow the default), from each lead's
             next start. Deleting the lead's puts leads back on the default
`;

export const HUB_START_USAGE = `  hub start [--home <dir>] [--listen <host:port>]
             run the hub (default home ~/.fleetd/hub, listen 127.0.0.1:4790,
             writes to an offline machine wait 24 h)
`;

export const HUB_KEY_USAGE = `  hub key create --name <name> --role <read|operate|admin> --machines <'*'|id,id> [--out <file>]
             create an agent key for the MCP endpoint; prints the key once, or with --out writes it
             to a new file (0600) and prints the file's path
  hub key create --agent <name> [--machines <'*'|id,id>] [--out <file>]
             a named agent's key, to write in a bot's chat (fleetd chat --key-file): its
             messages show as that agent's, never yours. Operate on every machine unless
             --machines. Written to a new file (0600), <hub home>/keys/<name>.key unless --out;
             prints only the file's path
  hub key create --human --name <device> [--role <role>] [--machines <'*'|id,id>] [--out <file>]
             a key for a person's device (the desktop app): what it answers is recorded as the
             human's; role defaults to operate on every machine
  hub key list
  hub key revoke <keyId>
             takes effect at once, also on a running hub
`;

export const NODE_USAGE = `  node join --hub <url> (--token <token> | --token-file <file|->) --machine <id>
            [--home <dir>] [--enroll-only] [--claude-config-dir <dir>]
             enroll this machine with the hub, then keep its link up (node home default ~/.fleetd/node);
             --token-file - reads the token from stdin; --enroll-only exits once the hub has accepted this
             node; sessions use your own claude setup (~/.claude) unless --claude-config-dir names a
             dedicated one
  node run [--home <dir>]
             keep the link up for a machine that has joined
  node restart
             restart this machine's node service (launchd or systemd)
  node grants [--ask accessibility|screen_recording|screen_capture] [--wait <seconds>] [--home <dir>]
             on the agents' Mac: the Accessibility and Screen Recording grants macOS gives a
             node started now; --ask has the running node ask macOS for one (waiting up to --wait,
             default 30, for it to), then opens its pane
  node leave [--home <dir>]
             stop being the agents' Mac: stops and removes the node's service, has the hub remove this
             machine when it answers, and deletes the node's key and settings
`;

export const PROMPTS_USAGE = `  prompts list [--project <machine>/<bot>]
             every prompt fleetd sends a model, which text is in effect, and
             "update" where a release changed the default you edited
  prompts show <id> [--project <machine>/<bot>] [--default]
  prompts show --session <machine>/<thread>
             the text in effect (or the shipped one), or exactly what a session was told
  prompts edit <id> [--project <machine>/<bot>]
             edit it in $VISUAL or $EDITOR; warns when a placeholder or a safety rule is gone
  prompts reset <id> [--project <machine>/<bot>]
  prompts diff <id> [--project <machine>/<bot>]
             shipped vs yours; after a release changed it, what changed in each
  instructions show|edit [--project <machine>/<bot>]
             your custom instructions, appended to every lead and task
`;

export const PUSH_RELAY_USAGE = `  push-relay [--listen 127.0.0.1:4795]
             forward hubs' sealed phone notifications to APNs and FCM with your own
             credentials: FLEETD_APNS_KEY_FILE (a .p8), FLEETD_APNS_KEY_ID, FLEETD_APNS_TEAM_ID,
             FLEETD_APNS_TOPIC (the app's bundle id), FLEETD_APNS_SANDBOX=1 for development
             builds; FLEETD_FCM_SERVICE_ACCOUNT (a Firebase service account's JSON key).
             FLEETD_PUSH_RELAY_KEY_FILE (a file holding a key): take only hubs that send it; set one
             when the relay is reachable beyond this machine. It never reads, keeps or logs a
             notification. Run your own only for an app you build yourself
  push-relay set <url|off> [--relay-key-file <path>] [--hub <url> --key-file <path>]
             hubs send phone notifications through https://push.fleetd.sh, the relay for the
             published app, without a key. <url> sends them through your own relay instead, with
             the key in --relay-key-file when it takes one, sealed to the hub;
             https://push.fleetd.sh goes back to the default; off sends none
             (admin key on every machine)
`;

export const TIME_USAGE = `  time [<order>|<bot>] [--since 7d] [--json] [--hub <url> --key-file <path>]
             where agents' time went: an order's critical path, agent time by category, the
             slowest commands and the findings; a bot by id or title (<machine>/<bot>
             when two machines have one), the whole fleet with neither. --since takes 1h to
             400d, a date or an ISO time. Timelines are kept 30 days, daily totals 400. On the
             hub machine it needs no --hub or --key-file
`;

export const METRICS_USAGE = `  metrics [--project <p>] [--days 30] [--json] [--hub <url> --key-file <path>]
             what the factory turned out: PRs merged per day by route, time from order to
             merged, your minutes per merged PR and the share through fleetd, over the last
             --days calendar days (1-400, today included) in this machine's zone; one bot by
             id or title (<machine>/<bot> when two machines have one), the whole fleet
             without one. Landed changes are kept 400 days. On the hub machine it needs no
             --hub or --key-file
`;

export const STATUS_USAGE = `  status [<bot>] [--watch] [--json] [--hub <url> --key-file <path>]
             one row per bot, as the app's Status screen shows it: what it is doing
             (working, waiting on you, blocked and why, idle), its work in groups (waiting on
             you, in review, working, landing, idle, done), agents running and the last merge;
             one bot by id or title (<machine>/<bot> when two machines have one).
             --watch prints the rows again after each change; a stale row says so. On the hub
             machine it needs no --hub or --key-file
`;

export const USAGE_USAGE = `  usage [<machine>] [--json] [--hub <url> --key-file <path>]
             each machine's Claude usage pause: open or not, why, until when, and how much is parked
  usage resume <machine> [--json] [--hub <url> --key-file <path>]
             lift the machine's usage pause now and send every parked agent "continue", like
             Resume in the app; one whose login is still limited parks again with the real reset.
             --json adds pauseLifted (null when the pause couldn't be read first). On the hub
             machine neither needs --hub or --key-file
`;

export const STEER_USAGE = `  steer T<n> "<text>" [--now] [--wait] --key-file <human key> [--hub <url>]
             steer one agent (T88) mid-run. Plain: it lands at the agent's next step, after the
             tool it is running returns. --now stops that step and delivers at once. --wait
             follows the receipt: exit 0 acknowledged, 1 not acknowledged, withdrawn or failed.
             Without --hub it uses the hub on this machine. To reach a bot's lead, use
             fleetd chat
  steer withdraw S<n> --key-file <human key> [--hub <url>]
             take back a steer the agent has not taken in yet
  steers <W|T> --key-file <human key> [--hub <url>]
             an order's (or one agent's) recent steers and their receipts
`;

export const CHAT_USAGE = `  chat <machine>/<bot> "<text>" [--now] [--wait | --follow] --key-file <key> [--hub <url>]
             write to a bot's lead, as the app does: it starts the lead's next turn, or lands at
             its next step while it works; --now (a human key) stops that step and delivers at once.
             --wait or --follow prints the lead's reply when its turn ends.
             Exit 0 it replied, 1 its turn ended without a reply. A human key writes as you; an agent
             key as that agent, by its name
  chat history <bot> [--page <n>] --key-file <key> [--hub <url>]
             the bot's chat: who wrote each message, when, and what; the newest page, older
             ones with --page
`;

export const WORK_USAGE = `  work [list] --key-file <key> [--hub <url>]
             what is in flight on this checkout's repo and base: fleetd's agents, PRs on the merge
             train, and people's claims
  work claim "<intent>" [--issue <key>]... [--paths <a,b>] [--anyway]
        [--not-duplicate-of <ids> --why "<reason>"] --key-file <key> [--hub <url>]
             check the intent against the work in flight and claim it, with the repo, branch,
             user.email and changed paths read from this checkout. Exit 0 claimed (or yours: a
             fleetd agent on its own task's branch), 1 taken or a likely duplicate (it says by
             what). Again on the same branch: renews it. --anyway (a human key only) claims taken
             work regardless
  work done [C<n>] [--landing <sha>] --key-file <key> [--hub <url>]
             end your claim as landed (by default the one on this branch); --landing: the commit
             on the base. --key-file defaults to $FLEETD_KEY_FILE
  work drop [C<n>] --key-file <key> [--hub <url>]
             end your claim as dropped (by default the one on this branch): you stop, or leave it
             to someone else
`;

export const MACHINE_SET_USAGE = `  machine set <id> --max-agents <n>|auto [--hub <url>]
             the most agents the machine runs at once (admin key), up to the fleet cap,
             in place of what it is measured to fit; auto: what it fits again. Raising
             starts queued agents at once; lowering stops nothing
  machine set <id> --roles agents,sessions [--max-sessions <n>|auto] [--hub <url>]
             what the machine is for (admin key): agents, sessions (screens: browsers and
             devices) or both, and the most screens it hosts at once (1 to 64; auto: what it
             fits). A screen an agent starts runs on its own machine when it can, else on
             another that can, through the hub. Without agents, running agents finish and new ones
             wait
`;

export const MACHINE_ADD_USAGE = `  machine add <ssh-host> | --local [--machine-id <id>] [--dry-run] [--no-service]
            [--hub-url <url>] [--ssh-config <file>]
            [--claude-config-dir <dir>]
             set up a machine that runs agents, over SSH (--local: this machine): copies this fleetd
             there (for another OS or CPU, this version's release build for it, checked against
             its SHA256SUMS; there is no Linux ARM build yet), checks its claude (installed, version >=2.1.300, <2.2.0, logged in), enrolls the node and
             runs it as a user service, then waits until the machine is online; prints every command
             first, --dry-run only prints (for a fresh machine, without connecting); --no-service
             enrolls the node but writes no service and prints how to run it; safe to run again
  machine remove <id> [--purge] [--force]
             stop and remove the node's service on the machine, revoke its key on the hub and forget
             its rows there (run again, it clears what an older remove left); --purge also deletes
             ~/.fleetd/node and ~/.fleetd/claude.env there; refused while the machine runs
             bots' leads, unless --force
`;

export const machineUsage = () => `${MACHINE_ADD_USAGE}${MACHINE_SET_USAGE}`;

/** `mac --help`. */
export const MAC_HELP = `mac: the agents' Mac, from wherever you run (fleetd's shared Mac for builds and iOS simulators).

  mac push                         your worktree as it is now (commits, changes, new files) becomes your folder on
                                   the Mac; only what changed goes across
  mac run [--bg] [--env NAME]... [--] <command line>
                                   runs it in your folder there with the Mac's shell, as ssh would; prints its output
                                   and exits with its exit code. --bg runs it on and prints its job number
  mac logs <job> [-f]              a job's output so far (-f: follow it to its end)
  mac ps                           your jobs
  mac kill <job>                   ends a job
  mac pull <path> [to]             a file or folder from your folder on the Mac into your worktree
  mac sim start [--device <type>] [--no-wait]
                                   an iOS simulator of your own on the Mac, booted (a plain iPhone; --device "iPad
                                   Pro 13-inch (M5)" another type, as xcrun simctl list devicetypes names it, booted
                                   from nothing: a minute or two). While none is free it waits its turn: agents get
                                   simulators in the order they asked, it prints its place as it changes ("2nd in
                                   line, about 90 s") and returns once yours is booted, so run it with your longest
                                   timeout; cut off, run it again within 2 minutes to keep your place. --no-wait
                                   says why there is none instead. From then on agent-device drives it, running on
                                   the Mac (its files land in your folder there: mac pull them). It is your screen:
                                   the person can watch it live in Screens and take it over (agent-device refuses
                                   until they hand it back); it never uses the Mac's own screen. In
                                   mac run, $FLEETD_MAC_SIM is its udid and $FLEETD_MAC_SIM_SET the device set plain
                                   simctl needs: xcrun simctl --set "$FLEETD_MAC_SIM_SET" <command> "$FLEETD_MAC_SIM"
  mac sim rotate left|right        turns it a quarter, its screenshots with it
  mac sim shake | home | lock      shakes it (an app's shake-to-undo), presses Home, presses the side button
  mac sim appearance [light|dark]  sets light or dark (no word: the other one)
  mac sim location <lat>,<lon>     moves its location (48.8584,2.2945)
  mac sim fold closed|half-open|open
                                   an iPhone Duo's pose: closed lights the outer panel, half-open and open the inner;
                                   take a new agent-device snapshot after it (refs and coordinates change)
  mac sim screenshot [to]          the lit panel's PNG, into your worktree (an iPhone Duo's too, which agent-device
                                   screenshot can't pick)
  mac sim end                      ends it, or leaves the line (30 minutes with no mac command ends it too)

Your folder there is $FLEETD_MAC_DIR, the pushed worktree $FLEETD_MAC_REPO; xcodebuild builds into your own
$FLEETD_MAC_DERIVED_DATA, and $FLEETD_MAC_CACHE is shared by every agent; pod (CocoaPods) and the Mac's other
Homebrew commands are on the PATH there. None of your secrets go to the Mac unless you name them with --env NAME. Every mac run lands in your action log.
`;

export const EXPORT_USAGE = `  export [--out <file>] [--no-secrets] [--passphrase-file <file|->]
             write this hub's data to one file (default fleetd-export-<time>.tar here), beside
             the running hub: bots, chats, orders, tasks, decisions, checklists, memory,
             skills, artifacts, attachments, recordings, automations, people and settings. The
             vault and the other secrets go in sealed under a passphrase you type (12 characters
             or more; for a script, --passphrase-file or FLEETD_EXPORT_PASSPHRASE), or stay out
             with --no-secrets. Machines' keys and device sign-ins are never in it
  import <file> [--no-secrets] [--passphrase-file <file|->]
             load an export into this hub, which must be fresh (no bots yet) and stopped.
             The whole file is checked first and it loads all or nothing. Afterwards machines
             join again under their ids and people sign in again; it prints the commands. An
             export from a newer fleetd is refused: update fleetd first
`;

export const VAULT_USAGE = `  vault key --store <file|keyring|passphrase>
             move the vault's root key: a file beside the hub (the default), this machine's
             keychain, or a file locked with a passphrase (read from stdin; the vault then stays
             locked after each restart until an owner or admin unlocks it in the app)
  vault recovery-code
             print the vault key's recovery code, to keep somewhere other than the hub
  vault restore-key
             take the vault key back from its recovery code (read from stdin)
`;
