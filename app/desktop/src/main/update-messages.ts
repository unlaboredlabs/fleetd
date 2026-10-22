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
