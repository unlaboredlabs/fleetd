// The badge of the tab whose pane gives a hook rather than a badge: History's lines since you last looked. It renders
// nothing until it has a number worth showing.
import { useActivityUnread } from "../activity";
import type { CountProps } from "./tabs";

export function ActivityCount({ project }: CountProps) {
  const n = useActivityUnread(project);
  return n > 0 ? String(n) : null;
}
