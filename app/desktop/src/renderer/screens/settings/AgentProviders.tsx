// Settings › Hub › Providers (#/settings/hub/providers): what agents run on, one row per provider (shared/
// agentProviders.ts), each with how it is connected beside its name, the models it offers under it, its one action and
// Add profile at its end, and under it the task profiles that run on it (Profiles.tsx), each opening its editor in its
// place; one whose provider isn't connected says it can't be used until it is. A row opens its setup under it: Anthropic's is the hub's Claude API key (admin/Claude.tsx, the same
// controls Setup's Claude step holds); Google's is a sign-in on each machine agents run on (GoogleSignIn.tsx), the team's
// Gemini API key, and the bots whose Vault holds a key of their own, which wins there. A link to Google's setup (a model
// picker's Sign in with Google, a search) lands with Google's row open. Every row reads the same way: a provider fleetd
// adds is one more entry in AGENT_PROVIDERS and its setup here.
import { Fragment, useState, type ReactNode } from "react";
import type { Person, ProfileModel } from "../../../shared/contracts";
import { AGENT_PROVIDERS, googleConnected, googleWords, runsWords, type AgentProvider, type AgentProviderId } from "../../../shared/agentProviders";
import { useToolQuery } from "../../src/data/react";
import { Button, Text } from "../../ui";
import { ClaudeAdmin } from "../admin/Claude";
import { AntigravityRow, GeminiKeyRow, useGoogle, useMachineName } from "./GoogleSignIn";
import { errorText, useLive } from "./hub";
import { AddButton, GroupNote, PageHead, SettingsList, SettingsListRow, SettingsRow, SettingsSection, useProjects, type Mark } from "./parts";
import { ProviderProfiles, type Editing } from "./Profiles";
import { useWanted } from "./reveal";
import s from "./settings.module.css";

const noInput = {};

/** The reveal key of each provider's row: a link or a search for it opens it. */
const revealOf = (id: AgentProviderId): string => `hub.providers.${id}`;

/** Where Anthropic's models come from, on its row's hover, while the hub has no Claude API key to list them. */
const BUILTIN = " The models offered are fleetd's own list until a Claude API key is saved in Setup.";

/** One provider's row at rest: how it is connected, its state as a dot, and its one action. */
type RowView = { words: string; mark: Mark; action?: ReactNode };

