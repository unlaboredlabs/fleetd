// The panel's Checklist tab. checklist-listed: storefront's lead keeps a list for the work in many-agents, some done
// (one with its merged PR), two under way (one with the agent on it, at work in many-agents), the rest still to do.
// checklist-empty: a project whose lead has set none.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { AGENT } from "../agents/route.ts";

const STOREFRONT = { machineId: AGENT.machineId, projectId: AGENT.projectId };

const items = (now: string) => {
  const at = (agoMs: number) => new Date(Date.parse(now) - agoMs).toISOString();
  return [
    { id: 1, text: "Receipts show the shop's local time", state: "done", link: { pr: "https://github.com/acme/storefront/pull/10" }, updatedAt: at(5_400_000) },
    { id: 2, text: "Cart totals round once, at checkout", state: "doing", link: { taskId: AGENT.laneId }, updatedAt: at(900_000) },
    { id: 3, text: "Saved carts survive a sign-out", state: "doing", updatedAt: at(600_000) },
    { id: 4, text: "Gift cards apply before tax", state: "todo", updatedAt: at(600_000) },
    { id: 5, text: "Release notes for the checkout changes", state: "todo", updatedAt: at(600_000) },
    { id: 6, text: "Search keeps its query on Back", state: "done", updatedAt: at(7_200_000) },
  ];
};

const listed = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "checklist-listed", "Checklist: storefront's lead's to-dos, two done, two doing, two to do.");
  f.answer("checklist_get", { projectRef: STOREFRONT }, { projectRef: STOREFRONT, items: items(f.now), updatedAt: f.now });
  return f;
};

const empty = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "checklist-empty", "Checklist: a project whose lead has set none.");
  f.answer("checklist_get", { projectRef: STOREFRONT }, { projectRef: STOREFRONT, items: [], next: "The project's lead keeps this list; it is empty until the lead sets one." });
  return f;
};

export default defineGroup({
  fixtures: (base) => [listed(base("many-agents")), empty(base("chat-waiting"))],
});
