import { MessageFlags, type ApplicationCommandOptionChoiceData, type AutocompleteInteraction, type ChatInputCommandInteraction, type Interaction } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigLoader } from '../../config/loader.js';
import type { ChannelConfig } from '../../config/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { handleInteraction, type AutocompleteHandler, type CommandHandler } from './interactionHandler.js';

function createConfigLoader(channelConfig?: ChannelConfig): ConfigLoader {
  return {
    getChannelConfig: vi.fn(() => channelConfig),
  } as unknown as ConfigLoader;
}

interface CommandInteractionOptions {
  channelId?: string;
  channel?: { parentId?: string | null; isThread?: () => boolean };
  deferred?: boolean;
}

function createCommandInteraction(
  commandName = 'new',
  userId = 'user-1',
  options: CommandInteractionOptions = {},
): ChatInputCommandInteraction {
  return {
    id: 'interaction-1',
    channelId: options.channelId ?? 'channel-1',
    channel: options.channel,
    guildId: 'guild-1',
    commandName,
    user: { id: userId },
    replied: false,
    deferred: options.deferred ?? false,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    reply: vi.fn(),
    followUp: vi.fn(),
    editReply: vi.fn(),
  } as unknown as ChatInputCommandInteraction;
}

function createAutocompleteInteraction(commandName = 'agent', userId = 'user-1'): AutocompleteInteraction {
  return {
    id: 'interaction-2',
    channelId: 'channel-1',
    guildId: 'guild-1',
    commandName,
    user: { id: userId },
    isChatInputCommand: () => false,
    isAutocomplete: () => true,
    respond: vi.fn(),
  } as unknown as AutocompleteInteraction;
}

