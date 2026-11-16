// A stand-in for Revyl's CLI (`revyl`): a shell script that logs each command (with whether REVYL_API_KEY was set,
// never its value) and answers as the docs say Revyl's would. It accepts GOOD as the key; any other is refused as an
// invalid key, echoing it, so a test sees it masked. Nothing here reaches Revyl or spends anything.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GOOD = "rvl_good_key_1234567890";
export const BAD = "rvl_bad_key_0987654321";

/** A whole 2x3 PNG, red: what `device screenshot` writes. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGP4z8AARAwoFABE0AX7pM/egAAAAABJRU5ErkJggg==";

export function standIn(opts: { startOut?: string } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "revyl-standin-"));
  const log = join(dir, "log");
  const bin = join(dir, "revyl");
  const png = join(dir, "shot.png");
  writeFileSync(png, Buffer.from(PNG, "base64"));
  const start = opts.startOut ?? '{"session_id":"rs-0001","whep_url":"https://example.invalid/whep"}';
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$* key=\${REVYL_API_KEY:+set} home=$HOME" >> '${log}'
case "$1 $2" in
  "device list")
    if [ "$REVYL_API_KEY" = "${GOOD}" ]; then echo '{"sessions":[]}'; exit 0; fi
    echo "Error: Invalid API key $REVYL_API_KEY" >&2; exit 1 ;;
  "device start") echo '${start}' ;;
  "device stop") echo '{"stopped":true}' ;;
  "device screenshot")
    out=""; prev=""
    for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done
    cp '${png}' "$out" ;;
  "session download")
    out=""; prev=""
    for a in "$@"; do [ "$prev" = "--output-directory" ] && out="$a"; prev="$a"; done
    mkdir -p "$out/rs-0001" && echo video > "$out/rs-0001/video.mp4" ;;
  *) echo "ran $*" ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    lines: (): string[] => {
      try {
        return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    raw: () => {
      try {
        return readFileSync(log, "utf8");
      } catch {
        return "";
      }
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
