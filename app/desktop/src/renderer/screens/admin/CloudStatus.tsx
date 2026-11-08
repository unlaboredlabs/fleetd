// The cloud line (D306): what cloud machines cost today against the day budget and how many are awake, why starts
// wait when they do, and for a member who to ask about them. Nothing on a hub without cloud machines set up.
// Self-contained (it asks the hub itself and sets no outer spacing), for the sidebar's hub status; admins have the
// whole view in Settings › Hub › Machines (Cloud.tsx).
import { useToolQuery } from "../../src/data/react";
import { HubText } from "../projects/HubText";
import { adminNames, adminWho } from "../sessions/pickScreen";
import { Text } from "../../ui";
import { cloudStatusLine, heldLine } from "./cloudModel";
import { useHubRole } from "./role";
import { useCloud } from "./useCloud";
import a from "./admin.module.css";

const noInput = {};

/** The day's cloud line, and for a member who to ask about it; inside the hub's HubScope. */
export function CloudStatus() {
  const cloud = useCloud();
  const role = useHubRole();
  const member = !role.pending && !role.administers;
  const people = useToolQuery("people_list", noInput, { enabled: member && cloud !== undefined && cloud !== null && cloud.hasKey });
  const line = cloudStatusLine(cloud ?? undefined);
  if (cloud === undefined || cloud === null || line === null) return null;
  const ask = member ? `Ask ${adminWho(adminNames(people.data?.people ?? []))} to change cloud machines.` : null;
  const held = heldLine(cloud);
  return (
    <div className={a.cloudStatus} role="status" aria-label="Cloud machines" data-cloud-status="">
      <Text size="sm" tone="quiet" tabular>
        {line}
      </Text>
      {held === null ? null : (
        <Text size="sm" tone="warning">
          <HubText>{held}</HubText>
        </Text>
      )}
      {ask === null ? null : (
        <Text size="xs" tone="faint">
          {ask}
        </Text>
      )}
    </div>
  );
}
