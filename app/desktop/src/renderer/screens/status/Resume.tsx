// Resume: lifts a machine's usage pause now (usage_resume), where the pause shows: a Status row and the chat's
// blocked line. Every agent parked there is sent "continue"; one whose login is still limited parks again with the
// real reset. The hub decides who may (operate on the machine); a refusal shows in its own words.

import { useState } from "react";
import { Button, toast } from "../../ui";
import { useData, useDataLayer } from "../../src/data/react";

/** "Sent “continue” to 3 parked agents.": what usage_resume answered. */
export const resumedWords = (resumed: number): string =>
  resumed === 0 ? "Nothing was parked there." : `Sent “continue” to ${String(resumed)} parked ${resumed === 1 ? "agent" : "agents"}.`;

export function ResumeButton({ machineId }: { machineId: string }) {
  const layer = useDataLayer();
  const name = useData((d) => d.machines[machineId]?.name ?? machineId);
  const [busy, setBusy] = useState(false);
  const resume = async () => {
    setBusy(true);
    const out = await layer.call("usage_resume", { machineId });
    setBusy(false);
    if (!out.ok) {
      toast({ title: `Couldn't resume ${name}`, description: out.error.fix ?? out.error.message, tone: "danger" });
      return;
    }
    toast({
      title: `Resumed ${name}`,
      description: `${resumedWords(out.output.resumed)} If its login is still limited, they park again with the real reset.`,
      tone: "success",
      key: `usage-resume-${machineId}`,
    });
  };
  return (
    <Button variant="link" disabled={busy} onClick={() => void resume()} aria-label={`Resume ${name}: lift its usage pause now`}>
      {busy ? "Resuming…" : "Resume"}
    </Button>
  );
}
