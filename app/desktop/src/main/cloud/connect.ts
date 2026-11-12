// Connect this computer, where a person signed in to fleetd cloud lands with no machine (hosted-plan §1): main asks
// the hub for a join line with no machine name (machine_join with none: the computer joins under its own name) and
// runs it in a terminal, where the install says what it does. The page never sees this code. Main builds the line
// itself from the hub's address and code, so a hub can't have the app run a command of its choosing.
import type { ConnectComputerOutcome } from "../../shared/cloud";
import type { CallOutcome } from "../../shared/hub";
import { openJoinLine, type TerminalDeps } from "../pairing/terminal";

/** Quoted for the shell only when it needs it (the CLI's `q`, fleetd/src/cli/pair.ts). */
const q = (value: string): string => (value !== "" && /^[A-Za-z0-9_/.,:@%+=-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);

/** The installer's join line (fleetd/src/cli/pair.ts joinLine) with no machine id. */
export const joinLine = (hub: string, code: string, identity?: string): string =>
  `curl -fsSL https://fleetd.sh | sh -s -- --join ${q(hub)} --code ${q(code)}${identity === undefined ? "" : ` --git-identity ${q(identity)}`}`;

const str = (o: unknown, key: string): string | undefined => {
  const v = typeof o === "object" && o !== null ? (o as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v : undefined;
};

const httpUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
};

export const connectComputer = async (call: (tool: "machine_join", input: Record<string, never>) => Promise<CallOutcome>, terminal: TerminalDeps): Promise<ConnectComputerOutcome> => {
  const join = await call("machine_join", {});
  if (!join.ok) return { ok: false, message: join.error.message };
  const hub = str(join.output, "hubUrl");
  const code = str(join.output, "code");
  if (hub === undefined || code === undefined || !httpUrl(hub) || !/^[A-Za-z0-9_-]{1,200}$/u.test(code)) {
    return { ok: false, message: "The hub answered with a join line this app doesn't understand. Copy the line below instead." };
  }
  const opened = await openJoinLine(terminal, joinLine(hub, code, str(join.output, "gitIdentity")));
  return opened.ok ? opened : { ok: false, message: "Couldn't open a terminal. Run the line below in one on this computer." };
};
