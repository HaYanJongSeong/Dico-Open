import { REST, SlashCommandBuilder } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandDefinitions } from './commands/index.js';
import { deployCommands } from './deploy.js';
import { ErrorCode, type BotError } from '../utils/errors.js';

const putMock = vi.fn();
const setTokenMock = vi.fn(() => ({ put: putMock }));

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();

  return {
    ...actual,
    REST: vi.fn(function MockRest() {
      return { setToken: setTokenMock };
    }),
  };
});

describe('getCommandDefinitions', () => {
  it('returns SlashCommandBuilder instances for all registered commands', () => {
    const commands = getCommandDefinitions();

    expect(commands).toHaveLength(12);
    expect(commands.every((command) => command instanceof SlashCommandBuilder)).toBe(true);
    expect(commands.map((command) => command.name)).toEqual([
      'new',
      'connect',
      'agent',
      'model',
      'interrupt',
      'info',
      'inspect',
      'status',
      'sync',
      'help',
      'restart',
      'diff',
    ]);
  });

  it('defines representative options, choices, and autocomplete flags', () => {
    const commandJson = getCommandDefinitions().map((command) => command.toJSON());

    const newCommand = commandJson.find((command) => command.name === 'new');
    expect(newCommand?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'prompt', type: 3, required: false }),
        expect.objectContaining({ name: 'agent', type: 3, autocomplete: true }),
        expect.objectContaining({ name: 'title', type: 3 }),
      ]),
    );

    const syncCommand = commandJson.find((command) => command.name === 'sync');
    expect(syncCommand?.options?.map((option) => option.name)).toEqual(['status', 'now']);
  });
});

describe('deployCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    putMock.mockResolvedValue(undefined);
  });

  it('registers command JSON with the guild command REST route', async () => {
    const token = `${Buffer.from('123456789012345678').toString('base64url')}.token.signature`;
    const commands = [
      new SlashCommandBuilder().setName('ping').setDescription('Ping command'),
    ];

    await deployCommands(token, 'guild-456', commands);

    expect(REST).toHaveBeenCalledWith({ version: '10' });
    expect(setTokenMock).toHaveBeenCalledWith(token);
    expect(putMock).toHaveBeenCalledWith(
      expect.stringContaining('/applications/123456789012345678/guilds/guild-456/commands'),
      { body: commands.map((command) => command.toJSON()) },
    );
  });

  it('throws a BotError for a non-empty token segment that decodes to a non-snowflake application ID', async () => {
    const token = `${Buffer.from('not-a-snowflake').toString('base64url')}.token.signature`;

    await expect(deployCommands(token, 'guild-456', [])).rejects.toMatchObject({
      code: ErrorCode.DISCORD_API_ERROR,
    } satisfies Partial<BotError>);
    expect(putMock).not.toHaveBeenCalled();
  });

  it('wraps Discord REST deployment failures in a BotError', async () => {
    const token = `${Buffer.from('123456789012345678').toString('base64url')}.token.signature`;
    const commands = [
      new SlashCommandBuilder().setName('ping').setDescription('Ping command'),
    ];
    putMock.mockRejectedValue(new Error('Missing Access'));

    await expect(deployCommands(token, 'guild-456', commands)).rejects.toMatchObject({
      code: ErrorCode.DISCORD_API_ERROR,
    } satisfies Partial<BotError>);
    expect(putMock).toHaveBeenCalledWith(
      expect.stringContaining('/applications/123456789012345678/guilds/guild-456/commands'),
      { body: commands.map((command) => command.toJSON()) },
    );
  });

  it('throws a BotError when the application ID cannot be decoded from the token', async () => {
    await expect(deployCommands('', 'guild-456', [])).rejects.toMatchObject({
      code: ErrorCode.DISCORD_API_ERROR,
    } satisfies Partial<BotError>);
  });
});
