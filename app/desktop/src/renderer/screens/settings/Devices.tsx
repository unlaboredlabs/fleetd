// Settings › You › Your devices: the devices signed in as you on each hub, and Pair a phone. Pair a phone mints a
// one-time code (pair_code_create, 15 minutes, as `fleetd pair` does) and shows its fleetd://pair link as a QR for the
// phone app or the Camera to scan, with the hub address and code under it for typing. When the phone has paired (its
// key.paired event refetches people_list), the QR gives way to the new phone, which also joins the list. Each other
// device has Sign out (device_revoke, once confirmed): its key stops working at once, and the hub links made on it with
// it, which the confirm counts (hub_links_get). The hub says which device this app is (people_list's thisDevice), and
// that one has none: signing it out would cut this app off.
import { Check, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentKeyInfo, PairCodeCreateOutput } from "../../../shared/contracts";
import { Button, Dialog, Text } from "../../ui";
import { HubScope, useData, useHubs, useToolQuery } from "../../src/data/react";
import { usePeople } from "../admin/usePeople";
import { Prose } from "../onboarding/Prose";
import { when } from "../live/when";
import { codeLife, deviceLine, linksMadeOn, pairedSince, qrPath, signOutLine, yourDevices } from "./devicesModel";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { GroupNote, SettingsList, SettingsListRow, SettingsRow, SettingsSection } from "./parts";
import s from "./settings.module.css";

/** Each paired hub's part: with one hub, just the list and Pair a phone, under the page's own title. */
export function DevicesSettings() {
  const hubs = useHubs();
  return (
    <>
      {hubs.map((hub) => (
        <HubScope key={hub.id} hub={hub}>
          <YourDevices title={hubs.length === 1 ? "Your devices" : `On ${hub.label}`} reveal={hubs.length === 1 ? "devices.pair" : `devices.${hub.id}`} one={hubs.length === 1} />
        </HubScope>
      ))}
    </>
  );
}

type Pairing =
  | { readonly phase: "making" }
  | { readonly phase: "shown"; readonly out: PairCodeCreateOutput; readonly before: ReadonlySet<string> }
  | { readonly phase: "failed"; readonly error: string };

function YourDevices({ title, reveal, one }: { title: string; reveal: string; one: boolean }) {
  const live = useLive();
  const read = usePeople();
  const call = useHubCall();
  // Where this app reaches the hub: the hub puts it in the link unless it is loopback.
  const appUrl = useData((st) => (st.hub.phase === "unpaired" ? undefined : st.hub.hub));
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [signingOut, setSigningOut] = useState<AgentKeyInfo | null>(null);
  // Day-grained, so the time the page opened is close enough.
  const [now] = useState(() => Date.now());
  const devices = yourDevices(read.data);
  const here = read.data?.thisDevice;
  const paired = pairing?.phase === "shown" ? pairedSince(devices, pairing.before) : undefined;
  const pair = () => {
    const before = new Set(devices.map((d) => d.keyId));
    setPairing({ phase: "making" });
    call("pair_code_create", appUrl === undefined ? {} : { hubUrl: appUrl })
      .then((out) => setPairing({ phase: "shown", out, before }))
      .catch((e: unknown) => setPairing({ phase: "failed", error: errorText(e) }));
  };
  return (
    <SettingsSection
      title={one ? undefined : title}
      reveal={reveal}
      hint="The apps signed in as you. Each acts as you on this hub, on every machine."
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
        <GroupNote tone="danger">{`Couldn't read your devices: ${errorText(read.error)}`}</GroupNote>
      ) : read.data === undefined ? (
        <GroupNote>Loading…</GroupNote>
      ) : devices.length === 0 ? (
        <GroupNote>No device is signed in as you.</GroupNote>
      ) : (
        <SettingsList label="Your devices">
          {devices.map((d) => (
            <DeviceRow
              key={d.keyId}
              device={d}
              just={d.keyId === paired?.keyId}
              here={d.keyId === here}
              now={now}
              onSignOut={here === undefined || d.keyId === here ? undefined : () => setSigningOut(d)}
            />
          ))}
        </SettingsList>
      )}
      <SignOutDialog device={signingOut} onClose={() => setSigningOut(null)} />
    </SettingsSection>
  );
}

function DeviceRow({
  device: d,
  just,
  here,
  now,
  onSignOut,
}: {
  device: AgentKeyInfo;
  just: boolean;
  here: boolean;
  now: number;
  onSignOut: (() => void) | undefined;
}) {
  const live = useLive();
  return (
    <SettingsListRow
      name={d.name}
      label={d.name}
      meta={here ? "this computer" : undefined}
      {...(just ? { state: { word: "just paired", tone: "success" as const } } : {})}
      controls={
        onSignOut === undefined ? undefined : (
          <Button size="sm" variant="ghost" disabled={!live} onClick={onSignOut}>
            Sign out
          </Button>
        )
      }
    >
      <Text size="sm" tone="quiet">
        {deviceLine(d, (iso) => when(iso, now))}
      </Text>
    </SettingsListRow>
  );
}

const noInput = {};

/** Asks before signing a device out: it stops working on this hub at once, until it is paired again, with its hub links. */
function SignOutDialog({ device, onClose }: { device: AgentKeyInfo | null; onClose: () => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const live = useLive();
  // A hub too old for links answers with an error: no count, as before.
  const links = useToolQuery("hub_links_get", noInput, { enabled: live && device !== null });
  const made = device === null ? 0 : linksMadeOn(links.data?.issued, device.keyId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const name = device?.name ?? "";
  const close = () => {
    setError(undefined);
    onClose();
  };
  const signOut = () => {
    if (device === null) return;
    setBusy(true);
    setError(undefined);
    call("device_revoke", { keyId: device.keyId })
      .then(() => {
        refetch(["people_list", "hub_links_get"]);
        close();
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog
      open={device !== null}
      onOpenChange={(open) => !open && close()}
      title={`Sign out ${name}?`}
      description={signOutLine(made)}
      footer={
        <>
          {error === undefined ? null : (
            <p role="alert" className={s.alertLine}>
              <Text size="xs" tone="danger">
                {error}
              </Text>
            </p>
          )}
          <Button onClick={close}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={signOut}>
            {`Sign out ${name}`}
          </Button>
        </>
      }
    />
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
    <SettingsRow
      title="Pair a phone"
      control={
        <>
          {pairing.phase === "failed" || (pairing.phase === "shown" && paired === undefined && codeLife(pairing.out.expiresAt, now) === null) ? (
            <Button variant="primary" onClick={onAgain}>
              New code
            </Button>
          ) : null}
          <Button variant={paired === undefined ? "ghost" : "primary"} onClick={onClose}>
            {paired === undefined ? "Cancel" : "Done"}
          </Button>
        </>
      }
    >
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
    </SettingsRow>
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
