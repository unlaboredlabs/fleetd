// A chat's second line in the list (W950), the desktop's sidebar and the phone's chat list alike: what waits on you,
// in words ("Approve: Run the stock migration on staging"), else that its lead works ("Working…"), else the line its
// lead last wrote on where things stand (`checklist`'s `status`), else its newest message. Pure, so both apps say it the same.

/** What waits on you in a chat, the most pressing first: its kind, how many, and the first one's words. */
export interface Waiting {
  /** A command to approve, a secret to enter, a sign-in to fill, a reply, a block outside the work, or something the
   * open requests haven't said yet. */
  readonly kind: "approve" | "secret" | "signIn" | "reply" | "blocked" | "unknown";
  readonly count: number;
  /** The first one's words: what the request is about (requestWhat), or why it is blocked. */
  readonly what?: string | undefined;
  /** It can't be done here, only on the desktop (a secret on the phone). */
  readonly elsewhere?: boolean | undefined;
}

/** What an open request is about, in a few words: a command's reason (the lead's own words), a sign-in's site, a
 * field's label and site ("Passport number for Visa application"), else the request's own line. */
export const requestWhat = (r: {
  readonly text?: string | undefined;
  readonly gated?: { readonly reason?: string | undefined } | undefined;
  readonly secureInput?: { readonly label: string; readonly site: { readonly name: string }; readonly signIn?: unknown } | undefined;
}): string | undefined => {
  const s = r.secureInput;
  if (s !== undefined) return s.signIn !== undefined ? s.site.name : `${s.label} for ${s.site.name}`;
  return r.gated?.reason ?? r.text;
};

/** A row's second line: `lead` in front of `text`, both in the line's tone. */
export interface RowLine {
  readonly text: string;
  /** The words that say what to do, drawn a step stronger ("Approve:"). */
  readonly lead?: string | undefined;
  /** "want": it waits on you; "working": its lead works now; undefined: a plain line. */
  readonly tone?: "want" | "working" | undefined;
}

const firstLine = (s: string | undefined): string | undefined => {
  const line = s?.split("\n")[0]?.trim();
  return line === undefined || line === "" ? undefined : line;
};

/** What a chat that waits on you says: what to do, and the thing, or the lead's own line for a reply. */
export const waitingLine = (w: Waiting, status: string | undefined): RowLine => {
  const what = firstLine(w.what);
  const many = w.count > 1;
  const n = String(w.count);
  switch (w.kind) {
    case "approve":
      if (what === undefined) return { text: many ? `${n} commands to approve` : "A command to approve", tone: "want" };
      return { lead: many ? `${n} to approve:` : "Approve:", text: what, tone: "want" };
    case "secret":
      if (w.elsewhere === true) return what === undefined ? { text: many ? `${n} secrets to enter on the desktop` : "A secret to enter on the desktop", tone: "want" } : { lead: "Enter on the desktop:", text: what, tone: "want" };
      if (what === undefined) return { text: many ? `${n} secrets to enter` : "A secret to enter", tone: "want" };
      return { lead: many ? `${n} secrets to enter:` : "Enter a secret:", text: what, tone: "want" };
    case "signIn":
      if (what === undefined) return { text: many ? `${n} sign-ins to fill in` : "A sign-in to fill in", tone: "want" };
      return { lead: many ? `${n} sign-ins:` : "Sign in:", text: what, tone: "want" };
    case "blocked":
      return what === undefined ? { text: "Blocked", tone: "want" } : { lead: "Blocked:", text: what, tone: "want" };
    case "reply":
      return { text: status ?? "Waiting for your reply", tone: "want" };
    case "unknown":
      return { text: status ?? "Waiting for you", tone: "want" };
  }
};

/**
 * A chat's second line: what waits on you, else "Working…" while its lead works, else its lead's status line, else its
 * newest message (`newest`, "" when there is none yet).
 */
export const rowLine = (o: { readonly waiting?: Waiting | undefined; readonly leadWorking: boolean; readonly status?: string | undefined; readonly newest: string }): RowLine => {
  if (o.waiting !== undefined) return waitingLine(o.waiting, o.status);
  if (o.leadWorking) return { text: "Working…", tone: "working" };
  if (o.status !== undefined && o.status !== "") return { text: o.status };
  return { text: o.newest };
};

/** The line as one string, for a tooltip or a screen reader. */
export const lineWords = (l: RowLine): string => (l.lead === undefined ? l.text : `${l.lead} ${l.text}`);
