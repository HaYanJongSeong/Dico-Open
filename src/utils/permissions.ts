import type { ChannelConfig } from '../config/types.js';

/**
 * Check if a user is allowed to interact in a channel.
 * @param channel - Channel configuration
 * @param userId - Discord user ID
 * @returns true if allowed (empty allowedUsers means everyone allowed)
 */
export function checkUserAllowed(channel: Pick<ChannelConfig, 'allowedUsers'>, userId: string): boolean {
  if (!channel.allowedUsers || channel.allowedUsers.length === 0) {
    return true;
  }

  return channel.allowedUsers.includes(userId);
}

export type AgentCheckResult = true | { allowed: false; reason: 'AGENT_SWITCH_DISABLED' | 'AGENT_NOT_ALLOWED' };

/**
 * Check if an agent selection is allowed for a channel.
 * @param channel - Channel configuration
 * @param agentName - Agent name to validate
 * @returns true if allowed, or rejection reason object
 */
export function checkAgentAllowed(channel: ChannelConfig, agentName: string): AgentCheckResult {
  if (channel.allowAgentSwitch === false) {
    return { allowed: false, reason: 'AGENT_SWITCH_DISABLED' };
  }

  if (channel.allowedAgents && channel.allowedAgents.length > 0) {
    if (!channel.allowedAgents.includes(agentName)) {
      return { allowed: false, reason: 'AGENT_NOT_ALLOWED' };
    }
  }

  return true;
}
