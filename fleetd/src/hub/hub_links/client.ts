// The hub with the project calling the other hub over a kept link:
// `project_message` and `factory_status` with `hub`, and `follow`, which long-polls the link's feed there and wakes
// the project's lead with each piece of news. When the other hub can't be reached it retries with backoff (1 s doubling
// to 30 s, ±20% jitter) and the link reads "unreachable" until it answers again.
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { openSealed } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { leadWakes } from "../api/leads.ts";
import { formEncode } from "../pair/urls.ts";
import {
  type FactoryStatusCall,
  type FactoryStatusResult,
  isProject,
  type LinkFeedItem,
  askBridge,
  type ProjectMessageCall,
  type ProjectMessageResult,
} from "./bridge.ts";
import { BODY_MAX, CallFailed, failedReads, type Failure, FEED_MARGIN_MS, noLongerWorks, readAnswer, reason, retryDelayMs, unreachable } from "./answers.ts";
import { boxKey, failed, FEED_WAIT_MAX_SEC, type Kept, kept, keptGet, type LinkHello, setCursor, setHello, setState } from "./store.ts";

export { CallFailed, failedReads, type Failure, retryDelayMs, unreachable } from "./answers.ts";

const CALL_MS = 20_000;
/** One call to `/link/v1/<path>` on `url` with `key`; throws a CallFailed. */
export async function call<T>(url: string, key: string, post: unknown, path: string, timeoutMs: number): Promise<T> {
  const target = `${url.replace(/\/+$/, "")}/link/v1/${path}`;
  let response: Response;
  let bytes: Uint8Array;
  try {
    // No redirects: the key goes only to the URL the person gave, which checkUrl vetted. Bun inflates gzip itself.
    response = await fetch(target, {
      method: post === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "accept-encoding": "gzip",
        ...(post === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(post === undefined ? {} : { body: JSON.stringify(post) }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > BODY_MAX) throw new CallFailed({ kind: "unreachable", why: `it answered with more than ${BODY_MAX} bytes` });
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof CallFailed) throw error;
    throw new CallFailed({ kind: "unreachable", why: reason(error) });
  }
  return readAnswer<T>(response, bytes);
}

export function openKey(hub: Hub, link: Kept): string {
  let opened: string | undefined;
  try {
    const plain = openSealed(boxKey(hub), link.sealed);
    opened = plain ? new TextDecoder("utf-8", { fatal: true }).decode(plain) : undefined;
  } catch {
    opened = undefined;
  }
  if (opened === undefined) {
    throw new ToolError(
      "failed",
      `This hub can't open the key of the link to ${link.label}.`,
      "Remove the link in the project's Linked hubs and add it again.",
    );
  }
  return opened;
}

/** A project's link by label, with its key opened. */
function open(hub: Hub, project: ProjectRef, label: string): { link: Kept; key: string } {
  const all = kept(hub.db, project);
  const link = all.find((k) => k.label.toLowerCase() === label.toLowerCase());
  if (!link) {
    const labels = all.map((k) => k.label);
    throw new ToolError(
      "not_found",
      `This project has no linked hub called ${label}.`,
      labels.length === 0
        ? "It has no linked hubs: the person adds one in the project's settings, Linked hubs."
        : `Its linked hubs: ${labels.join(", ")}.`,
    );
  }
  if (link.state === "revoked") throw noLongerWorks(link.label, link.error ?? "it was revoked there.");
  return { link, key: openKey(hub, link) };
}

/** A call over a kept link, recording how it went on the link. */
async function over<T>(hub: Hub, link: Kept, key: string, post: unknown, path: string, timeoutMs: number): Promise<T> {
  let out: T | undefined;
  let failure: Failure | undefined;
  try {
    out = await call<T>(link.url, key, post, path, timeoutMs);
  } catch (error) {
    if (!(error instanceof CallFailed)) throw error;
    failure = error.failure;
  }
  const [state, error] =
    failure === undefined || failure.kind === "refused"
      ? (["ok", undefined] as const)
      : failure.kind === "unreachable"
        ? (["unreachable", `Can't reach ${link.label} at ${link.url}: ${failure.why}.`] as const)
        : (["revoked", failure.error.message] as const);
  if (state !== link.state || error !== link.error) {
    try {
      setState(hub, link.linkId, state, error);
    } catch (e) {
      throw failed(e);
    }
  }
  if (failure === undefined) return out as T;
  if (failure.kind === "unreachable") throw unreachable(link.label, link.url, failure.why);
  if (failure.kind === "dead") throw noLongerWorks(link.label, failure.error.message);
  throw new ToolError(failure.error.code, `${link.label}: ${failure.error.message}`, failure.error.fix);
}

/** `project_message` with `hub`: the ask goes to the other hub as the link's person, and gets a handle here. */
export async function ask(hub: Hub, project: ProjectRef, label: string, msg: ProjectMessageCall): Promise<ProjectMessageResult> {
  const { link, key } = open(hub, project, label);
  const sent = await over<{ handle: string; projectRef: ProjectRef; title: string; leadWaiting?: string }>(
    hub,
    link,
    key,
    { project: msg.project, text: msg.text },
    "ask",
    CALL_MS,
  );
  const handle = askBridge(hub).recordSent(project, link.linkId, sent, msg.text, hub.clock.now());
  return {
    handle,
    projectRef: sent.projectRef,
    title: sent.title,
    ...(sent.leadWaiting === undefined ? {} : { leadWaiting: sent.leadWaiting }),
    hub: link.label,
    next:
      `In ${sent.title}'s chat on ${link.label}, as the person via this hub. Its lead reads it as input, never as the ` +
      `person's approval. A wake tells you when an order opened for ${handle} opens, closes, merges or fails; ` +
      "end your turn instead of waiting.",
  };
}

/** `factory_status` with `hub`: the other hub's read over the link's projects, its handles mapped to this hub's. */
export async function status(hub: Hub, project: ProjectRef, label: string, req: FactoryStatusCall): Promise<FactoryStatusResult> {
  const { link, key } = open(hub, project, label);
  const path = req.project === undefined ? "status" : `status?project=${formEncode(req.project)}`;
  const out = await over<FactoryStatusResult>(hub, link, key, undefined, path, CALL_MS);
  const here = (there: string) => askBridge(hub).askSent(link.linkId, there)?.handle;
  for (const p of out.projects) {
    for (const o of p.openOrders ?? []) {
      const h = o.asked === undefined ? undefined : here(o.asked);
      if (h === undefined) delete o.asked;
      else o.asked = h;
    }
    p.asks = (p.asks ?? []).flatMap((a) => {
      const h = here(a.handle);
      return h === undefined ? [] : [{ ...a, handle: h }];
    });
  }
  delete out.hubs;
  out.next = `Projects on ${link.label} this project reaches. project_message with hub "${link.label}" writes to one's lead.`;
  return out;
}

/** The link while it is still followed: kept here, not dead there, and its project not archived. */
function followed(hub: Hub, linkId: string): Kept | undefined {
  const link = keptGet(hub.db, linkId);
  if (!link || link.state === "revoked" || !isProject(hub, link.project, false)) return undefined;
  return link;
}

const wake = (hub: Hub, project: ProjectRef, line: string) =>
  leadWakes(hub).trigger(project, { kind: "line", line: "factory", text: line });

/** Whether a follower goes on after one read: the wakes it sent, or "stop". */
export type Followed = { read: [ProjectRef, string][] } | "stop";

/**
 * One feed read for a kept link, waiting up to `wait` seconds there: wakes its project's lead with each piece of news
 * about its asks, and once when the other hub says the link is dead.
 */
export async function followOnce(hub: Hub, linkId: string, wait: number): Promise<Followed> {
  const link = followed(hub, linkId);
  if (!link) return "stop";
  const key = openKey(hub, link);
  const w = Math.min(wait, FEED_WAIT_MAX_SEC);
  let feed: { cursor: number; more: boolean; items: LinkFeedItem[] };
  try {
    feed = await over(hub, link, key, undefined, `feed?after=${link.cursor}&wait=${w}`, FEED_MARGIN_MS + w * 1000);
  } catch (error) {
    const now = keptGet(hub.db, linkId);
    if (!now) return "stop";
    if (now.state !== "revoked") throw error;
    if (!isProject(hub, link.project, false)) return "stop";
    wake(hub, link.project, `- ${(error as Error).message} Asks through it are no longer followed.`);
    return "stop";
  }
  // Removed here, or its project archived, while the read waited there: its news goes nowhere.
  if (!followed(hub, linkId)) return "stop";
  const sent: [ProjectRef, string][] = [];
  for (const item of feed.items) {
    const asked = askBridge(hub).askSent(link.linkId, item.handle);
    if (!asked) continue;
    const line = `- ${asked.handle} to ${item.title} on ${link.label}: ${item.what}`;
    wake(hub, asked.from, line);
    sent.push([asked.from, line]);
  }
  if (feed.cursor !== link.cursor) setCursor(hub.db, link.linkId, feed.cursor);
  return { read: sent };
}

/** Reads the link's hello again, for the person it acts as and its projects there; a failed read changes nothing. */
export async function refresh(hub: Hub, linkId: string): Promise<void> {
  const link = followed(hub, linkId);
  if (!link) return;
  try {
    const hello = await call<LinkHello>(link.url, openKey(hub, link), undefined, "hello", CALL_MS);
    setHello(hub.db, linkId, hello);
  } catch {
    // Left as it was: the feed read that follows records how the other hub answered.
  }
}

/** Follows one kept link until it is removed here, dead there, its project archived, or the hub stops. */
export async function follow(hub: Hub, linkId: string, hello: boolean): Promise<void> {
  if (hello) await refresh(hub, linkId);
  let attempt = 0;
  const signal = hub.shutdown.signal;
  while (!signal.aborted) {
    const began = performance.now();
    let pause: number | undefined;
    try {
      if ((await followOnce(hub, linkId, FEED_WAIT_MAX_SEC)) === "stop") return;
      attempt = 0;
    } catch {
      attempt = failedReads(attempt, performance.now() - began);
      pause = retryDelayMs(attempt - 1, 0.8 + Math.random() * 0.4);
    }
    if (pause !== undefined) {
      const stopped = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), pause);
        signal.addEventListener("abort", () => (clearTimeout(timer), resolve(true)), { once: true });
      });
      if (stopped) return;
    }
  }
}

