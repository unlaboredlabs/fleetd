import { parseArgs } from "node:util";
import * as Auth from "@fleetd/hub/auth/Auth.ts";
import * as HubDb from "@fleetd/hub/store/HubDb.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CliResult } from "./cli.ts";

export const HUB_DEVICE_USAGE = `  hub device add --name <device> --url <hub url> [--home <dir>]
             print a one-time pairing link (15 min) for the phone web app; opening it gives
             the device its own human key (see \`hub key list\`, revoke with \`hub key revoke\`)
`;

const fail = (code: number, message: string): CliResult => ({ code, stdout: "", stderr: `fleetd: ${message}\n` });
const usage = (message: string) => fail(2, `${message}\n\nusage:\n${HUB_DEVICE_USAGE}`);

const isLoopback = (host: string) => host === "localhost" || host === "[::1]" || host.startsWith("127.");

/** `fleetd hub device add`. Writes the hub home's database directly, like `hub key`. */
export const hubDevice = (argv: ReadonlyArray<string>): CliResult => {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({ args: [...rest], options: { home: { type: "string" }, name: { type: "string" }, url: { type: "string" } } }));
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  if (command !== "add") return usage(command ? `unknown hub device command '${command}'` : "missing hub device command");
  const name = values.name?.trim();
  if (!name || name.length > 80 || /[\r\n]/u.test(name)) return usage("--name is required: a short device name such as phone");
  let url: URL;
  try {
    url = new URL(values.url ?? "");
  } catch {
    return usage("--url is required: the address the device opens the hub at, e.g. https://forge.tailnet.ts.net");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return usage(`--url must be http(s), got '${values.url}'`);

  return Effect.runSync(
    HubDb.resolveHubHome(values.home).pipe(
      Effect.flatMap((home) =>
        Effect.gen(function* () {
          const { token, expiresAt } = yield* (yield* Auth.Auth).createPairToken(name);
          const insecure = url.protocol === "http:" && !isLoopback(url.hostname);
          return {
            code: 0,
            stdout: `${url.origin}/#pair=${token}\n`,
            stderr:
              `one-time pairing link for ${name}, valid until ${expiresAt}. Open it on the device.\n` +
              (insecure ? "warning: the app needs HTTPS for push and its service worker; put the hub behind Tailscale Serve or your own TLS.\n" : ""),
          };
        }).pipe(Effect.provide(Auth.layer.pipe(Layer.provide(HubDb.layer(home))))),
      ),
      Effect.catchTags({ HubHomeError: (error) => Effect.succeed(fail(1, error.message)) }),
    ),
  );
};
