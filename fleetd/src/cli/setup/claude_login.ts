// `claude auth login` in `fleetd init`, on a terminal of its own rather than the person's: handed the terminal, its
// "Paste code here" prompt never ends (each Enter says "Invalid code" again; Ctrl-D, Esc and Ctrl-C are ignored).
// fleetd prints its link and takes the code at a prompt of its own: an empty Enter says what to do once, a second
// one or Ctrl-D skips the login, which the Claude step at the end can still do.
import { Logins } from "../../node/runner/login.ts";
import type { Checklist } from "./checklist.ts";
import type { Ui } from "./wizard.ts";

/** A desktop session a browser could open in: always on macOS, an X or Wayland display on Linux. */
export const hasDisplay = () => process.platform === "darwin" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/**
 * Logs claude in with `argv` (its `auth login`, here or over SSH): its link, then the code the page shows. `here`: it
 * runs on this machine, so with a screen it opens the page itself and a sign-in there ends it alone. Whether it logged
 * in; skipped or failed, why is said.
 */
export async function claudeLogin(ui: Ui, list: Checklist, argv: string[], here: boolean, logins = new Logins()): Promise<boolean> {
  const browser = here && hasDisplay();
  list.start("Starting claude's login");
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  let url: string;
  try {
    url = await logins.start(argv, env, { browser });
  } catch (error) {
    list.warn("claude login", (error as Error).message);
    return false;
  }
  list.stopSpinner();
  list.note(`${browser ? "Sign in to Claude in the browser that opened, or open" : "Open"} this link and sign in:\n${url}`);
  /** claude's words, without the command that said them. */
  const words = (error: unknown) => (error as Error).message.replace(/^.*? failed: /, "").replace(/\.+$/, "");
  let told = false;
  try {
    for (;;) {
      const typed = await ui.line(list, "Code the page shows", told ? "Enter to skip" : browser ? "Enter once signed in" : "");
      // Ctrl-D, or nobody at the terminal.
      if (typed === undefined) return false;
      // Esc then Enter is an empty one too.
      const code = typed.replace(/\p{Cc}/gu, "");
      if (code === "") {
        if (browser) {
          try {
            if ((await logins.ended()) !== undefined) return true;
          } catch (error) {
            list.warn("claude login", words(error));
            return false;
          }
        }
        if (told) return false;
        told = true;
        list.note("No code yet: paste the code the page shows once you've signed in, or press Enter again to skip (the Claude step at the end has other ways).");
        continue;
      }
      try {
        await logins.finish(code);
        return true;
      } catch (error) {
        if (!logins.waiting) {
          list.warn("claude login", words(error));
          return false;
        }
        told = true;
        list.note(`${words(error)}. Paste it again, or press Enter to skip.`);
      }
    }
  } finally {
    logins.end();
  }
}
