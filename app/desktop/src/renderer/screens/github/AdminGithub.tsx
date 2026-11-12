// Settings › Hub › Setup › GitHub (the GitHub step's own page, admin/SetupPage.tsx): the hub's own GitHub App (D190),
// which does the hub's work on GitHub (the train's reads, rebases, statuses and merges, and the PR pages) on the
// repositories it is installed on. Create GitHub App goes through main (window.fleetd.github.createApp): it posts the
// hub's manifest to GitHub from a page on 127.0.0.1 and hands GitHub's code to github_app_create, so the App's keys go
// from GitHub to the hub and never to this computer. Then the admin installs it on repositories at GitHub, and Test
// (github_app_test) reads where it is installed with a token for each. Without an App, the hub's gh uses its
// machine's own login, as before.
//
// On a team of fleetd cloud (a hub that came with the account) there is one App, fleetd's (decision hosted.github-app),
// and nothing to create: Install asks the team for GitHub's install page (window.fleetd.cloud.installGithub), whose
// state only this person can finish, after they connect their own GitHub; the step reads the App again when the window
// gets focus back from the browser. Remove takes the installations off the team; they stay installed on GitHub.
import { Check, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import type { GithubAccount, GithubApp, GithubAppGetOutput, GithubAppTestOutput, GithubInstallation } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useDataLayer, useHub, useToolQuery } from "../../src/data/react";
import { Button, Field, Input, Segmented, Text } from "../../ui";
import { useServes } from "../admin/role";
import { useNow } from "../live";
import { useHubState } from "../onboarding/hooks";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { GroupNote, SettingsRow, SettingsSection } from "../settings/parts";
import { ConfirmRemove } from "../settings/claudeParts";
import { when } from "../live/when";
import { dayWords, listWords } from "./words";
import s from "./github.module.css";

const noInput = {};

/** What each permission lets the App do, as a person reads it. */
const PERMISSION_WORDS: Record<string, string> = {
  contents: "Contents: rebase and merge branches",
  pull_requests: "Pull requests: read, update and merge them",
  issues: "Issues: find and label PRs (fleetd:next)",
  workflows: "Workflows: merge changes to .github/workflows",
  statuses: "Commit statuses: post fleetd/train",
  actions: "Actions: re-run CI",
  checks: "Checks: read CI's results",
  metadata: "Metadata: read the repository",
};

/**
 * The default name: `fleetd on <hub>`, as GitHub takes it (34 characters at most), after the hub's label in this app,
 * else its address's first name (`devbox` of `devbox.tailnet.ts.net:4790`).
 */
