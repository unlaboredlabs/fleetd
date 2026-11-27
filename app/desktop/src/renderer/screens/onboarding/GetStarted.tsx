import { Bot, Button, EmptyState } from "../../ui";
import { TAGLINE } from "./setup";
import s from "./onboarding.module.css";

/** `#/` with no projects yet: the next step's button, where the welcome left it, as every empty state, the bot its mark. */
export function GetStarted({ onAddProject }: { onAddProject: () => void }) {
  return (
    <div className={s.empty}>
      <EmptyState
        title="Add a bot to chat with its lead"
        mark={<Bot state="idle" size={48} />}
        actions={
          <Button variant="primary" onClick={onAddProject}>
            Add a bot
          </Button>
        }
      >
        {TAGLINE}
      </EmptyState>
    </div>
  );
}
