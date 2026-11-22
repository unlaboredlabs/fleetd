// An artifact's format as its icon: in a module of its own, so the chat's artifact card doesn't bring the Artifacts
// pane (and its styles) into the web's first load.
import { FileCode2, FileText } from "lucide-react";
import type { ArtifactFormat } from "../../../shared/contracts";

export function FormatIcon({ format, className }: { format: ArtifactFormat; className?: string | undefined }) {
  const Icon = format === "html" ? FileCode2 : FileText;
  return <Icon aria-hidden className={className} />;
}
