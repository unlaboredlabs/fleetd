// Settings › Hub › Machines' fleetd's computers, on a fleetd cloud team once they are on for it (Billing's answer):
// each bot that runs there, its computer awake or asleep and its agents at work (its avatar sleeps with it), with the
// size its agents get, a row opening the bot's Computer page where that is picked; how many run at once now of what the
// team's plan allows (the slot board's hosted limits, `providedHold`); and this period's computer time against what the
// plan includes, a row of the same list opening Billing. Every number is the cloud's: nothing here knows a price or a plan.
import { Gauge } from "lucide-react";
import { useMemo } from "react";
import type { ProjectSummary } from "../../../shared/contracts";
import { periodWord, sizeWord } from "../../../shared/billing";
import { atOnceWord, computerStateWord, heldLine, usedWord } from "../../../shared/provided";
import { RUNNER_ID } from "../../../shared/providers";
import { useData, useHub, useToolQuery } from "../../src/data/react";
import { Button, Text } from "../../ui";
import { useNow } from "../live";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import { GroupNote, SettingsList, SettingsListRow, SettingsSection } from "../settings/parts";
import { revealNext } from "../settings/search";
import { navigate } from "../shell/navigation";
import { toHash } from "../shell/routes";
import { useBilling } from "./billingQuery";
import g from "../settings/groups.module.css";

export function ProvidedComputers() {
  const hub = useHub();
  const billing = useBilling(hub.cloud === true).data;
  const nowMs = useNow(true, 60_000);
  const projects = useData((d) => d.projects);
  const bots = useMemo(
    () => Object.values(projects).filter((p) => p.machineId === RUNNER_ID && p.archivedAt === undefined).sort((a, b) => a.title.localeCompare(b.title)),
    [projects],
  );
  const slots = useData((st) => (st.fresh ? (st.live.slots ?? st.slots) : undefined));
  if (billing === undefined || !billing.providedOn) return null;
  const atOnce = slots === undefined ? undefined : atOnceWord(slots.hosted ?? []);
  const toBilling = () => navigate({ id: "settings", tab: "hub.billing", at: hub.id });
  return (
    <SettingsSection
      title="fleetd's computers"
      reveal="hub.provided"
      aside={
        atOnce === undefined || atOnce === null ? undefined : (
          <Text size="sm" tone="quiet" data-provided-at-once="">
            {atOnce}
          </Text>
        )
      }
      data={{ "data-provided": "" }}
    >
      {atOnce === null ? (
        <GroupNote
          tone="danger"
          action={
            <Button size="sm" onClick={toBilling}>
              Billing
            </Button>
          }
        >
          {heldLine(billing)}
        </GroupNote>
      ) : null}
      <SettingsList label="fleetd's computers">
        {bots.length === 0 ? <GroupNote>No bot runs here yet.</GroupNote> : null}
        {bots.map((p) => (
          <BotComputer key={p.projectId} project={p} running={slots?.perProject.find((x) => x.projectRef.projectId === p.projectId && x.projectRef.machineId === p.machineId)?.running} />
        ))}
        <SettingsListRow
          label="Computer time"
          name="Computer time"
          icon={<Gauge aria-hidden />}
          meta={periodWord(billing, nowMs)}
          controls={
            <span className={g.state}>
              <Text size="sm" tone="quiet">
                {usedWord(billing)}
              </Text>
            </span>
          }
          open={{ onClick: toBilling }}
          data={{ "data-provided-time": "" }}
        />
      </SettingsList>
    </SettingsSection>
  );
}

/** One bot on fleetd's computers: awake or asleep with its agents at work, the size its agents get; opens its Computer. */
function BotComputer({ project, running }: { project: ProjectSummary; running: number | undefined }) {
  const ref = { machineId: project.machineId, projectId: project.projectId };
  const key = `${project.machineId}/${project.projectId}`;
  const asleep = useData((d) => d.chatStates[key]?.leadAsleep === true);
  const pick = useToolQuery("project_settings_get", ref).data?.settings.computer;
  const state = computerStateWord(asleep, running);
  return (
    <SettingsListRow
      label={project.title}
      name={project.title}
      icon={<ProjectAvatar project={project} size={20} />}
      meta={pick === undefined ? "Automatic" : sizeWord(pick)}
      controls={
        <span className={g.state}>
          <Text size="sm" tone="quiet">
            {state}
          </Text>
        </span>
      }
      open={{
        onClick: () => {
          revealNext("projects.computer");
          window.location.hash = toHash({ id: "settings", tab: "projects", for: key });
        },
      }}
      data={{ "data-provided-bot": asleep ? "asleep" : "awake" }}
    />
  );
}
