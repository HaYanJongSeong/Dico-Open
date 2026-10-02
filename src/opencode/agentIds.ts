/**
 * List agent IDs that can be used directly for a session.
 * @param agents - Raw OpenCode agent metadata from the SDK cache
 * @returns Selectable agent IDs in source order
 */
export function listSelectableAgentIds(agents: unknown[]): string[] {
  return agents
    .filter(isSelectableAgent)
    .map(getAgentId)
    .filter((agent): agent is string => Boolean(agent));
}

function isSelectableAgent(agent: unknown): boolean {
  if (!isRecord(agent)) {
    return false;
  }

  if (agent.hidden === true || agent.disable === true) {
    return false;
  }

  return agent.mode === undefined || agent.mode === 'primary' || agent.mode === 'all';
}

function getAgentId(agent: unknown): string | undefined {
  if (!isRecord(agent)) {
    return undefined;
  }

  return typeof agent.name === 'string' ? agent.name : typeof agent.id === 'string' ? agent.id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
