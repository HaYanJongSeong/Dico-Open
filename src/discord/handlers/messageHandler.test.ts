import type { Message } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateManager } from '../../state/manager.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import {
  handleMessageCreate,
  type AttachmentProvider,
  type ContextFile,
  type QuestionAnswerHandler,
  type SessionPromptBridge,
} from './messageHandler.js';

const NOW = 1_700_000_000_000;

interface MockMessageOptions {
  author?: { id: string; bot: boolean };
  content?: string;
  id?: string;
  channelId?: string;
  channel?: { id: string; isThread: () => boolean; send?: ReturnType<typeof vi.fn> };
  attachments?: unknown;
}

function createSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 'session-1',
    guildId: 'guild-1',
    channelId: 'thread-1',
    projectPath: '/project',
    agent: 'build',
    model: 'model-1',
    createdBy: 'user-1',
    createdAt: NOW - 1_000,
    lastActivityAt: NOW - 500,
    status: 'active',
    ...overrides,
  };
}

function createMessage(overrides: MockMessageOptions = {}): Message {
  return {
    author: { id: 'user-1', bot: false },
    content: 'hello agent',
    id: 'message-1',
    channelId: 'thread-1',
    channel: { id: 'thread-1', isThread: () => true },
    attachments: new Map(),
    ...overrides,
  } as unknown as Message;
}

function createStateManager(session?: SessionState): StateManager {
  return {
    getSession: vi.fn(() => session),
    setSession: vi.fn(),
    enqueue: vi.fn(),
    clearQueue: vi.fn(),
  } as unknown as StateManager;
}

function createQuestionHandler(hasPendingQuestion = false): QuestionAnswerHandler {
  return {
    hasPendingQuestion: vi.fn(() => hasPendingQuestion),
    handleQuestionAnswer: vi.fn(),
  };
}

function createSessionBridge(isBusy = false): SessionPromptBridge {
  return {
    isBusy: vi.fn(() => isBusy),
    sendPrompt: vi.fn(),
  };
}

function createOptions(session?: SessionState, isBusy = false, hasPendingQuestion = false) {
  return {
    stateManager: createStateManager(session),
    questionHandler: createQuestionHandler(hasPendingQuestion),
    sessionBridge: createSessionBridge(isBusy),
    now: () => NOW,
  };
}

