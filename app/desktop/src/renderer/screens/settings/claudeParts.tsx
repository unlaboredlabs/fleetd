// What Settings › Your accounts › Claude and Settings › Hub accounts › Claude share: saving a key or token through main (which seals it to
// every machine; the page never gets it back), the Test button (one tiny claude call on a machine holding it), its
// verdict, and a confirm before removing one.
import { useState } from "react";
import type { ClaudeSealedOn, ClaudeTest, ClaudeTestTarget } from "../../../shared/contracts";
import type { ClaudeAccountRequest } from "../../../shared/ipc";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer } from "../../src/data/react";
import { Button, Dialog, Text } from "../../ui";
import { HubText } from "../projects/HubText";
import { boxesOf, missingOn, testLine } from "./claudeModel";
import { errorText, useHubCall, useRefetch } from "./hub";

/** A claude -p call takes up to 90 s on the node, plus the way there and back. */
const TEST_MS = 120_000;

export type Tried = { readonly test: ClaudeTest } | { readonly error: string };

/** Every machine's box key, and the machines agents run on. */
export function useMachines(): { boxes: ClaudeAccountRequest["boxes"]; ids: string[] } {
  const machines = useData((d) => d.machines);
  return { boxes: boxesOf(machines), ids: Object.keys(machines).sort() };
}

/** Tests an account; the verdict, or why it couldn't be tried. The hub records it as the account's last Test. */
export function useTest() {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  return async (account: ClaudeTestTarget): Promise<Tried> => {
    const tried = await hubCall("claude_account_test", { account }, { timeoutMs: TEST_MS }).then(
      (out): Tried => ({ test: out.test }),
      (e: unknown): Tried => ({ error: errorText(e) }),
    );
    refetch(["claude_accounts_get", "setup_list"]);
    return tried;
  };
}

/**
 * Saves through main, which seals the value to each machine, then tests it at once. The machines that didn't take it
 * (offline) come back to say so; the value itself never does.
 */
export function useSave() {
  const { hub } = useDataLayer();
  const refetch = useRefetch();
  const test = useTest();
  return async (request: ClaudeAccountRequest): Promise<{ ok: true; missing: string[]; tried: Tried | null } | { ok: false; problem: string }> => {
    const out = await window.fleetd.secret.claudeAccount(hub, request).catch((e: unknown) => ({ ok: false as const, problem: errorText(e) }));
    if (!out.ok) return { ok: false, problem: "problem" in out ? out.problem : errorText(new CallError(out.error)) };
    refetch(["claude_accounts_get", "setup_list"]);
    const missing = (out.output as { missingOn?: string[] } | null)?.missingOn ?? [];
    // An endpoint change alone keeps a key already tried; anything new is tried now.
    const fresh = request.account === "mine" || request.key !== undefined || request.endpoint !== undefined;
    return { ok: true, missing, tried: fresh ? await test(request.account) : null };
  };
}

/** A Test's verdict, or the last one the hub kept. */
export function TestResult({ tried, nowMs }: { tried: Tried | undefined; nowMs: number }) {
  if (tried === undefined) return null;
  if ("error" in tried) {
    return (
      <div role="alert">
        <Text size="sm" tone="danger">
          <HubText>{tried.error}</HubText>
        </Text>
      </div>
    );
  }
  const line = testLine(tried.test, nowMs);
  return (
    <div role={line.ok ? "status" : "alert"}>
      <Text size="sm" tone={line.ok ? "quiet" : "danger"}>
        <HubText>{line.text}</HubText>
      </Text>
    </div>
  );
}

/** Machines a secret isn't on: what runs there can't use it until it is saved again while they are online. */
export function MissingOn({ sealedOn, machines, there = "nothing runs on it there" }: { sealedOn: ReadonlyArray<ClaudeSealedOn>; machines: ReadonlyArray<string>; there?: string }) {
  const missing = missingOn(sealedOn, machines);
  if (missing.length === 0) return null;
  return (
    <div role="status">
      <Text size="sm" tone="warning">
        {`Not on ${missing.join(", ")}: ${there}. Save it again while ${missing.length === 1 ? "it is" : "they are"} online.`}
      </Text>
    </div>
  );
}

export function TestButton(props: { testing: boolean; onTest: () => void }) {
  return (
    <Button size="sm" variant="ghost" disabled={props.testing} onClick={props.onTest}>
      {props.testing ? "Testing…" : "Test"}
    </Button>
  );
}

export function Problem({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <div role="alert">
      <Text size="sm" tone="danger">
        <HubText>{text}</HubText>
      </Text>
    </div>
  );
}

/** Asks before a key or token is removed; the hub's call, then the page's refetch. */
export function ConfirmRemove(props: { title: string; description: string; action: string; onRemove: () => Promise<unknown>; onClose: () => void }) {
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = () => {
    setBusy(true);
    setProblem(null);
    props.onRemove().then(
      () => {
        setBusy(false);
        refetch(["claude_accounts_get", "setup_list"]);
        props.onClose();
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && props.onClose()}
      title={props.title}
      description={props.description}
      footer={
        <>
          <Button onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={go}>
            {busy ? "Removing…" : props.action}
          </Button>
        </>
      }
    >
      <Problem text={problem} />
    </Dialog>
  );
}
