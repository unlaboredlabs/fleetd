import { X } from "lucide-react";
import { display } from "../../../shared/shortcuts";
import { Button, Panel, SectionHeader } from "../../ui";
import { InboxBody } from "./screens";
import s from "./shell.module.css";

/** The inbox panel on the right, over whatever screen is open. F5's cards fill it. */
export function InboxPanel({ count, askId, onClose }: { count: number | undefined; askId: string | null; onClose: () => void }) {
  return (
    <aside className={s.inbox} aria-label="Needs you">
      <Panel
        fill
        header={
          <SectionHeader
            bordered
            title="Needs you"
            count={count !== undefined && count > 0 ? count : undefined}
            actions={
              <Button variant="quiet" iconOnly aria-label="Close the inbox" title={`Close (Esc or ${display("inbox.toggle", window.fleetd.platform)})`} onClick={onClose}>
                <X />
              </Button>
            }
          />
        }
      >
        <InboxBody askId={askId} onClose={onClose} />
      </Panel>
    </aside>
  );
}
