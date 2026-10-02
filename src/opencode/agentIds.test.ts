import { describe, expect, it } from 'vitest';
import { listSelectableAgentIds } from './agentIds.js';

describe('listSelectableAgentIds', () => {
  it('returns direct-use agents and excludes subagents or hidden system agents', () => {
    const agents = [
      { name: 'build', mode: 'primary' },
      { id: 'plan', mode: 'primary' },
      { name: 'custom' },
      { name: 'all-purpose', mode: 'all' },
      { name: 'general', mode: 'subagent' },
      { name: 'compact', mode: 'primary', hidden: true },
      { name: 'title', mode: 'primary', hidden: true },
      { name: 'disabled-primary', mode: 'primary', disable: true },
      { mode: 'primary' },
    ];

    expect(listSelectableAgentIds(agents)).toEqual(['build', 'plan', 'custom', 'all-purpose']);
  });
});