export function ProvidersPage({ me }: { me: Person | undefined }) {
  const live = useLive();
  const wanted = useWanted();
  const asked = (key: string | null) => AGENT_PROVIDERS.find((p) => revealOf(p.id) === key)?.id;
  const [open, setOpen] = useState<AgentProviderId | undefined>(() => asked(wanted));
  // A link that arrives while the page is up opens its row too.
  const [seen, setSeen] = useState(wanted);
  if (wanted !== seen) {
    setSeen(wanted);
    const hit = asked(wanted);
    if (hit !== undefined) setOpen(hit);
  }
  // Sign in with Google on the row: the row opens, and with one machine to sign in, its sign-in starts.
  const [signing, setSigning] = useState(false);
  const profiles = useToolQuery("profiles_list", noInput, { enabled: live });
  const models = profiles.data?.models ?? [];
  // One profile's editor open on the page at a time, and what the hub said of the last change.
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [echo, setEcho] = useState<string | undefined>(undefined);
  const edit = (next: Editing) => (setEcho(undefined), setEditing(next));
  const done = (said: string | undefined) => (setEditing(undefined), setEcho(said));
  const claude = useToolQuery("claude_accounts_get", noInput, { enabled: live }).data;
  const google = useGoogle();
  const name = useMachineName();
  const projects = useProjects();
  const connected = googleConnected(google.status);
  const unsigned = google.machines.filter((m) => m.signedIn === undefined);

  const views: Record<AgentProviderId, RowView> = {
    anthropic: {
      words: [claude?.hubApi === undefined ? null : "API key", (claude?.people ?? []).some((p) => p.subscription !== undefined) ? "Subscriptions" : null].filter((w) => w !== null).join(" · ") || "Each machine's Claude sign-in",
      mark: "ready",
    },
    google: {
      words: googleWords(google.status) ?? (connected === "no" ? "Not connected" : "Sign in to check"),
      mark: connected === "yes" ? "ready" : connected === "no" ? "off" : "needs",
      ...(connected === "yes" || google.machines.length === 0
        ? {}
        : {
            action: (
              <Button
                size="sm"
                disabled={!live}
                onClick={() => {
                  setSigning(unsigned.length === 1);
                  setOpen("google");
                }}
              >
                Sign in with Google
              </Button>
            ),
          }),
    },
  };

  const setup = (id: AgentProviderId): ReactNode =>
    id === "anthropic" ? (
      <ClaudeAdmin me={me} />
    ) : (
      <SettingsSection title="Google" reveal="hub.providers.google" data={{ "data-provider-setup": "google" }}>
        {google.machines.map((m) => (
          <AntigravityRow key={m.machineId} machineId={m.machineId} title={name(m.machineId)} signedIn={m.signedIn} autoStart={signing && unsigned.length === 1 && unsigned[0]?.machineId === m.machineId} />
        ))}
        <GeminiKeyRow status={google.status} />
        {google.status === undefined || google.status.keyIn.length === 0 ? null : (
          <SettingsRow
            title="Bots with their own key"
            hint="Their agents on Google run on the GEMINI_API_KEY in the bot's Vault instead of the team's."
            line={google.status.keyIn.map((r) => projects?.find((p) => p.machineId === r.machineId && p.projectId === r.projectId)?.title ?? r.projectId).join(", ")}
            data={{ "data-row": "gemini-bots" }}
          />
        )}
      </SettingsSection>
    );

  // Each provider, its profiles under its row: a section of its own, its setup open under it.
  const provider = (p: AgentProvider, first: boolean) => {
    const id = p.id;
    const v = views[id];
    const runs = runsWords(models, id);
    const add =
      profiles.data === undefined || runs === "" ? null : (
        <AddButton label={`Add ${p.name} profile`} disabled={!live || (editing?.kind === "new" && editing.provider === id)} onClick={() => edit({ kind: "new", provider: id })} />
      );
    return (
      <Fragment key={id}>
        <SettingsSection reveal={first ? "hub.profiles" : undefined} data={{ "data-provider-group": id }}>
          <SettingsList label="Providers">
            <SettingsListRow
              name={p.name}
              label={p.name}
              mark={v.mark}
              meta={v.words}
              hint={runs === "" ? undefined : `Runs ${runs.replaceAll(" · ", ", ")}.${id === "anthropic" && profiles.data?.modelsFrom === "builtin" ? BUILTIN : ""}`}
              data={{ "data-provider": id }}
              open={{ onClick: () => (setSigning(false), setOpen(open === id ? undefined : id)) }}
              expanded={open === id}
              controls={
                v.action === undefined && add === null ? undefined : (
                  <>
                    {v.action}
                    {add}
                  </>
                )
              }
            >
              <ModelsLine models={models} provider={id} />
            </SettingsListRow>
          </SettingsList>
          {profiles.data === undefined ? null : (
            <ProviderProfiles provider={p} view={profiles.data} unusable={v.mark === "off"} editing={editing} onEdit={(pid) => edit({ kind: "edit", id: pid })} onDone={done} />
          )}
        </SettingsSection>
        {open === id ? setup(id) : null}
      </Fragment>
    );
  };
  return (
    <div className={s.scroll} data-screen="settings.hub.providers">
      <div className={s.column}>
        <PageHead title="Providers" />
        {profiles.error ? <GroupNote tone="danger">{`Profiles not read: ${errorText(profiles.error)}`}</GroupNote> : null}
        {AGENT_PROVIDERS.map((p, ix) => provider(p, ix === 0))}
        {echo === undefined ? null : (
          <GroupNote>
            <span role="status">{echo}</span>
          </GroupNote>
        )}
      </div>
    </div>
  );
}

/** How many models a row names under its provider; the row's hover names them all. */
const MODELS_SHOWN = 3;

/** The models a provider offers, quietly under its name: the first few, then how many more. */
function ModelsLine({ models, provider }: { models: ReadonlyArray<ProfileModel>; provider: AgentProviderId }) {
  const words = runsWords(models, provider, MODELS_SHOWN);
  return words === "" ? null : (
    <Text size="sm" tone="quiet" data-provider-models="">
      {words}
    </Text>
  );
}
