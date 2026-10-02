import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../../state/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createDiffCommandHandler, type DiffCommandDependencies } from './diff.js';

function createInteraction(): ChatInputCommandInteraction {
  return {
    channelId: 'thread-1',
    channel: { parentId: 'channel-1' },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 'session-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    projectPath: '/repo',
    agent: 'build',
    model: null,
    createdBy: 'user-1',
    createdAt: 1,
    lastActivityAt: 1,
    status: 'active',
    ...overrides,
  };
}

function createDeps(overrides: Partial<DiffCommandDependencies> = {}): DiffCommandDependencies {
  const client = { session: { diff: vi.fn(async () => 'diff --git a/file.ts b/file.ts') } };
  return {
    stateManager: { getSession: vi.fn(() => createSession()) },
    serverManager: { getClient: vi.fn(() => client) },
    splitMessage: vi.fn((text: string) => [text]),
    createAttachment: vi.fn((content: string, name: string) => ({ content, name })),
    ...overrides,
  };
}

describe('createDiffCommandHandler', () => {
  it('formats session diff as an inline-preview attachment', async () => {
    const deps = createDeps();
    const interaction = createInteraction();

    await createDiffCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    const client = deps.serverManager.getClient('/repo') as { session: { diff: ReturnType<typeof vi.fn> } };
    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(client.session.diff).toHaveBeenCalledWith({ sessionID: 'session-1' });
    expect(deps.splitMessage).not.toHaveBeenCalled();
    expect(deps.createAttachment).toHaveBeenCalledWith('diff --git a/file.ts b/file.ts', 'session.diff');
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '프로젝트:\n```\n/repo\n```', files: [{ content: 'diff --git a/file.ts b/file.ts', name: 'session.diff' }] });
  });

  it('keeps long session diffs complete in the attachment', async () => {
    const longDiff = `diff --git a/file.ts b/file.ts\n${'a'.repeat(4000)}`;
    const client = { session: { diff: vi.fn(async () => longDiff) } };
    const deps = createDeps({ serverManager: { getClient: vi.fn(() => client) } });
    const interaction = createInteraction();

    await createDiffCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(deps.splitMessage).not.toHaveBeenCalled();
    expect(deps.createAttachment).toHaveBeenCalledWith(longDiff, 'session.diff');
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('does not wrap the attached diff in code fences', async () => {
    const deps = createDeps();

    await createDiffCommandHandler(deps)(createInteraction(), { correlationId: 'corr-1' });

    const createAttachment = deps.createAttachment;
    expect(createAttachment).toBeDefined();
    const attachedContent = vi.mocked(createAttachment!).mock.calls[0]?.[0];
    expect(attachedContent).toBe('diff --git a/file.ts b/file.ts');
    expect(attachedContent?.startsWith('```diff')).toBe(false);
  });

  it('reports no changes when session diff is empty', async () => {
    const client = { session: { diff: vi.fn(async () => '') } };
    const deps = createDeps({ serverManager: { getClient: vi.fn(() => client) } });
    const interaction = createInteraction();

    await createDiffCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(interaction.editReply).toHaveBeenCalledWith({ content: '이 세션에 파일 변경 사항이 없습니다.' });
  });

  it('formats SDK file diff arrays as an attached patch', async () => {
    const client = {
      session: {
        diff: vi.fn(async () => [
          {
            file: 'src/index.ts',
            patch: 'diff --git a/src/index.ts b/src/index.ts\n+change',
            additions: 1,
            deletions: 0,
            status: 'modified',
          },
        ]),
      },
    };
    const deps = createDeps({ serverManager: { getClient: vi.fn(() => client) } });
    const interaction = createInteraction();

    await createDiffCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(deps.createAttachment).toHaveBeenCalledWith('diff --git a/src/index.ts b/src/index.ts\n+change', 'session.diff');
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '프로젝트:\n```\n/repo\n```', files: [{ content: 'diff --git a/src/index.ts b/src/index.ts\n+change', name: 'session.diff' }] });
  });

  it('attaches patches from the nested CLI v2 diff response', async () => {
    const patch = 'diff --git a/src/index.ts b/src/index.ts\n+change';
    const client = { session: { diff: vi.fn(async () => ({ data: { data: [{ patch }] } })) } };
    const deps = createDeps({ serverManager: { getClient: vi.fn(() => client) } });

    await createDiffCommandHandler(deps)(createInteraction(), { correlationId: 'corr-1' });

    expect(deps.createAttachment).toHaveBeenCalledWith(patch, 'session.diff');
  });

  it('does not report no changes when the SDK returns an error', async () => {
    const client = { session: { diff: vi.fn(async () => ({ error: 'unavailable' })) } };
    const deps = createDeps({ serverManager: { getClient: vi.fn(() => client) } });

    await expect(createDiffCommandHandler(deps)(createInteraction(), { correlationId: 'corr-1' })).rejects.toMatchObject({ code: ErrorCode.SERVER_UNHEALTHY });
    expect(deps.createAttachment).not.toHaveBeenCalled();
  });

  it('requires a session thread', async () => {
    const interaction = { ...createInteraction(), channel: { parentId: null } } as unknown as ChatInputCommandInteraction;

    await expect(createDiffCommandHandler(createDeps())(interaction, { correlationId: 'corr-1' })).rejects.toMatchObject({
      code: ErrorCode.DISCORD_API_ERROR,
    });
  });
});
