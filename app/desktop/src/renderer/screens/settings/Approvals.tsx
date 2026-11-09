// A project's approvals (its Projects page; W239): how its lead's risky actions (sends, shares, a site it opens on its
// own for the first time, a final confirm on a site) are approved, and the log of what ran without asking, each row
// linking to its line in the project's chat. The checker runs on the hub's default model (W467). Reads
// project_approvals; writes project_approvals_set.
import { useState } from "react";
import type { AutoApproved, NaviApprovalMode, NaviApprovals } from "../../../shared/contracts";
import { Button, Radio, RadioGroup, Text } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { shortClock } from "../chat/format";
import { prose } from "../inline/prose";
import { navigate } from "../shell/navigation";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { FLOORS, logWhy, MODES } from "./approvalsModel";
import { PROJECT_TOOLS } from "../projects/model";
import { SettingsList, SettingsListRow, SettingsRow } from "./parts";
import s from "./settings.module.css";

type Ref = { machineId: string; projectId: string };

export function ApprovalsSetting({ projectRef }: { projectRef: Ref }) {
  const live = useLive();
  const read = useToolQuery(PROJECT_TOOLS.approvals, projectRef, { enabled: live });
  const data = read.data;
  return (
    <>
      <SettingsRow reveal="projects.approvals" title="Approvals" line="When the lead asks you before it sends, shares or confirms.">
        {data === undefined && read.isError ? (
          // Plain words: the lookup's own error names the tool and the project, which mean nothing to the person.
          <div className={s.inline}>
            <Text size="sm" tone="danger">
              The approval settings couldn&apos;t be loaded.
            </Text>
            <Button disabled={!live || read.isFetching} onClick={() => void read.refetch()}>
              Try again
            </Button>
          </div>
        ) : data === undefined ? (
          <Text size="sm" tone="quiet">
            Loading…
          </Text>
        ) : (
          <ModeEditor key={data.approvals.mode} projectRef={projectRef} saved={data.approvals} />
        )}
      </SettingsRow>
      {data === undefined ? null : <ApprovedLog projectRef={projectRef} log={data.log} />}
    </>
  );
}

function ModeEditor({ projectRef, saved }: { projectRef: Ref; saved: NaviApprovals }) {
  const live = useLive();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = (mode: NaviApprovalMode) => {
    setBusy(true);
    setProblem(null);
    hubCall(PROJECT_TOOLS.approvalsSet, { ...projectRef, mode }).then(
      () => {
        setBusy(false);
        refetch([PROJECT_TOOLS.approvals]);
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };
  return (
    <div className={s.stack}>
      <RadioGroup className={s.modes} value={saved.mode} disabled={!live || busy} onValueChange={(v) => save(v as NaviApprovalMode)} aria-label="Approval mode">
        {MODES.map((m) => (
          <Radio key={m.mode} value={m.mode} label={m.label} description={m.description} />
        ))}
      </RadioGroup>
      {saved.mode === "checker" ? (
        <Text size="xs" tone="quiet">
          It sees the action, never the mail or pages the lead read.
        </Text>
      ) : null}
      <Text size="xs" tone="quiet">
        {FLOORS}
      </Text>
      {problem === null ? null : (
        <div role="alert">
          <Text size="sm" tone="danger">
            {problem}
          </Text>
        </div>
      )}
    </div>
  );
}

function ApprovedLog({ projectRef, log }: { projectRef: Ref; log: ReadonlyArray<AutoApproved> }) {
  return (
    <SettingsRow
      reveal="projects.approved"
      title="Ran without asking"
      line={`Each action the checker let through, or YOLO ran, newest first, with why. Show in chat opens its line.${log.length === 0 ? " Nothing yet." : ""}`}
    >
      {log.length === 0 ? null : (
        <SettingsList label="Ran without asking">
          {log.map((e, i) => (
            <SettingsListRow
              key={`${e.at}-${String(i)}`}
              label={e.what}
              name={prose(e.what)}
              controls={
                e.messageId === undefined ? undefined : (
                  <Button variant="ghost" onClick={() => navigate({ id: "project", project: projectRef, message: e.messageId ?? null })}>
                    Show in chat
                  </Button>
                )
              }
            >
              <Text size="sm" tone="quiet" tabular>
                {`${shortClock(e.at)} · ${logWhy(e)}`}
              </Text>
            </SettingsListRow>
          ))}
        </SettingsList>
      )}
    </SettingsRow>
  );
}
