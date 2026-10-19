export const DEB = "fleetd-desktop-linux-amd64.deb";

export type UpdateOutcome =
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "downloading"; readonly version: string }
  | { readonly kind: "ready"; readonly version: string }
  | { readonly kind: "deb"; readonly version: string }
  | { readonly kind: "failed"; readonly error: unknown };

export interface UpdateMessage {
  readonly type: "info" | "warning";
  readonly message: string;
  readonly detail: string;
  /** The first button acts (restart, download); the last one closes. */
  readonly buttons: readonly string[];
}

const OFFLINE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|net::ERR_/u;
const NO_FEED = /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|HttpError: 404/u;
const UNSIGNED = /code signature|did not pass validation|not signed/iu;
const CHECKSUM = /sha512 checksum mismatch/iu;

/** Why a check or download failed, in words a user can act on; never a stack trace. */
export const failureReason = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  if (OFFLINE.test(text)) return "The release server didn't answer. Check your connection and try again.";
  if (NO_FEED.test(text)) return "This release has no update information yet. Try again later.";
  if (UNSIGNED.test(text)) return "The downloaded update isn't signed by fleetd, so it wasn't installed.";
  if (CHECKSUM.test(text)) return "The download was damaged, so it wasn't installed. Try again.";
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  return first === "" ? "Something went wrong. Try again later." : first.length > 200 ? `${first.slice(0, 199)}…` : first;
};

/** What the update dialog says for each outcome of a check. */
export const updateMessage = (outcome: UpdateOutcome, current: string): UpdateMessage => {
  switch (outcome.kind) {
    case "current":
      return { type: "info", message: "fleetd is up to date", detail: `You have version ${current}.`, buttons: ["OK"] };
    case "downloading":
      return {
        type: "info",
        message: `Downloading fleetd ${outcome.version}`,
        detail: "You can keep working. fleetd will ask to restart when the update is ready.",
        buttons: ["OK"],
      };
    case "ready":
      return {
        type: "info",
        message: `fleetd ${outcome.version} is ready`,
        detail: "Restart fleetd to finish updating. It also updates the next time you quit.",
        buttons: ["Restart Now", "Later"],
      };
    case "deb":
      return {
        type: "info",
        message: `fleetd ${outcome.version} is available`,
        detail: `Download ${DEB}, then install it with:\n\nsudo apt install ./${DEB}`,
        buttons: ["Download", "Later"],
      };
    case "failed":
      return { type: "warning", message: "Couldn't check for updates", detail: failureReason(outcome.error), buttons: ["OK"] };
  }
};
