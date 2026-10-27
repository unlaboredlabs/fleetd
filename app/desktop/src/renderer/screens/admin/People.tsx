// Administration → People: everyone on the hub, with their role and devices. An owner or admin changes a role in place
// (person_set) or removes someone (person_remove, once confirmed: their devices are signed out at once). What a row
// offers comes from model.ts; the hub checks it all again. Below them, every hub link minted here, which acts as its
// person (hubLinks/AllLinks.tsx).
import { useState } from "react";
import type { HubRole, PeopleListOutput, Person } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { Button, Dialog, Select, Text } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { PageHead } from "../settings/parts";
import { setUpdatesOpen } from "../updates/state";
import { AllLinks } from "../hubLinks/AllLinks";
import { devicesLine, peopleRows, roleWord, type PersonRow } from "./model";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

const noInput = {};

/** The hub's people, devices and open invites: one read, shared by People and Invites. */
export const usePeople = () => {
  const live = useLive();
  return useToolQuery("people_list", noInput, { enabled: live });
};

/** A hub from before people answers that it has no such tool: it needs updating, not a retry. */
export const lacksPeople = (error: unknown): boolean => error instanceof CallError && lacksTool(error.error);

/** In place of People and Invites on a hub from before people; Hub settings still works there. */
export function NeedsUpdate() {
  return (
    <div className={s.stack}>
      <Text tone="quiet">This hub needs updating to manage people. Hub settings work as they are.</Text>
      <span>
        <Button onClick={() => setUpdatesOpen(true)}>Update the hub</Button>
      </span>
    </div>
  );
}

export function People({ me }: { me: Person | undefined }) {
  const live = useLive();
  const read = usePeople();
  return (
    <div className={s.scroll} data-screen="admin.people">
      <div className={s.column}>
        <PageHead title="People">Who is on this hub. Each person's devices act as them; removing someone signs all of them out.</PageHead>
        {!live ? (
          <Text tone="quiet">Connect to a hub to see and change this.</Text>
        ) : lacksPeople(read.error) ? (
          <NeedsUpdate />
        ) : read.error ? (
          <Text tone="danger">{`Couldn't read the people: ${errorText(read.error)}`}</Text>
        ) : read.data === undefined ? (
          <Text tone="quiet">Loading…</Text>
        ) : (
          <PeopleList list={read.data} me={me} />
        )}
        <AllLinks />
      </div>
    </div>
  );
}

function PeopleList({ list, me }: { list: PeopleListOutput; me: Person | undefined }) {
  const [removing, setRemoving] = useState<PersonRow | null>(null);
  const rows = peopleRows(list, me);
  return (
    <>
      <div className={a.list} role="list" aria-label="People">
        {rows.map((row) => (
          <PersonLine key={row.person.personId} row={row} onRemove={() => setRemoving(row)} />
        ))}
      </div>
      <RemoveDialog row={removing} onClose={() => setRemoving(null)} />
    </>
  );
}

function PersonLine({ row, onRemove }: { row: PersonRow; onRemove: () => void }) {
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const p = row.person;
  const setRole = (role: HubRole) => {
    if (role === p.role) return;
    setBusy(true);
    setError(undefined);
    call("person_set", { personId: p.personId, role })
      .then(() => refetch(["people_list", "hub_info"]))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  const devices = row.devices.map((d) => d.name).join(", ");
  return (
    <div className={a.row} role="listitem" aria-label={p.name}>
      <div className={a.who}>
        <div className={a.name}>
          <Text strong>{p.name}</Text>
          {row.you ? (
            <Text size="xs" tone="quiet">
              you
            </Text>
          ) : null}
        </div>
        <Text size="xs" tone="quiet">
          {row.invited ? "Invited, not joined yet" : devices === "" ? devicesLine(0) : `${devicesLine(row.devices.length)}: ${devices}`}
        </Text>
        {row.why ? (
          <Text size="xs" tone="quiet">
            {row.why}
          </Text>
        ) : null}
        {error === undefined ? null : (
          <p role="alert" className={s.alertLine}>
            <Text size="xs" tone="danger">{`Not changed: ${error}`}</Text>
          </p>
        )}
      </div>
      <div className={a.controls}>
        {row.roles.length === 0 ? (
          <Text size="sm" tone="quiet">
            {roleWord(p.role)}
          </Text>
        ) : (
          <Select
            aria-label={`${p.name}'s role`}
            className={a.role}
            value={p.role}
            options={row.roles.map((r) => ({ value: r, label: roleWord(r) }))}
            disabled={!live || busy}
            onValueChange={setRole}
          />
        )}
        {row.removable ? (
          <Button size="sm" variant="ghost" disabled={!live || busy} onClick={onRemove}>
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Asks before removing someone: their devices are signed out at once, and what they did keeps their name. */
function RemoveDialog({ row, onClose }: { row: PersonRow | null; onClose: () => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const name = row?.person.name ?? "";
  const n = row?.devices.length ?? 0;
  const close = () => {
    setError(undefined);
    onClose();
  };
  const remove = () => {
    if (row === null) return;
    setBusy(true);
    setError(undefined);
    call("person_remove", { personId: row.person.personId })
      .then(() => {
        refetch(["people_list", "hub_info"]);
        close();
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => !open && close()}
      title={`Remove ${name}?`}
      description={`${n === 0 ? "They have no device yet, and their open invites close." : `Their ${devicesLine(n).toLowerCase()} ${n === 1 ? "is" : "are"} signed out at once.`} What they did keeps their name.`}
      footer={
        <>
          {error === undefined ? null : (
            <p role="alert" className={s.alertLine}>
              <Text size="xs" tone="danger">
                {error}
              </Text>
            </p>
          )}
          <Button onClick={close}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={remove}>
            {`Remove ${name}`}
          </Button>
        </>
      }
    />
  );
}
