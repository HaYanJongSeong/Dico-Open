import { describe, it, expect } from 'vitest';
import { checkUserAllowed, checkAgentAllowed } from './permissions.js';
import type { ChannelConfig } from '../config/types.js';

const baseChannel: ChannelConfig = {
  channelId: '123',
  projectPath: '/tmp',
};

describe('checkUserAllowed', () => {
  it('allows any user when allowedUsers is undefined', () => {
    expect(checkUserAllowed(baseChannel, 'anyone')).toBe(true);
  });

  it('allows any user when allowedUsers is empty', () => {
    const channel = { ...baseChannel, allowedUsers: [] };
    expect(checkUserAllowed(channel, 'anyone')).toBe(true);
  });

  it('allows user in allowedUsers list', () => {
    const channel = { ...baseChannel, allowedUsers: ['user1', 'user2'] };
    expect(checkUserAllowed(channel, 'user1')).toBe(true);
  });

  it('rejects user not in allowedUsers list', () => {
    const channel = { ...baseChannel, allowedUsers: ['user1'] };
    expect(checkUserAllowed(channel, 'user2')).toBe(false);
  });
});

describe('checkAgentAllowed', () => {
  it('allows any agent when allowAgentSwitch is undefined (default true)', () => {
    expect(checkAgentAllowed(baseChannel, 'any-agent')).toBe(true);
  });

  it('rejects agent switch when allowAgentSwitch is false', () => {
    const channel = { ...baseChannel, allowAgentSwitch: false };
    expect(checkAgentAllowed(channel, 'code')).toEqual({
      allowed: false,
      reason: 'AGENT_SWITCH_DISABLED',
    });
  });

  it('allows agent in allowedAgents list', () => {
    const channel = { ...baseChannel, allowedAgents: ['code', 'build'] };
    expect(checkAgentAllowed(channel, 'code')).toBe(true);
  });

  it('rejects agent not in allowedAgents list', () => {
    const channel = { ...baseChannel, allowedAgents: ['code'] };
    expect(checkAgentAllowed(channel, 'hack')).toEqual({
      allowed: false,
      reason: 'AGENT_NOT_ALLOWED',
    });
  });

  it('allows any agent when allowedAgents is empty', () => {
    const channel = { ...baseChannel, allowedAgents: [] };
    expect(checkAgentAllowed(channel, 'anything')).toBe(true);
  });
});
