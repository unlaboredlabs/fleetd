// Settings › Hub accounts › GitHub: the hub's own GitHub App (D190), which does the hub's work on GitHub (the train's reads,
// rebases, statuses and merges, and the PR pages) on the repositories it is installed on. Create GitHub App goes
// through main (window.fleetd.github.createApp): it posts the hub's manifest to GitHub from a page on 127.0.0.1 and
// hands GitHub's code to github_app_create, so the App's keys go from GitHub to the hub and never to this computer.
// Then the admin installs it on repositories at GitHub, and Test (github_app_test) reads where it is installed with a
// token for each. Without an App, the hub's gh uses its machine's own login, as before.
import { Check, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { GithubApp, GithubAppGetOutput, GithubAppTestOutput, GithubInstallation } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useDataLayer, useHub, useToolQuery } from "../../src/data/react";
import { Button, Field, Input, Segmented, Separator, Text } from "../../ui";
import { useHubState } from "../onboarding/hooks";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { PagePart } from "../settings/parts";
import { ConfirmRemove } from "../settings/claudeParts";
import { Part } from "../setup/Guide";
import { dayWords, listWords } from "../google/model";
import s from "./github.module.css";
import settings from "../settings/settings.module.css";

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
  const read = useToolQuery("github_app_get", noInput, { enabled: live });
  // Said once the App's own section has gone with it.
  const [removed, setRemoved] = useState<string | null>(null);
  const intro =
    "The hub works on GitHub as an App of its own: the merge train's rebases, statuses and merges, and the PR pages. You create it here once, with nothing to paste; GitHub hands its keys straight to the hub.";
  if (!live || read.data === undefined) {
    const text = !live ? "Not connected. Connect to a hub to set up GitHub." : read.error !== null ? errorText(read.error) : "Loading…";
    const old = read.error instanceof CallError && lacksTool(read.error.error);
    return (
      <PagePart title="GitHub" reveal="admin.github" intro={intro}>
        <Text tone={read.error !== null && !old ? "danger" : "quiet"}>{old ? "This hub is too old for a GitHub App. Update fleetd on the hub first." : text}</Text>
      </PagePart>
    );
  }
  const app = read.data.app;
  return (
    <PagePart title="GitHub" reveal="admin.github" intro={intro}>
      {app === undefined ? <NoApp removed={removed} /> : <AppStatus app={app} onRemoved={setRemoved} />}
      <Separator />
      <Create info={read.data} />
    </PagePart>
  );
}

function NoApp({ removed }: { removed: string | null }) {
  return (
    <section aria-label="GitHub App" className={s.status}>
      <Text strong>No App yet</Text>
      <Text size="sm" tone="quiet">
        Until there is one, the hub uses gh as it is logged in on the hub&rsquo;s machine. Create the App below.
      </Text>
      {removed === null ? null : (
        <div role="status">
          <Text size="sm">{removed}</Text>
        </div>
      )}
    </section>
  );
}

type Tested = { ok: boolean; text: string };

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
        refetch(["github_app_get"]);
      },
      (e: unknown) => {
        setTesting(false);
        setProblem(errorText(e));
      },
    );
  };
  const last: Tested | null = app.lastTest === undefined ? null : { ok: app.lastTest.ok, text: app.lastTest.said };
  const installs = app.installations ?? [];
  return (
    <section aria-label="GitHub App" className={s.status}>
      <div className={s.head}>
        <div className={settings.stack}>
          <Text strong>{app.name}</Text>
          <Text size="xs" tone="quiet">
            {`Owned by ${app.owner}. Created ${dayWords(app.createdAt)}. Its keys are sealed on the hub.`}
          </Text>
        </div>
        <Button size="sm" disabled={testing} onClick={test}>
          {testing ? "Testing…" : "Test"}
        </Button>
      </div>
      {installs.length === 0 ? (
        <Text size="sm">Not installed yet: install it on the repositories fleetd works on, then Test.</Text>
      ) : (
        <ul className={s.list} aria-label="Installed on">
          {installs.map((i) => (
            <li key={i.installationId}>
              <Text size="sm">{reachWords(i)}</Text>
            </li>
          ))}
        </ul>
      )}
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
      {last === null ? null : <TestLine tested={last} />}
      {problem === null ? null : (
        <div role="alert">
          <Text size="sm" tone="danger">
            {problem}
          </Text>
        </div>
      )}
      {removing ? (
        <ConfirmRemove
          title={`Remove ${app.name} from the hub?`}
          description="The hub forgets the App and its keys, and its gh goes back to the machine's own login. GitHub keeps the App until you delete it there."
          action="Remove"
          onRemove={() =>
            hubCall("github_app_remove", {}).then((out) => {
              onRemoved(`Removed from the hub. Delete it on GitHub too, under Advanced: ${out.settingsUrl}/advanced`);
              refetch(["github_app_get"]);
            })
          }
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </section>
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
    refetch(["github_app_get"]);
  };
  const fresh = info.app === undefined;
  const steps = (
    <>
      <Part n={1} title="Where it lives">
        <div className={s.fields}>
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
        {owner === "org" ? (
          <Field label="Organization" error={orgIssue}>
            <Input mono aria-label="Organization" value={org} disabled={waiting} autoComplete="off" spellCheck={false} placeholder="acme" onChange={(e) => setOrg(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Name" error={nameIssue}>
          <Input aria-label="Name" value={name} disabled={waiting} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Text size="xs" tone="quiet">
          App names are unique on GitHub: if this one is taken, GitHub asks for another on its form.
        </Text>
        </div>
      </Part>
      <Part n={2} title="What it asks for, on each repository you install it on">
        <ul className={s.list} aria-label="Permissions">
          {info.permissions.map(([key, level]) => (
            <li key={key}>
              <Text size="sm">{`${PERMISSION_WORDS[key] ?? key} (${level})`}</Text>
            </li>
          ))}
          <li>
            <Text size="sm" tone="quiet">
              Webhooks: off. The hub polls GitHub, as the merge train already does.
            </Text>
          </li>
        </ul>
      </Part>
      <Part n={3} title="Create it on GitHub">
        <Text size="sm" tone="quiet">
          GitHub opens in your browser with all of this filled in. Press Create GitHub App there; GitHub sends its keys to the hub, and you come back here
          to install it.
        </Text>
        <div className={s.links}>
          <Button variant="primary" disabled={waiting || !ready} onClick={() => void create()}>
            {waiting ? "Waiting for GitHub…" : fresh ? "Create GitHub App" : "Create a new App"}
          </Button>
          {waiting ? (
            <Button variant="ghost" onClick={() => void window.fleetd.github.cancel()}>
              Cancel
            </Button>
          ) : null}
        </div>
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
      </Part>
    </>
  );
  const [open, setOpen] = useState(fresh);
  return (
    <section aria-label="Create the App" className={s.guide}>
      <details className={s.fold} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <Text size="sm" strong={fresh}>
            {fresh ? "Create the App" : "Replace it with a new App"}
          </Text>
          <Text size="xs" tone="quiet">
            {fresh ? "On your GitHub account or an organization you administer." : "A new App replaces this one on the hub; delete the old one on GitHub."}
          </Text>
        </summary>
        {steps}
      </details>
      <Text size="xs" tone="quiet">
        No desktop app at hand? On the hub&rsquo;s machine, <code>fleetd github-app create</code> does the same from a terminal.
      </Text>
    </section>
  );
}
