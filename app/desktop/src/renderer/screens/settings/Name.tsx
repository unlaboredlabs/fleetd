// Settings › You › General, Name: the name a hub's people and leads call you, changed in place. Enter or leaving the
// field saves it (person_name_set, whatever your role), Escape puts the saved name back, and what the hub refuses (an
// empty name) shows under the row's title with the field kept as typed. Every open app follows by the hub's own
// people.changed. You are a person on each hub, so with several hubs each has its row.
import { useRef, useState } from "react";
import { Input } from "../../ui";
import { HubScope, useHubs } from "../../src/data/react";
import { useHubRole } from "../admin/role";
import { errorText, useHubCall, useRefetch } from "./hub";
import { SettingsRow } from "./parts";
import s from "./settings.module.css";

/** The hub's own limit (person_name_set), an invite's too. */
const NAME_MAX = 80;

export function YourName() {
  const hubs = useHubs();
  return (
    <>
      {hubs.map((hub, i) => (
        <HubScope key={hub.id} hub={hub}>
          <NameRow title={hubs.length === 1 ? "Name" : `Name on ${hub.label}`} reveal={i === 0 ? "general.name" : undefined} />
        </HubScope>
      ))}
    </>
  );
}

/** Nothing until the hub says who this app acts as, and nothing on a hub from before people: it has no one to name. */
function NameRow(props: { title: string; reveal: string | undefined }) {
  const me = useHubRole().me;
  return me === undefined ? null : <NameField {...props} saved={me.name} />;
}

function NameField({ title, reveal, saved }: { title: string; reveal: string | undefined; saved: string }) {
  const call = useHubCall();
  const refetch = useRefetch();
  // What is typed and not the hub's yet; null shows the saved name.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The hub's name changed (ours saved, or a change made on another device): the field shows it.
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    setShown(saved);
    setDraft(null);
    setError(null);
  }
  // Escape leaves the field too, and that leaving saves nothing.
  const reverting = useRef(false);
  const save = () => {
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    if (draft === null || busy) return;
    if (draft.trim() === saved) {
      setDraft(null);
      setError(null);
      return;
    }
    setBusy(true);
    call("person_name_set", { name: draft })
      .then((out) => {
        // The hub's cleaned name stands until hub_info says it too.
        setDraft(out.person.name);
        setError(null);
        refetch(["hub_info", "people_list"]);
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <SettingsRow
      reveal={reveal}
      title={title}
      hint="What your teammates and the leads call you."
      line={error === null ? null : <span role="alert">{error}</span>}
      lineTone="danger"
      data={{ "data-your-name": "" }}
      control={
        <Input
          aria-label={title}
          aria-invalid={error === null ? undefined : true}
          className={s.nameField}
          value={draft ?? saved}
          maxLength={NAME_MAX}
          disabled={busy}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.preventDefault();
              reverting.current = true;
              setDraft(null);
              setError(null);
              e.currentTarget.blur();
            }
          }}
        />
      }
    />
  );
}
