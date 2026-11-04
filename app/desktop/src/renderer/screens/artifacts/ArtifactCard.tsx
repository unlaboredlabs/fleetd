// A published artifact's card in the chat (W367): its title over its format, version and who published it; the
// whole card opens that version in the panel's Artifacts.
import type { ArtifactPublished } from "../../../shared/contracts";
import { Text } from "../../ui";
import { navigate } from "../shell/navigation";
import { panelRoute, type ProjectKey } from "../shell/routes";
import { FormatIcon } from "./ArtifactsPane";
import { formatWord } from "./model";
import s from "./artifacts.module.css";

export function ArtifactCard({ project, published, at }: { project: ProjectKey; published: ArtifactPublished; at: string }) {
  const line = [formatWord(published.format), ...(published.version > 1 ? [`version ${String(published.version)}`] : []), published.by].join(" · ");
  return (
    <button
      type="button"
      className={s.card}
      data-artifact-card={published.name}
      aria-label={`Open ${published.title}`}
      onClick={() => navigate(panelRoute(project, { tab: "artifacts", artifact: published.name, version: published.version }))}
    >
      <FormatIcon format={published.format} className={s.cardIcon} />
      <span className={s.words}>
        <span className={s.title}>{published.title}</span>
        <Text size="xs" tone="quiet" className={s.meta}>
          {line}
        </Text>
      </span>
      <span className={s.cardTime}>{at}</span>
    </button>
  );
}