export const appName = (label: string, address: string): string => {
  const host = address.replace(/^[a-z]+:\/\//u, "").split(/[.:/]/u)[0] ?? "";
  const hub = label.trim() !== "" ? label.trim() : /^\d+$/u.test(host) || host === "" ? "my hub" : host;
  return `fleetd on ${hub}`.slice(0, 34).trim();
};

/** One installation in words: `acme: acme/web and acme/api` or `Solo: all 31 repositories`. */
export const reachWords = (i: GithubInstallation): string => {
  if (i.allRepositories) return `${i.account}: all ${String(i.repositoryCount)} repositories`;
  const names = i.repositories ?? [];
  if (names.length > 0 && names.length === i.repositoryCount) return `${i.account}: ${listWords(names)}`;
  return `${i.account}: ${String(i.repositoryCount)} chosen ${i.repositoryCount === 1 ? "repository" : "repositories"}`;
};

const installUrl = (app: GithubApp): string => `https://github.com/apps/${app.slug}/installations/new`;

export function AdminGithub() {
  const live = useLive();
  const cloud = useHub().cloud === true;
  // fleetd cloud leaves the hub's own App out (hub_info's leftOut): nothing to create there.
  const creates = useServes("github_app_create") && !cloud;
  const read = useToolQuery("github_app_get", noInput, { enabled: live });
  // Said once the App's own section has gone with it.
  const [removed, setRemoved] = useState<string | null>(null);
  if (!live || read.data === undefined) {
    const text = !live ? "Not connected. Connect to a hub to set up GitHub." : read.error !== null ? errorText(read.error) : "Loading…";
    const old = read.error instanceof CallError && lacksTool(read.error.error);
    return (
      <SettingsSection reveal="admin.github">
        <GroupNote tone={read.error !== null && !old ? "danger" : "quiet"}>{old ? "This hub is too old for a GitHub App. Update fleetd on the hub first." : text}</GroupNote>
      </SettingsSection>
    );
  }
  const app = read.data.app;
  if (app === undefined && !creates) {
    return (
      <SettingsSection reveal="admin.github">
        <GroupNote>GitHub isn&apos;t set up on this service.</GroupNote>
      </SettingsSection>
    );
  }
  return (
    <>
      <SettingsSection reveal="admin.github">
        {app === undefined ? <NoApp removed={removed} /> : cloud ? <CloudApp app={app} me={read.data.me} /> : <AppStatus app={app} onRemoved={setRemoved} />}
      </SettingsSection>
      {creates ? <Create info={read.data} /> : null}
    </>
  );
}

function NoApp({ removed }: { removed: string | null }) {
  return (
    <SettingsRow title="No App yet" label="GitHub App" hint="Until there is one, the hub uses gh as it is logged in on the hub’s machine. Create the App below.">
      {removed === null ? null : (
        <div role="status">
          <Text size="sm">{removed}</Text>
        </div>
      )}
    </SettingsRow>
  );
}

type Tested = { ok: boolean; text: string };

/** The last Test, or the hub's later read of where the App is installed, and when it was. */
export const testWords = (test: NonNullable<GithubApp["lastTest"]>, nowMs: number): Tested => {
  const at = when(test.at, nowMs);
  const said = test.said.trim();
  return test.ok ? { ok: true, text: `${said} Checked ${at}.` } : { ok: false, text: `Failed ${at}: ${said}` };
};

/** What a change to the App changes: the App itself, and the GitHub step of Hub › Setup, whose row and page show it. */
const APP_READS = ["github_app_get", "setup_list"] as const;

/** The App as the hub keeps it: where it is installed, Install, Test and Remove. */
function AppStatus({ app, onRemoved }: { app: GithubApp; onRemoved: (line: string) => void }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const test = () => {
    setTesting(true);
    setProblem(null);
    hubCall("github_app_test", {}, { timeoutMs: 60_000 }).then(
      (_out: GithubAppTestOutput) => {
        setTesting(false);
        refetch(APP_READS);
      },
      (e: unknown) => {
        setTesting(false);
        setProblem(errorText(e));
      },
    );
  };
  const installs = app.installations ?? [];
  return (
    <SettingsRow
      title={app.name}
      label="GitHub App"
      hint="Its keys are sealed on the hub."
      line={`Owned by ${app.owner}. Created ${dayWords(app.createdAt)}.`}
      control={
        <Button size="sm" disabled={testing} onClick={test}>
          {testing ? "Testing…" : "Test"}
        </Button>
      }
    >
      <Installs app={app} />
      <div className={s.links}>
        <Button variant={installs.length === 0 ? "primary" : "secondary"} icon={<ExternalLink size={14} />} onClick={() => void window.fleetd.openExternal(installUrl(app))}>
          {installs.length === 0 ? "Install it on repositories" : "Install on more repositories"}
        </Button>
        <Button variant="ghost" icon={<ExternalLink size={14} />} onClick={() => void window.fleetd.openExternal(app.settingsUrl)}>
          Its settings on GitHub
        </Button>
        <Button variant="ghost" onClick={() => setRemoving(true)}>
          Remove
        </Button>
      </div>
      <LastTest app={app} />
      <ProblemLine text={problem} />
      {removing ? (
        <ConfirmRemove
          title={`Remove ${app.name} from the hub?`}
          description="The hub forgets the App and its keys, and goes back to each machine's own GitHub login. GitHub keeps the App until you delete it there."
          action="Remove"
          onRemove={() =>
            hubCall("github_app_remove", {}).then((out) => {
              onRemoved(`Removed from the hub. Delete it on GitHub too, under Advanced: ${out.settingsUrl}/advanced`);
              // The step, ConfirmRemove reads again itself.
              refetch(["github_app_get"]);
            })
          }
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </SettingsRow>
  );
}

/** Where the App is installed, or that it isn't yet. */
function Installs({ app }: { app: GithubApp }) {
  const installs = app.installations ?? [];
  return installs.length === 0 ? (
    <Text size="sm">Not installed yet: install it on the repositories fleetd works on, then Test.</Text>
  ) : (
    <ul className={s.list} aria-label="Installed on">
      {installs.map((i) => (
        <li key={i.installationId}>
          <Text size="sm">{reachWords(i)}</Text>
        </li>
      ))}
    </ul>
  );
}

function LastTest({ app }: { app: GithubApp }) {
  const nowMs = useNow(true, 60_000);
  return app.lastTest === undefined ? null : <TestLine tested={testWords(app.lastTest, nowMs)} />;
}

function ProblemLine({ text }: { text: string | null }) {
  return text === null ? null : (
    <div role="alert">
      <Text size="sm" tone="danger">
        {text}
      </Text>
    </div>
  );
}

/**
 * fleetd's App on a cloud team: where the team installed it, Install (after the person's own GitHub is connected,
 * which the team checks), Test and Remove. Read again whenever the window gets focus back, as from GitHub's page.
 */
function CloudApp({ app, me }: { app: GithubApp; me: GithubAccount | undefined }) {
  const { hub } = useDataLayer();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState<"test" | "install" | "connect" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The team said the person's own GitHub isn't connected, whatever the last read said.
  const [connectFirst, setConnectFirst] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removed, setRemoved] = useState<string | null>(null);
  useEffect(() => {
    const again = () => refetch(["github_app_get"]);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [refetch]);
  const installs = app.installations ?? [];
  const connect = me === undefined || me.lapsed === true || connectFirst;
  const test = () => {
    setBusy("test");
    setProblem(null);
    hubCall("github_app_test", {}, { timeoutMs: 60_000 }).then(
      () => {
        setBusy(null);
        refetch(["github_app_get"]);
      },
      (e: unknown) => {
        setBusy(null);
        setProblem(errorText(e));
      },
    );
  };
  const install = async () => {
    setBusy("install");
    setProblem(null);
    setRemoved(null);
    const out = await window.fleetd.cloud.installGithub(hub);
    setBusy(null);
    if (out.ok) return;
    if (out.connectFirst === true) setConnectFirst(true);
    setProblem(out.connectFirst === true ? out.failure.message : errorText(new CallError(out.failure)));
  };
  const connectGithub = async () => {
    setBusy("connect");
    setProblem(null);
    const out = await window.fleetd.github.connect(hub).catch((e: unknown) => ({ ok: false as const, error: { code: "failed", message: errorText(e) } }));
    setBusy(null);
    if (!out.ok) {
      if (out.error.code !== "cancelled") setProblem(errorText(new CallError(out.error)));
      return;
    }
    setConnectFirst(false);
    refetch(["github_app_get"]);
  };
  return (
    <SettingsRow
      title={app.name}
      label="GitHub App"
      control={
        installs.length === 0 ? null : (
          <Button size="sm" disabled={busy !== null} onClick={test}>
            {busy === "test" ? "Testing…" : "Test"}
          </Button>
        )
      }
    >
      {installs.length === 0 ? null : <Installs app={app} />}
      <div className={s.links}>
        {busy === "connect" ? (
          <Button variant="ghost" onClick={() => void window.fleetd.github.cancel()}>
            Cancel
          </Button>
        ) : null}
        {connect ? (
          <Button variant="primary" disabled={busy !== null} onClick={() => void connectGithub()}>
            {busy === "connect" ? "Waiting for GitHub…" : "Connect GitHub"}
          </Button>
        ) : (
          <Button variant={installs.length === 0 ? "primary" : "secondary"} icon={<ExternalLink size={14} />} disabled={busy !== null} onClick={() => void install()}>
            {installs.length === 0 ? "Install it on repositories" : "Install on more repositories"}
          </Button>
        )}
        {installs.length === 0 ? null : (
          <Button variant="ghost" onClick={() => setRemoving(true)}>
            Remove
          </Button>
        )}
      </div>
      <LastTest app={app} />
      <ProblemLine text={problem} />
      {removed === null ? null : (
        <div role="status" className={s.links}>
          <Text size="sm">Taken off this team.</Text>
          <Button variant="ghost" icon={<ExternalLink size={14} />} onClick={() => void window.fleetd.openExternal(removed)}>
            Uninstall on GitHub
          </Button>
        </div>
      )}
      {removing ? (
        <ConfirmRemove
          title="Take GitHub off this team?"
          description="Agents stop working on its repositories. It stays installed on GitHub until you uninstall it there."
          action="Remove"
          onRemove={() =>
            hubCall("github_app_remove", {}).then((out) => {
              setRemoved(out.settingsUrl);
              refetch(["github_app_get"]);
            })
          }
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </SettingsRow>
  );
}

function TestLine({ tested }: { tested: Tested }) {
  return (
    <div role={tested.ok ? "status" : "alert"}>
      <Text size="sm" tone={tested.ok ? "success" : "warning"} className={s.tested}>
        {tested.ok ? <Check size={14} aria-hidden /> : null}
        {tested.text}
      </Text>
    </div>
  );
}

type Owner = "me" | "org";

/** Creating the App: where it lives, its name, what it asks for, and the button that takes the admin to GitHub. */
function Create({ info }: { info: GithubAppGetOutput }) {
  const { hub } = useDataLayer();
  const { label } = useHub();
  const state = useHubState();
  const refetch = useRefetch();
  const [owner, setOwner] = useState<Owner>("me");
  const [org, setOrg] = useState("");
  const [name, setName] = useState(() => appName(label, state.phase === "unpaired" ? "" : state.hub));
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const orgIssue = owner === "org" && org.trim() !== "" && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(org.trim()) ? "An organization's login, as in github.com/<login>." : null;
  const nameIssue = name.trim().length > 34 ? "GitHub takes 34 characters at most." : null;
  const ready = name.trim() !== "" && nameIssue === null && (owner === "me" || (org.trim() !== "" && orgIssue === null));
  const create = async () => {
    setWaiting(true);
    setProblem(null);
    setMade(null);
    const out = await window.fleetd.github
      .createApp(hub, { name: name.trim(), ...(owner === "org" ? { organization: org.trim() } : {}) })
      .catch((e: unknown) => ({ ok: false as const, error: { code: "failed", message: errorText(e) } }));
    setWaiting(false);
    if (!out.ok) {
      if (out.error.code !== "cancelled") setProblem(errorText(new CallError(out.error)));
      return;
    }
    setMade("Created. Now install it on the repositories fleetd works on, above.");
    refetch(APP_READS);
  };
  const fresh = info.app === undefined;
  const [open, setOpen] = useState(fresh);
  // Why Create can't be pressed yet, when the fields don't already say.
  const why = waiting || ready ? undefined : name.trim() === "" ? "Name it first, above." : owner === "org" && org.trim() === "" ? "Name the organization first, above." : "Fix what's marked above first.";
  return (
    <SettingsSection
      title={fresh ? "Create the App" : "Replace it with a new App"}
      hint={fresh ? "On your GitHub account or an organization you administer." : "A new App replaces this one on the hub; delete the old one on GitHub."}
      aside={
        fresh ? undefined : (
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide steps" : "Show steps"}
          </Button>
        )
      }
    >
      {open || fresh ? (
        <>
          <SettingsRow
            title="Where it lives"
            hint="App names are unique on GitHub: if this one is taken, GitHub asks for another on its form."
            control={
              <Segmented<Owner>
                label="Owner"
                options={[
                  { value: "me", label: "My account" },
                  { value: "org", label: "An organization" },
                ]}
                value={owner}
                disabled={waiting}
                onChange={setOwner}
              />
            }
          >
            <div className={s.fields}>
              {owner === "org" ? (
                <Field label="Organization" error={orgIssue}>
                  <Input mono aria-label="Organization" value={org} disabled={waiting} autoComplete="off" spellCheck={false} placeholder="acme" onChange={(e) => setOrg(e.target.value)} />
                </Field>
              ) : null}
              <Field label="Name" error={nameIssue}>
                <Input aria-label="Name" value={name} disabled={waiting} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>
          </SettingsRow>
          <SettingsRow title="What it asks for" hint="On each repository you install it on. It needs no webhooks: the hub polls GitHub, as the merge train already does.">
            <ul className={s.list} aria-label="Permissions">
              {info.permissions.map(([key, level]) => (
                <li key={key}>
                  <Text size="sm">{`${PERMISSION_WORDS[key] ?? key} (${level})`}</Text>
                </li>
              ))}
              <li>
                <Text size="sm" tone="quiet">
                  Webhooks: off
                </Text>
              </li>
            </ul>
          </SettingsRow>
          <SettingsRow
            title="Create it on GitHub"
            hint="GitHub opens in your browser with all of this filled in. Press Create GitHub App there; GitHub sends its keys to the hub, and you come back here to install it. No desktop app at hand? On the hub’s machine, fleetd github-app create does the same from a terminal."
            line={why ?? null}
            control={
              <>
                {waiting ? (
                  <Button size="sm" variant="ghost" onClick={() => void window.fleetd.github.cancel()}>
                    Cancel
                  </Button>
                ) : null}
                <Button size="sm" variant="primary" disabled={waiting || !ready} onClick={() => void create()}>
                  {waiting ? "Waiting for GitHub…" : fresh ? "Create GitHub App" : "Create a new App"}
                </Button>
              </>
            }
          >
            {problem === null ? null : (
              <div role="alert">
                <Text size="sm" tone="danger">
                  {problem}
                </Text>
              </div>
            )}
            {made === null ? null : (
              <div role="status">
                <Text size="sm" tone="success">
                  {made}
                </Text>
              </div>
            )}
          </SettingsRow>

        </>
      ) : null}
    </SettingsSection>
  );
}
