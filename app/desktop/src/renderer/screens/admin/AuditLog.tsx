// Settings › Workspace › Audit log (#/settings/hub/audit): what was done in the workspace, newest first, by whom, on
// which bot or item, a hundred rows a page, as `audit_list` keeps it for a year. Filters by person, bot, kind and date
// over the table; Export writes every row they pick as CSV, the same file `fleetd audit --csv` writes
// (shared/auditCsv.ts). Never a value or chat content: the workspace keeps none in it.
import { useMemo, useState } from "react";
import type { AuditEvent, AuditListInput } from "../../../shared/contracts";
import { auditCsv } from "../../../shared/auditCsv";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useHub, useToolQuery } from "../../src/data/react";
import { Button, cx, Select, Text, toast, Tooltip } from "../../ui";
import { errorText, useHubCall, useLive } from "../settings/hub";
import { PageHead, useProjects } from "../settings/parts";
import { ALL, actorQuiet, exportName, fullTime, inputOf, KIND_GROUPS, NO_FILTERS, RANGES, whenText, type Filters, type Range } from "./auditModel";
import { usePeople } from "./usePeople";
import s from "../settings/settings.module.css";
import a from "./audit.module.css";

const PAGE = 100;
/** Export reads at most this many rows (a year of a busy workspace fits). */
const EXPORT_MAX = 200_000;

export function AuditLog() {
  const live = useLive();
  const hub = useHub();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // The range's start, fixed while the filters stay: a moving `since` would read the page again at every render.
  const [now, setNow] = useState(() => Date.now());
  const [before, setBefore] = useState<number[]>([]);
  const input = useMemo(() => inputOf(filters, now), [filters, now]);
  const older = before[before.length - 1];
  const page = useToolQuery(
    "audit_list",
    { ...input, limit: PAGE, ...(older === undefined ? {} : { before: older }) },
    { enabled: live, keepPrevious: true },
  );
  const set = (change: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...change }));
    setNow(Date.now());
    setBefore([]);
  };
  const rows = page.data?.events ?? [];
  const last = rows[rows.length - 1];
  const lacks = page.error instanceof CallError && lacksTool(page.error.error);
  const filtered = filters.person !== ALL || filters.bot !== ALL || filters.kind !== ALL || filters.range !== "any";
  return (
    <div className={s.scroll} data-screen="settings.hub.audit">
      <div className={cx(s.column, a.column)}>
        <PageHead title="Audit log" aside={lacks ? undefined : <ExportButton input={input} workspace={hub.label} disabled={!live || rows.length === 0} />} />
        {lacks ? (
          <Text tone="quiet">This workspace keeps no audit log yet: update fleetd on it.</Text>
        ) : (
          <>
            <FilterBar filters={filters} set={set} cloud={hub.cloud === true || hub.codePaired === true} />
            {page.isLoadingError ? (
              <Text tone="danger">{errorText(page.error)}</Text>
            ) : page.data === undefined ? (
              <Text tone="quiet">Loading…</Text>
            ) : rows.length === 0 ? (
              <Text tone="quiet" data-audit-empty>
                {filtered ? "Nothing matches these filters." : "Nothing yet."}
              </Text>
            ) : (
              <AuditTable rows={rows} now={now} />
            )}
            {before.length > 0 || page.data?.more === true ? (
              <div className={a.pager}>
                <Button size="sm" variant="ghost" disabled={before.length === 0} onClick={() => setBefore((b) => b.slice(0, -1))}>
                  Newer
                </Button>
                <Text size="sm" tone="quiet">
                  Page {before.length + 1}
                </Text>
                <Button size="sm" variant="ghost" disabled={page.data?.more !== true || last === undefined} onClick={() => last && setBefore((b) => [...b, last.n])}>
                  Older
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function FilterBar({ filters, set, cloud }: { filters: Filters; set: (f: Partial<Filters>) => void; cloud: boolean }) {
  const people = usePeople().data?.people;
  const projects = useProjects();
  const personOptions = useMemo(
    () => [{ value: ALL, label: "Everyone" }, ...[...(people ?? [])].sort((x, y) => x.name.localeCompare(y.name)).map((p) => ({ value: p.personId, label: p.name }))],
    [people],
  );
  const botOptions = useMemo(
    () => [{ value: ALL, label: "Every bot" }, ...[...(projects ?? [])].sort((x, y) => x.title.localeCompare(y.title)).map((p) => ({ value: p.projectId, label: p.title }))],
    [projects],
  );
  const kindOptions = useMemo(() => [{ value: ALL, label: "Everything" }, ...KIND_GROUPS.filter((g) => cloud || g.cloud !== true)], [cloud]);
  return (
    <div className={a.filters} role="group" aria-label="Filters">
      <Select aria-label="Person" value={filters.person} onValueChange={(person) => set({ person })} options={personOptions} className={a.filter} />
      <Select aria-label="Bot" value={filters.bot} onValueChange={(bot) => set({ bot })} options={botOptions} className={a.filter} />
      <Select aria-label="Kind" value={filters.kind} onValueChange={(kind) => set({ kind })} options={kindOptions} className={a.filter} />
      <Select<Range> aria-label="Date" value={filters.range} onValueChange={(range) => set({ range })} options={RANGES} className={a.filter} />
    </div>
  );
}

function AuditTable({ rows, now }: { rows: readonly AuditEvent[]; now: number }) {
  return (
    <div className={a.tableWrap}>
      <table className={a.table} data-audit-table>
        <colgroup>
          <col className={a.colWhen} />
          <col className={a.colWho} />
          <col />
          <col className={a.colBot} />
        </colgroup>
        <thead>
          <tr>
            <th>Time</th>
            <th>Who</th>
            <th>What</th>
            <th>Bot</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.n} data-audit-row={e.kind}>
              <td className={a.when}>
                <Tooltip content={fullTime(e.at)}>
                  <span>{whenText(e.at, now)}</span>
                </Tooltip>
              </td>
              <td className={cx(a.cut, actorQuiet(e) && a.quiet)} title={e.actor.name}>
                {e.actor.name}
              </td>
              <td title={e.summary}>
                <div className={a.what}>
                  <span className={a.summary}>{e.summary}</span>
                  {e.outcome === "ok" ? null : <span className={a.refused}>{e.outcome === "refused" ? "refused" : "failed"}</span>}
                </div>
              </td>
              <td className={cx(a.cut, a.quiet)} title={e.bot?.name}>
                {e.bot?.name ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every row the filters pick, newest first, as CSV: the pages read one after another, then saved as a file. */
function ExportButton({ input, workspace, disabled }: { input: AuditListInput; workspace: string; disabled: boolean }) {
  const call = useHubCall();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const all: AuditEvent[] = [];
      let before: number | undefined;
      for (;;) {
        const out = await call("audit_list", { ...input, limit: 500, ...(before === undefined ? {} : { before }) });
        all.push(...out.events);
        before = out.events[out.events.length - 1]?.n;
        if (!out.more || before === undefined || all.length >= EXPORT_MAX) break;
      }
      const url = URL.createObjectURL(new Blob([auditCsv(all)], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = exportName(workspace, Date.now());
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      toast({ title: "Export didn't finish", description: errorText(error), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="secondary" disabled={disabled || busy} onClick={() => void run()} data-audit-export>
      {busy ? "Exporting…" : "Export CSV"}
    </Button>
  );
}
