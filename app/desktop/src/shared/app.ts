// What the app shell passes between main and the renderer that isn't hub traffic: things to open (a clicked
// notification, a fleetd:// link) and notifications to post. Menu commands are the palette registry's ids.
import { z } from "zod";

/** Ids from the hub, as they appear in a notification's target. */
const machineId = z.string().regex(/^[a-z0-9-]{1,32}$/u);
const hubId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);

/** A pairing code as typed or linked; the onboarding screen normalises it. */
const pairCode = z.string().regex(/^[A-Za-z0-9-]{4,32}$/u);
const hubUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "a http(s) hub address");

const notifyTargets = [
  /** A project's lead chat, at one message when the notification is about it. */
  z.strictObject({ kind: z.literal("chat"), machineId, projectId: hubId, messageId: hubId.optional() }),
  z.strictObject({ kind: z.literal("machines") }),
  z.strictObject({ kind: z.literal("status") }),
  /** Settings → Notifications: where the test notification leads. */
  z.strictObject({ kind: z.literal("notifications") }),
] as const;

/** What a notification is about, and so what clicking it opens. */
export const NotifyTarget = z.discriminatedUnion("kind", notifyTargets);
export type NotifyTarget = z.infer<typeof NotifyTarget>;

/** Where main sends the renderer: a clicked notification's target, or a pairing link to prefill. */
export const OpenTarget = z.discriminatedUnion("kind", [
  ...notifyTargets,
  z.strictObject({ kind: z.literal("pair"), hub: hubUrl, code: pairCode }),
]);
export type OpenTarget = z.infer<typeof OpenTarget>;

/** Whether this app is the OS handler for fleetd:// links. A dev build never is, and never claims. */
export interface LinkHandlerStatus {
  readonly packaged: boolean;
  readonly handler: boolean;
}

/** What may ask main to claim the scheme: the Settings action, or onboarding after a pairing link failed. */
export const LinkHandlerClaim = z.enum(["user", "pair-failed"]);
export type LinkHandlerClaim = z.infer<typeof LinkHandlerClaim>;

export const NotifyRequest = z.strictObject({
  /** A later notification with the same tag replaces the earlier one. */
  tag: z.string().regex(/^[a-z0-9-]{1,32}$/u),
  title: z.string().min(1).max(120),
  body: z.string().max(400),
  target: NotifyTarget,
  /** No sound (Settings → Notifications). */
  silent: z.boolean().optional(),
});
export type NotifyRequest = z.infer<typeof NotifyRequest>;

/**
 * `fleetd://pair?hub=<url-encoded>&code=<code>` (as `fleetd pair` prints it), or null for anything else. The link
 * comes from outside the app, so it only ever prefills the pairing screen; F10 asks before it pairs.
 */
export const parseDeepLink = (link: string): OpenTarget | null => {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "fleetd:") return null;
  // `fleetd://pair?…` parses with "pair" as the host; `fleetd:pair?…` with it as the path.
  const route = (url.host || url.pathname).replace(/^\/+|\/+$/gu, "");
  if (route !== "pair") return null;
  const parsed = OpenTarget.safeParse({
    kind: "pair",
    hub: url.searchParams.get("hub") ?? "",
    code: url.searchParams.get("code") ?? "",
  });
  return parsed.success ? parsed.data : null;
};
