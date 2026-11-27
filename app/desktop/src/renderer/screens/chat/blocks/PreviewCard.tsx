// A share link in a message as a card: what it shows, its port and machine, when it ends, and Open preview, which asks
// the workspace for a one-time way in (`share_link_open`) and opens it in the browser, signed in. The block holds no
// address; the card reads the link's state from `share_links_list`, so an ended or stopped one says so, and one on
// fleetd's computers says the link keeps that computer running.
import { MonitorPlay } from "lucide-react";
import { useState } from "react";
import type { PreviewBlock, ShareLink, ShareLinkOpenInput, ShareLinkOpenOutput } from "../../../../shared/contracts";
import { useData, useDataLayer, useToolQuery } from "../../../src/data/react";
import { selectMachines } from "../../../src/data/selectors";
import { FLEETD_COMPUTERS, keptRunning, RUNNER_ID } from "../../../../shared/providers";
import { Button, Text, toast, Truncate } from "../../../ui";
import b from "./blocks.module.css";

const noInput = {};

/** "until 4:30 PM", or "until Tue 4:30 PM" past today. */
export function untilText(at: string, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return today ? `until ${time}` : `until ${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

type Call = (tool: "share_link_open", input: ShareLinkOpenInput) => Promise<{ ok: true; output: ShareLinkOpenOutput } | { ok: false; error: { message: string } }>;

/** Opens a link signed in: a one-time code from the workspace, then the browser. */
export async function openPreview(call: Call, name: string, to?: string): Promise<void> {
  const got = await call("share_link_open", { name, ...(to === undefined || to === "/" ? {} : { to }) }).catch((e: unknown) => ({ ok: false as const, error: { message: String(e) } }));
  if (!got.ok) return void toast({ tone: "danger", title: "The preview didn’t open", description: got.error.message });
  const out = await window.fleetd.openExternal(got.output.url);
  if (!out.ok) toast({ tone: "danger", title: "The preview didn’t open", description: out.message });
}

export function useOpenPreview() {
  const layer = useDataLayer();
  return (name: string): Promise<void> => openPreview((tool, input) => layer.call(tool, input), name);
}

/** The machine's name as the app shows it; the workspace's hosted sandboxes are fleetd's computers. */
export function useMachineName(): (machineId: string) => string {
  const machines = useData(selectMachines);
  return (id) => (id === RUNNER_ID ? FLEETD_COMPUTERS : (machines?.find((m) => m.machine.machineId === id)?.machine.name ?? id));
}

export function PreviewCard({ preview }: { preview: PreviewBlock }) {
  const list = useToolQuery("share_links_list", noInput);
  const open = useOpenPreview();
  const machineName = useMachineName();
  const [busy, setBusy] = useState(false);
  const link: ShareLink | undefined = list.data?.links.find((l) => l.name === preview.name);
  const ended = list.data !== undefined && link === undefined;
  const port = link?.port ?? preview.port;
  const title = preview.label ?? link?.label ?? (port !== undefined ? `Preview of port ${port}` : "Preview");
  const meta = ended
    ? "This link has ended"
    : link !== undefined
      ? `${link.machineId === RUNNER_ID ? `Port ${link.port}` : `${machineName(link.machineId)}:${link.port}`} · ${untilText(link.expiresAt).replace(/^until/, "ends")}`
      : port !== undefined
        ? `Port ${port}`
        : "Share link";
  const kept = !ended && link !== undefined ? keptRunning(link.machineId) : undefined;
  const go = async () => {
    if (busy) return;
    setBusy(true);
    await open(preview.name);
    setBusy(false);
  };
  return (
    <div className={b.fileCard} data-block="preview" data-ended={ended ? "" : undefined}>
      <div className={b.fileRow}>
        <span className={b.fileGlyph} data-glyph="preview" aria-hidden>
          <MonitorPlay />
        </span>
        <span className={b.fileText}>
          <Truncate size="sm" expand="none">
            {title}
          </Truncate>
          <Text size="xs" tone="quiet" tabular>
            {meta}
          </Text>
          {kept !== undefined ? (
            <Text size="xs" tone="quiet" data-kept="">
              {kept}
            </Text>
          ) : null}
        </span>
        <span className={b.fileActions}>
          <Button variant="secondary" disabled={busy || ended} onClick={() => void go()}>
            {busy ? "Opening…" : "Open preview"}
          </Button>
        </span>
      </div>
    </div>
  );
}
