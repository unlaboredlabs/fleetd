// The hub call behind a project's DMs between agents, as the desktop makes it: agent_messages, a page at a time,
// newest first, the older ones from before the oldest shown. Read-only: there is no call that changes a DM.
import type { ProjectRef } from "../../desktop";
import type { Hub, Result } from "../manage/api";
import { DM_PAGE, type DmPage } from "./model";

const ref = (p: ProjectRef): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });

export const readDms = async (hub: Hub, p: ProjectRef, before?: string, limit = DM_PAGE): Promise<Result<DmPage>> => {
  const r = await hub.call("agent_messages", { projectRef: ref(p), limit, ...(before === undefined ? {} : { before }) });
  return r.ok ? { ok: true, value: { messages: r.output.messages, more: r.output.more, total: r.output.total } } : r;
};
