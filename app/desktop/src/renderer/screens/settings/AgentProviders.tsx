// Settings › Hub › Providers (#/settings/hub/providers): what agents run on, one row per provider (shared/
// agentProviders.ts), each with how it is connected beside its name, the models it offers under it, and its one action
// at its end. A row opens its setup in its place: Anthropic's is the hub's Claude API key (admin/Claude.tsx, the same
// controls Setup's Claude step holds); Google's is a sign-in on each machine agents run on (GoogleSignIn.tsx) and the
// bots whose Vault holds a Gemini key, with Add key, which opens a bot's Vault. A link to Google's setup (a model
// picker's Sign in with Google, a search) lands with Google's row open. Every row reads the same way: a provider fleetd
// adds is one more entry in AGENT_PROVIDERS and its setup here.
import { useState, type ReactNode } from "react";
import type { Person, ProfileModel } from "../../../shared/contracts";
import { AGENT_PROVIDERS, googleConnected, googleWords, runsWords, type AgentProvider, type AgentProviderId } from "../../../shared/agentProviders";
import { useToolQuery } from "../../src/data/react";
import { Button, Menu, MenuContent, MenuItem, MenuTrigger, Text } from "../../ui";
import { ClaudeAdmin } from "../admin/Claude";
import { navigate } from "../shell/navigation";
import { AntigravityRow, useGoogle, useMachineName } from "./GoogleSignIn";
import { useLive } from "./hub";
import { PageHead, SettingsList, SettingsListRow, SettingsRow, SettingsSection, useProjects, type Mark } from "./parts";
import { useWanted } from "./reveal";
import s from "./settings.module.css";

const noInput = {};

/** The reveal key of each provider's row: a link or a search for it opens it. */
const revealOf = (id: AgentProviderId): string => `hub.providers.${id}`;

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
  const models = useToolQuery("profiles_list", noInput, { enabled: live }).data?.models ?? [];
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
        <SettingsRow
          title="Gemini API key"
          hint="A bot's agents on Google run on the GEMINI_API_KEY in its Vault, ahead of a sign-in."
          line={
            google.status === undefined || google.status.keyIn.length === 0
              ? undefined
              : google.status.keyIn.map((r) => projects?.find((p) => p.machineId === r.machineId && p.projectId === r.projectId)?.title ?? r.projectId).join(", ")
          }
          data={{ "data-row": "gemini-key" }}
          control={
            projects === undefined || projects.length === 0 ? undefined : (
              <Menu>
                <MenuTrigger asChild disabled={!live}>
                  <Button size="sm">Add key…</Button>
                </MenuTrigger>
                <MenuContent align="end">
                  {projects.map((p) => (
                    <MenuItem key={`${p.machineId}/${p.projectId}`} onSelect={() => navigate({ id: "settings", tab: "project-vault", for: `${p.machineId}/${p.projectId}` })}>
                      {`${p.title}'s Vault`}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            )
          }
        />
      </SettingsSection>
    );

  const row = (p: AgentProvider) => {
    const id = p.id;
    const v = views[id];
    return (
      <SettingsListRow
        key={id}
        name={p.name}
        label={p.name}
        mark={v.mark}
        meta={v.words}
        hint={runsWords(models, id) === "" ? undefined : `Runs ${runsWords(models, id).replaceAll(" · ", ", ")}.`}
        data={{ "data-provider": id }}
        open={{ onClick: () => (setSigning(false), setOpen(open === id ? undefined : id)) }}
        expanded={open === id}
        controls={v.action}
      >
        <ModelsLine models={models} provider={id} />
      </SettingsListRow>
    );
  };
  const at = AGENT_PROVIDERS.findIndex((p) => p.id === open);
  const before = at === -1 ? AGENT_PROVIDERS : AGENT_PROVIDERS.slice(0, at + 1);
  const after = at === -1 ? [] : AGENT_PROVIDERS.slice(at + 1);
  return (
    <div className={s.scroll} data-screen="settings.hub.providers">
      <div className={s.column}>
        <PageHead title="Providers" />
        <SettingsSection reveal="hub.providers">
          <SettingsList label="Providers">{before.map(row)}</SettingsList>
        </SettingsSection>
        {open === undefined ? null : setup(open)}
        {after.length === 0 ? null : (
          <SettingsSection>
            <SettingsList label="Providers">{after.map(row)}</SettingsList>
          </SettingsSection>
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
