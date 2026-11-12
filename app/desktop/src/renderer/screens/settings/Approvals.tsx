// A project's approvals (its Projects page; W239): how its lead's risky actions (sends, shares, a site it opens on its
// own for the first time, a final confirm on a site) are approved, and the log of what ran without asking, each row
// linking to its line in the project's chat: the newest few, repeats folded, and Show all for the rest in a bounded
// list that reads older pages as it scrolls (W601). The checker runs on the hub's default model (W467). Reads
// project_approvals; writes project_approvals_set.
import { useState, type UIEvent } from "react";
import type { ApprovalMode, ProjectApprovals, ProjectApprovalsOutput } from "../../../shared/contracts";
import { Button, Radio, RadioGroup, Text } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { shortClock } from "../chat/format";
import { prose } from "../inline/prose";
import { navigate } from "../shell/navigation";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { FLOORS, logWhy, MODES } from "./approvalsModel";
import { addPage, FIRST_PAGE, fold, hasMore, PAGE, SHOWN, showAllWord, timesWord, type LogRow, type Pages } from "./approvedLog";
import { PROJECT_TOOLS } from "../projects/model";
import { HintLines, SettingsList, SettingsListRow, SettingsRow } from "./parts";
import s from "./settings.module.css";

type Ref = { machineId: string; projectId: string };

export function ApprovalsSetting({ projectRef }: { projectRef: Ref }) {
  const live = useLive();
  const read = useToolQuery(PROJECT_TOOLS.approvals, { ...projectRef, limit: FIRST_PAGE }, { enabled: live });
  const data = read.data;
  return (
    <>
      <SettingsRow
        reveal="projects.approvals"
        title="Approvals"
        hint={<HintLines lines={["When the lead asks you before it sends, shares or confirms.", ...MODES.map((m) => [m.label, m.description] as const), FLOORS]} />}
      >
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
      {data === undefined ? null : <ApprovedLog projectRef={projectRef} first={data} />}
    </>
  );
}

function ModeEditor({ projectRef, saved }: { projectRef: Ref; saved: ProjectApprovals }) {
  const live = useLive();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = (mode: ApprovalMode) => {
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
      <RadioGroup className={s.modes} value={saved.mode} disabled={!live || busy} onValueChange={(v) => save(v as ApprovalMode)} aria-label="Approval mode">
        {MODES.map((m) => (
          <Radio key={m.mode} value={m.mode} label={m.label} />
        ))}
      </RadioGroup>
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

function ApprovedLog({ projectRef, first }: { projectRef: Ref; first: ProjectApprovalsOutput }) {
  // What Show all holds: the first page as it was when opened, then each older page read after it.
  const [all, setAll] = useState<Pages | null>(null);
  const rows = fold(first.log);
  const more = hasMore(rows, first.older);
  return (
    <SettingsRow
      reveal="projects.approved"
      title="Ran without asking"
      hint="Each action the checker let through, or YOLO ran, newest first, with why. Show in chat opens its line."
      line={first.log.length === 0 ? "Nothing yet." : null}
      control={
        more ? (
          <Button variant="ghost" aria-expanded={all !== null} onClick={() => setAll(all === null ? { log: first.log, older: first.older } : null)}>
            {all === null ? showAllWord(first.total) : "Show fewer"}
          </Button>
        ) : undefined
      }
    >
      {first.log.length === 0 ? null : all === null ? (
        <LogList projectRef={projectRef} rows={rows.slice(0, SHOWN)} />
      ) : (
        <AllLog projectRef={projectRef} pages={all} onPage={(page) => setAll((now) => (now === null ? now : addPage(now, page)))} />
      )}
    </SettingsRow>
  );
}

/** The whole log in a bounded list: an older page reads as it scrolls near its end, or with Show older. */
function AllLog({ projectRef, pages, onPage }: { projectRef: Ref; pages: Pages; onPage: (page: Pages) => void }) {
  const hubCall = useHubCall();
  const live = useLive();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const older = pages.older;
  const load = () => {
    if (older === undefined || busy || !live) return;
    setBusy(true);
    setProblem(null);
    hubCall(PROJECT_TOOLS.approvals, { ...projectRef, limit: PAGE, before: older }).then(
      (page) => {
        setBusy(false);
        onPage({ log: page.log, older: page.older });
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };
  const nearEnd = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (problem === null && el.scrollTop + el.clientHeight >= el.scrollHeight - 160) load();
  };
  return (
    <div className={s.logAll} onScroll={nearEnd}>
      <LogList projectRef={projectRef} rows={fold(pages.log)} />
      {older === undefined ? null : (
        <div className={s.inline}>
          <Button variant="ghost" disabled={busy || !live} onClick={load}>
            Show older
          </Button>
          {problem === null ? null : (
            <Text size="sm" tone="danger">
              {problem}
            </Text>
          )}
        </div>
      )}
    </div>
  );
}

function LogList({ projectRef, rows }: { projectRef: Ref; rows: ReadonlyArray<LogRow> }) {
  return (
    <SettingsList label="Ran without asking">
      {rows.map(({ entry: e, count }, i) => (
        <SettingsListRow
          key={`${e.at}-${String(i)}`}
          label={e.what}
          name={prose(e.what)}
          meta={timesWord(count)}
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
  );
}
