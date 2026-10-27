// Navi (#/navi): your assistants. With none yet, what Navi is in a few lines and one button that makes the first;
// otherwise a box to name a new one, your Navis (each opens its chat) and the archived ones, each a click from coming
// back. A new Navi opens its chat once the hub has added it. Rename and archive are also in the sidebar's menu.
import { useEffect, useMemo, useState } from "react";
import { useData, useDataLayer } from "../../src/data/react";
import { selectProjects } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { Button, Field, FrameTitle, Input, Text } from "../../ui";
import { HubText } from "../projects/HubText";
import { navigate } from "../shell/navigation";
import { when } from "../status/view";
import { archiveNavi } from "./actions";
import { isArchived, isNavi, NAME_MAX, nameProblem } from "./model";
import type { ProjectSummary } from "../../../shared/contracts";
import s from "./navi.module.css";

/** What a new Navi is called when you leave the name empty. */
export const DEFAULT_NAME = "Navi";

const open = (p: ProjectSummary) => navigate({ id: "project", project: { machineId: p.machineId, projectId: p.projectId }, message: null });

export function NaviScreen() {
  const projects = useData(selectProjects);
  const navis = useMemo(() => projects?.filter((p) => isNavi(p)), [projects]);
  const active = navis?.filter((p) => !isArchived(p));
  const archived = navis?.filter(isArchived);
  const state = navis === undefined ? "navi.loading" : active?.length === 0 ? "navi.empty" : "navi";

  return (
    <div className={s.scroller} data-screen={state}>
      <FrameTitle title="Navi" />
      {active === undefined || archived === undefined ? null : (
        <div className={s.page}>
          {active.length === 0 ? (
            <section className={s.intro} aria-labelledby="navi-intro">
              <Text as="h2" id="navi-intro" size="xl" strong>
                Meet Navi
              </Text>
              <Text as="p" tone="quiet">
                Your own assistant, on your machines. Tell it what you need in a chat, as you would a person.
              </Text>
              <ul className={s.does}>
                <Text as="li">Reads your mail, keeps your calendar and finds things in your Drive and Notion.</Text>
                <Text as="li">Uses a browser for you, and remembers what matters from one day to the next.</Text>
                <Text as="li">Asks your projects’ leads for work, and tells you when it lands.</Text>
              </ul>
              <Text as="p" size="sm" tone="quiet">
                It never sends, posts, pays or deletes without asking you first, and shows you exactly what goes out.
              </Text>
            </section>
          ) : (
            <Text as="p" tone="quiet">
              Each Navi is an assistant of its own, with its own chat, memory and connections. Make one for each part of your life: home, work, taxes.
            </Text>
          )}
          <NewNavi first={active.length === 0} />
          {active.length === 0 ? null : <NaviList title="Your Navis" navis={active} />}
          {archived.length === 0 ? null : <NaviList title="Archived" navis={archived} />}
        </div>
      )}
    </div>
  );
}

/** The name box and the one button: an empty name makes a Navi called Navi. It opens once the hub has added it. */
function NewNavi({ first }: { first: boolean }) {
  const layer = useDataLayer();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix?: string | undefined } | null>(null);
  const [made, setMade] = useState<ProjectSummary | null>(null);
  const arrived = useData((d) => made !== null && projectKey(made) in d.projects);
  useEffect(() => {
    if (made !== null && arrived) open(made);
  }, [made, arrived]);
  const problem = nameProblem(name);
  const create = async () => {
    if (busy || problem !== undefined) return;
    setBusy(true);
    setError(null);
    const out = await layer.call("navi_create", { name: name.trim() === "" ? DEFAULT_NAME : name.trim() });
    if (!out.ok) {
      setBusy(false);
      setError({ message: out.error.message, fix: out.error.fix });
      return;
    }
    setMade(out.output.navi);
  };
  const label = busy ? "Creating…" : first ? "Create your Navi" : "New Navi";
  return (
    <form
      className={s.group}
      aria-label="New Navi"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className={s.new}>
        <Field label={first ? "What will you call it?" : "A new Navi"} error={problem}>
          <Input value={name} placeholder={DEFAULT_NAME} maxLength={NAME_MAX + 1} autoComplete="off" disabled={busy} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || problem !== undefined}>
          {label}
        </Button>
      </div>
      {error === null ? null : (
        <div role="alert">
          <Text size="sm" tone="danger">
            <HubText>{error.message}</HubText>
          </Text>
          {error.fix === undefined ? null : (
            <Text as="p" size="sm" tone="quiet">
              <HubText>{error.fix}</HubText>
            </Text>
          )}
        </div>
      )}
    </form>
  );
}

function NaviList({ title, navis }: { title: string; navis: readonly ProjectSummary[] }) {
  const layer = useDataLayer();
  const machines = useData((d) => d.machines);
  // Read when the list changes; dates are day-grained, so nothing ticks.
  const [now] = useState(() => Date.now());
  return (
    <section className={s.group} aria-label={title}>
      <Text as="h3" size="xs" tone="quiet">
        {title}
      </Text>
      <ul className={s.rows}>
        {navis.map((p) => {
          const machine = machines[p.machineId]?.name ?? p.machineId;
          const gone = isArchived(p);
          const detail = gone && p.archivedAt !== undefined ? `Archived ${when(p.archivedAt, now)} · on ${machine}` : `On ${machine}`;
          return (
            <li key={projectKey(p)} className={s.row}>
              {gone ? (
                <div className={s.rowText}>
                  <Text tone="quiet">{p.title}</Text>
                  <Text size="xs" tone="quiet">
                    {detail}
                  </Text>
                </div>
              ) : (
                <button type="button" className={s.open} onClick={() => open(p)}>
                  <Text className={s.name}>{p.title}</Text>
                  <Text size="xs" tone="quiet">
                    {detail}
                  </Text>
                </button>
              )}
              {gone ? (
                <Button variant="secondary" size="sm" onClick={() => void archiveNavi(layer, p, false)}>
                  Bring back
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
