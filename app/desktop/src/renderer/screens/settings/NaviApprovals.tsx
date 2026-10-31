// A Navi's approvals (its Projects page, only for a project of kind assistant; W239): how its risky actions (sends,
// shares, a site it opens on its own for the first time, a final confirm on a site) are approved, the checker's model
// and effort, and the log of what ran without asking, each row linking to its line in the Navi's chat. Reads
// navi_approvals and profiles_list (the models); writes navi_approvals_set.
import { useState } from "react";
import type { AutoApproved, Effort, NaviApprovalMode, NaviApprovals, ProfileModel } from "../../../shared/contracts";
import { Button, Field, Radio, RadioGroup, Select, Text } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { shortClock } from "../chat/format";
import { prose } from "../inline/prose";
import { navigate } from "../shell/navigation";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { checkerLine, checkerModels, FLOORS, logWhy, MODES } from "./naviApprovalsModel";
import { Setting } from "./parts";
import { EFFORT_WORD } from "./profilesModel";
import s from "./settings.module.css";

type Ref = { machineId: string; projectId: string };

const EFFORTS: ReadonlyArray<Effort> = ["low", "medium", "high", "xhigh", "max"];
const noInput = {};

export function ApprovalsSetting({ projectRef }: { projectRef: Ref }) {
  const live = useLive();
  const read = useToolQuery("navi_approvals", projectRef, { enabled: live });
  const profiles = useToolQuery("profiles_list", noInput, { enabled: live });
  const models = profiles.data?.models ?? [];
  const data = read.data;
  return (
    <>
      <Setting
        reveal="projects.approvals"
        label="Approvals"
        help="What Navi does without asking you: its sends, replies, shares and invites, a site it opens on its own for the first time, and the final Confirm on a site. Its own commands never ask."
      >
        {data === undefined ? (
          <Text size="sm" tone="quiet">
            {read.error ? `Not read: ${errorText(read.error)}` : "Loading…"}
          </Text>
        ) : (
          <ModeEditor key={`${data.approvals.mode}:${data.approvals.model}:${data.approvals.effort}`} projectRef={projectRef} saved={data.approvals} models={models} />
        )}
      </Setting>
      {data === undefined ? null : <ApprovedLog projectRef={projectRef} log={data.log} />}
    </>
  );
}

function ModeEditor({ projectRef, saved, models }: { projectRef: Ref; saved: NaviApprovals; models: ReadonlyArray<ProfileModel> }) {
  const live = useLive();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = (mode: NaviApprovalMode, model: string | undefined, effort: Effort | undefined) => {
    setBusy(true);
    setProblem(null);
    hubCall("navi_approvals_set", { ...projectRef, mode, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }).then(
      () => {
        setBusy(false);
        refetch(["navi_approvals"]);
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };
  // Picking a mode keeps the checker's model and effort as the person set them; the defaults stay the hub's.
  const keep = (mode: NaviApprovalMode) => save(mode, saved.defaults ? undefined : saved.model, saved.defaults ? undefined : saved.effort);
  return (
    <div className={s.stack}>
      <RadioGroup className={s.modes} value={saved.mode} disabled={!live || busy} onValueChange={(v) => keep(v as NaviApprovalMode)} aria-label="Approval mode">
        {MODES.map((m) => (
          <Radio key={m.mode} value={m.mode} label={m.label} description={m.description} />
        ))}
      </RadioGroup>
      {saved.mode === "checker" ? (
        <div className={s.inline}>
          <Field label="Checker model">
            <Select
              aria-label="Checker model"
              value={saved.model}
              disabled={!live || busy}
              options={checkerModels(models, saved.model).map((m) => ({ value: m.id, label: m.displayName ?? m.id, textValue: m.displayName ?? m.id }))}
              onValueChange={(model) => save(saved.mode, model, saved.effort)}
            />
          </Field>
          <Field label="Effort">
            <Select<Effort>
              aria-label="Checker effort"
              value={saved.effort}
              disabled={!live || busy}
              options={EFFORTS.map((e) => ({ value: e, label: EFFORT_WORD[e] }))}
              onValueChange={(effort) => save(saved.mode, saved.model, effort)}
            />
          </Field>
          {saved.defaults ? null : (
            <Button variant="ghost" disabled={!live || busy} onClick={() => save(saved.mode, undefined, undefined)}>
              Use the default
            </Button>
          )}
        </div>
      ) : null}
      {saved.mode === "checker" ? (
        <Text size="xs" tone="quiet">{`Runs on your own Claude: ${checkerLine(models, saved)}. It sees the action and where each part came from, never the mail or pages Navi read.`}</Text>
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
    <Setting reveal="projects.approved" label="Ran without asking" help="Each action the checker let through, or YOLO ran, newest first, with why. Show in chat opens its line.">
      {log.length === 0 ? (
        <Text size="sm" tone="quiet">
          Nothing yet.
        </Text>
      ) : (
        <ul className={s.approvedLog} aria-label="Ran without asking">
          {log.map((e, i) => (
            <li key={`${e.at}-${String(i)}`} className={s.approvedRow}>
              <Text size="xs" tone="quiet" tabular className={s.approvedAt}>
                {shortClock(e.at)}
              </Text>
              <div className={s.approvedText}>
                <Text size="sm">{prose(e.what)}</Text>
                <Text size="xs" tone="quiet">
                  {logWhy(e)}
                </Text>
              </div>
              {e.messageId === undefined ? null : (
                <Button variant="ghost" size="sm" onClick={() => navigate({ id: "project", project: projectRef, message: e.messageId ?? null })}>
                  Show in chat
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Setting>
  );
}
