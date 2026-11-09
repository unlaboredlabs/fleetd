// A project's sign-ins (its Projects page): its browser keeps the sites it signed into between sessions, in a browser
// profile of its own on its machine, never shared with another project. Forget sign-ins is project_signins_forget,
// which ends its open browser session and deletes that profile; deleting the project deletes it too. It is offered
// only while its machine says it keeps one (project_settings_get's signinsKept), or can't say. Its skills
// (Skills) are in its panel; the page links there.
import { useState } from "react";
import { Button, Dialog, Text } from "../../ui";
import { useData } from "../../src/data/react";
import { errorText, useHubCall, useLive } from "./hub";
import { navigate } from "../shell/navigation";
import { projectSkills } from "../shell/routes";
import { revealNext } from "./search";
import { DangerButton, SettingsRow } from "./parts";
import { PROJECT_TOOLS } from "../projects/model";

type Ref = { machineId: string; projectId: string };

/** Ending a browser session that is open, then deleting its profile, can take a while. */
const FORGET_MS = 60_000;

export function SigninsSetting({ projectRef, kept }: { projectRef: Ref; kept: boolean | undefined }) {
  const live = useLive();
  const machine = useData((d) => d.machines[projectRef.machineId]?.name) ?? projectRef.machineId;
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <SettingsRow
      reveal="projects.signins"
      title="Sign-ins"
      line={
        done ? (
          <span role="status">Forgotten. Its next browser session starts signed out of every site.</span>
        ) : (
          `Its browser stays signed in to the sites it signed into, on ${machine}, for this project alone.${kept === false ? " No sign-ins kept yet." : ""}`
        )
      }
      control={
        kept === false || done ? undefined : (
          <DangerButton
            disabled={!live}
            onClick={() => {
              setDone(false);
              setAsking(true);
            }}
          >
            Forget sign-ins…
          </DangerButton>
        )
      }
    >
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
    </SettingsRow>
  );
}

function ForgetDialog(props: { projectRef: Ref; machine: string; onClose: (forgotten: boolean) => void }) {
  const hubCall = useHubCall();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = () => {
    setBusy(true);
    setProblem(null);
    hubCall(PROJECT_TOOLS.signinsForget, props.projectRef, { timeoutMs: FORGET_MS }).then(
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
      description={`It is signed out of every site, and its browser profile is deleted from ${props.machine}. A browser session it has open now ends. Its chat, memory, folder and allowed sites stay.`}
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

/** What the lead has learned to do: its skills are listed in Agents' Skills, each one's history in the panel. */
export function SkillsSetting({ projectRef }: { projectRef: Ref }) {
  return (
    <SettingsRow
      reveal="projects.skills"
      title="Skills"
      line="What this project's lead has learned to do. It saves and improves its own skills as it works; you see every change, edit, undo or turn one off."
      control={
        <Button
          variant="secondary"
          onClick={() => {
            revealNext("agents.skills");
            navigate(projectSkills(projectRef));
          }}
        >
          Open its skills
        </Button>
      }
    />
  );
}
