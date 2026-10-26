// The badges of the tabs whose panes give a hook rather than a badge: Activity's lines since you last looked, and the
// decisions in force. Each renders nothing until it has a number worth showing.
import { useActivityUnread } from "../activity";
import { useDecisionCount } from "../decisions/DecisionsPane";
import type { CountProps } from "./tabs";

export function ActivityCount({ project }: CountProps) {
  const n = useActivityUnread(project);
  return n > 0 ? String(n) : null;
}

export function DecisionCount({ project }: CountProps) {
  const n = useDecisionCount(project) ?? 0;
  return n > 0 ? String(n) : null;
}
