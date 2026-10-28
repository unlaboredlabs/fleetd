// A Navi's sign-ins (its Projects page, only for a project of kind assistant): its browser keeps the sites it signed
// into between sessions, in a browser profile of its own on its machine that Navi itself can't read (D221). Forget
// sign-ins is navi_signins_forget, which ends its open browser session and deletes that profile; deleting the Navi
// deletes it too.
import { useState } from "react";
import { Button, Dialog, Text } from "../../ui";
import { useData } from "../../src/data/react";
import { errorText, useHubCall, useLive } from "./hub";
import { Setting } from "./parts";
import s from "./settings.module.css";

type Ref = { machineId: string; projectId: string };

/** Ending a browser session that is open, then deleting its profile, can take a while. */
const FORGET_MS = 60_000;

export function SigninsSetting({ projectRef }: { projectRef: Ref }) {
  const live = useLive();
  const machine = useData((d) => d.machines[projectRef.machineId]?.name) ?? projectRef.machineId;
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <Setting
      reveal="projects.signins"
      label="Sign-ins"
      help={`Navi's browser stays signed in to the sites it signed into, from one session to the next. Their cookies and site data are kept on ${machine}, where Navi itself can't read them; its history, cache and passwords are not kept.`}
    >
      <div className={s.inline}>
        <Button
          variant="danger"
          disabled={!live}
          onClick={() => {
            setDone(false);
            setAsking(true);
          }}
        >
          Forget sign-ins…
        </Button>
      </div>
      {done ? (
        <div role="status">
          <Text size="sm" tone="quiet">
            Forgotten. Its next browser session starts signed out of every site.
          </Text>
        </div>
      ) : null}
      {asking ? (
        <ForgetDialog
          projectRef={projectRef}
          machine={machine}
          onClose={(forgotten) => {
            setAsking(false);
            setDone(forgotten);
          }}
        />
      ) : null}
    </Setting>
  );
}

function ForgetDialog(props: { projectRef: Ref; machine: string; onClose: (forgotten: boolean) => void }) {
  const hubCall = useHubCall();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = () => {
    setBusy(true);
    setProblem(null);
    hubCall("navi_signins_forget", props.projectRef, { timeoutMs: FORGET_MS }).then(
      () => {
        setBusy(false);
        props.onClose(true);
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && props.onClose(false)}
      title="Forget sign-ins?"
      description={`Navi is signed out of every site, and its browser profile is deleted from ${props.machine}. A browser session it has open now ends. Its chat, memory, folder and allowed sites stay.`}
      footer={
        <>
          <Button onClick={() => props.onClose(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={go}>
            {busy ? "Forgetting…" : "Forget sign-ins"}
          </Button>
        </>
      }
    >
      {problem === null ? null : (
        <div role="alert">
          <Text tone="danger">{problem}</Text>
        </div>
      )}
    </Dialog>
  );
}