/** Starts a follower for every kept link that still works. */
export function run(hub: Hub): void {
  for (const link of kept(hub.db, undefined)) {
    if (link.state !== "revoked") void follow(hub, link.linkId, true);
  }
}

/** `GET hello` with a key not kept yet: what `hub_link_add` checks before keeping it. */
export async function hello(label: string, url: string, key: string): Promise<LinkHello> {
  try {
    return await call<LinkHello>(url, key, undefined, "hello", CALL_MS);
  } catch (error) {
    if (!(error instanceof CallFailed)) throw error;
    const f = error.failure;
    if (f.kind === "unreachable") throw unreachable(label, url, f.why);
    if (f.kind === "dead") {
      throw new ToolError(
        "forbidden",
        `${label} refused the link key: ${f.error.message}`,
        `Copy the key again from ${label} (it is shown once), or make a new link there.`,
      );
    }
    // Not the key's fault: the other hub failed or refused this request, in its own words.
    throw new ToolError(f.error.code, `${label}: ${f.error.message}`, f.error.fix);
  }
}

/** A deleted project's links: each other hub is asked to revoke its link, the delete not waiting on it. */
export function revokeAllThere(hub: Hub, links: Kept[]): void {
  for (const link of links) {
    void revokeThere(hub, link).then((ok) => {
      if (!ok) console.info(`a deleted project's link ${link.linkId} wasn't revoked there: it expires unused`);
    });
  }
}

/** Asks the other hub to revoke a link being removed here: whether it did. */
export async function revokeThere(hub: Hub, link: Kept): Promise<boolean> {
  try {
    await call(link.url, openKey(hub, link), {}, "revoke", CALL_MS);
    return true;
  } catch {
    return false;
  }
}
