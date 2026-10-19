// Switches that would let another local process drive the app: Chromium's DevTools protocol reaches the page, which
// holds window.fleetd (hub calls with the saved key), and Node's inspector reaches main itself.

/** Chromium takes "--x" and, on macOS and Linux, "-x"; values follow "=". */
const DEBUG_SWITCH = /^--?(remote-debugging-[a-z-]+|inspect(?:-brk|-port|-publish-uid|-wait)?)(?:=|$)/iu;

/** Also asked of Chromium's own parsed command line, which may hold switches added from elsewhere. */
export const DEBUG_SWITCH_NAMES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "inspect-wait",
] as const;

/** The exit code when a release build refuses to start. */
export const DEBUG_REFUSED_EXIT = 3;

/**
 * The debug switches present: in argv, in ELECTRON_EXTRA_LAUNCH_ARGS (Electron appends it to the command line), in
 * NODE_OPTIONS, or on the parsed command line. Lower-cased, sorted, without values.
 */
export const debugSwitches = (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  hasSwitch: (name: string) => boolean,
): Array<string> => {
  const found = new Set<string>();
  const scan = (args: ReadonlyArray<string>) => {
    for (const arg of args) {
      const name = DEBUG_SWITCH.exec(arg)?.[1];
      if (name !== undefined) found.add(name.toLowerCase());
    }
  };
  const words = (value: string | undefined) => (value ?? "").split(/\s+/u).filter((w) => w !== "");
  scan(argv);
  scan(words(env["ELECTRON_EXTRA_LAUNCH_ARGS"]));
  scan(words(env["NODE_OPTIONS"]));
  for (const name of DEBUG_SWITCH_NAMES) if (hasSwitch(name)) found.add(name);
  return [...found].sort();
};