describe('handleMessageCreate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('ignores bot messages', async () => {
    const options = createOptions(createSession());
    const message = createMessage({ author: { id: 'bot-1', bot: true } });

    await handleMessageCreate(message, options);

    expect(options.questionHandler.hasPendingQuestion).not.toHaveBeenCalled();
    expect(options.stateManager.getSession).not.toHaveBeenCalled();
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('ignores non-thread messages', async () => {
    const options = createOptions(createSession());
    const message = createMessage({
      channel: { id: 'channel-1', isThread: () => false },
    });

    await handleMessageCreate(message, options);

    expect(options.questionHandler.hasPendingQuestion).not.toHaveBeenCalled();
    expect(options.stateManager.getSession).not.toHaveBeenCalled();
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects disallowed users before accepting question answers or session prompts', async () => {
    const options = createOptions(createSession(), false, true);
    await handleMessageCreate(createMessage({ author: { id: 'outsider', bot: false } }), {
      ...options,
      getChannelConfig: () => ({ allowedUsers: ['user-1'] }),
    });
    expect(options.questionHandler.handleQuestionAnswer).not.toHaveBeenCalled();
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('intercepts answers when a pending question exists', async () => {
    const options = createOptions(createSession(), false, true);
    const message = createMessage({ content: 'yes' });

    await handleMessageCreate(message, options);

    expect(options.questionHandler.hasPendingQuestion).toHaveBeenCalledWith('thread-1');
    expect(options.questionHandler.handleQuestionAnswer).toHaveBeenCalledWith(
      'thread-1',
      'yes',
      expect.stringMatching(/^thread-1-\d+$/),
    );
    expect(options.stateManager.getSession).toHaveBeenCalledWith('thread-1');
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('ignores messages without a session', async () => {
    const options = createOptions(undefined);

    await handleMessageCreate(createMessage(), options);

    expect(options.stateManager.getSession).toHaveBeenCalledWith('thread-1');
    expect(options.sessionBridge.isBusy).not.toHaveBeenCalled();
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('ignores messages for ended sessions', async () => {
    const options = createOptions(createSession({ status: 'ended' }));

    await handleMessageCreate(createMessage(), options);

    expect(options.sessionBridge.isBusy).not.toHaveBeenCalled();
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('queues active session messages when the bridge is busy', async () => {
    const session = createSession();
    const options = createOptions(session, true);

    await handleMessageCreate(createMessage({ content: 'queue this' }), options);

    expect(options.sessionBridge.isBusy).toHaveBeenCalledWith('thread-1');
    expect(options.stateManager.enqueue).toHaveBeenCalledWith('thread-1', {
      userId: 'user-1',
      content: 'queue this',
      attachments: [],
      queuedAt: NOW,
    });
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('forwards active session messages when the bridge is idle', async () => {
    const session = createSession();
    const options = createOptions(session);

    await handleMessageCreate(createMessage({ content: 'send this' }), options);

    expect(options.sessionBridge.sendPrompt).toHaveBeenCalledWith('thread-1', 'send this', {
      session,
      correlationId: expect.stringMatching(/^thread-1-\d+$/),
      contextFiles: [],
    });
  });

  it('ends the mapping, clears queue, and notifies the thread when OpenCode lost the session after reboot', async () => {
    const session = createSession();
    const options = createOptions(session);
    const send = vi.fn(async () => undefined);
    const message = createMessage({ channel: { id: 'thread-1', isThread: () => true, send } });
    vi.mocked(options.sessionBridge.sendPrompt).mockRejectedValue(new BotError(ErrorCode.SESSION_NOT_FOUND, 'OpenCode session was not found'));

    await handleMessageCreate(message, options);

    expect(options.stateManager.setSession).toHaveBeenCalledWith('thread-1', { ...session, status: 'ended' });
    expect(options.stateManager.clearQueue).toHaveBeenCalledWith('thread-1');
    expect(send).toHaveBeenCalledWith('재시작 후 이전 OpenCode 세션을 복구하지 못했습니다. `/new`로 새 세션을 만들거나 `/connect`로 기존 세션에 연결하세요.');
  });

  it('reactivates inactive sessions before forwarding', async () => {
    const session = createSession({ status: 'inactive' });
    const options = createOptions(session);

    await handleMessageCreate(createMessage(), options);

    const expectedSession: SessionState = { ...session, status: 'active', lastActivityAt: NOW };
    expect(options.stateManager.setSession).toHaveBeenCalledWith('thread-1', expectedSession);
    expect(options.sessionBridge.sendPrompt).toHaveBeenCalledWith(
      'thread-1',
      'hello agent',
      expect.objectContaining({ session: expectedSession }),
    );
  });

  it('forwards downloaded Discord attachments with idle passthrough messages', async () => {
    const attachmentFiles: ContextFile[] = [
      { path: '/tmp/image.png', url: 'file:///tmp/image.png', mime: 'image/png', filename: 'image.png' },
    ];
    const options = createOptions(createSession());
    const attachmentProvider: AttachmentProvider = { download: vi.fn(async () => attachmentFiles) };

    await handleMessageCreate(createMessage(), { ...options, attachmentProvider });

    expect(attachmentProvider.download).toHaveBeenCalledWith(expect.objectContaining({ id: 'message-1' }), createSession());
    expect(options.sessionBridge.sendPrompt).toHaveBeenCalledWith(
      'thread-1',
      'hello agent',
      expect.objectContaining({ contextFiles: attachmentFiles }),
    );
  });

  it('queues downloaded Discord attachment paths when the bridge is busy', async () => {
    const session = createSession();
    const options = createOptions(session, true);
    const attachmentProvider: AttachmentProvider = {
      download: vi.fn(async () => [
        { path: '/tmp/image.png', url: 'file:///tmp/image.png', mime: 'image/png', filename: 'image.png' },
      ]),
    };

    await handleMessageCreate(createMessage({ content: 'queue with file' }), { ...options, attachmentProvider });

    expect(attachmentProvider.download).toHaveBeenCalledWith(expect.objectContaining({ id: 'message-1' }), session);
    expect(options.stateManager.enqueue).toHaveBeenCalledWith('thread-1', {
      userId: 'user-1',
      content: 'queue with file',
      attachments: ['/tmp/image.png'],
      queuedAt: NOW,
    });
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('prefers channel.id over message.channelId for thread ID', async () => {
    const session = createSession({ channelId: 'thread-from-channel' });
    const options = createOptions(session);
    const message = createMessage({
      channelId: 'thread-from-message',
      channel: { id: 'thread-from-channel', isThread: () => true },
    });

    await handleMessageCreate(message, options);

    expect(options.stateManager.getSession).toHaveBeenCalledWith('thread-from-channel');
    expect(options.sessionBridge.sendPrompt).toHaveBeenCalledWith(
      'thread-from-channel',
      'hello agent',
      expect.objectContaining({ correlationId: expect.stringMatching(/^thread-from-channel-\d+$/) }),
    );
  });
});
