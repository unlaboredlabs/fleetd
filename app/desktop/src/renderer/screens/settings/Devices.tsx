// Settings › You › Your devices: the devices signed in as you on each hub, and Pair a phone. Pair a phone mints a
// one-time code (pair_code_create, 15 minutes, as `fleetd pair` does) and shows its fleetd://pair link as a QR for the
// phone app or the Camera to scan, with the hub address and code under it for typing. When the phone has paired (its
// key.paired event refetches people_list), the QR gives way to the new phone, which also joins the list.
import { Check, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentKeyInfo, PairCodeCreateOutput } from "../../../shared/contracts";
import { Button, Text } from "../../ui";
import { HubScope, useData, useHubs } from "../../src/data/react";
import { usePeople } from "../admin/usePeople";
import { Prose } from "../onboarding/Prose";
import { when } from "../status/view";
import { codeLife, deviceLine, pairedSince, qrPath, yourDevices } from "./devicesModel";
import { errorText, useHubCall, useLive } from "./hub";
import { PagePart } from "./parts";
import a from "../admin/admin.module.css";
import s from "./settings.module.css";

/** Each paired hub's part: with one hub, just Your devices. */
export function DevicesSettings() {
  const hubs = useHubs();
  return (
    <>
      {hubs.map((hub) => (
        <HubScope key={hub.id} hub={hub}>
          <YourDevices title={hubs.length === 1 ? "Your devices" : `On ${hub.label}`} reveal={hubs.length === 1 ? "devices.pair" : `devices.${hub.id}`} />
        </HubScope>
      ))}
    </>
  );
}

type Pairing =
  | { readonly phase: "making" }
  | { readonly phase: "shown"; readonly out: PairCodeCreateOutput; readonly before: ReadonlySet<string> }
  | { readonly phase: "failed"; readonly error: string };

function YourDevices({ title, reveal }: { title: string; reveal: string }) {
  const live = useLive();
  const read = usePeople();
  const call = useHubCall();
  // Where this app reaches the hub: the hub puts it in the link unless it is loopback.
  const appUrl = useData((st) => (st.hub.phase === "unpaired" ? undefined : st.hub.hub));
  const [pairing, setPairing] = useState<Pairing | null>(null);
  // Day-grained, so the time the page opened is close enough.
  const [now] = useState(() => Date.now());
  const devices = yourDevices(read.data);
  const paired = pairing?.phase === "shown" ? pairedSince(devices, pairing.before) : undefined;
  const pair = () => {
    const before = new Set(devices.map((d) => d.keyId));
    setPairing({ phase: "making" });
    call("pair_code_create", appUrl === undefined ? {} : { hubUrl: appUrl })
      .then((out) => setPairing({ phase: "shown", out, before }))
      .catch((e: unknown) => setPairing({ phase: "failed", error: errorText(e) }));
  };
  return (
    <PagePart
      title={title}
      reveal={reveal}
      intro="Each of these acts as you on this hub, on every machine."
      aside={
        pairing === null ? (
          <Button icon={<Smartphone size={14} />} disabled={!live || read.data === undefined} onClick={pair}>
            Pair a phone
          </Button>
        ) : null
      }
    >
      {pairing === null ? null : <PairPhone pairing={pairing} paired={paired} onAgain={pair} onClose={() => setPairing(null)} />}
      {read.error ? (
        <Text tone="danger">{`Couldn't read your devices: ${errorText(read.error)}`}</Text>
      ) : read.data === undefined ? (
        <Text tone="quiet">Loading…</Text>
      ) : devices.length === 0 ? (
        <Text tone="quiet">No device is signed in as you.</Text>
      ) : (
        <div className={a.list} role="list" aria-label="Your devices">
          {devices.map((d) => (
            <DeviceRow key={d.keyId} device={d} just={d.keyId === paired?.keyId} now={now} />
          ))}
        </div>
      )}
    </PagePart>
  );
}

function DeviceRow({ device: d, just, now }: { device: AgentKeyInfo; just: boolean; now: number }) {
  return (
    <div className={a.row} role="listitem" aria-label={d.name}>
      <div className={a.who}>
        <div className={a.name}>
          <Text strong>{d.name}</Text>
          {just ? (
            <Text size="xs" tone="success">
              just paired
            </Text>
          ) : null}
        </div>
        <Text size="xs" tone="quiet">
          {deviceLine(d, (iso) => when(iso, now))}
        </Text>
      </div>
    </div>
  );
}

/** Now, from the mount and again every 10 s while `on`: a code's minutes left, and its end. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

function PairPhone({ pairing, paired, onAgain, onClose }: { pairing: Pairing; paired: AgentKeyInfo | undefined; onAgain: () => void; onClose: () => void }) {
  const waiting = pairing.phase === "shown" && paired === undefined;
  const now = useNow(waiting);
  return (
    <section className={s.pairing} aria-label="Pair a phone">
      <Text strong>Pair a phone</Text>
      {pairing.phase === "making" ? (
        <Text size="sm" tone="quiet">
          Making a code…
        </Text>
      ) : pairing.phase === "failed" ? (
        <div role="alert">
          <Prose size="sm" tone="danger" text={`No code: ${pairing.error}`} />
        </div>
      ) : paired !== undefined ? (
        <div className={s.hubLine} role="status">
          <Check size={14} color="var(--success)" />
          <Text size="sm">{`${paired.name} paired. It acts as you on this hub now.`}</Text>
        </div>
      ) : (
        <Shown out={pairing.out} life={codeLife(pairing.out.expiresAt, now)} />
      )}
      <div className={s.actions}>
        {pairing.phase === "failed" || (pairing.phase === "shown" && paired === undefined && codeLife(pairing.out.expiresAt, now) === null) ? (
          <Button variant="primary" onClick={onAgain}>
            New code
          </Button>
        ) : null}
        <Button variant={paired === undefined ? "ghost" : "primary"} onClick={onClose}>
          {paired === undefined ? "Cancel" : "Done"}
        </Button>
      </div>
    </section>
  );
}

/** The QR, and under it the address and code for typing, and how long the code lasts. */
function Shown({ out, life }: { out: PairCodeCreateOutput; life: string | null }) {
  if (life === null) {
    return (
      <Text size="sm" tone="quiet">
        This code expired, unused. Make a new one to pair the phone.
      </Text>
    );
  }
  const qr = qrPath(out.link);
  return (
    <div className={s.pairPhone}>
      <svg className={s.qr} viewBox={`0 0 ${String(qr.size)} ${String(qr.size)}`} role="img" aria-label="Pairing QR code" shapeRendering="crispEdges" data-link={out.link}>
        <rect width={qr.size} height={qr.size} fill="#fff" />
        <path d={qr.path} fill="#000" />
      </svg>
      <div className={s.stack}>
        <Text size="sm">Scan it with the fleetd app on your phone, or with its Camera.</Text>
        <Text size="xs" tone="quiet">
          Or open the app, then enter:
        </Text>
        <dl className={s.pairFields}>
          <dt>
            <Text size="xs" tone="quiet">
              Hub
            </Text>
          </dt>
          <dd>
            <Text mono size="sm">
              {out.hubUrl}
            </Text>
          </dd>
          <dt>
            <Text size="xs" tone="quiet">
              Code
            </Text>
          </dt>
          <dd>
            <Text mono size="sm" strong>
              {out.code}
            </Text>
          </dd>
        </dl>
        <Text size="xs" tone="quiet">
          {life}
        </Text>
      </div>
    </div>
  );
}
