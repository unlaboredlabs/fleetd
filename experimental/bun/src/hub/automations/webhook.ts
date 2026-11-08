// `POST /hooks/<automationId>/<secret>`: a webhook run, with the request body as its context
// (crates/fleetd/src/hub/automations/webhook.rs). An unknown automation (deleted, or its project removed) and a wrong
// secret get the same 404, and neither is logged or recorded: the URL holds the secret, so nothing here writes the
// path, the secret or the body anywhere but the run it starts.
import { json, type Route } from "../http/route.ts";
import { automations, WEBHOOK_BODY_MAX } from "./index.ts";

const refused = (status: number, error: string) => json({ ok: false, error }, status);

/** The body, or undefined once it runs past `max` bytes. */
async function bodyOf(req: Request, max: number): Promise<Uint8Array | undefined> {
  if (!req.body) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of req.body) {
    size += part.byteLength;
    if (size > max) return undefined;
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export const hook: Route = async (req, ctx) => {
  const hub = ctx.hub;
  const a = automations(hub);
  const id = ctx.params.automation_id ?? "";
  const secret = ctx.params.secret ?? "";
  let target: ReturnType<typeof a.webhookTarget>;
  try {
    target = a.webhookTarget(id, secret);
  } catch {
    return refused(500, "The hub failed to answer.");
  }
  if (!target) return refused(404, "This webhook URL is not valid.");
  const bytes = await bodyOf(req, WEBHOOK_BODY_MAX);
  if (bytes === undefined) return refused(413, `The body is over ${WEBHOOK_BODY_MAX} bytes.`);
  const payload = new TextDecoder().decode(bytes);
  let opened: ReturnType<typeof a.open>;
  try {
    opened = a.open(target.automationId, { kind: "webhook", payload });
  } catch (e) {
    return refused(500, (e as Error).message);
  }
  const [automation, run] = opened;
  const status = run.state === "running" || run.state === "queued" ? 202 : run.state === "failed" ? 500 : 200;
  // The caller gets its answer now; a lead that has to start takes as long as it takes.
  void a.wakeLead(automation, run).catch((error) => console.warn("automation lead not woken:", (error as Error).message));
  return json(
    { ok: run.state !== "failed", runId: run.runId, state: run.state, workstreamId: run.workstreamId ?? null, why: run.why ?? null },
    status,
  );
};
