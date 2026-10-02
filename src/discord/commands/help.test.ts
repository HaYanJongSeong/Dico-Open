import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { createHelpCommandHandler } from './help.js';

describe('createHelpCommandHandler', () => {
  it('shows channel commands as an ephemeral reply in a configured channel', async () => {
    const interaction = { channelId: 'channel-1', channel: null, reply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;

    await createHelpCommandHandler()(interaction, { correlationId: 'corr-1', channelConfig: { channelId: 'channel-1', projectPath: '/repo' } });

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral, content: expect.stringContaining('/new') }));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('/status') }));
  });

  it('shows thread commands as an ephemeral reply inside a session thread', async () => {
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1' }, reply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;

    await createHelpCommandHandler()(interaction, { correlationId: 'corr-1', channelConfig: { channelId: 'channel-1', projectPath: '/repo' } });

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral, content: expect.stringContaining('/agent set') }));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('/interrupt') }));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('/inspect') }));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.not.stringContaining('/end') }));
  });
});
