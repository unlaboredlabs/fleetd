// `/link/v1/<op>` (crates/fleetd/src/hub/hub_links/serve.rs): what a link minted here may do, with its key as
// `Authorization: Bearer flk_…`. Nothing else on the hub takes a link key, and nothing here administers anything.
// - `GET hello`: the link's label, its person, the projects it reaches (and whether it is limited), the feed's start.
// - `POST ask`: `project_message` as the link's person, "<person> via <label>".
// - `GET status?project=`: `factory_status` over the projects it reaches, with its own asks.
// - `GET feed?after=&wait=`: what happened to its asks after `after`, waiting up to `wait` seconds for some.
// - `POST revoke`: the link revokes itself, when the hub with the Navi removes it.
// A refusal is an McpToolError as JSON: 401 with `dead: true` when the link is dead for good, else by its code.
import type { ErrorCode } from "../../shared/contracts.ts";
import { internalError, NotImplemented, ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { json, type Route } from "../http/route.ts";
import { events } from "../store/events.ts";
import { naviBridge } from "./bridge.ts";
import { failed, FEED_WAIT_MAX_SEC, type Issued, type LinkHello, revokeIssued, verify } from "./store.ts";

const STATUS: Record<string, number> = { forbidden: 403, not_found: 404, invalid: 400, machine_offline: 503, failed: 500 };
const statusOf = (code: ErrorCode) => STATUS[code] ?? 500;

const refused = (e: ToolError) => json(e.toJSON(), statusOf(e.code));

/** A refusal of the key itself: 401 with `dead` for a link dead for good, else (a store failure) its own status. */
const keyRefused = (e: ToolError) => (e.code !== "forbidden" ? refused(e) : json({ ...e.toJSON(), dead: true }, 401));

async function hello(hub: Hub, link: Issued): Promise<LinkHello> {
  const all = await naviBridge(hub).factoryStatus({ kind: "link", link }, {});
  return {
    label: link.label,
    projects: all.projects.map((p) => ({ projectRef: p.projectRef, title: p.title })),
    cursor: events(hub).head(),
    who: link.who,
    limited: link.projects !== undefined,
  };
}

async function ask(hub: Hub, link: Issued, body: string) {
  let call: { project?: unknown; text?: unknown };
  try {
    call = JSON.parse(body) as typeof call;
  } catch (error) {
    throw new ToolError("invalid", `Not an ask: ${(error as Error).message}.`);
  }
  if (typeof call?.project !== "string" || typeof call.text !== "string") {
    throw new ToolError("invalid", `Not an ask: missing field \`${typeof call?.project !== "string" ? "project" : "text"}\`.`);
  }
  const out = await naviBridge(hub).projectMessage({ kind: "link", link }, { project: call.project, text: call.text });
  return {
    handle: out.handle,
    projectRef: out.projectRef,
    title: out.title,
    ...(out.leadWaiting === undefined ? {} : { leadWaiting: out.leadWaiting }),
  };
}

/** One feed read: at once when there is news, else when some comes, the wait ends or the hub stops. */
async function feed(hub: Hub, link: Issued, query: URLSearchParams, bearer: string): Promise<Response> {
  const number = (name: string): number | undefined => {
    const v = query.get(name);
    if (v === null) return undefined;
    if (!/^[+-]?\d+$/.test(v)) throw new ToolError("invalid", `${name} is not a number.`);
    return Number(v);
  };
  let after = number("after") ?? events(hub).head();
  const wait = Math.min(Math.max(number("wait") ?? 0, 0), FEED_WAIT_MAX_SEC);
  const until = performance.now() + wait * 1000;
  for (;;) {
    let page: ReturnType<ReturnType<typeof naviBridge>["feed"]>;
    try {
      page = naviBridge(hub).feed(link.linkId, after);
    } catch (error) {
      if (error instanceof NotImplemented || error instanceof ToolError) throw error;
      throw failed(error);
    }
    after = page.cursor;
    if (page.items.length > 0 || page.more || performance.now() >= until) return json(page);
    // Wakes on the next append, the end of the wait, or the hub stopping.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.max(0, until - performance.now()));
      const unsubscribe = events(hub).subscribe(() => done());
      const signal = hub.shutdown.signal;
      signal.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", done);
        resolve();
      }
    });
    try {
      verify(hub, bearer);
    } catch (error) {
      if (error instanceof ToolError) return keyRefused(error);
      throw error;
    }
    if (hub.shutdown.signal.aborted) return json({ cursor: after, more: false, items: [] });
  }
}

export const hubLink: Route = async (req, { hub, params }) => {
  const bearer = req.headers.get("authorization") ?? "";
  let link: Issued;
  try {
    link = verify(hub, bearer);
  } catch (error) {
    if (error instanceof ToolError) return keyRefused(error);
    return keyRefused(failed(error));
  }
  const op = params.op ?? "";
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && op === "hello") return json(await hello(hub, link));
    if (req.method === "POST" && op === "ask") return json(await ask(hub, link, await req.text()));
    if (req.method === "GET" && op === "status") {
      const project = url.searchParams.get("project");
      if (project !== null && (project.trim() === "" || [...project].length > 200 || /[\r\n]/.test(project))) {
        throw new ToolError("invalid", "project must be one line of 1 to 200 characters");
      }
      return json(await naviBridge(hub).factoryStatus({ kind: "link", link }, project === null ? {} : { project }));
    }
    if (req.method === "GET" && op === "feed") return await feed(hub, link, url.searchParams, bearer);
    if (req.method === "POST" && op === "revoke") {
      revokeIssued(hub, link.linkId);
      return json({});
    }
    throw new ToolError("not_found", `No ${req.method} /link/v1/${op} on this hub.`);
  } catch (error) {
    if (error instanceof ToolError) return refused(error);
    if (error instanceof NotImplemented) return refused(new ToolError("failed", error.message));
    console.error("link request failed:", error);
    return refused(internalError());
  }
};
