// Kept free of React so the time fixtures (tsconfig.fixtures.json) can read the same words.
export type AgentRole = "lead" | "implementer" | "reader" | "reviewer" | "verifier" | "qa";

/** Each role's one name in the app; an implementer is a writer everywhere the user reads it (and in the docs). */
export const ROLE_WORD: Record<AgentRole, string> = {
  lead: "lead",
  implementer: "writer",
  reader: "reader",
  reviewer: "reviewer",
  verifier: "verifier",
  qa: "QA",
};
