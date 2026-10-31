import { Button, Text } from "../../ui";
import { TAGLINE } from "./setup";
import s from "./onboarding.module.css";

/** `#/` with no projects yet: the next step's button, where the welcome left it. */
export function GetStarted({ onAddProject }: { onAddProject: () => void }) {
  return (
    <div className={s.screen}>
      <div className={s.column}>
        <Text as="h1" size="xl" strong>
          Add a project to chat with its lead
        </Text>
        <Text as="p" tone="quiet">
          {TAGLINE}
        </Text>
        <div className={s.actions}>
          <Button variant="primary" onClick={onAddProject}>
            Add a project
          </Button>
        </div>
      </div>
    </div>
  );
}
