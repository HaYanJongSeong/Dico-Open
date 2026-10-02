import { describe, expect, it, vi } from 'vitest';
import { createInspectCommandHandler } from './inspect.js';

function setup(values: string[], administrator = false) {
  const component = {
    customId: 'inspect-types', user: { id: 'user-1' }, values,
    isStringSelectMenu: () => true,
    update: vi.fn(async () => undefined), followUp: vi.fn(async () => undefined),
  };
  const menu = { awaitMessageComponent: vi.fn(async () => component) };
  const interaction = {
    channelId: 'thread-1', user: { id: 'user-1' },
    memberPermissions: { has: () => administrator },
    deferReply: vi.fn(async () => undefined), editReply: vi.fn(async (_options: unknown) => menu),
  };
  const messages = vi.fn(async () => ({ data: { data: [
    { id: 'msg_5', type: 'assistant', content: [
      { type: 'text', text: '```ts\nconst example = 1;\n```' },
      { type: 'reasoning', text: '생각' },
      { type: 'tool', name: 'read', state: { status: 'completed', output: '도구 비밀' } },
    ] },
    { id: 'msg_4', type: 'user', text: '@everyone 직접 작성' },
    { id: 'msg_3', type: 'system', text: '시스템 비밀' },
  ] } }));
  const command = createInspectCommandHandler({
    stateManager: { getSession: () => ({ sessionId: 'ses_1', projectPath: '/repo', status: 'active' }) as never },
    serverManager: { getClient: () => ({ session: { messages } }) },
  });
  return { component, menu, interaction, messages, command };
}

describe('/inspect', () => {
  it('lists available types with default auto-sync checks, then privately retrieves selected user and code entries', async () => {
    const { command, interaction, menu, component, messages } = setup(['user', 'code']);
    await command(interaction as never, { channelConfig: {} as never });
    expect(messages).toHaveBeenCalledWith({ sessionID: 'ses_1', limit: 100 });
    const payload = interaction.editReply.mock.calls[0]?.[0] as { components: Array<{ toJSON(): unknown }> };
    expect(JSON.stringify(payload.components[0]?.toJSON())).toContain('내 말');
    expect(JSON.stringify(payload.components[0]?.toJSON())).toContain('생각');
    const options = (payload.components[0]?.toJSON() as { components: Array<{ options: Array<{ value: string; default?: boolean }> }> }).components[0]?.options ?? [];
    expect(options.filter((option) => option.default).map((option) => option.value)).toEqual(['user', 'assistant', 'reasoning']);
    expect(menu.awaitMessageComponent).toHaveBeenCalledOnce();
    expect(component.update).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    expect(component.followUp).toHaveBeenCalledTimes(2);
    expect(component.followUp).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('const example = 1;'), allowedMentions: { parse: [] },
    }));
    expect(component.followUp).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('@everyone 직접 작성'), allowedMentions: { parse: [] },
    }));
    expect(JSON.stringify(component.followUp.mock.calls)).not.toContain('시스템 비밀');
  });

  it('blocks raw system and tool output for non-administrators', async () => {
    const { command, interaction, component } = setup(['system', 'tool']);
    await command(interaction as never, { channelConfig: {} as never });
    expect(component.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('관리자') }));
    expect(component.followUp).not.toHaveBeenCalled();
  });

  it('allows an administrator to privately inspect raw system and tool entries', async () => {
    const { command, interaction, component } = setup(['system', 'tool'], true);
    await command(interaction as never, { channelConfig: {} as never });
    expect(JSON.stringify(component.followUp.mock.calls)).toContain('시스템 비밀');
    expect(JSON.stringify(component.followUp.mock.calls)).toContain('도구 비밀');
  });
});
