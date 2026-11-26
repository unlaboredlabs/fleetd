// Where connections' sign-ins come back to a self-hosted workspace (sign_ins_get): its https address, or fleetd's return
// page while it has none, which an admin turns off at the foot of Connections. "Give the workspace an https address"
// (https_address_add) runs Tailscale Serve there; it is offered on that row and in a sign-in that a service refused for
// want of https (reason needs_https). A workspace that doesn't serve sign_ins_get (the cloud, always https) shows none.
import { useCallback, useState } from "react";
import { NEEDS_HTTPS, type SignIns } from "../../../shared/contracts";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { Button, InlineCode, Text } from "../../ui";
import { useSettledAdministers } from "../admin/role";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import c from "./connections.module.css";

const noInput = {};
/** Tailscale Serve answers in seconds; a first certificate can take longer. */
const HTTPS_WAIT_MS = 60_000;

/** Whether a call failed because the service takes only an https sign-in address and the workspace has none. */
export const needsHttps = (e: unknown): boolean => e instanceof CallError && e.error.reason === NEEDS_HTTPS;

/** The host and port of an https address, as the row names it. */
export const hostOfHttps = (url: string): string => url.replace(/^https:\/\//, "").replace(/\/+$/, "");

/** The workspace's sign-in address, the switch, and the https button's call. */
export function useSignIns() {
  const live = useLive();
  const read = useToolQuery("sign_ins_get", noInput, { enabled: live });
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState<"https" | "switch" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const settle = useCallback(
    (work: Promise<SignIns>, what: "https" | "switch"): Promise<boolean> => {
      setBusy(what);
      setProblem(null);
      return work
        .then(
          () => true,
          (e: unknown) => {
            setProblem(errorText(e));
            return false;
          },
        )
        .finally(() => {
          setBusy(null);
          refetch(["sign_ins_get"]);
        });
    },
    [refetch],
  );
  const addHttps = useCallback(() => settle(call("https_address_add", noInput, { timeoutMs: HTTPS_WAIT_MS }), "https"), [call, settle]);
  const setReturnPage = useCallback((on: boolean) => void settle(call("sign_ins_set", { returnPage: on }), "switch"), [call, settle]);
  return { state: read.data, busy, problem, addHttps, setReturnPage };
}

/**
 * Under a sign-in a service refused for want of https: one plain line, then the fix. An admin gets the button, which
 * signs in again once the workspace has its address; anyone else is told who can.
 */
export function HttpsFix({ label, onFixed }: { label: string; onFixed: () => void }) {
  const admin = useSettledAdministers();
  const signIns = useSignIns();
  return (
    <div className={c.stack} data-needs-https="">
      <span role="alert">
        <Text size="sm" tone="danger">
          {`${label} only signs in to a workspace with an https address.`}
        </Text>
      </span>
      {admin ? (
        <div>
          <Button size="sm" disabled={signIns.busy !== null} onClick={() => void signIns.addHttps().then((ok) => ok && onFixed())}>
            {signIns.busy === "https" ? "Giving it one…" : "Give the workspace an https address"}
          </Button>
        </div>
      ) : (
        <Text size="sm" tone="quiet">
          An admin can give the workspace one in Connections.
        </Text>
      )}
      <Failed text={signIns.problem} />
    </div>
  );
}

/** Why the workspace has no https address yet, and the fix by hand: its `code` spans (a command) as code. */
export function Failed({ text }: { text: string | null }) {
  if (text === null) return null;
  const parts = text.split("`");
  return (
    <span role="alert">
      <Text size="sm" tone="danger">
        {parts.map((part, i) => (i % 2 === 1 && i < parts.length - 1 ? <InlineCode key={i}>{part}</InlineCode> : part))}
      </Text>
    </span>
  );
}
