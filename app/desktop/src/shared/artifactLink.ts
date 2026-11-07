// The message a link click inside an HTML artifact's frame posts to the app's page (main/artifactFrames.ts puts the
// script that sends it; renderer/screens/artifacts/HtmlFrame.tsx opens the link): `{ [ARTIFACT_LINK]: href }`.
export const ARTIFACT_LINK = "fleetdArtifactLink";

/** The link a frame's message names when it carries the page's `key`, or undefined for any other message. */
export const linkOf = (data: unknown, key: string): string | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const { [ARTIFACT_LINK]: href, key: carried } = data as Record<string, unknown>;
  return typeof href === "string" && carried === key ? href : undefined;
};
