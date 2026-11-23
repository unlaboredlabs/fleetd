// Sections that moved when the docs were rebuilt (W846). A redirect in site/vercel.json can't see a link's #section,
// but the browser keeps it: /docs/projects#max-agents lands on /docs/bots#max-agents. On a page here, a #section that
// no longer exists on it is sent on to where that section lives now.
export const OLD_ANCHORS = {
  "/docs/bots": {
    "max-agents": "/docs/models#max-agents",
    models: "/docs/models#profiles",
    antigravity: "/docs/models#gemini",
    "lead-profile": "/docs/models#lead-model",
    env: "/docs/vault",
    approvals: "/docs/approvals-and-secrets#modes",
    purchases: "/docs/payments-and-sign-ins#purchases",
    "sign-ins": "/docs/payments-and-sign-ins#sign-ins",
    "secure-input": "/docs/payments-and-sign-ins#secure-input",
    computer: "/docs/bots#settings",
    setup: "/docs/bots#settings",
    sections: "/docs/bots#sidebar",
    "start-a-new-project": "/docs/bots#new",
    "add-a-project": "/docs/bots#new",
    "lead-setup": "/docs/bots#lead-changes",
    "lead-propose": "/docs/bots#lead-changes",
    asked: "/docs/bots#bots-talk",
    "lead-texts": "/docs/bots#bots-talk",
    skills: "/docs/skills#learned",
    branches: "/docs/merge-train",
    clients: "/docs/reference/agent-tools",
  },
  "/docs/what-agents-are-told": {
    memory: "/docs/memory#memory",
    "memory-refresh": "/docs/memory#memory-refresh",
    "memory-tidy": "/docs/memory#memory-tidy",
    "memory-import": "/docs/memory#memory-import",
    checklist: "/docs/desktop-app#checklist",
    "tagged-chat": "/docs/chat",
    safety: "/docs/reference/agent-tools",
    "agent-tools": "/docs/reference/agent-tools",
  },
  "/docs/merge-train": {
    "fast-set": "/docs/merge-train-ci#fast-set",
    "ci-time": "/docs/merge-train-ci#ci-time",
    "scarce-runners": "/docs/merge-train-ci#scarce-runners",
    "next-label": "/docs/merge-train-ci#next-label",
    regenerate: "/docs/merge-train-ci#regenerate",
  },
  "/docs/mcp-clients": { "key-file": "/docs/mcp-clients#roles" },
  "/docs/glossary": {
    node: "/docs/glossary#worker",
    workstream: "/docs/glossary#order",
    "human-key": "/docs/mcp-clients#human-key",
    "agent-key": "/docs/mcp-clients#human-key",
  },
  "/docs/troubleshooting": { "slow-start": "/docs/troubleshooting#stuck" },
};

/** The inline script every page carries: once the page is read, it looks up its own path in the map above. */
export const oldAnchorScript = `document.addEventListener("DOMContentLoaded", () => {
  const moved = ${JSON.stringify(OLD_ANCHORS)}[location.pathname.replace(/(\\.html|\\/)$/, "")];
  const id = decodeURIComponent(location.hash.slice(1));
  if (moved && id && moved[id] && !document.getElementById(id)) location.replace(moved[id]);
});`;
