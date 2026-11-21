// agent-browser's own skill as a Claude Code plugin, with nothing of the machine's: the plugin's files, made from the
// skill's SKILL.md (the agent-browser package's `skills/agent-browser/SKILL.md` at the pinned VERSION). The node
// writes them under its home (./agent_browser.ts); a service with no node writes them into the agent's box. Either
// gives the agent's claude `--plugin-dir` at the folder they are written in.

/** The plugin's manifest. */
export const PLUGIN_MANIFEST = { name: "agent-browser", description: "agent-browser's skill, for the browser session fleetd opens with session_start." };

/** The plugin's files, each by its path in the plugin's folder, from the skill's SKILL.md text. */
export function pluginFiles(skill: string): { path: string; text: string }[] {
  return [
    { path: ".claude-plugin/plugin.json", text: `${JSON.stringify(PLUGIN_MANIFEST)}\n` },
    { path: "skills/agent-browser/SKILL.md", text: skill },
  ];
}
