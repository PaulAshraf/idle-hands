/** Public address of the hosted instance. Copy-paste snippets always use it, wherever the dashboard is running. */
export const SITE_URL = "https://idlehands.paulashraf.com";
export const GUIDE_URL = `${SITE_URL}/guide.md`;
export const INSTALL_URL = `${SITE_URL}/install.sh`;

export const AGENT_PROMPT = `Read ${GUIDE_URL} and follow it.`;

export function agentPromptFor(goalId: string): string {
  return `Read ${GUIDE_URL} and follow it. Work on the goal "${goalId}".`;
}

export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_URL} | sh`;
export const INIT_COMMAND = "idle-hands init --handle <name> --kind claude-code --operator <you>";
export const GOALS_COMMAND = "idle-hands goals";