describe('handleInteraction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches command interactions to the registered command handler with context', async () => {
    const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/project' };
    const configLoader = createConfigLoader(channelConfig);
    const commandHandler = vi.fn<CommandHandler>();
    const interaction = createCommandInteraction('new');

    await handleInteraction(interaction, {
      configLoader,
      commandHandlers: new Map([['new', commandHandler]]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(configLoader.getChannelConfig).toHaveBeenCalledWith('guild-1', 'channel-1');
    expect(commandHandler).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({
        channelConfig,
        correlationId: expect.stringMatching(/^channel-1-\d+$/),
      }),
    );
  });

  it('logs command receipt with command name and correlation ID', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleInteraction(createCommandInteraction('new'), {
      configLoader: createConfigLoader(),
      commandHandlers: new Map([['new', vi.fn<CommandHandler>()]]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"msg":"Command interaction received"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"commandName":"new"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/"correlationId":"channel-1-\d+"/));
  });

  it('responds to autocomplete interactions with returned choices', async () => {
    const choices: ApplicationCommandOptionChoiceData[] = [
      { name: 'agent-a', value: 'agent-a' },
      { name: 'agent-b', value: 'agent-b' },
    ];
    const autocompleteHandler = vi.fn<AutocompleteHandler>(async () => choices);
    const interaction = createAutocompleteInteraction();

    await handleInteraction(interaction, {
      configLoader: createConfigLoader(),
      commandHandlers: new Map(),
      autocompleteHandler,
    });

    expect(autocompleteHandler).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({ correlationId: expect.stringMatching(/^channel-1-\d+$/) }),
    );
    expect(interaction.respond).toHaveBeenCalledWith(choices);
  });

  it('does not reveal autocomplete choices to users outside allowedUsers', async () => {
    const autocompleteHandler = vi.fn<AutocompleteHandler>(async () => [{ name: 'private-agent', value: 'private-agent' }]);
    const interaction = createAutocompleteInteraction('agent', 'blocked-user');
    await handleInteraction(interaction, {
      configLoader: createConfigLoader({ channelId: 'channel-1', projectPath: '/private', allowedUsers: ['allowed-user'] }),
      commandHandlers: new Map(),
      autocompleteHandler,
    });
    expect(autocompleteHandler).not.toHaveBeenCalled();
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it('logs autocomplete receipt with command name and correlation ID', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleInteraction(createAutocompleteInteraction('new'), {
      configLoader: createConfigLoader(),
      commandHandlers: new Map(),
      autocompleteHandler: vi.fn<AutocompleteHandler>(async () => []),
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"msg":"Autocomplete interaction received"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"commandName":"new"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/"correlationId":"channel-1-\d+"/));
  });

  it('returns an ephemeral error for unknown commands', async () => {
    const interaction = createCommandInteraction('missing');
    const commandHandler = vi.fn<CommandHandler>();

    await handleInteraction(interaction, {
      configLoader: createConfigLoader(),
      commandHandlers: new Map([['new', commandHandler]]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(commandHandler).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringMatching(/요청을 처리하지 못했습니다.*참조: channel-1-\d+/),
      flags: MessageFlags.Ephemeral,
    });
  });

  it('checks allowedUsers before executing command handlers', async () => {
    const channelConfig: ChannelConfig = {
      channelId: 'channel-1',
      projectPath: '/project',
      allowedUsers: ['allowed-user'],
    };
    const interaction = createCommandInteraction('new', 'blocked-user');
    const commandHandler = vi.fn<CommandHandler>();

    await handleInteraction(interaction, {
      configLoader: createConfigLoader(channelConfig),
      commandHandlers: new Map([['new', commandHandler]]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(commandHandler).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringMatching(/요청을 처리하지 못했습니다.*참조: channel-1-\d+/),
      flags: MessageFlags.Ephemeral,
    });
  });

  it('checks allowedUsers against the parent channel config for thread commands', async () => {
    const channelConfig: ChannelConfig = {
      channelId: 'channel-1',
      projectPath: '/project',
      allowedUsers: ['allowed-user'],
    };
    const configLoader = {
      getChannelConfig: vi.fn((guildId: string, channelId: string) => {
        if (guildId === 'guild-1' && channelId === 'channel-1') {
          return channelConfig;
        }

        return undefined;
      }),
    } as unknown as ConfigLoader;
    const interaction = createCommandInteraction('new', 'blocked-user', {
      channelId: 'thread-1',
      channel: { parentId: 'channel-1', isThread: () => true },
    });
    const commandHandler = vi.fn<CommandHandler>();

    await handleInteraction(interaction, {
      configLoader,
      commandHandlers: new Map([['new', commandHandler]]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(configLoader.getChannelConfig).toHaveBeenCalledWith('guild-1', 'channel-1');
    expect(commandHandler).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringMatching(/요청을 처리하지 못했습니다.*참조: thread-1-\d+/),
      flags: MessageFlags.Ephemeral,
    });
  });

  it('looks up text channel config by channel ID when the channel is inside a category', async () => {
    const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/project' };
    const configLoader = createConfigLoader(channelConfig);
    const commandHandler = vi.fn<CommandHandler>();
    const interaction = createCommandInteraction('new', 'user-1', {
      channelId: 'channel-1',
      channel: { parentId: 'category-1', isThread: () => false },
    });

    await handleInteraction(interaction, {
      configLoader,
      commandHandlers: new Map([['new', commandHandler]]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(configLoader.getChannelConfig).toHaveBeenCalledWith('guild-1', 'channel-1');
    expect(commandHandler).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({ channelConfig }),
    );
  });

  it('looks up thread command config by parent channel ID', async () => {
    const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/project' };
    const configLoader = createConfigLoader(channelConfig);
    const commandHandler = vi.fn<CommandHandler>();
    const interaction = createCommandInteraction('new', 'user-1', {
      channelId: 'thread-1',
      channel: { parentId: 'channel-1', isThread: () => true },
    });

    await handleInteraction(interaction, {
      configLoader,
      commandHandlers: new Map([['new', commandHandler]]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(configLoader.getChannelConfig).toHaveBeenCalledWith('guild-1', 'channel-1');
    expect(commandHandler).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({ channelConfig }),
    );
  });

  it('sends deferred command errors as ephemeral follow-up messages', async () => {
    const interaction = createCommandInteraction('new', 'user-1', { deferred: true });

    await handleInteraction(interaction, {
      configLoader: createConfigLoader(),
      commandHandlers: new Map([
        ['new', vi.fn<CommandHandler>(async () => {
          throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Deferred failure');
        })],
      ]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringMatching(/요청을 처리하지 못했습니다.*참조: channel-1-\d+/),
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('logs BotError command failures with code and correlation ID', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleInteraction(createCommandInteraction('new'), {
      configLoader: createConfigLoader(),
      commandHandlers: new Map([
        ['new', vi.fn<CommandHandler>(async () => {
          throw new BotError(ErrorCode.AGENT_NOT_FOUND, 'Agent missing', { agent: 'ghost' });
        })],
      ]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/"correlationId":"channel-1-\d+"/));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"code":"AGENT_NOT_FOUND"'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"agent":"ghost"'));
  });

  it('logs unknown command failures with correlation ID', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handleInteraction(createCommandInteraction('new'), {
      configLoader: createConfigLoader(),
      commandHandlers: new Map([
        ['new', vi.fn<CommandHandler>(async () => {
          throw new Error('boom');
        })],
      ]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/"correlationId":"channel-1-\d+"/));
  });

  it('does not reject when a command error response fails because Discord expired the interaction', async () => {
    const interaction = createCommandInteraction('new');
    interaction.reply = vi.fn(async () => {
      throw new Error('Unknown interaction');
    }) as never;

    await expect(handleInteraction(interaction, {
      configLoader: createConfigLoader(),
      commandHandlers: new Map([
        ['new', vi.fn<CommandHandler>(async () => {
          throw new BotError(ErrorCode.SERVER_START_FAILED, 'OpenCode server failed to become healthy');
        })],
      ]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    })).resolves.toBeUndefined();
  });

  it('responds with empty autocomplete choices when the autocomplete handler fails', async () => {
    const interaction = createAutocompleteInteraction();

    await handleInteraction(interaction, {
      configLoader: createConfigLoader(),
      commandHandlers: new Map(),
      autocompleteHandler: vi.fn<AutocompleteHandler>(async () => {
        throw new BotError(ErrorCode.AGENT_NOT_FOUND, 'Agent cache failed');
      }),
    });

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it('does not reject when the autocomplete fallback response fails because Discord expired the interaction', async () => {
    const interaction = createAutocompleteInteraction();
    interaction.respond = vi.fn(async () => {
      throw new Error('Unknown interaction');
    }) as never;

    await expect(handleInteraction(interaction, {
      configLoader: createConfigLoader(),
      commandHandlers: new Map(),
      autocompleteHandler: vi.fn<AutocompleteHandler>(async () => {
        throw new BotError(ErrorCode.AGENT_NOT_FOUND, 'Agent cache failed');
      }),
    })).resolves.toBeUndefined();
  });

  it('ignores interactions that are neither commands nor autocomplete', async () => {
    const interaction = {
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
    } as unknown as Interaction;
    const commandHandler = vi.fn<CommandHandler>();
    const autocompleteHandler = vi.fn<AutocompleteHandler>();

    await handleInteraction(interaction, {
      configLoader: createConfigLoader(),
      commandHandlers: new Map([['new', commandHandler]]),
      autocompleteHandler,
    });

    expect(commandHandler).not.toHaveBeenCalled();
    expect(autocompleteHandler).not.toHaveBeenCalled();
  });
});
